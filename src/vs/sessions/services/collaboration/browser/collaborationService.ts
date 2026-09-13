/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue, transaction } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AgentHostRoomMessageMode, IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessagePage, IAgentHostRoomsService } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { ResolveSessionConfigResult } from '../../../../platform/agentHost/common/state/protocol/commands.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ModelSelection, PolicyState, SessionModelInfo } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { resolveSessionForResource } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { CollaborationAvailability, CollaborationEnabledSettingId, CollaborationRequestResponse, ICollaborationRequest, ICollaborationService, ICollaborationWorkspaceTrust } from '../common/collaboration.js';
import { CollaborationDraft, getCollaborationMentionTargets } from '../common/collaborationMentions.js';
import { CollaborationRoomRequests } from './collaborationRoomRequests.js';
import { ICollaborationRoomViewService } from './collaborationRoomView.js';
import { CollaborationWorkspaceTrust } from './collaborationWorkspaceTrust.js';
import { CollaborationHistory } from './collaborationHistory.js';

const EMPTY_MESSAGES: IAgentHostRoomMessagePage = { messages: [], hasEarlier: false, hasLater: false };

export class CollaborationService extends Disposable implements ICollaborationService {
	declare readonly _serviceBrand: undefined;

	readonly availability = observableValue<CollaborationAvailability>(this, 'disabled');
	readonly supported = observableValue(this, false);
	readonly availabilityError = observableValue<string | undefined>(this, undefined);
	readonly rooms = observableValue<readonly IAgentHostRoom[]>(this, []);
	readonly activeRoomId = observableValue<string | undefined>(this, undefined);
	readonly activeRoom = derived(reader => this.rooms.read(reader).find(room => room.id === this.activeRoomId.read(reader)));
	readonly messages = observableValue<IAgentHostRoomMessagePage>(this, EMPTY_MESSAGES);
	readonly models = observableValue<readonly SessionModelInfo[]>(this, []);
	readonly loading = observableValue(this, false);
	readonly loadingEarlier = observableValue(this, false);
	readonly creating = observableValue(this, false);
	readonly canSteer = observableValue(this, false);
	readonly canConfigure = observableValue(this, false);
	readonly canSetMemberModel = observableValue(this, false);
	readonly error = observableValue<string | undefined>(this, undefined);
	readonly workspaceTrust: IObservable<ICollaborationWorkspaceTrust>;
	readonly requests: IObservable<readonly ICollaborationRequest[]>;
	readonly requestError: IObservable<string | undefined>;
	private readonly sendingRooms = observableValue<ReadonlySet<string>>(this, new Set());
	readonly sending = derived(reader => this.sendingRooms.read(reader).has(this.activeRoomId.read(reader) ?? ''));

	private readonly connection = this._register(new MutableDisposable<DisposableStore>());
	private readonly historyStore = this._register(new DisposableStore());
	private history: CollaborationHistory | undefined;
	private readonly drafts = new Map<string, CollaborationDraft>();
	private readonly authorizationGeneration = observableValue(this, 0);
	private readonly trust: CollaborationWorkspaceTrust;
	private readonly roomRequests: CollaborationRoomRequests;
	private hostGeneration = 0;
	private selectionGeneration = 0;
	private authenticationGeneration = 0;
	private refreshPending = false;
	private refreshingMessages = false;

	constructor(
		@IAgentHostService private readonly host: IAgentHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceTrustManagementService workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceTrustRequestService workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@ICollaborationRoomViewService roomViewService: ICollaborationRoomViewService,
	) {
		super();
		const liveRoom = derived(this, reader => this.availability.read(reader) === 'available'
			&& roomViewService.visible.read(reader) && roomViewService.activeView.read(reader)
			? this.activeRoom.read(reader) : undefined);
		this.trust = this._register(new CollaborationWorkspaceTrust(liveRoom, this.authorizationGeneration, () => this.api, workspaceTrustManagementService, workspaceTrustRequestService));
		this.roomRequests = this._register(new CollaborationRoomRequests(host, liveRoom, this.authorizationGeneration, () => this.ensureExecutionAuthorized()));
		this.workspaceTrust = this.trust.state;
		this.requests = this.roomRequests.requests;
		this.requestError = this.roomRequests.error;
		this._register(autorun(reader => {
			roomViewService.visible.read(reader);
			roomViewService.activeView.read(reader);
			this.authorizationGeneration.set(this.authorizationGeneration.read(undefined) + 1, undefined);
		}));
		this._register(authenticationService.onDidChangeSessions(() => {
			this.authenticationGeneration++;
			this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, undefined);
		}));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CollaborationEnabledSettingId) || e.affectsConfiguration('chat.disableAIFeatures')) {
				this.updateConnection();
			}
		}));
		this._register(host.onAgentHostStart(() => this.updateConnection()));
		this._register(host.onAgentHostExit(() => {
			this.hostGeneration++;
			this.selectionGeneration++;
			this.historyStore.clear();
			this.history = undefined;
			this.connection.clear();
			this.loading.set(false, undefined);
			transaction(tx => {
				this.availability.set(this.enabled ? 'unavailable' : 'disabled', tx);
				this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, tx);
				this.availabilityError.set(localize('room.hostExited', "The local agent host disconnected. Reconnect to see authoritative worker status; no work is resumed automatically."), tx);
				this.models.set([], tx);
				this.canSteer.set(false, tx);
				this.canConfigure.set(false, tx);
				this.canSetMemberModel.set(false, tx);
				this.loading.set(false, tx);
				this.loadingEarlier.set(false, tx);
			});
		}));
		this.updateConnection();
	}

	private get enabled(): boolean {
		return !isWeb && this.configurationService.getValue<boolean>(CollaborationEnabledSettingId) === true
			&& this.configurationService.getValue<boolean>('chat.disableAIFeatures') !== true;
	}

	private updateConnection(): void {
		this.hostGeneration++;
		this.selectionGeneration++;
		this.historyStore.clear();
		this.history = undefined;
		this.connection.clear();
		transaction(tx => {
			this.availability.set('connecting', tx);
			this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, tx);
		});
		this.canSteer.set(false, undefined);
		this.canConfigure.set(false, undefined);
		this.canSetMemberModel.set(false, undefined);
		this.loadingEarlier.set(false, undefined);
		if (!this.enabled || !this.host.rooms) {
			transaction(tx => {
				this.supported.set(false, tx);
				this.availability.set(this.enabled ? 'unavailable' : 'disabled', tx);
				this.availabilityError.set(undefined, tx);
				this.models.set([], tx);
				this.loading.set(false, tx);
			});
			return;
		}
		const store = this.connection.value = new DisposableStore();
		store.add(this.host.rooms.onDidChangeRoom(room => {
			this.acceptRoom(room);
			if (room.id === this.activeRoomId.get()) {
				this.queueMessageRefresh();
			}
		}));
		const updateModels = () => {
			const root = this.host.rootState.value;
			this.models.set(root && !(root instanceof Error)
				? root.agents.find(agent => agent.provider === 'copilotcli')?.models.filter(model => model.policyState !== PolicyState.Disabled) ?? []
				: [], undefined);
		};
		store.add(this.host.rootState.onDidChange(updateModels));
		updateModels();
		void this.refresh().catch(error => {
			if (!store.isDisposed && this.availability.get() !== 'available') {
				this.availabilityError.set(toErrorMessage(error), undefined);
			}
		});
	}

	isRepository(folderUri: string): Promise<boolean> {
		return this.api.isRepository(folderUri);
	}

	async refresh(): Promise<void> {
		if (!this.enabled || !this.host.rooms) {
			return;
		}
		const generation = this.hostGeneration;
		this.availability.set('connecting', undefined);
		this.availabilityError.set(undefined, undefined);
		try {
			const capabilities = await this.host.rooms.getCapabilities();
			if (generation !== this.hostGeneration || this._store.isDisposed) {
				return;
			}
			this.supported.set(capabilities.available, undefined);
			if (!capabilities.available) {
				this.availability.set('unavailable', undefined);
				return;
			}
			const rooms = await this.host.rooms.listRooms();
			if (generation !== this.hostGeneration || this._store.isDisposed) {
				return;
			}
			transaction(tx => {
				// Events can overtake the initial catalogue response.
				const current = new Map(this.rooms.get().map(room => [room.id, room]));
				for (const room of rooms) {
					if ((current.get(room.id)?.revision ?? -1) <= room.revision) {
						current.set(room.id, room);
					}
				}
				this.rooms.set([...current.values()], tx);
				this.availability.set('available', tx);
				this.canSteer.set(capabilities.supportsSteering === true, tx);
				this.canConfigure.set(capabilities.supportsConfiguration === true, tx);
				this.canSetMemberModel.set(capabilities.supportsMemberModels === true, tx);
			});
		} catch (error) {
			if (generation === this.hostGeneration && !this._store.isDisposed) {
				transaction(tx => {
					this.availability.set('error', tx);
					this.availabilityError.set(toErrorMessage(error), tx);
				});
			}
			throw error;
		}
		if (generation === this.hostGeneration && !this._store.isDisposed && this.activeRoomId.get()) {
			await this.selectRoom(this.activeRoomId.get());
		}
	}

	private get api(): IAgentHostRoomsService {
		if (!this.enabled || this.availability.get() !== 'available' || !this.host.rooms) {
			throw new Error(localize('room.unavailable', "Collaboration requires an available local Copilot agent host."));
		}
		return this.host.rooms;
	}

	private get roomId(): string {
		const id = this.activeRoomId.get();
		if (!id) {
			throw new Error(localize('room.noSelection', "Select a collaboration room first."));
		}
		return id;
	}

	private acceptRoom(room: IAgentHostRoom): void {
		const rooms = this.rooms.get();
		const index = rooms.findIndex(candidate => candidate.id === room.id);
		const previous = rooms[index];
		if (previous && previous.revision >= room.revision) {
			return;
		}
		const updated = [...rooms];
		if (index < 0) {
			updated.push(room);
		} else {
			updated[index] = room;
		}
		this.rooms.set(updated, undefined);
	}

	async selectRoom(roomId: string | undefined): Promise<void> {
		const selection = ++this.selectionGeneration;
		this.historyStore.clear();
		this.history = undefined;
		transaction(tx => {
			this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, tx);
			this.activeRoomId.set(roomId, tx);
			this.messages.set(EMPTY_MESSAGES, tx);
			this.error.set(undefined, tx);
			this.loading.set(roomId !== undefined, tx);
			this.loadingEarlier.set(false, tx);
		});
		if (!roomId) {
			return;
		}
		try {
			const room = await this.api.getRoom(roomId);
			if (selection !== this.selectionGeneration || this._store.isDisposed) {
				return;
			}
			this.acceptRoom(room);
			const api = this.api;
			const history = this.history = this.historyStore.add(new CollaborationHistory(query => api.getMessages(roomId, query)));
			this.historyStore.add(autorun(reader => {
				const page = history.page.read(reader);
				const loading = history.loading.read(reader);
				const loadingEarlier = history.loadingEarlier.read(reader);
				const error = history.error.read(reader);
				transaction(tx => {
					this.messages.set(page, tx);
					this.loading.set(loading, tx);
					this.loadingEarlier.set(loadingEarlier, tx);
					this.error.set(error, tx);
				});
			}));
			await history.loadLatest();
		} catch (error) {
			if (selection === this.selectionGeneration && !this._store.isDisposed) {
				this.error.set(toErrorMessage(error), undefined);
			}
			throw error;
		} finally {
			if (selection === this.selectionGeneration && !this._store.isDisposed) {
				this.loading.set(false, undefined);
			}
		}
	}

	async createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom> {
		if (this.creating.get()) {
			throw new Error(localize('room.alreadyCreating', "A collaboration room is already being created."));
		}
		if (options.memberModels?.some(model => model !== undefined) && !this.canSetMemberModel.get()) {
			throw new Error(localize('room.memberModelsUnavailable', "The local agent host does not support per-peer model selection. Reconnect or update the host."));
		}
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		this.creating.set(true, undefined);
		try {
			const room = await this.api.createRoom(options);
			if (host === this.hostGeneration && !this._store.isDisposed) {
				this.acceptRoom(room);
				if (selection === this.selectionGeneration) {
					await this.selectRoom(room.id);
				}
			}
			return room;
		} finally {
			if (!this._store.isDisposed) {
				this.creating.set(false, undefined);
			}
		}
	}

	async loadMessages(): Promise<void> {
		if (!this.history) {
			await this.selectRoom(this.roomId);
			return;
		}
		await this.history.refresh();
	}

	async loadEarlierMessages(): Promise<void> {
		if (!this.history) {
			throw new Error(localize('room.historyNotReady', "Room history is not ready. Wait for loading to finish or reconnect."));
		}
		await this.history.loadEarlier();
	}

	private queueMessageRefresh(): void {
		this.refreshPending = true;
		if (this.refreshingMessages || this.availability.get() !== 'available') {
			return;
		}
		this.refreshingMessages = true;
		const refresh = async () => {
			const selection = this.selectionGeneration;
			try {
				while (this.refreshPending && this.history && this.activeRoomId.get() && !this._store.isDisposed) {
					this.refreshPending = false;
					await this.history.refresh();
				}
			} catch (error) {
				if (selection === this.selectionGeneration && !this._store.isDisposed) {
					this.error.set(toErrorMessage(error), undefined);
				}
			} finally {
				this.refreshingMessages = false;
				if (this.refreshPending && this.history && this.activeRoomId.get() && this.availability.get() === 'available' && !this._store.isDisposed) {
					this.queueMessageRefresh();
				}
			}
		};
		void refresh();
	}

	async getConfiguration(): Promise<ResolveSessionConfigResult> {
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		const result = await this.api.getRoomConfiguration(this.roomId);
		if (selection !== this.selectionGeneration || host !== this.hostGeneration || this._store.isDisposed) {
			throw new CancellationError();
		}
		return result;
	}

	async setConfiguration(configuration: Partial<IAgentHostRoomConfiguration>): Promise<void> {
		if (!this.canConfigure.get()) {
			throw new Error(localize('room.configurationUnavailable', "The local agent host does not support room configuration."));
		}
		await this.mutate((api, roomId) => api.setRoomConfiguration(roomId, configuration),
			(configuration.autoApprove !== undefined && configuration.autoApprove !== 'default') || configuration.sandboxEnabled === 'off');
	}

	async setMemberModel(memberId: string, model: ModelSelection | undefined): Promise<void> {
		if (!this.canSetMemberModel.get()) {
			throw new Error(localize('room.memberModelsUnavailable', "The local agent host does not support per-peer model selection. Reconnect or update the host."));
		}
		await this.mutate((api, roomId) => api.setMemberModel(roomId, memberId, model));
	}

	getDraft(roomId: string): CollaborationDraft {
		let draft = this.drafts.get(roomId);
		if (!draft) {
			draft = new CollaborationDraft();
			this.drafts.set(roomId, draft);
		}
		return draft;
	}

	async sendMessage(mode: AgentHostRoomMessageMode = 'message'): Promise<void> {
		const roomId = this.roomId;
		if (!this.history) {
			await this.loadMessages();
			if (roomId !== this.activeRoomId.get() || this._store.isDisposed) {
				throw new CancellationError();
			}
		}
		if (mode === 'steer' && !this.canSteer.get()) {
			throw new Error(localize('room.steeringUnavailable', "This host does not support live room steering. Update or reconnect the local agent host."));
		}
		if (this.sendingRooms.get().has(roomId)) {
			return;
		}
		const draft = this.getDraft(roomId);
		const pending = draft.beginSend(generateUuid(), mode);
		if (!pending.text.trim()) {
			return;
		}
		const members = this.activeRoom.get()?.members ?? [];
		const mentions = getCollaborationMentionTargets(pending.text, members);
		// Explicit recipients also wake finished peers when connected to an older room host.
		const recipients = mode === 'message' && !mentions.length ? members.map(member => member.id) : mentions;
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		const authentication = this.authenticationGeneration;
		const api = this.api;
		this.sendingRooms.set(new Set([...this.sendingRooms.get(), roomId]), undefined);
		try {
			await this.ensureExecutionAuthorized();
			if (selection !== this.selectionGeneration || host !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
				throw new CancellationError();
			}
			const message = await api.postMessage(roomId, {
				id: pending.messageId, text: pending.text,
				mentions: recipients,
				replyTo: pending.replyTo,
				...(mode === 'steer' ? { mode } : {}),
			});
			draft.acknowledge(pending.revision);
			if (selection === this.selectionGeneration && host === this.hostGeneration && !this._store.isDisposed) {
				this.history?.acceptMessage(message);
				this.queueMessageRefresh();
			}
		} finally {
			if (!this._store.isDisposed) {
				this.sendingRooms.set(new Set([...this.sendingRooms.get()].filter(id => id !== roomId)), undefined);
			}
		}
	}

	async retryMessage(messageId: string): Promise<void> {
		const roomId = this.roomId;
		const message = this.messages.get().messages.find(message => message.id === messageId);
		if (!message || message.authorKind !== 'human' || !message.deliveries.some(delivery => ['pending', 'cancelled', 'failed'].includes(delivery.state))) {
			throw new Error(localize('room.noPendingMessage', "Choose one of your messages with a pending, cancelled, or failed delivery."));
		}
		const api = this.api;
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		const authentication = this.authenticationGeneration;
		await this.ensureExecutionAuthorized();
		if (selection !== this.selectionGeneration || host !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
			throw new CancellationError();
		}
		await api.retryMessage(roomId, message.id);
		if (selection === this.selectionGeneration && host === this.hostGeneration && !this._store.isDisposed) {
			this.queueMessageRefresh();
		}
	}

	async startRoom(limits: IAgentHostRoomLimits): Promise<void> {
		await this.mutate((api, roomId) => api.startRoom(roomId, limits), true);
	}

	async pauseRoom(): Promise<void> {
		await this.mutate((api, roomId) => api.pauseRoom(roomId));
	}

	async stopRoom(): Promise<void> {
		await this.mutate((api, roomId) => api.stopRoom(roomId));
	}

	async stopMember(memberId: string): Promise<void> {
		await this.mutate((api, roomId) => api.stopMember(roomId, memberId));
	}

	async retryMember(memberId: string): Promise<void> {
		await this.mutate((api, roomId) => api.retryMember(roomId, memberId), true);
	}

	private async mutate(operation: (api: IAgentHostRoomsService, roomId: string) => Promise<IAgentHostRoom>, requiresAuthentication = false): Promise<void> {
		const generation = this.hostGeneration;
		const selection = this.selectionGeneration;
		const authentication = this.authenticationGeneration;
		const api = this.api;
		const roomId = this.roomId;
		if (requiresAuthentication) {
			await this.ensureExecutionAuthorized();
			if (generation !== this.hostGeneration || selection !== this.selectionGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
				throw new CancellationError();
			}
		}
		const room = await operation(api, roomId);
		if (generation === this.hostGeneration && !this._store.isDisposed) {
			this.acceptRoom(room);
		}
	}

	requestWorkspaceTrust(): Promise<void> {
		return this.trust.ensureTrusted();
	}

	respondToRequest(request: ICollaborationRequest, response: CollaborationRequestResponse): Promise<void> {
		return this.roomRequests.respond(request, response);
	}

	reloadRequestContent(request: ICollaborationRequest): Promise<void> {
		return this.roomRequests.reloadContent(request);
	}

	private async ensureExecutionAuthorized(): Promise<void> {
		const generation = this.authorizationGeneration.get();
		const roomId = this.roomId;
		await this.ensureAuthenticated();
		if (generation !== this.authorizationGeneration.get() || roomId !== this.activeRoomId.get() || this._store.isDisposed) {
			throw new CancellationError();
		}
		await this.requestWorkspaceTrust();
		if (generation !== this.authorizationGeneration.get() || roomId !== this.activeRoomId.get() || this._store.isDisposed) {
			throw new CancellationError();
		}
	}

	private async ensureAuthenticated(): Promise<void> {
		if (this.host.authenticationPending.get()) {
			throw new Error(localize('room.authenticationPending', "The local agent host is signing in. Wait for sign-in to finish before starting or retrying peers."));
		}
		const root = this.host.rootState.value;
		const resources = root && !(root instanceof Error)
			? root.agents.find(agent => agent.provider === 'copilotcli')?.protectedResources?.filter(resource => resource.required !== false)
			: undefined;
		if (!resources?.length) {
			throw new Error(localize('room.authenticationNotReady', "Local Copilot authentication is not ready. Sign in through the Accounts menu before starting peers."));
		}
		const generation = this.hostGeneration;
		const authentication = this.authenticationGeneration;
		for (const resource of resources) {
			const scopes = resource.scopes_supported ?? [];
			const session = await resolveSessionForResource(
				URI.parse(resource.resource), resource.authorization_servers ?? [], scopes,
				this.authenticationService, this.logService, '[Collaboration]',
			);
			if (generation !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
				throw new CancellationError();
			}
			if (!session) {
				throw new Error(localize('room.signInRequired', "Sign in through the Accounts menu before starting or retrying Copilot peers."));
			}
			const expiresIn = session.expiresIn;
			const result = await this.host.authenticate({
				resource: resource.resource, scopes, token: session.accessToken,
				...(expiresIn !== undefined && Number.isInteger(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
			});
			if (!result.authenticated) {
				throw new Error(localize('room.authenticationRejected', "The local agent host did not accept the Copilot sign-in. Sign in again through the Accounts menu."));
			}
		}
	}

	getArtifact(roomId: string, artifactId: string): Promise<string> {
		return this.api.getArtifact(roomId, artifactId);
	}
}

registerSingleton(ICollaborationService, CollaborationService, InstantiationType.Delayed);
