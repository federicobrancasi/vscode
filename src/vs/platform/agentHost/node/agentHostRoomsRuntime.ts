/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { hasKey } from '../../../base/common/types.js';
import { localize } from '../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomMember } from '../common/agentHostRooms.js';
import { IAgentService } from '../common/agentService.js';
import { ActionType } from '../common/state/sessionActions.js';
import { buildDefaultChatUri, MessageKind } from '../common/state/sessionState.js';
import { createAgentChatContext } from './agentChatContext.js';
import { IAgentHostProviderService } from './agentHostProviderService.js';
import { AgentHostStateManager } from './agentHostStateManager.js';
import { IAgentHostTurnService } from './agentHostTurnService.js';
import { IRoomRuntime, IRoomRuntimeEvent } from './agentHostRoomsTypes.js';

/** Session lifecycle remains owned by AgentService and is bound by composition. */
export interface IRoomSessionLifecycle {
	readonly createSession: IAgentService['createSession'];
	readonly listSessions: IAgentService['listSessions'];
	readonly subscribe: IAgentService['subscribe'];
	readonly unsubscribe: IAgentService['unsubscribe'];
	readonly abortTurn: (chat: URI, turnId?: string) => Promise<void>;
}

/** Keeps room workers on the ordinary AHP chat, approval, and turn-admission paths. */
export class AgentHostRoomsRuntime extends Disposable implements IRoomRuntime {
	private readonly _onDidChange = this._register(new Emitter<IRoomRuntimeEvent>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _sessionsByChat = new Map<string, string>();
	private readonly _subscriptions = new Set<string>();
	private readonly _clientId = 'local-room-authority';

	constructor(
		private readonly _lifecycle: IRoomSessionLifecycle,
		private readonly _stateManager: AgentHostStateManager,
		private readonly _turnService: IAgentHostTurnService,
		private readonly _providers: IAgentHostProviderService,
	) {
		super();
		this._register(_stateManager.onDidEmitEnvelope(envelope => {
			const sessionUri = this._sessionsByChat.get(envelope.channel);
			if (!sessionUri) {
				return;
			}
			const action = envelope.action;
			const turnId = hasKey(action, { turnId: true }) ? action.turnId : this._stateManager.getActiveTurnId(envelope.channel);
			if (envelope.rejectionReason) {
				if (action.type === ActionType.ChatTurnStarted) {
					this._onDidChange.fire({ sessionUri, turnId, state: 'failed', error: envelope.rejectionReason });
				}
				return;
			}
			switch (action.type) {
				case ActionType.ChatTurnStarted:
				case ActionType.ChatToolCallConfirmed:
				case ActionType.ChatToolCallComplete:
				case ActionType.ChatInputCompleted:
					this._onDidChange.fire({ sessionUri, turnId, state: 'working' });
					break;
				case ActionType.ChatToolCallStart:
					this._onDidChange.fire({ sessionUri, turnId, state: 'working', activity: action.displayName });
					break;
				case ActionType.ChatToolCallReady:
					this._onDidChange.fire({ sessionUri, turnId, state: action.confirmed ? 'working' : 'needsInput' });
					break;
				case ActionType.ChatInputRequested:
					this._onDidChange.fire({ sessionUri, turnId, state: 'needsInput' });
					break;
				case ActionType.ChatTurnComplete:
					this._onDidChange.fire({ sessionUri, turnId, state: 'idle' });
					break;
				case ActionType.ChatTurnCancelled:
					this._onDidChange.fire({ sessionUri, turnId, state: 'stopped' });
					break;
				case ActionType.ChatError:
					this._onDidChange.fire({ sessionUri, turnId, state: 'failed', error: action.part.error.message });
					break;
			}
		}));
	}

	async prepare(_room: IAgentHostRoom, member: IAgentHostRoomMember, initialized: boolean): Promise<void> {
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		const session = URI.parse(member.sessionUri);
		if (!initialized && !this._stateManager.getSessionState(member.sessionUri)) {
			const existing = (await this._lifecycle.listSessions()).some(candidate => candidate.session.toString() === member.sessionUri);
			if (!existing) {
				const created = await this._lifecycle.createSession({
					provider: 'copilotcli', session, workingDirectories: [URI.parse(member.worktreeUri!)],
					model: member.model ? { id: member.model } : undefined,
					config: { isolation: 'folder', mode: 'interactive', autoApprove: 'default' },
				});
				if (created.toString() !== member.sessionUri) {
					throw new Error(localize('rooms.changedSessionIdentity', "The provider did not preserve the room member session identity."));
				}
			}
		}
		for (const resource of [member.sessionUri, chat]) {
			if (!this._subscriptions.has(resource)) {
				await this._lifecycle.subscribe(URI.parse(resource), this._clientId);
				this._subscriptions.add(resource);
			}
		}
		if (this._store.isDisposed) {
			this._releaseSubscriptions();
			throw new Error(localize('rooms.runtimeShutdown', "The room runtime is shutting down."));
		}
		const state = this._stateManager.getSessionState(member.sessionUri);
		if (state?.defaultChat !== chat) {
			throw new Error(localize('rooms.changedDefaultChat', "The preserved room session does not contain its recorded default chat."));
		}
		if (state.workingDirectories?.length !== 1 || state.workingDirectories[0] !== member.worktreeUri) {
			throw new Error(localize('rooms.changedWorktree', "The preserved room session points to a different working directory. Restore its original worktree before retrying."));
		}
		this._sessionsByChat.set(chat, member.sessionUri);
	}

	isIdle(sessionUri: string): boolean {
		return !this._stateManager.getActiveTurnId(buildDefaultChatUri(sessionUri));
	}

	submit(sessionUri: string, turnId: string, prompt: string): void {
		const chat = buildDefaultChatUri(sessionUri);
		if (!this._sessionsByChat.has(chat) || !this.isIdle(sessionUri)) {
			throw new Error(localize('rooms.memberNotPrepared', "The room member is not prepared and idle."));
		}
		this._turnService.startTurnMessage(URI.parse(chat), { text: prompt, origin: { kind: MessageKind.User } }, turnId);
	}

	async steer(sessionUri: string, turnId: string, prompt: string): Promise<boolean> {
		const chat = buildDefaultChatUri(sessionUri);
		if (!this._sessionsByChat.has(chat) || this._stateManager.getActiveTurnId(chat) !== turnId) {
			return false;
		}
		const provider = this._providers.getProviderForSession(sessionUri);
		return await provider?.chats.sendSteeringInCurrentTurn?.(URI.parse(chat), turnId, prompt, createAgentChatContext(this._stateManager, sessionUri, chat)) ?? false;
	}

	async abort(sessionUri: string, turnId?: string): Promise<void> {
		const chat = buildDefaultChatUri(sessionUri);
		const active = this._stateManager.getChatState(chat)?.activeTurn;
		if (!active && !this._sessionsByChat.has(chat)) {
			return;
		}
		if (active && turnId && active.id !== turnId) {
			return;
		}
		await this._lifecycle.abortTurn(URI.parse(chat), turnId);
	}

	async assertContentAccess(sessionUri: string, paths: readonly string[]): Promise<void> {
		const chat = buildDefaultChatUri(sessionUri);
		const provider = this._providers.getProviderForSession(sessionUri);
		if (!provider?.chats.assertContentAccess) {
			throw new Error(localize('rooms.contentExclusionsUnavailable', "Content exclusion checks are unavailable; the room cannot share this artifact."));
		}
		await provider.chats.assertContentAccess(URI.parse(chat), paths, createAgentChatContext(this._stateManager, sessionUri, chat));
	}

	private _releaseSubscriptions(): void {
		for (const resource of this._subscriptions) {
			this._lifecycle.unsubscribe(URI.parse(resource), this._clientId);
		}
		this._subscriptions.clear();
		this._sessionsByChat.clear();
	}

	override dispose(): void {
		this._releaseSubscriptions();
		super.dispose();
	}
}
