/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { derived, observableValue, transaction } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AgentHostRoomMessageMode, IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery, IAgentHostRoomsService } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { PolicyState, SessionModelInfo } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { resolveSessionForResource } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostAuth.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { COLLABORATION_MESSAGE_PAGE_SIZE, CollaborationAvailability, CollaborationEnabledSettingId, ICollaborationService } from '../common/collaboration.js';
import { CollaborationDraft, getCollaborationMentionTargets } from '../common/collaborationMentions.js';

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
	readonly creating = observableValue(this, false);
	readonly canSteer = observableValue(this, false);
	readonly error = observableValue<string | undefined>(this, undefined);
	private readonly sendingRooms = observableValue<ReadonlySet<string>>(this, new Set());
	readonly sending = derived(reader => this.sendingRooms.read(reader).has(this.activeRoomId.read(reader) ?? ''));

	private readonly connection = this._register(new MutableDisposable<DisposableStore>());
	private readonly drafts = new Map<string, CollaborationDraft>();
	private hostGeneration = 0;
	private selectionGeneration = 0;
	private messageGeneration = 0;
	private loadingGeneration = 0;
	private authenticationGeneration = 0;
	private query: IAgentHostRoomMessageQuery | undefined;
	private refreshPending = false;
	private refreshingMessages = false;

	constructor(
		@IAgentHostService private readonly host: IAgentHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(authenticationService.onDidChangeSessions(() => this.authenticationGeneration++));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CollaborationEnabledSettingId) || e.affectsConfiguration('chat.disableAIFeatures')) {
				this.updateConnection();
			}
		}));
		this._register(host.onAgentHostStart(() => this.updateConnection()));
		this._register(host.onAgentHostExit(() => {
			this.hostGeneration++;
			this.selectionGeneration++;
			this.messageGeneration++;
			this.connection.clear();
			this.loading.set(false, undefined);
			transaction(tx => {
				this.availability.set(this.enabled ? 'unavailable' : 'disabled', tx);
				this.availabilityError.set(localize('room.hostExited', "The local agent host disconnected. Reconnect to see authoritative worker status; no work is resumed automatically."), tx);
				this.models.set([], tx);
				this.canSteer.set(false, tx);
				this.loading.set(false, tx);
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
		this.messageGeneration++;
		this.connection.clear();
		this.canSteer.set(false, undefined);
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
		this.messageGeneration++;
		this.query = undefined;
		transaction(tx => {
			this.activeRoomId.set(roomId, tx);
			this.messages.set(EMPTY_MESSAGES, tx);
			this.error.set(undefined, tx);
			this.loading.set(roomId !== undefined, tx);
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
			await this.loadMessages();
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

	async loadMessages(query?: IAgentHostRoomMessageQuery): Promise<void> {
		await this.readMessages(query, true);
	}

	private async readMessages(query: IAgentHostRoomMessageQuery | undefined, showLoading: boolean): Promise<void> {
		const roomId = this.roomId;
		const request = ++this.messageGeneration;
		const selection = this.selectionGeneration;
		const loading = showLoading ? ++this.loadingGeneration : undefined;
		this.query = query;
		if (showLoading) {
			this.loading.set(true, undefined);
		}
		try {
			const page = await this.api.getMessages(roomId, { ...query, limit: COLLABORATION_MESSAGE_PAGE_SIZE });
			if (selection === this.selectionGeneration && request === this.messageGeneration && !this._store.isDisposed) {
				transaction(tx => {
					this.messages.set(page, tx);
					this.error.set(undefined, tx);
				});
			}
		} finally {
			if (loading !== undefined && loading === this.loadingGeneration && selection === this.selectionGeneration && !this._store.isDisposed) {
				this.loading.set(false, undefined);
			}
		}
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
				while (this.refreshPending && this.activeRoomId.get() && !this._store.isDisposed) {
					this.refreshPending = false;
					await this.readMessages(this.query, false);
				}
			} catch (error) {
				if (selection === this.selectionGeneration && !this._store.isDisposed) {
					this.error.set(toErrorMessage(error), undefined);
				}
			} finally {
				this.refreshingMessages = false;
				if (this.refreshPending && this.activeRoomId.get() && this.availability.get() === 'available' && !this._store.isDisposed) {
					this.queueMessageRefresh();
				}
			}
		};
		void refresh();
	}

	setFollowingLatest(following: boolean): void {
		const page = this.messages.get();
		if (!page.hasLater) {
			this.query = following ? undefined : { before: (page.messages.at(-1)?.sequence ?? 0) + 1 };
		}
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
		const selection = this.selectionGeneration;
		const host = this.hostGeneration;
		const authentication = this.authenticationGeneration;
		const api = this.api;
		this.sendingRooms.set(new Set([...this.sendingRooms.get(), roomId]), undefined);
		try {
			if (mentions.length || mode === 'steer') {
				await this.ensureAuthenticated();
				if (selection !== this.selectionGeneration || host !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
					throw new CancellationError();
				}
			}
			const message = await api.postMessage(roomId, {
				id: pending.messageId, text: pending.text,
				mentions,
				replyTo: pending.replyTo,
				...(mode === 'steer' ? { mode } : {}),
			});
			draft.acknowledge(pending.revision);
			if (selection === this.selectionGeneration && host === this.hostGeneration && !this._store.isDisposed) {
				this.revealSentMessage(message);
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
		await this.ensureAuthenticated();
		if (selection !== this.selectionGeneration || host !== this.hostGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
			throw new CancellationError();
		}
		await api.retryMessage(roomId, message.id);
		if (selection === this.selectionGeneration && host === this.hostGeneration && !this._store.isDisposed) {
			this.queueMessageRefresh();
		}
	}

	private revealSentMessage(message: IAgentHostRoomMessage): void {
		const page = this.messages.get();
		const current = page.messages;
		// Reveal the acknowledgement without joining disjoint history pages.
		const messages = (current.some(item => item.id === message.id)
			? current
			: current.at(-1)?.sequence === message.sequence - 1
				? [...current, message]
				: [message]).slice(-COLLABORATION_MESSAGE_PAGE_SIZE);
		this.query = undefined;
		this.messageGeneration++;
		this.messages.set({
			messages,
			hasEarlier: messages[0].sequence > 1,
			hasLater: (this.activeRoom.get()?.latestMessageSequence ?? message.sequence) > messages[messages.length - 1].sequence,
		}, undefined);
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
			await this.ensureAuthenticated();
			if (generation !== this.hostGeneration || selection !== this.selectionGeneration || authentication !== this.authenticationGeneration || this._store.isDisposed) {
				throw new CancellationError();
			}
		}
		const room = await operation(api, roomId);
		if (generation === this.hostGeneration && !this._store.isDisposed) {
			this.acceptRoom(room);
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
