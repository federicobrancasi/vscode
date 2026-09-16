/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { generateAgentHostRoomMemberName, isAgentHostRoomMemberName } from '../common/agentHostRoomNames.js';
import { IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery, IAgentHostRoomPostOptions, IAgentHostRoomsService, MAX_ROOM_INBOX_BATCH_CHARACTERS, MAX_ROOM_MESSAGE_LENGTH, MAX_ROOM_WORKERS, newAgentHostRoomConfiguration } from '../common/agentHostRooms.js';
import { AgentSession } from '../common/agentService.js';
import { ResolveSessionConfigResult } from '../common/state/protocol/commands.js';
import { buildDefaultChatUri, ModelSelection } from '../common/state/sessionState.js';
import { RoomInbox, seedRoomMember } from './agentHostRoomInbox.js';
import { RoomMembers } from './agentHostRoomMembers.js';
import { inboxMessageText, roomExecution, roomMember, roomMessagePage, RoomStateStore, updateRoomMember, validateRoomMessageId, validateRoomText } from './agentHostRoomState.js';
import { getRoomMemberModel, parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomRecord, IRoomRuntime, IRoomStorage, roomExcludedTools } from './agentHostRoomsTypes.js';

export interface IRoomAgentPost extends IAgentHostRoomPostOptions {
	readonly kind?: 'message' | 'work' | 'finding';
	readonly blocked?: boolean;
}

/** SDK handlers capture the session identity; models cannot choose the author. */
export interface IRoomSessionTools {
	isRoomSession(sessionId: string): boolean;
	read(sessionId: string, query?: IAgentHostRoomMessageQuery): Promise<IRoomContext>;
	readArtifact(sessionId: string, artifactId: string, offset?: number): Promise<IRoomArtifactContent>;
	post(sessionId: string, options: IRoomAgentPost): Promise<IAgentHostRoomMessage>;
	sharePatch(sessionId: string, title: string): Promise<IAgentHostRoomArtifact>;
	beforeTool(sessionId: string, toolName: string, expectedTurnId?: string): void;
}

export interface IRoomContext extends IAgentHostRoomMessagePage {
	readonly room: IAgentHostRoom;
	readonly self: IAgentHostRoomMember;
	readonly inbox: readonly IAgentHostRoomMessage[];
}

export interface IRoomArtifactContent {
	readonly artifact: IAgentHostRoomArtifact;
	readonly patchPath: string;
	readonly text: string;
	readonly offset: number;
	readonly totalCharacters: number;
	readonly nextOffset?: number;
}

function memberNames(value: readonly string[] | undefined, count: number): string[] {
	if (value !== undefined && (!Array.isArray(value) || value.length !== count)) {
		throw new Error(localize('rooms.invalidMemberNames', "Provide exactly one name per room member."));
	}
	const names: string[] = [];
	for (let index = 0; index < count; index++) {
		const name = value === undefined ? generateAgentHostRoomMemberName(names) : value[index];
		if (typeof name !== 'string' || !isAgentHostRoomMemberName(name) || names.includes(name)) {
			throw new Error(localize('rooms.invalidMemberName', "Room members require unique lowercase kebab-case names."));
		}
		names.push(name);
	}
	return names;
}

/** Human and session-bound APIs share one durable inbox and one admission path. */
export class AgentHostRooms extends Disposable implements IAgentHostRoomsService, IRoomSessionTools {
	declare readonly _serviceBrand: undefined;
	private readonly state: RoomStateStore;
	private readonly members: RoomMembers;
	private readonly inbox: RoomInbox;
	readonly onDidChangeRoom: IAgentHostRoomsService['onDidChangeRoom'];

	constructor(
		private readonly storage: IRoomStorage,
		private readonly runtime: IRoomRuntime,
		logService: ILogService,
		private readonly now: () => number = Date.now,
		stopTimeoutMs = 5000,
	) {
		super();
		this._register(runtime);
		this.state = this._register(new RoomStateStore(storage, runtime, logService, now));
		this.members = new RoomMembers(this.state, runtime);
		this.inbox = this._register(new RoomInbox(this.state, this.members, storage, runtime, logService, now, stopTimeoutMs));
		this.onDidChangeRoom = this.state.onDidChange;
	}

	async getCapabilities() {
		try {
			await this.state.ready;
		} catch {
			// Recovery already logged the failure and closed admission.
		}
		return { version: 2 as const, available: this.inbox.available, maxWorkers: MAX_ROOM_WORKERS, supportsInbox: true, supportsConfiguration: true, supportsMemberModels: true };
	}

	isRepository(folderUri: string): Promise<boolean> { return this.storage.isRepository(folderUri); }
	async listRooms(): Promise<readonly IAgentHostRoom[]> { await this.state.ready; return this.state.list(); }
	async getRoom(roomId: string): Promise<IAgentHostRoom> { await this.state.ready; return this.state.room(roomId); }

	async createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom> {
		await this.state.ready;
		this.inbox.assertOpen();
		validateRoomText(options.title, 200);
		validateRoomText(options.goal, 32000);
		if (options.instructions !== undefined && (typeof options.instructions !== 'string' || options.instructions.length > 32000)) {
			throw new Error(localize('rooms.invalidInstructions', "Room instructions are too long."));
		}
		if (!Number.isSafeInteger(options.workerCount) || options.workerCount < 1 || options.workerCount > MAX_ROOM_WORKERS) {
			throw new Error(localize('rooms.invalidCount', "A room requires between 1 and {0} members.", MAX_ROOM_WORKERS));
		}
		if (options.memberModels !== undefined && (!Array.isArray(options.memberModels) || options.memberModels.length !== options.workerCount)) {
			throw new Error(localize('rooms.invalidMemberModels', "Provide exactly one model selection per room member."));
		}
		const names = memberNames(options.memberNames, options.workerCount);
		const fallback = options.model === undefined ? undefined : parseRoomModelSelection({ id: options.model });
		const models = Array.from({ length: options.workerCount }, (_, index) => {
			const model = options.memberModels?.[index] === undefined ? fallback : parseRoomModelSelection(options.memberModels[index]);
			if (model) {
				this.runtime.validateModel(model);
			}
			return model;
		});
		const repository = await this.storage.resolveRepository(options.repositoryUri, options.baseRevision, options.initializeRepository === true);
		this.inbox.assertOpen();
		for (const model of models) {
			if (model) {
				this.runtime.validateModel(model);
			}
		}
		const id = generateUuid();
		const members = names.map((name, index) => this.newMember(id, name, models[index]));
		return (await this.state.add({
			version: 2,
			room: {
				id, title: options.title.trim(), goal: options.goal.trim(), instructions: options.instructions ?? '', ...repository,
				createdAt: this.now(), updatedAt: this.now(), revision: 0, state: 'created', members, artifacts: [], latestMessageSequence: 0,
			},
			messages: [], executions: members.map(member => ({ memberId: member.id, initialized: false })),
		})).room;
	}

	private newMember(roomId: string, name: string, model?: ModelSelection): IAgentHostRoomMember {
		const id = generateUuid();
		const sessionUri = AgentSession.uri('copilotcli', generateUuid()).toString();
		return {
			id, name, sessionUri, chatUri: buildDefaultChatUri(sessionUri), worktreeUri: this.storage.worktreeUri(roomId, id),
			model: model?.id, pendingModel: model, state: 'pending', turns: 0, configuration: { ...newAgentHostRoomConfiguration },
		};
	}

	async getMessages(roomId: string, query?: IAgentHostRoomMessageQuery): Promise<IAgentHostRoomMessagePage> {
		await this.state.ready;
		return roomMessagePage(this.state.messages(roomId), query);
	}

	postMessage(roomId: string, options: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage> {
		return this.postToRoom(roomId, options);
	}

	private async postToRoom(roomId: string, options: IRoomAgentPost, memberId?: string): Promise<IAgentHostRoomMessage> {
		this.inbox.assertOpen();
		const pauseVersion = this.inbox.getPauseVersion(roomId);
		let humanInput = false;
		validateRoomMessageId(options.id);
		validateRoomText(options.text, MAX_ROOM_MESSAGE_LENGTH);
		if (!Array.isArray(options.mentions) || options.mentions.length > MAX_ROOM_WORKERS
			|| new Set(options.mentions).size !== options.mentions.length || options.mentions.some(id => typeof id !== 'string')) {
			throw new Error(localize('rooms.explicitRecipients', "Choose explicit, unique recipient member IDs. Use an empty list for a room note."));
		}
		if (options.kind !== undefined && !['message', 'work', 'finding'].includes(options.kind)
			|| options.blocked !== undefined && typeof options.blocked !== 'boolean') {
			throw new Error(localize('rooms.invalidPost', "Invalid room message kind or work status."));
		}
		const record = await this.state.update(roomId, record => {
			this.inbox.assertOpen();
			const author = memberId === undefined ? undefined : roomMember(record, memberId);
			if (author) {
				this.inbox.assertMemberTurn(record, author.id);
			}
			const existing = record.messages.find(message => message.id === options.id);
			if (existing) {
				if (existing.authorId !== (memberId ?? 'human') || existing.text !== options.text || existing.replyTo !== options.replyTo
					|| existing.kind !== (author ? options.kind ?? 'message' : 'message') || !equals(existing.mentions, options.mentions)
					|| !equals(existing.artifactIds ?? [], options.artifactIds ?? [])) {
					throw new Error(localize('rooms.messageConflict', "This message ID is already used by a different message."));
				}
				return record;
			}
			for (const id of options.mentions) {
				if (roomMember(record, id).removed) {
					throw new Error(localize('rooms.recipientRemoved', "The recipient was removed from this room."));
				}
			}
			if (options.replyTo !== undefined) {
				validateRoomMessageId(options.replyTo);
				if (!record.messages.some(message => message.id === options.replyTo)) {
					throw new Error(localize('rooms.invalidReply', "The replied-to message does not exist."));
				}
			}
			if (options.artifactIds !== undefined && (!Array.isArray(options.artifactIds) || options.artifactIds.length > 20
				|| new Set(options.artifactIds).size !== options.artifactIds.length
				|| options.artifactIds.some(id => !record.room.artifacts.some(artifact => artifact.id === id)))) {
				throw new Error(localize('rooms.invalidArtifacts', "Reference only unique published artifact IDs from this room."));
			}
			const message: IAgentHostRoomMessage = {
				id: options.id, sequence: record.room.latestMessageSequence + 1, authorId: memberId ?? 'human',
				authorName: author?.name ?? localize('rooms.human', "You"), authorKind: author ? 'agent' : 'human',
				kind: author ? options.kind ?? 'message' : 'message', text: options.text, timestamp: this.now(),
				mentions: [...options.mentions], replyTo: options.replyTo, artifactIds: options.artifactIds ? [...options.artifactIds] : undefined,
				deliveries: options.mentions.map(memberId => ({ memberId, state: 'pending' })),
			};
			if (message.mentions.length && inboxMessageText(message).length > MAX_ROOM_INBOX_BATCH_CHARACTERS) {
				throw new Error(localize('rooms.inboxMessageTooLarge', "The encoded message exceeds the inbox input limit. Split it into smaller messages."));
			}
			const next: IRoomRecord = {
				...record, room: { ...record.room, latestMessageSequence: message.sequence }, messages: [...record.messages, message],
			};
			if (!author && message.mentions.length) {
				const resumed = this.inbox.resumeForHumanInput(next, message.mentions, pauseVersion);
				humanInput = true;
				return resumed;
			}
			return author && (message.kind === 'work' || message.kind === 'finding')
				? updateRoomMember(next, author.id, { work: { description: message.text, blocked: options.blocked === true, updatedAt: this.now() } }) : next;
		});
		const message = record.messages.find(message => message.id === options.id)!;
		if (humanInput) {
			this.inbox.dispatchHumanInput(roomId, pauseVersion);
		} else if (message.mentions.length) {
			this.inbox.schedule(roomId);
		}
		return message;
	}

	async retryMessage(roomId: string, messageId: string): Promise<IAgentHostRoomMessage> {
		this.inbox.assertOpen();
		const record = await this.state.update(roomId, record => {
			const message = record.messages.find(message => message.id === messageId);
			if (!message || !message.deliveries.some(delivery => delivery.state !== 'submitted')) {
				throw new Error(localize('rooms.notRetryable', "Choose a message with a pending, interrupted, or failed delivery."));
			}
			if (message.deliveries.some(delivery => delivery.state === 'reserved')) {
				throw new Error(localize('rooms.retryReserved', "This message is reserved for an active turn. Stop or reconcile that turn before retrying."));
			}
			const targets = message.deliveries.filter(delivery => delivery.state !== 'submitted');
			for (const delivery of targets) {
				const member = roomMember(record, delivery.memberId);
				if (member.removed || this.inbox.isStopping(roomId, member.id) || roomExecution(record, member.id).turnId || !this.runtime.isIdle(member.sessionUri)) {
					throw new Error(localize('rooms.retryUnsettled', "Inspect or stop the recipient's previous turn before retrying delivery."));
				}
			}
			return {
				...record,
				room: {
					...record.room, members: record.room.members.map(member => targets.some(target => target.memberId === member.id) && ['failed', 'interrupted'].includes(member.state)
						? { ...member, state: 'idle', error: undefined } : member),
				},
				messages: record.messages.map(item => item.id === messageId ? {
					...item, deliveries: item.deliveries.map(delivery => delivery.state === 'submitted' ? delivery : { memberId: delivery.memberId, state: 'pending' }),
				} : item),
			};
		});
		this.inbox.schedule(roomId);
		return record.messages.find(message => message.id === messageId)!;
	}

	startRoom(roomId: string, limits: IAgentHostRoomLimits): Promise<IAgentHostRoom> { return this.inbox.start(roomId, limits); }
	extendRun(roomId: string, additionalTurns: number): Promise<IAgentHostRoom> { return this.inbox.extend(roomId, additionalTurns); }
	pauseRoom(roomId: string): Promise<IAgentHostRoom> { return this.inbox.pause(roomId); }
	stopRoom(roomId: string): Promise<IAgentHostRoom> { return this.inbox.stop(roomId); }
	stopMember(roomId: string, memberId: string): Promise<IAgentHostRoom> { return this.inbox.stopMember(roomId, memberId); }
	removeMember(roomId: string, memberId: string): Promise<IAgentHostRoom> { return this.inbox.stopMember(roomId, memberId, true); }
	retryMember(roomId: string, memberId: string): Promise<IAgentHostRoom> { return this.inbox.retryMember(roomId, memberId); }

	async addMember(roomId: string, model?: ModelSelection): Promise<IAgentHostRoom> {
		this.inbox.assertOpen();
		const selection = model === undefined ? undefined : parseRoomModelSelection(model);
		if (selection) {
			this.runtime.validateModel(selection);
		}
		await this.state.update(roomId, record => {
			if (record.room.members.length >= MAX_ROOM_WORKERS || this.inbox.isStopping(roomId)) {
				throw new Error(localize('rooms.cannotAddMember', "The room is stopping or has reached its member limit."));
			}
			const member = this.newMember(roomId, generateAgentHostRoomMemberName(record.room.members.map(member => member.name)), selection);
			return seedRoomMember({
				...record, room: { ...record.room, members: [...record.room.members, member] },
				executions: [...record.executions, { memberId: member.id, initialized: false }],
			}, member, this.now());
		});
		this.inbox.schedule(roomId);
		return this.state.room(roomId);
	}

	getRoomConfiguration(roomId: string): Promise<ResolveSessionConfigResult> { return this.members.configuration(roomId); }
	setRoomConfiguration(roomId: string, configuration: Partial<IAgentHostRoomConfiguration>): Promise<IAgentHostRoom> {
		this.inbox.assertOpen();
		return this.members.setConfiguration(roomId, configuration);
	}
	setMemberModel(roomId: string, memberId: string, model: ModelSelection | undefined): Promise<IAgentHostRoom> {
		this.inbox.assertOpen();
		return this.members.setModel(roomId, memberId, model);
	}

	async setMemberConfiguration(session: string, configuration: Partial<IAgentHostRoomConfiguration>, onApplied?: () => void): Promise<void> {
		await this.state.ready;
		this.inbox.assertOpen();
		const binding = this.bindingUri(session);
		await this.members.setConfiguration(binding.roomId, configuration, binding.memberId, onApplied);
	}

	async getMemberModelForChat(session: string, chat: string): Promise<ModelSelection | undefined> {
		await this.state.ready;
		const binding = this.state.binding(session);
		if (!binding) {
			return undefined;
		}
		const member = roomMember(this.state.record(binding.roomId), binding.memberId);
		return member.chatUri === chat ? getRoomMemberModel(member) : undefined;
	}

	async setMemberModelForChat(session: string, chat: string, model: ModelSelection): Promise<void> {
		await this.state.ready;
		const binding = this.bindingUri(session);
		if (roomMember(this.state.record(binding.roomId), binding.memberId).chatUri !== chat) {
			throw new Error(localize('rooms.changedDefaultChat', "Use the room member's preserved default chat."));
		}
		try {
			await this.setMemberModel(binding.roomId, binding.memberId, model);
		} catch (error) {
			const record = await this.state.update(binding.roomId, record => updateRoomMember(record, binding.memberId, { modelError: String(error) }));
			this.runtime.publishModel(roomMember(record, binding.memberId));
			throw error;
		}
	}

	isRoomSession(sessionId: string): boolean { return this.isRoomSessionUri(AgentSession.uri('copilotcli', sessionId).toString()); }
	isRoomStateReady(): boolean { return this.state.isReady; }
	isRoomSessionUri(session: string): boolean { return this.state.isRoomSession(session); }
	isAdmittedTurn(session: string, chat: string, turnId: string): boolean { return this.inbox.isAdmitted(session, chat, turnId); }

	private bindingUri(session: string) {
		if (this.state.isArchiveSession(session)) {
			throw new Error(localize('rooms.archiveReadOnly', "Archived collaboration rooms are read-only."));
		}
		const binding = this.state.binding(session);
		if (!binding) {
			throw new Error(localize('rooms.noBinding', "The session is not a room member."));
		}
		return binding;
	}

	async read(sessionId: string, query?: IAgentHostRoomMessageQuery): Promise<IRoomContext> {
		await this.state.ready;
		const binding = this.bindingUri(AgentSession.uri('copilotcli', sessionId).toString());
		const room = this.state.room(binding.roomId);
		const page = roomMessagePage(this.state.messages(binding.roomId), query);
		return {
			room, self: room.members.find(member => member.id === binding.memberId)!, ...page,
			inbox: page.messages.filter(message => message.mentions.includes(binding.memberId)),
		};
	}

	async post(sessionId: string, options: IRoomAgentPost): Promise<IAgentHostRoomMessage> {
		await this.state.ready;
		const binding = this.bindingUri(AgentSession.uri('copilotcli', sessionId).toString());
		return this.postToRoom(binding.roomId, options, binding.memberId);
	}

	beforeTool(sessionId: string, toolName: string, expectedTurnId?: string): void {
		const binding = this.bindingUri(AgentSession.uri('copilotcli', sessionId).toString());
		this.inbox.assertMemberTurn(this.state.record(binding.roomId), binding.memberId, expectedTurnId);
		if (roomExcludedTools.some(name => toolName === name || toolName.endsWith(`:${name}`) || toolName.endsWith(`.${name}`))) {
			throw new Error(localize('rooms.noDelegation', "Room members cannot launch nested agents. Collaborate with the existing room members instead."));
		}
	}

	async getArtifact(roomId: string, artifactId: string): Promise<string> {
		const room = await this.getRoom(roomId);
		return this.storage.readArtifact(room, this.artifact(room, artifactId));
	}

	async readArtifact(sessionId: string, artifactId: string, offset = 0): Promise<IRoomArtifactContent> {
		await this.state.ready;
		this.beforeTool(sessionId, 'room_read_artifact');
		const binding = this.bindingUri(AgentSession.uri('copilotcli', sessionId).toString());
		const record = this.state.record(binding.roomId);
		const turnId = roomExecution(record, binding.memberId).turnId!;
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new Error(localize('rooms.invalidArtifactOffset', "Use a nonnegative artifact offset."));
		}
		const artifact = this.artifact(record.room, artifactId);
		const contents = await this.storage.readArtifact(record.room, artifact, paths => this.assertContentAccess(roomMember(record, binding.memberId), paths));
		this.beforeTool(sessionId, 'room_read_artifact', turnId);
		if (offset > contents.length) {
			throw new Error(localize('rooms.artifactOffsetPastEnd', "The artifact offset is past the end of the published patch."));
		}
		const text = contents.slice(offset, offset + 16000);
		return {
			artifact, patchPath: URI.parse(artifact.uri).fsPath, text, offset, totalCharacters: contents.length,
			...(offset + text.length < contents.length ? { nextOffset: offset + text.length } : {}),
		};
	}

	async sharePatch(sessionId: string, title: string): Promise<IAgentHostRoomArtifact> {
		await this.state.ready;
		validateRoomText(title, 200);
		this.beforeTool(sessionId, 'room_share_patch');
		const binding = this.bindingUri(AgentSession.uri('copilotcli', sessionId).toString());
		const record = this.state.record(binding.roomId);
		const member = roomMember(record, binding.memberId);
		const turnId = roomExecution(record, member.id).turnId!;
		const artifact = await this.storage.publishPatch(record.room, member, title, paths => this.assertContentAccess(member, paths));
		await this.state.update(binding.roomId, record => {
			this.inbox.assertMemberTurn(record, member.id, turnId);
			const message: IAgentHostRoomMessage = {
				id: artifact.id, sequence: record.room.latestMessageSequence + 1, authorId: member.id, authorName: member.name, authorKind: 'agent',
				kind: 'artifact', text: title, timestamp: this.now(), mentions: [], artifactId: artifact.id, artifactIds: [artifact.id], deliveries: [],
			};
			return {
				...record, room: { ...record.room, artifacts: [...record.room.artifacts, artifact], latestMessageSequence: message.sequence },
				messages: [...record.messages, message],
			};
		});
		return artifact;
	}

	private artifact(room: IAgentHostRoom, artifactId: string): IAgentHostRoomArtifact {
		const artifact = room.artifacts.find(artifact => artifact.id === artifactId);
		if (!artifact) {
			throw new Error(localize('rooms.artifactNotFound', "The room artifact does not exist."));
		}
		return artifact;
	}

	private async assertContentAccess(member: IAgentHostRoomMember, paths: readonly string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		if (!this.runtime.assertContentAccess || !member.worktreeUri) {
			throw new Error(localize('rooms.contentExclusionsUnavailable', "Content exclusion checks are unavailable; the room cannot share this artifact."));
		}
		await this.runtime.assertContentAccess(member.sessionUri, paths.map(path => URI.joinPath(URI.parse(member.worktreeUri!), path).fsPath));
	}

	shutdown(): Promise<void> { return this.inbox.shutdown(); }
}
