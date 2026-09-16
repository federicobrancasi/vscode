/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../base/common/async.js';
import { equals } from '../../../base/common/objects.js';
import { localize } from '../../../nls.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomConfiguration } from '../common/agentHostRooms.js';
import { ResolveSessionConfigResult } from '../common/state/protocol/commands.js';
import { ModelSelection } from '../common/state/sessionState.js';
import { roomExecution, roomMember, RoomStateStore, updateRoomMember } from './agentHostRoomState.js';
import { intersectRoomConfigurations, parseRoomConfiguration, validateRoomConfigurationChange } from './agentHostRoomsConfiguration.js';
import { getRoomMemberModel, parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomRuntime } from './agentHostRoomsTypes.js';

/** Serializes provider settings per member without holding the room's persistence queue. */
export class RoomMembers {
	private readonly queue = new SequencerByKey<string>();
	private readonly versions = new Map<string, number>();

	constructor(private readonly state: RoomStateStore, private readonly runtime: IRoomRuntime) { }

	private changeVersion(memberId: string): void {
		this.versions.set(memberId, (this.versions.get(memberId) ?? 0) + 1);
	}

	async setModel(roomId: string, memberId: string, model: ModelSelection | undefined): Promise<IAgentHostRoom> {
		await this.state.ready;
		const member = roomMember(this.state.record(roomId), memberId);
		if (member.removed) {
			throw new Error(localize('rooms.removedMember', "This room member has been removed."));
		}
		const selected = parseRoomModelSelection(model ?? { id: 'auto' });
		this.runtime.validateModel(selected);
		this.changeVersion(memberId);
		await this.queue.queue(memberId, async () => {
			this.runtime.validateModel(selected);
			const record = await this.state.update(roomId, record => {
				if (roomMember(record, memberId).removed) {
					throw new Error(localize('rooms.removedMember', "This room member has been removed."));
				}
				return updateRoomMember(record, memberId, { model: selected.id, pendingModel: model === undefined ? null : selected, modelError: undefined });
			});
			this.runtime.publishModel(roomMember(record, memberId));
			const execution = roomExecution(record, memberId);
			if (execution.initialized && !execution.turnId && this.runtime.isIdle(member.sessionUri)) {
				await this.applyModel(roomId, memberId);
			}
		});
		return this.state.room(roomId);
	}

	async configuration(roomId: string): Promise<ResolveSessionConfigResult> {
		await this.state.ready;
		return intersectRoomConfigurations(await Promise.all(this.state.record(roomId).room.members
			.filter(member => !member.removed).map(member => this.runtime.resolveConfiguration(member))));
	}

	async setConfiguration(roomId: string, configuration: Partial<IAgentHostRoomConfiguration>, memberId?: string, onApplied?: () => void): Promise<IAgentHostRoom> {
		await this.state.ready;
		const patch = parseRoomConfiguration(configuration);
		const record = this.state.record(roomId);
		const members = record.room.members.filter(member => !member.removed && (memberId === undefined || member.id === memberId));
		if (!members.length) {
			throw new Error(localize('rooms.memberNotFound', "The room member does not exist."));
		}
		if (!Object.keys(patch).length) {
			return this.state.room(roomId);
		}
		for (const member of members) {
			this.changeVersion(member.id);
		}
		const save = async () => {
			for (const member of members) {
				const selected = { ...defaultAgentHostRoomConfiguration, ...member.configuration, ...patch };
				validateRoomConfigurationChange(patch, await this.runtime.resolveConfiguration(member, selected));
			}
			await this.state.update(roomId, record => {
				if (members.some(member => roomMember(record, member.id).removed)) {
					throw new Error(localize('rooms.removedMember', "This room member has been removed."));
				}
				return {
					...record,
					room: {
						...record.room, error: undefined,
						members: record.room.members.map(member => members.some(target => target.id === member.id)
							? { ...member, configuration: { ...defaultAgentHostRoomConfiguration, ...member.configuration, ...patch } } : member),
					},
				};
			});
		};
		const saved = save();
		await Promise.all([saved, ...members.map(member => this.queue.queue(member.id, async () => {
			await saved;
			const current = this.state.record(roomId);
			if (roomMember(current, member.id).removed) {
				throw new Error(localize('rooms.removedMember', "This room member has been removed."));
			}
			if (!roomExecution(current, member.id).initialized) {
				return;
			}
			try {
				await this.runtime.applyConfiguration(roomMember(this.state.record(roomId), member.id), patch);
			} catch (error) {
				await this.state.update(roomId, record => updateRoomMember(record, member.id, { state: 'failed', error: String(error) }));
				throw error;
			}
		}))]);
		onApplied?.();
		return this.state.room(roomId);
	}

	async withSettings(roomId: string, memberId: string, canSubmit: () => boolean, submit: () => Promise<void>): Promise<boolean> {
		return this.queue.queue(memberId, async () => {
			const version = this.versions.get(memberId);
			if (!canSubmit()) {
				return true;
			}
			try {
				await this.runtime.applyConfiguration(roomMember(this.state.record(roomId), memberId));
				if (!canSubmit()) {
					return true;
				}
				await this.applyModel(roomId, memberId);
			} catch (error) {
				if (version !== this.versions.get(memberId)) {
					return false;
				}
				throw error;
			}
			if (version !== this.versions.get(memberId)) {
				return false;
			}
			if (canSubmit()) {
				await submit();
			}
			return true;
		});
	}

	private async applyModel(roomId: string, memberId: string): Promise<void> {
		const member = roomMember(this.state.record(roomId), memberId);
		try {
			const selected = member.pendingModel !== undefined ? getRoomMemberModel(member) : this.runtime.getModel(member) ?? getRoomMemberModel(member);
			if (selected) {
				this.runtime.validateModel(selected);
				await this.runtime.applyModel(member, selected);
			}
			const applied = this.runtime.getModel(member) ?? selected;
			if (selected && applied && !equals(selected, applied)) {
				throw new Error(localize('rooms.modelNotApplied', "The provider did not apply the requested model '{0}'.", selected.id));
			}
			const record = await this.state.update(roomId, record => {
				const current = roomMember(record, memberId);
				const change = { model: applied?.id, modelSelection: applied, pendingModel: undefined, modelError: undefined };
				return equals(current, { ...current, ...change }) ? record : updateRoomMember(record, memberId, change);
			});
			this.runtime.publishModel(roomMember(record, memberId));
		} catch (error) {
			await this.state.update(roomId, record => updateRoomMember(record, memberId, { modelError: String(error) }));
			throw error;
		}
	}
}
