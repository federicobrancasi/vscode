/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableSignalFromEvent, observableValue } from '../../../../base/common/observable.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomsService, MAX_ROOM_WORKERS } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ICollaborationWorkspaceTrust } from '../common/collaboration.js';

/** Extends consent for a source repository only to the local room authority's exact peer worktrees. */
export class CollaborationWorkspaceTrust extends Disposable {
	readonly state = observableValue<ICollaborationWorkspaceTrust>(this, { state: 'unavailable' });
	private pending: { readonly identity: string; readonly promise: Promise<void> } | undefined;
	private refreshGeneration = 0;
	private readonly identity: IObservable<string>;

	constructor(
		private readonly room: IObservable<IAgentHostRoom | undefined>,
		private readonly generation: IObservable<number>,
		private readonly getApi: () => IAgentHostRoomsService,
		private readonly management: IWorkspaceTrustManagementService,
		private readonly requestService: IWorkspaceTrustRequestService,
	) {
		super();
		this.identity = derived(this, reader => {
			const room = this.room.read(reader);
			return JSON.stringify([this.generation.read(reader), room?.id, room?.repositoryUri, room?.members.map(member => [member.id, member.sessionUri, member.worktreeUri])]);
		});
		const trustChanged = observableSignalFromEvent(this, management.onDidChangeTrustedFolders);
		this._register(autorun(reader => {
			const identity = this.identity.read(reader);
			trustChanged.read(reader);
			void this.refresh(identity);
		}));
	}

	private assertCurrent(identity: string): void {
		if (this._store.isDisposed || this.identity.get() !== identity || !this.room.get()) {
			throw new CancellationError();
		}
	}

	private directories(room: IAgentHostRoom): { repository: URI; worktrees: URI[] } {
		const localDirectory = (value: string): URI => {
			const uri = URI.parse(value, true);
			if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || uri.path.length <= 1) {
				throw new Error(localize('room.trustLocalOnly', "Room trust requires exact local repository and peer worktree directories from the local host."));
			}
			return uri;
		};
		const repository = localDirectory(room.repositoryUri);
		if (room.members.length > MAX_ROOM_WORKERS) {
			throw new Error(localize('room.trustTooManyPeers', "The local room contains too many peers."));
		}
		const worktrees = room.members.map(member => {
			if (!member.worktreeUri) {
				throw new Error(localize('room.trustMissingWorktree', "The local host has not supplied {0}'s worktree. Reload the room before authorizing work.", member.name));
			}
			const worktree = localDirectory(member.worktreeUri);
			if (extUriBiasedIgnorePathCase.isEqualOrParent(repository, worktree)) {
				throw new Error(localize('room.trustInvalidWorktree', "A peer worktree cannot be the source repository or one of its parent directories."));
			}
			return worktree;
		});
		return { repository, worktrees };
	}

	private async refresh(identity: string): Promise<void> {
		const refresh = ++this.refreshGeneration;
		const room = this.room.get();
		if (!room) {
			this.state.set({ state: 'unavailable' }, undefined);
			return;
		}
		if (this.pending?.identity === identity) {
			return;
		}
		this.state.set({ state: 'checking', repositoryUri: room.repositoryUri }, undefined);
		try {
			const { repository, worktrees } = this.directories(room);
			const infos = await Promise.all([repository, ...worktrees].map(uri => this.management.getUriTrustInfo(uri)));
			this.assertCurrent(identity);
			if (refresh === this.refreshGeneration && this.pending?.identity !== identity) {
				this.state.set({
					state: infos.every(info => info.trusted) ? 'trusted' : 'untrusted',
					repositoryUri: repository.toString(), worktreeUris: worktrees.map(uri => uri.toString()),
				}, undefined);
			}
		} catch (error) {
			if (!this._store.isDisposed && identity === this.identity.get() && refresh === this.refreshGeneration) {
				this.state.set({ state: 'unavailable', repositoryUri: room.repositoryUri, error: toErrorMessage(error) }, undefined);
			}
		}
	}

	ensureTrusted(): Promise<void> {
		const identity = this.identity.get();
		if (this.pending) {
			return this.pending.identity === identity ? this.pending.promise : Promise.reject(new Error(localize('room.trustPending', "Finish the pending workspace trust decision before authorizing a different room.")));
		}
		const promise = this.authorize(identity);
		this.pending = { identity, promise };
		void promise.finally(() => {
			if (this.pending?.promise === promise) {
				this.pending = undefined;
			}
		}).catch(() => { });
		return promise;
	}

	private async authorize(identity: string): Promise<void> {
		this.assertCurrent(identity);
		const selected = this.room.get()!;
		this.state.set({ ...this.state.get(), state: 'requesting', error: undefined }, undefined);
		try {
			// Only this local, validated API may supply directories that inherit source trust.
			const room = await this.getApi().getRoom(selected.id);
			this.assertCurrent(identity);
			if (room.id !== selected.id || room.repositoryUri !== selected.repositoryUri
				|| JSON.stringify(room.members.map(member => [member.id, member.sessionUri, member.worktreeUri])) !== JSON.stringify(selected.members.map(member => [member.id, member.sessionUri, member.worktreeUri]))) {
				throw new Error(localize('room.trustIdentityChanged', "The room's workspace identity changed. Reload the room before authorizing work."));
			}
			const { repository, worktrees } = this.directories(room);
			let sourceTrust = await this.management.getUriTrustInfo(repository);
			this.assertCurrent(identity);
			if (!sourceTrust.trusted) {
				const granted = await this.requestService.requestResourcesTrust({
					uri: repository,
					message: localize('room.trustConsent', "Trust this room's source repository to run its Copilot peers? Every peer uses a separate local worktree. Trust will apply only to this repository and the exact peer directories below, not their shared parent folder.\n\nSource: {0}\n\nPeer worktrees:\n{1}", repository.fsPath, worktrees.map(uri => uri.fsPath).join('\n')),
				});
				this.assertCurrent(identity);
				if (granted !== true) {
					throw new Error(localize('room.trustRequired', "Workspace trust was not granted. No peers were started or allowed. You can still discuss work in the room."));
				}
				sourceTrust = await this.management.getUriTrustInfo(repository);
				this.assertCurrent(identity);
				if (!sourceTrust.trusted) {
					throw new Error(localize('room.trustNotSaved', "Workspace trust could not be confirmed. No peers were started or allowed."));
				}
			}
			const infos = await Promise.all(worktrees.map(uri => this.management.getUriTrustInfo(uri)));
			this.assertCurrent(identity);
			const untrusted = worktrees.filter((_uri, index) => !infos[index].trusted);
			if (untrusted.length) {
				await this.management.setUrisTrust(untrusted, true);
				this.assertCurrent(identity);
			}
			const confirmed = await Promise.all([repository, ...worktrees].map(uri => this.management.getUriTrustInfo(uri)));
			this.assertCurrent(identity);
			if (!confirmed.every(info => info.trusted)) {
				throw new Error(localize('room.trustNotSaved', "Workspace trust could not be confirmed. No peers were started or allowed."));
			}
			this.state.set({ state: 'trusted', repositoryUri: repository.toString(), worktreeUris: worktrees.map(uri => uri.toString()) }, undefined);
		} catch (error) {
			if (!this._store.isDisposed && identity === this.identity.get()) {
				this.state.set({ ...this.state.get(), state: 'untrusted', error: toErrorMessage(error) }, undefined);
			}
			throw error;
		}
	}
}
