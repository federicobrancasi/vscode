/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue, transaction } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomPostOptions, IAgentHostRoomsService } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { ResolveSessionConfigResult } from '../../../../platform/agentHost/common/state/protocol/commands.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ModelSelection, PolicyState, SessionModelInfo } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { resolveSessionForResource } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { COLLABORATION_MESSAGE_PAGE_SIZE, CollaborationAvailability, CollaborationEnabledSettingId, CollaborationRequestResponse, ICollaborationRequest, ICollaborationService, ICollaborationWorkspaceTrust } from '../common/collaboration.js';
import { CollaborationDraft, getCollaborationRecipients } from '../common/collaborationMentions.js';
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
	readonly inboxMemberId = observableValue<string | undefined>(this, undefined);
	readonly messages = observableValue<IAgentHostRoomMessagePage>(this, EMPTY_MESSAGES);
	readonly models = observableValue<readonly SessionModelInfo[]>(this, []);
	readonly loading = observableValue(this, false);
	readonly loadingEarlier = observableValue(this, false);
	readonly creating = observableValue(this, false);
	readonly canSend = observableValue(this, false);
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
	private readonly historyObservation = this._register(new MutableDisposable<DisposableStore>());
	private readonly histories = new Map<string, CollaborationHistory>();
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
		const liveRoom = derived(this, reader => {
			const room = this.activeRoom.read(reader);
			return this.availability.read(reader) === 'available' && this.canSend.read(reader) && !room?.archived
				&& roomViewService.visible.read(reader) && roomViewService.activeView.read(reader) ? room : undefined;
		});
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
			this.clearHistories();
			this.connection.clear();
			this.loading.set(false, undefined);
			transaction(tx => {
				this.availability.set(this.enabled ? 'unavailable' : 'disabled', tx);
				this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, tx);
				this.availabilityError.set(localize('room.hostExited', "The local agent host disconnected. Reconnect to see authoritative worker status; no work is resumed automatically."), tx);
				this.models.set([], tx);
				this.canSend.set(false, tx);
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
		this.clearHistories();
		this.connection.clear();
		transaction(tx => {
			this.availability.set('connecting', tx);
			this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, tx);
		});
		this.canSend.set(false, undefined);
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
				const supportsInbox = capabilities.version === 2 && capabilities.supportsInbox === true;
				this.canSend.set(supportsInbox, tx);
				this.canConfigure.set(supportsInbox && capabilities.supportsConfiguration === true, tx);
				this.canSetMemberModel.set(supportsInbox && capabilities.supportsMemberModels === true, tx);
				this.availabilityError.set(supportsInbox ? undefined : localize('room.inboxUnavailable', "This host does not support inbox collaboration. Rooms are read-only. Update or reconnect the local agent host."), tx);
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

	private assertInboxSupported(): void {
		if (!this.canSend.get()) {
			throw new Error(localize('room.inboxUnavailable', "This host does not support inbox collaboration. Rooms are read-only. Update or reconnect the local agent host."));
		}
	}

	private assertWritableRoom(roomId = this.roomId): IAgentHostRoom {
		this.assertInboxSupported();
		const room = this.rooms.get().find(room => room.id === roomId);
		if (!room) {
			throw new Error(localize('room.noSelection', "Select a collaboration room first."));
		}
		if (room.archived) {
			throw new Error(localize('room.archiveReadOnly', "This room is an archive. Its history, sessions, and patches are available for inspection only."));
		}
		return room;
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
		const inboxMemberId = roomId === this.activeRoomId.get() ? this.inboxMemberId.get() : undefined;
		this.history?.cancelPendingRequests();
		this.historyObservation.clear();
		this.history = undefined;
		transaction(tx => {
			this.authorizationGeneration.set(this.authorizationGeneration.get() + 1, tx);
			this.activeRoomId.set(roomId, tx);
			this.inboxMemberId.set(inboxMemberId, tx);
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
			await this.activateHistory(roomId, this.inboxMemberId.get());
		} catch (error) {
			if (!isCancellationError(error) && selection === this.selectionGeneration && !this._store.isDisposed) {
				this.error.set(toErrorMessage(error), undefined);
			}
			throw error;
		} finally {
			if (selection === this.selectionGeneration && !this._store.isDisposed && !this.history) {
				this.loading.set(false, undefined);
			}
		}
	}

	async selectInbox(memberId: string | undefined): Promise<void> {
		const room = this.activeRoom.get();
		if (!room || (memberId !== undefined && !room.members.some(member => member.id === memberId))) {
			throw new Error(localize('room.inboxMissing', "Choose a peer from the selected room to view its inbox."));
		}
		if (memberId === this.inboxMemberId.get()) {
			return;
		}
		this.inboxMemberId.set(memberId, undefined);
		await this.activateHistory(room.id, memberId);
	}

	private async activateHistory(roomId: string, memberId: string | undefined): Promise<void> {
		this.history?.cancelPendingRequests();
		this.historyObservation.clear();
		const key = JSON.stringify([roomId, memberId]);
		let history = this.histories.get(key);
		const cached = !!history;
		if (!history) {
			const api = this.api;
			history = this.historyStore.add(new CollaborationHistory(query => api.getMessages(roomId, query), COLLABORATION_MESSAGE_PAGE_SIZE, memberId));
			this.histories.set(key, history);
		}
		this.history = history;
		const selected = history;
		const observation = this.historyObservation.value = new DisposableStore();
		observation.add(autorun(reader => {
			const page = selected.page.read(reader);
			const loading = selected.loading.read(reader);
			const loadingEarlier = selected.loadingEarlier.read(reader);
			const error = selected.error.read(reader);
			transaction(tx => {
				this.messages.set(page, tx);
				this.loading.set(loading, tx);
				this.loadingEarlier.set(loadingEarlier, tx);
				this.error.set(error, tx);
			});
		}));
		await (cached ? history.refresh() : history.loadLatest());
	}

	private clearHistories(): void {
		this.historyObservation.clear();
		this.history = undefined;
		this.histories.clear();
		this.historyStore.clear();
	}

	async createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom> {
		this.assertInboxSupported();
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
			const history = this.history;
			try {
				while (this.refreshPending && history && history === this.history && this.activeRoomId.get() && !this._store.isDisposed) {
					this.refreshPending = false;
					await history.refresh();
				}
			} catch (error) {
				if (!isCancellationError(error) && selection === this.selectionGeneration && history === this.history && !this._store.isDisposed) {
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

	async sendMessage(): Promise<void> {
		const room = this.assertWritableRoom();
		const roomId = room.id;
		const draft = this.getDraft(roomId);
		if (!draft.text.trim()) {
			throw new Error(localize('room.messageRequired', "Enter a message before sending."));
		}
		const pending = draft.beginSend(generateUuid(), getCollaborationRecipients(draft.audience, room.members));
		await this.postMessage(roomId, {
			id: pending.messageId, text: pending.text, mentions: pending.mentions, replyTo: pending.replyTo,
		});
		draft.acknowledge(pending.revision);
	}

	async askForSummary(memberId: string): Promise<void> {
		const room = this.assertWritableRoom();
		const mentions = getCollaborationRecipients({ kind: 'member', memberId }, room.members);
		await this.postMessage(room.id, {
			id: generateUuid(),
			text: localize('room.summaryRequest', "Please summarize the room's progress, evidence, published patches, and open questions. Share your summary with the room."),
			mentions,
		});
	}

	private async postMessage(roomId: string, options: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage> {
		if (this.sendingRooms.get().has(roomId)) {
			throw new Error(localize('room.sendingInProgress', "Wait for the current room message to finish sending."));
		}
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		const authentication = this.authenticationGeneration;
		const api = this.api;
		this.sendingRooms.set(new Set([...this.sendingRooms.get(), roomId]), undefined);
		try {
			await (options.mentions.length ? this.ensureExecutionAuthorized() : this.ensureAuthenticated());
			if (selection !== this.selectionGeneration || host !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
				throw new CancellationError();
			}
			this.assertWritableRoom(roomId);
			const message = await api.postMessage(roomId, options);
			if (selection === this.selectionGeneration && host === this.hostGeneration && !this._store.isDisposed) {
				this.history?.acceptMessage(message);
				this.queueMessageRefresh();
			}
			return message;
		} finally {
			if (!this._store.isDisposed) {
				this.sendingRooms.set(new Set([...this.sendingRooms.get()].filter(id => id !== roomId)), undefined);
			}
		}
	}

	async retryMessage(messageId: string): Promise<void> {
		const roomId = this.assertWritableRoom().id;
		const message = this.messages.get().messages.find(message => message.id === messageId);
		if (!message || message.authorKind !== 'human' || !message.deliveries.some(delivery => ['interrupted', 'cancelled', 'failed'].includes(delivery.state))) {
			throw new Error(localize('room.noPendingMessage', "Choose one of your messages with an interrupted, cancelled, or failed delivery."));
		}
		const api = this.api;
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		const authentication = this.authenticationGeneration;
		await this.ensureExecutionAuthorized();
		if (selection !== this.selectionGeneration || host !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
			throw new CancellationError();
		}
		this.assertWritableRoom(roomId);
		await api.retryMessage(roomId, message.id);
		if (selection === this.selectionGeneration && host === this.hostGeneration && !this._store.isDisposed) {
			this.queueMessageRefresh();
		}
	}

	async startRoom(limits: IAgentHostRoomLimits): Promise<void> {
		const room = this.assertWritableRoom();
		if (!room.run) {
			this.validateTurns(limits.maxTurns);
		} else if (limits.maxTurns !== undefined) {
			throw new Error(localize('room.extendExistingBudget', "Use Extend to add turns to the existing run budget."));
		} else if (room.run.limits.maxTurns === undefined || room.run.admittedTurns >= room.run.limits.maxTurns) {
			throw new Error(localize('room.budgetExhausted', "The turn budget is exhausted. Use Extend to authorize more turns."));
		}
		await this.mutate((api, roomId) => api.startRoom(roomId, limits), true);
	}

	async extendRun(additionalTurns: number): Promise<void> {
		if (!this.assertWritableRoom().run) {
			throw new Error(localize('room.noRunToExtend', "Choose a finite turn budget and Start before extending a run."));
		}
		this.validateTurns(additionalTurns);
		await this.mutate((api, roomId) => api.extendRun(roomId, additionalTurns), true);
	}

	private validateTurns(turns: number | undefined): void {
		if (turns === undefined || !Number.isSafeInteger(turns) || turns < 1) {
			throw new Error(localize('room.finiteBudgetRequired', "Choose a finite turn budget of at least one turn."));
		}
	}

	async pauseRoom(): Promise<void> {
		await this.mutate((api, roomId) => api.pauseRoom(roomId));
	}

	async stopRoom(): Promise<void> {
		await this.mutate((api, roomId) => api.stopRoom(roomId));
	}

	/** The host must publish a new peer's exact worktree before it can inherit source trust. */
	async addMember(model?: ModelSelection): Promise<void> {
		const wasActive = ['running', 'idle'].includes(this.activeRoom.get()?.state ?? '');
		await this.mutate((api, roomId) => api.addMember(roomId, model));
		if (wasActive) {
			await this.ensureExecutionAuthorized();
		}
	}

	async removeMember(memberId: string): Promise<void> {
		await this.mutate((api, roomId) => api.removeMember(roomId, memberId));
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
		const roomId = this.assertWritableRoom().id;
		if (requiresAuthentication) {
			await this.ensureExecutionAuthorized();
			if (generation !== this.hostGeneration || selection !== this.selectionGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
				throw new CancellationError();
			}
		}
		this.assertWritableRoom(roomId);
		const room = await operation(api, roomId);
		if (generation === this.hostGeneration && !this._store.isDisposed) {
			this.acceptRoom(room);
		}
	}

	requestWorkspaceTrust(): Promise<void> {
		this.assertWritableRoom();
		return this.trust.ensureTrusted();
	}

	respondToRequest(request: ICollaborationRequest, response: CollaborationRequestResponse): Promise<void> {
		this.assertWritableRoom(request.roomId);
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
