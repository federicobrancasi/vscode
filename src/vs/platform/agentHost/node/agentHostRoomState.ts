/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostRoom, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery, MAX_ROOM_INBOX_BATCH_CHARACTERS, MAX_ROOM_INBOX_BATCH_SIZE } from '../common/agentHostRooms.js';
import { buildDefaultChatUri } from '../common/state/sessionState.js';
import { IRoomArchive, IRoomMemberExecution, IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomStorage } from './agentHostRoomsTypes.js';

export interface IRoomMemberBinding {
	readonly roomId: string;
	readonly memberId: string;
}

export function roomMember(record: IRoomRecord, memberId: string): IAgentHostRoomMember {
	const member = record.room.members.find(member => member.id === memberId);
	if (!member) {
		throw new Error(localize('rooms.memberNotFound', "The room member does not exist."));
	}
	return member;
}

export function roomExecution(record: IRoomRecord, memberId: string): IRoomMemberExecution {
	const execution = record.executions.find(execution => execution.memberId === memberId);
	if (!execution) {
		throw new Error(localize('rooms.executionNotFound', "The room member's execution record is missing."));
	}
	return execution;
}

export function updateRoomMember(record: IRoomRecord, memberId: string, change: Partial<IAgentHostRoomMember>): IRoomRecord {
	return { ...record, room: { ...record.room, members: record.room.members.map(member => member.id === memberId ? { ...member, ...change } : member) } };
}

export function validateRoomText(value: string, limit: number): void {
	if (typeof value !== 'string' || !value.trim() || value.length > limit) {
		throw new Error(localize('rooms.invalidText', "Provide nonempty text of at most {0} characters.", limit));
	}
}

export function validateRoomMessageId(value: string): void {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
		throw new Error(localize('rooms.invalidMessageId', "Use a message ID containing only letters, numbers, underscores, and hyphens."));
	}
}

export function roomMessagePage(messages: readonly IAgentHostRoomMessage[], query: IAgentHostRoomMessageQuery = {}): IAgentHostRoomMessagePage {
	if ((query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0))
		|| (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1))
		|| (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200))
		|| (query.memberId !== undefined && typeof query.memberId !== 'string')) {
		throw new Error(localize('rooms.invalidQuery', "Use integer room message cursors and a limit from 1 to 200."));
	}
	const audience = query.memberId === undefined ? messages : messages.filter(message => message.mentions.includes(query.memberId!));
	const matching = audience.filter(message => (query.after === undefined || message.sequence > query.after) && (query.before === undefined || message.sequence < query.before));
	const limit = query.limit ?? 100;
	const page = query.after === undefined ? matching.slice(-limit) : matching.slice(0, limit);
	return {
		messages: page,
		hasEarlier: !!page.length && audience[0].sequence < page[0].sequence,
		hasLater: !!page.length && audience[audience.length - 1].sequence > page[page.length - 1].sequence,
	};
}

export function inboxMessageText(message: IAgentHostRoomMessage): string {
	return JSON.stringify({
		id: message.id, sequence: message.sequence, authorId: message.authorId, authorName: message.authorName,
		authorKind: message.authorKind, text: message.text, replyTo: message.replyTo, artifactIds: message.artifactIds,
	});
}

export function roomInboxBatch(record: IRoomRecord, memberId: string): readonly IAgentHostRoomMessage[] {
	const batch: IAgentHostRoomMessage[] = [];
	let characters = 0;
	for (const message of record.messages) {
		if (!message.deliveries.some(delivery => delivery.memberId === memberId && delivery.state === 'pending' && !delivery.turnId)) {
			continue;
		}
		const length = inboxMessageText(message).length + (batch.length ? 1 : 0);
		if (batch.length >= MAX_ROOM_INBOX_BATCH_SIZE || characters + length > MAX_ROOM_INBOX_BATCH_CHARACTERS) {
			break;
		}
		batch.push(message);
		characters += length;
	}
	return batch;
}

/** Durable transitions are serialized per room; streaming activity is a separate projection. */
export class RoomStateStore extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<IAgentHostRoom>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidFail = this._register(new Emitter<void>());
	readonly onDidFail = this._onDidFail.event;
	private readonly _records = new Map<string, IRoomRecord>();
	private readonly _archives = new Map<string, IRoomArchive>();
	private readonly _bindings = new Map<string, IRoomMemberBinding>();
	private readonly _archiveSessions = new Set<string>();
	private readonly _queue = new SequencerByKey<string>();
	private readonly _activity = new Map<string, IRoomRuntimeEvent>();
	private readonly _revisions = new Map<string, number>();
	private _failure: string | undefined;
	private _ready = false;
	readonly ready: Promise<void>;

	constructor(
		private readonly storage: IRoomStorage,
		private readonly runtime: IRoomRuntime,
		private readonly log: ILogService,
		private readonly now: () => number,
	) {
		super();
		this.ready = this.restore();
	}

	get available(): boolean { return this._failure === undefined && !this._store.isDisposed; }
	get isReady(): boolean { return this._ready; }
	get records(): readonly IRoomRecord[] { return [...this._records.values()]; }
	binding(session: string): IRoomMemberBinding | undefined { return this._bindings.get(session); }
	isArchiveSession(session: string): boolean { return this._archiveSessions.has(session); }
	isRoomSession(session: string): boolean { return this._bindings.has(session) || this.isArchiveSession(session); }

	record(roomId: string): IRoomRecord {
		if (this._archives.has(roomId)) {
			throw new Error(localize('rooms.archiveReadOnly', "Archived collaboration rooms are read-only."));
		}
		const record = this._records.get(roomId);
		if (!record) {
			throw new Error(localize('rooms.notFound', "The room does not exist."));
		}
		return record;
	}

	room(roomId: string): IAgentHostRoom {
		return this._archives.get(roomId)?.room ?? this.snapshot(this.record(roomId));
	}

	messages(roomId: string): readonly IAgentHostRoomMessage[] {
		return this._archives.get(roomId)?.messages ?? this.record(roomId).messages;
	}

	list(): readonly IAgentHostRoom[] {
		return [...this._records.values()].map(record => this.snapshot(record)).concat([...this._archives.values()].map(archive => archive.room))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async add(record: IRoomRecord): Promise<IRoomRecord> {
		await this.ready;
		return this._queue.queue(record.room.id, async () => {
			if (this._records.has(record.room.id) || this._archives.has(record.room.id)) {
				throw new Error(localize('rooms.duplicateRoom', "The room identity already exists."));
			}
			return this.commit(record);
		});
	}

	async update(roomId: string, change: (record: IRoomRecord) => IRoomRecord): Promise<IRoomRecord> {
		await this.ready;
		return this._queue.queue(roomId, async () => {
			this.assertAvailable();
			const current = this.record(roomId);
			const next = change(current);
			return next === current ? current : this.commit(next);
		});
	}

	activity(binding: IRoomMemberBinding, event: IRoomRuntimeEvent): void {
		const record = this.record(binding.roomId);
		const member = roomMember(record, binding.memberId);
		if (roomExecution(record, member.id).turnId !== event.turnId || equals(this._activity.get(member.id), event)) {
			return;
		}
		this._activity.set(member.id, event);
		this._revisions.set(record.room.id, this.revision(record) + 1);
		this._onDidChange.fire(this.snapshot(record));
	}

	private snapshot(record: IRoomRecord): IAgentHostRoom {
		return {
			...record.room, revision: this.revision(record),
			...(this._failure ? { state: 'interrupted', error: this._failure } : {}),
			members: record.room.members.map(member => {
				const activity = this._activity.get(member.id);
				return activity && activity.turnId === roomExecution(record, member.id).turnId && ['starting', 'working', 'needsInput'].includes(member.state)
					? { ...member, state: activity.state === 'needsInput' ? 'needsInput' : 'working', activity: activity.activity }
					: member;
			}),
		};
	}

	private revision(record: IRoomRecord): number { return this._revisions.get(record.room.id) ?? record.room.revision; }

	private assertAvailable(): void {
		if (!this.available) {
			throw new Error(localize('rooms.persistenceFailed', "Room state is unavailable. Resolve the storage error and restart the host: {0}", this._failure ?? 'Host disposed'));
		}
	}

	private index(record: IRoomRecord): void {
		this._records.set(record.room.id, record);
		for (const member of record.room.members) {
			this._bindings.set(member.sessionUri, { roomId: record.room.id, memberId: member.id });
			if (!record.executions.some(execution => execution.memberId === member.id && execution.turnId === this._activity.get(member.id)?.turnId)) {
				this._activity.delete(member.id);
			}
		}
	}

	private async commit(record: IRoomRecord): Promise<IRoomRecord> {
		this.assertAvailable();
		const next: IRoomRecord = { ...record, room: { ...record.room, revision: this.revision(record) + 1, updatedAt: this.now() } };
		try {
			await this.storage.save(next);
		} catch (error) {
			this._failure = localize('rooms.saveFailed', "Collaboration stopped because its state could not be saved: {0}", String(error));
			this.log.error('[AgentHostRooms] Durable write failed', error);
			for (const current of this._records.values()) {
				this._revisions.set(current.room.id, this.revision(current) + 1);
				this._onDidChange.fire(this.snapshot(current));
			}
			this._onDidFail.fire();
			throw error;
		}
		this.index(next);
		this._revisions.set(next.room.id, next.room.revision);
		this._onDidChange.fire(this.snapshot(next));
		return next;
	}

	private async restore(): Promise<void> {
		try {
			const [records, archives] = await Promise.all([this.storage.load(), this.storage.loadArchives()]);
			for (const archive of archives) {
				this._archives.set(archive.room.id, archive);
				for (const session of archive.sessionUris) {
					this._archiveSessions.add(session);
				}
			}
			for (const stored of records) {
				if (stored.version !== 2 || this._archives.has(stored.room.id) || stored.room.members.some(member => this.isRoomSession(member.sessionUri))) {
					throw new Error(localize('rooms.invalidIdentity', "Room recovery found an invalid or duplicate executable identity."));
				}
				const uncertain = stored.executions.some(execution => execution.turnId) || ['running', 'stopping'].includes(stored.room.state);
				const record: IRoomRecord = {
					...stored,
					room: { ...stored.room, members: stored.room.members.map(member => ({ ...member, chatUri: member.chatUri ?? buildDefaultChatUri(member.sessionUri), activity: undefined })) },
				};
				this.index(record);
				if (!uncertain) {
					continue;
				}
				const error = localize('rooms.recoveryInterrupted', "The host stopped during this run. Inspect unfinished turns and interrupted reservations before resuming; no input was replayed.");
				await this.commit({
					...record,
					room: {
						...record.room, state: 'interrupted', error,
						members: record.room.members.map(member => roomExecution(record, member.id).turnId
							? { ...member, state: 'interrupted', error } : member),
					},
					messages: record.messages.map(message => ({
						...message,
						deliveries: message.deliveries.map(delivery => {
							const execution = roomExecution(record, delivery.memberId);
							if (!execution.turnId || execution.turnId !== delivery.turnId || delivery.state !== 'reserved') {
								return delivery;
							}
							const known = this.runtime.hasTurn(roomMember(record, delivery.memberId).sessionUri, execution.turnId);
							return { ...delivery, state: known ? 'submitted' : 'interrupted', error: known ? undefined : error };
						}),
					})),
					executions: record.executions.map(execution => ({ ...execution, turnId: undefined, runId: undefined })),
				});
			}
			this._ready = true;
		} catch (error) {
			this._failure = String(error);
			this.log.error('[AgentHostRooms] Room recovery failed', error);
			throw error;
		}
	}
}
