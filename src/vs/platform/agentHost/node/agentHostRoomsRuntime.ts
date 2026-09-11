/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { URI } from '../../../base/common/uri.js';
import { hasKey } from '../../../base/common/types.js';
import { localize } from '../../../nls.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomMember } from '../common/agentHostRooms.js';
import { AgentHostAutoApprovePolicyRestrictedConfigKey, platformRootSchema, platformSessionSchema } from '../common/agentHostSchema.js';
import { IAgentService } from '../common/agentService.js';
import { SessionConfigKey } from '../common/sessionConfigKeys.js';
import { ResolveSessionConfigResult, SessionConfigPropertySchema } from '../common/state/protocol/commands.js';
import { ActionType } from '../common/state/sessionActions.js';
import { buildDefaultChatUri, MessageKind, ModelSelection } from '../common/state/sessionState.js';
import { createAgentChatContext } from './agentChatContext.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { IAgentHostProviderService } from './agentHostProviderService.js';
import { AgentHostStateManager } from './agentHostStateManager.js';
import { IAgentHostTurnService } from './agentHostTurnService.js';
import { IRoomRuntime, IRoomRuntimeEvent } from './agentHostRoomsTypes.js';
import { roomConfigurationKeys, validateRoomConfigurationChange } from './agentHostRoomsConfiguration.js';
import { getRoomMemberModel, validateRoomModelSelection } from './agentHostRoomsModels.js';

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
	private readonly _appliedModels = new Map<string, ModelSelection>();
	private readonly _clientId = 'local-room-authority';

	constructor(
		private readonly _lifecycle: IRoomSessionLifecycle,
		private readonly _stateManager: AgentHostStateManager,
		private readonly _turnService: IAgentHostTurnService,
		private readonly _providers: IAgentHostProviderService,
		private readonly _configurationService: IAgentConfigurationService,
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

	validateModel(model: ModelSelection): void {
		const provider = this._providers.resolveProvider('copilotcli');
		validateRoomModelSelection(model, provider?.models.get() ?? []);
	}

	getModel(member: IAgentHostRoomMember): ModelSelection | undefined {
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		if (!this._stateManager.getChatState(chat)) {
			return undefined;
		}
		return this._providers.getProviderForSession(member.sessionUri)?.chats.getModel?.(
			URI.parse(chat), createAgentChatContext(this._stateManager, member.sessionUri, chat),
		);
	}

	publishModel(member: IAgentHostRoomMember): void {
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		const state = this._stateManager.getChatState(chat);
		const model = getRoomMemberModel(member);
		if (state && !equals(state.draft?.model, model)) {
			this._stateManager.dispatchServerAction(chat, {
				type: ActionType.ChatDraftChanged,
				draft: { text: '', origin: { kind: MessageKind.User }, ...state.draft, model },
			});
		}
	}

	async applyModel(member: IAgentHostRoomMember, model: ModelSelection): Promise<void> {
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		await this._subscribeMember(member);
		this._assertMemberSession(member);
		if (!this.isIdle(member.sessionUri)) {
			throw new Error(localize('rooms.modelWhileBusy', "The room member's model can only be applied between turns."));
		}
		this.validateModel(model);
		const provider = this._providers.getProviderForSession(member.sessionUri);
		if (!provider) {
			throw new Error(localize('rooms.modelProviderUnavailable', "The room provider is not available to change models."));
		}
		if (equals(this._appliedModels.get(chat), model) && equals(this.getModel(member), model)) {
			return;
		}
		await provider.chats.changeModel(URI.parse(chat), model, createAgentChatContext(this._stateManager, member.sessionUri, chat));
		const applied = this.getModel(member);
		if (applied && !equals(applied, model)) {
			throw new Error(localize('rooms.modelNotApplied', "The provider did not apply the requested model '{0}'.", model.id));
		}
		this._appliedModels.set(chat, model);
	}

	async resolveConfiguration(member: IAgentHostRoomMember, configuration?: IAgentHostRoomConfiguration): Promise<ResolveSessionConfigResult> {
		const provider = this._providers.getProviderForSession(member.sessionUri) ?? this._providers.resolveProvider('copilotcli');
		if (!provider) {
			throw new Error(localize('rooms.configurationUnavailable', "The room provider is not available to resolve configuration."));
		}
		const selected = { ...defaultAgentHostRoomConfiguration, ...member.configuration };
		if (!configuration) {
			const current = this._configurationService.getSessionConfigValues(member.sessionUri);
			for (const key of roomConfigurationKeys) {
				const value = current?.[key];
				if (platformSessionSchema.validate(key, value)) {
					Object.assign(selected, { [key]: value });
				}
			}
		}
		const result = await provider.resolveChatConfig({
			provider: 'copilotcli', workingDirectory: URI.parse(member.worktreeUri!),
			config: { ...(configuration ?? selected) },
		});
		const properties: Record<string, SessionConfigPropertySchema> = {};
		const values: Record<string, unknown> = {};
		const policy = this._configurationService.getSessionSandboxPolicy(member.sessionUri);
		for (const key of roomConfigurationKeys) {
			const property = result.schema.properties[key];
			if (!property) {
				continue;
			}
			const restricted = key === SessionConfigKey.AutoApprove
				&& this._configurationService.getRootValue(platformRootSchema, AgentHostAutoApprovePolicyRestrictedConfigKey) === true;
			const sandboxRequired = key === SessionConfigKey.SandboxEnabled && policy?.enabled && !policy.allowBypass;
			const indices = property.enum?.map((_, index) => index).filter(index =>
				(!restricted || property.enum![index] === 'default') && (!sandboxRequired || property.enum![index] !== 'off'));
			properties[key] = indices ? {
				...property,
				enum: indices.map(index => property.enum![index]),
				...(property.enumLabels ? { enumLabels: indices.map(index => property.enumLabels![index]) } : {}),
				...(property.enumDescriptions ? { enumDescriptions: indices.map(index => property.enumDescriptions![index]) } : {}),
			} : property;
			const value = result.values[key] ?? (configuration ?? selected)[key];
			values[key] = restricted || (sandboxRequired && value === 'off') ? 'default' : value;
		}
		return { schema: { type: 'object', properties }, values };
	}

	async applyConfiguration(member: IAgentHostRoomMember, requested?: Partial<IAgentHostRoomConfiguration>): Promise<void> {
		let state = this._stateManager.getSessionState(member.sessionUri);
		if (!state) {
			if (!(await this._lifecycle.listSessions()).some(session => session.session.toString() === member.sessionUri)) {
				return;
			}
			await this._subscribeMember(member);
			state = this._stateManager.getSessionState(member.sessionUri);
		}
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		if (state?.defaultChat !== chat || state.workingDirectories?.length !== 1 || state.workingDirectories[0] !== member.worktreeUri) {
			throw new Error(localize('rooms.configurationIdentityChanged', "The room member's preserved chat or working directory has changed."));
		}
		const provider = this._providers.getProviderForSession(member.sessionUri);
		if (!provider?.chats.applyConfiguration) {
			throw new Error(localize('rooms.configurationApplicationUnavailable', "The room provider cannot apply configuration to this session."));
		}
		const resolved = await this.resolveConfiguration(member, member.configuration ?? defaultAgentHostRoomConfiguration);
		if (requested) {
			validateRoomConfigurationChange(requested, resolved);
		}
		const previous: Record<string, unknown> = {};
		for (const key of roomConfigurationKeys) {
			previous[key] = state.config?.values[key] ?? defaultAgentHostRoomConfiguration[key];
		}
		this._configurationService.updateSessionConfig(member.sessionUri, resolved.values);
		try {
			await provider.chats.applyConfiguration(URI.parse(chat), createAgentChatContext(this._stateManager, member.sessionUri, chat));
			if (requested) {
				validateRoomConfigurationChange(requested, await this.resolveConfiguration(member));
			}
		} catch (error) {
			this._configurationService.updateSessionConfig(member.sessionUri, previous);
			try {
				await provider.chats.applyConfiguration(URI.parse(chat), createAgentChatContext(this._stateManager, member.sessionUri, chat));
			} finally {
				await this.abort(member.sessionUri);
			}
			throw error;
		}
	}

	async prepare(_room: IAgentHostRoom, member: IAgentHostRoomMember, initialized: boolean): Promise<void> {
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		const session = URI.parse(member.sessionUri);
		if (!initialized && !this._stateManager.getSessionState(member.sessionUri)) {
			const existing = (await this._lifecycle.listSessions()).some(candidate => candidate.session.toString() === member.sessionUri);
			if (!existing) {
				const configuration = await this.resolveConfiguration(member, member.configuration ?? defaultAgentHostRoomConfiguration);
				const created = await this._lifecycle.createSession({
					provider: 'copilotcli', session, workingDirectories: [URI.parse(member.worktreeUri!)],
					model: getRoomMemberModel(member),
					config: { isolation: 'folder', ...configuration.values },
				});
				if (created.toString() !== member.sessionUri) {
					throw new Error(localize('rooms.changedSessionIdentity', "The provider did not preserve the room member session identity."));
				}
			}
		}
		await this._subscribeMember(member);
		this._assertMemberSession(member);
		this._sessionsByChat.set(chat, member.sessionUri);
	}

	private _assertMemberSession(member: IAgentHostRoomMember): void {
		const chat = member.chatUri ?? buildDefaultChatUri(member.sessionUri);
		const state = this._stateManager.getSessionState(member.sessionUri);
		if (state?.defaultChat !== chat) {
			throw new Error(localize('rooms.changedDefaultChat', "The preserved room session does not contain its recorded default chat."));
		}
		if (state.workingDirectories?.length !== 1 || state.workingDirectories[0] !== member.worktreeUri) {
			throw new Error(localize('rooms.changedWorktree', "The preserved room session points to a different working directory. Restore its original worktree before retrying."));
		}
	}

	private async _subscribeMember(member: IAgentHostRoomMember): Promise<void> {
		for (const resource of [member.sessionUri, member.chatUri ?? buildDefaultChatUri(member.sessionUri)]) {
			if (!this._subscriptions.has(resource)) {
				await this._lifecycle.subscribe(URI.parse(resource), this._clientId);
				this._subscriptions.add(resource);
			}
		}
		if (this._store.isDisposed) {
			this._releaseSubscriptions();
			throw new Error(localize('rooms.runtimeShutdown', "The room runtime is shutting down."));
		}
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
		this._appliedModels.clear();
	}

	override dispose(): void {
		this._releaseSubscriptions();
		super.dispose();
	}
}
