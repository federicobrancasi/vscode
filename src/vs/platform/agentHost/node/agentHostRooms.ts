/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { AgentHostRoomMessageKind, defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery, IAgentHostRoomPostOptions, IAgentHostRoomsService, MAX_ROOM_WORKERS, newAgentHostRoomConfiguration } from '../common/agentHostRooms.js';
import { AgentSession } from '../common/agentService.js';
import { ResolveSessionConfigResult } from '../common/state/protocol/commands.js';
import { buildDefaultChatUri, ModelSelection } from '../common/state/sessionState.js';
import { intersectRoomConfigurations, parseRoomConfiguration, validateRoomConfigurationChange } from './agentHostRoomsConfiguration.js';
import { getRoomMemberModel, parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomMemberExecution, IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomStorage, roomExcludedTools } from './agentHostRoomsTypes.js';

export interface IRoomAgentPost extends IAgentHostRoomPostOptions {
	readonly kind?: 'message' | 'work' | 'finding';
	readonly nextStep?: string;
	readonly blocked?: boolean;
}

/** Narrow, host-only capability captured by a member's SDK tool handlers. */
export interface IRoomSessionTools {
	isRoomSession(sessionId: string): boolean;
	read(sessionId: string, query?: IAgentHostRoomMessageQuery): Promise<IRoomContext>;
	readArtifact(sessionId: string, artifactId: string, offset?: number): Promise<IRoomArtifactContent>;
	post(sessionId: string, options: IRoomAgentPost): Promise<IAgentHostRoomMessage>;
	sharePatch(sessionId: string, title: string): Promise<IAgentHostRoomArtifact>;
	beforeTool(sessionId: string, toolName: string, expectedTurnId?: string): void;
}

export interface IRoomContext {
	readonly room: IAgentHostRoom;
	readonly self: IAgentHostRoomMember;
	readonly messages: readonly IAgentHostRoomMessage[];
	readonly inbox: readonly IAgentHostRoomMessage[];
	readonly humanGuidance: readonly IAgentHostRoomMessage[];
	readonly hasEarlier: boolean;
	readonly hasLater: boolean;
}

export interface IRoomArtifactContent {
	readonly artifact: IAgentHostRoomArtifact;
	readonly patchPath: string;
	readonly text: string;
	readonly offset: number;
	readonly totalCharacters: number;
	readonly nextOffset?: number;
}

/** Turn interval on which a member is pointed at peer work, to slow diversity collapse. */
const PEER_REVIEW_INTERVAL = 3;

/**
 * The room is a separate durable authority, not an AHP queued message.
 * All admissions are journalled before touching the runtime.
 */
export class AgentHostRooms extends Disposable implements IAgentHostRoomsService, IRoomSessionTools {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeRoom = this._register(new Emitter<IAgentHostRoom>());
	readonly onDidChangeRoom = this._onDidChangeRoom.event;
	private readonly _records = new Map<string, IRoomRecord>();
	private readonly _sessions = new Map<string, { roomId: string; memberId: string }>();
	private readonly _queue = new SequencerByKey<string>();
	private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _stops = new Map<string, Promise<IAgentHostRoom>>();
	private readonly _memberStops = new Map<string, Promise<IAgentHostRoom>>();
	private readonly _modelChangeVersions = new Map<string, number>();
	private readonly _ready: Promise<void>;
	private _closed = false;
	private _persistenceError: string | undefined;

	constructor(
		private readonly _storage: IRoomStorage,
		private readonly _runtime: IRoomRuntime,
		private readonly _logService: ILogService,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._register(_runtime);
		this._ready = this._restore();
		this._register(_runtime.onDidChange(event => {
			void this._onRuntimeEvent(event).catch(error => this._logService.error('[AgentHostRooms] Runtime update failed', error));
		}));
	}

	private async _restore(): Promise<void> {
		for (const stored of await this._storage.load()) {
			const record: IRoomRecord = {
				...stored,
				room: {
					...stored.room,
					members: stored.room.members.map(member => ({
						...member, chatUri: member.chatUri ?? buildDefaultChatUri(member.sessionUri),
						...(member.model?.trim() && !member.model.includes('\0') && member.modelSelection === undefined && member.pendingModel === undefined
							? stored.executions.find(execution => execution.memberId === member.id)?.initialized
								? { modelSelection: { id: member.model } } : { pendingModel: { id: member.model } }
							: {}),
						configuration: member.configuration ?? { ...defaultAgentHostRoomConfiguration },
					})),
				},
			};
			const interrupted = record.executions.some(execution => execution.turnId) || record.room.state === 'running' || record.room.state === 'stopping';
			const restored: IRoomRecord = interrupted ? {
				...record,
				room: {
					...record.room, revision: record.room.revision + 1, updatedAt: this._now(), state: 'interrupted',
					members: record.room.members.map(member => ['starting', 'working', 'needsInput', 'stopping'].includes(member.state) ? { ...member, state: 'interrupted', activity: undefined } : member),
				},
				executions: record.executions.map(execution => ({ ...execution, turnId: undefined, runId: undefined, readSequence: undefined, announced: false })),
				messages: record.messages.map(message => ({
					...message,
					deliveries: message.deliveries.map(delivery => ['submitted', 'steering', 'delivered'].includes(delivery.state) ? { ...delivery, state: 'interrupted' } : delivery),
				})),
			} : record;
			if (interrupted) {
				await this._storage.save(restored);
			}
			this._records.set(restored.room.id, restored);
			for (const member of restored.room.members) {
				this._sessions.set(member.sessionUri, { roomId: restored.room.id, memberId: member.id });
			}
		}
	}

	async getCapabilities() {
		try {
			await this._ready;
		} catch (error) {
			this._closed = true;
			this._logService.error('[AgentHostRooms] Room recovery failed; rooms are unavailable', error);
		}
		return { version: 1 as const, available: !this._closed, maxWorkers: MAX_ROOM_WORKERS, supportsSteering: true, supportsConfiguration: true, supportsMemberModels: true };
	}

	async listRooms(): Promise<readonly IAgentHostRoom[]> {
		await this._ready;
		return [...this._records.values()].map(record => record.room).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	isRepository(folderUri: string): Promise<boolean> {
		return this._storage.isRepository(folderUri);
	}

	async getRoom(roomId: string): Promise<IAgentHostRoom> {
		await this._ready;
		return this._record(roomId).room;
	}

	async setMemberModel(roomId: string, memberId: string, model: ModelSelection | undefined): Promise<IAgentHostRoom> {
		await this._ready;
		this._assertOpen();
		this._member(this._record(roomId), memberId);
		const selection = parseRoomModelSelection(model === undefined ? { id: 'auto' } : model);
		this._runtime.validateModel(selection);
		this._modelChangeVersions.set(memberId, (this._modelChangeVersions.get(memberId) ?? 0) + 1);
		return this._queue.queue(roomId, async () => {
			this._assertOpen();
			this._runtime.validateModel(selection);
			let record = this._record(roomId);
			const member = this._member(record, memberId);
			if (equals(getRoomMemberModel(member), selection) && !member.modelError) {
				return record.room;
			}
			record = await this._save({
				...record,
				room: {
					...record.room,
					members: record.room.members.map(member => member.id === memberId
						? { ...member, model: selection.id, pendingModel: selection, modelError: undefined } : member),
				},
			});
			this._runtime.publishModel(this._member(record, memberId));
			const execution = this._execution(record, memberId);
			if (execution.initialized && !execution.turnId && this._runtime.isIdle(member.sessionUri)
				&& !this._stops.has(roomId) && !this._memberStops.has(memberId)) {
				record = await this._applyMemberModel(record, memberId);
			}
			return record.room;
		});
	}

	async setContinuous(roomId: string, continuous: boolean): Promise<IAgentHostRoom> {
		await this._ready;
		this._assertOpen();
		if (typeof continuous !== 'boolean') {
			throw new Error(localize('rooms.invalidContinuous', "Choose whether idle members keep working."));
		}
		const room = await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			if (record.room.continuous === continuous) {
				return record.room;
			}
			return (await this._save({ ...record, room: { ...record.room, continuous } })).room;
		});
		this._schedule(roomId);
		return room;
	}

	async getMemberModelForChat(session: string, chat: string): Promise<ModelSelection | undefined> {
		await this._ready;
		const binding = this._sessions.get(session);
		if (!binding) {
			return undefined;
		}
		const member = this._member(this._record(binding.roomId), binding.memberId);
		return member.chatUri === chat ? getRoomMemberModel(member) : undefined;
	}

	async setMemberModelForChat(session: string, chat: string, model: ModelSelection): Promise<void> {
		await this._ready;
		const binding = this._sessions.get(session);
		if (!binding || this._member(this._record(binding.roomId), binding.memberId).chatUri !== chat) {
			return;
		}
		try {
			await this.setMemberModel(binding.roomId, binding.memberId, model);
		} catch (error) {
			if (this._closed) {
				throw error;
			}
			await this._queue.queue(binding.roomId, async () => {
				const record = this._record(binding.roomId);
				const saved = await this._save({
					...record,
					room: { ...record.room, members: record.room.members.map(member => member.id === binding.memberId ? { ...member, modelError: String(error) } : member) },
				});
				this._runtime.publishModel(this._member(saved, binding.memberId));
			});
			throw error;
		}
	}

	private async _applyMemberModel(record: IRoomRecord, memberId: string): Promise<IRoomRecord> {
		const member = this._member(record, memberId);
		let applied: ModelSelection | undefined;
		try {
			const requested = member.pendingModel !== undefined ? getRoomMemberModel(member) : this._runtime.getModel(member) ?? getRoomMemberModel(member);
			const model = requested === undefined ? undefined : parseRoomModelSelection(requested);
			if (model) {
				this._runtime.validateModel(model);
				await this._runtime.applyModel(member, model);
			}
			const current = model ?? this._runtime.getModel(member);
			applied = current === undefined ? undefined : parseRoomModelSelection(current);
		} catch (error) {
			await this._save({
				...record, room: { ...record.room, members: record.room.members.map(member => member.id === memberId ? { ...member, modelError: String(error) } : member) },
			});
			throw error;
		}
		const updated = { ...member, model: applied?.id, modelSelection: applied, pendingModel: undefined, modelError: undefined };
		const saved = equals(member, updated) ? record : await this._save({
			...record, room: { ...record.room, members: record.room.members.map(member => member.id === memberId ? updated : member) },
		});
		this._runtime.publishModel(updated);
		return saved;
	}

	async getRoomConfiguration(roomId: string): Promise<ResolveSessionConfigResult> {
		await this._ready;
		return this._queue.queue(roomId, async () => intersectRoomConfigurations(
			await Promise.all(this._record(roomId).room.members.map(member => this._runtime.resolveConfiguration(member))),
		));
	}

	async setRoomConfiguration(roomId: string, configuration: Partial<IAgentHostRoomConfiguration>): Promise<IAgentHostRoom> {
		await this._ready;
		const patch = parseRoomConfiguration(configuration);
		return this._queue.queue(roomId, () => this._setConfiguration(this._record(roomId), patch));
	}

	async setMemberConfiguration(session: string, configuration: Partial<IAgentHostRoomConfiguration>, onApplied?: () => void): Promise<void> {
		await this._ready;
		const binding = this._sessions.get(session);
		if (!binding) {
			throw new Error(localize('rooms.noBinding', "The session is not a room member."));
		}
		const patch = parseRoomConfiguration(configuration);
		await this._queue.queue(binding.roomId, async () => {
			await this._setConfiguration(this._record(binding.roomId), patch, binding.memberId);
			onApplied?.();
		});
	}

	private async _setConfiguration(record: IRoomRecord, patch: Partial<IAgentHostRoomConfiguration>, memberId?: string): Promise<IAgentHostRoom> {
		this._assertOpen();
		const members = record.room.members.filter(member => memberId === undefined || member.id === memberId);
		for (const member of members) {
			const selected = { ...defaultAgentHostRoomConfiguration, ...member.configuration, ...patch };
			validateRoomConfigurationChange(patch, await this._runtime.resolveConfiguration(member, selected));
		}
		if (!Object.keys(patch).length) {
			return record.room;
		}
		const saved = await this._save({
			...record,
			room: {
				...record.room, error: undefined,
				members: record.room.members.map(member => members.includes(member) ? {
					...member, configuration: { ...defaultAgentHostRoomConfiguration, ...member.configuration, ...patch },
				} : member),
			},
		});
		await this._applyMemberConfigurations(saved, saved.room.members.filter(member => memberId === undefined || member.id === memberId), patch);
		return saved.room;
	}

	private async _applyMemberConfigurations(record: IRoomRecord, members = record.room.members, requested?: Partial<IAgentHostRoomConfiguration>): Promise<void> {
		const results = await Promise.allSettled(members.map(member => this._runtime.applyConfiguration(member, requested)));
		const failures = results.filter(result => result.status === 'rejected');
		if (failures.length) {
			const error = localize('rooms.configurationFailed', "Room configuration was saved but could not be applied: {0}", failures.map(result => String(result.reason)).join('\n'));
			await this._save({ ...record, room: { ...record.room, state: record.room.state === 'running' ? 'paused' : record.room.state, error } });
			throw new Error(error);
		}
	}

	async createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom> {
		await this._ready;
		this._assertOpen();
		this._text(options.title, 200);
		this._text(options.goal, 32000);
		if (options.instructions !== undefined && (typeof options.instructions !== 'string' || options.instructions.length > 32000)) {
			throw new Error(localize('rooms.invalidInstructions', "Room instructions are too long."));
		}
		if (!Number.isInteger(options.workerCount) || options.workerCount < 1 || options.workerCount > MAX_ROOM_WORKERS) {
			throw new Error(localize('rooms.invalidCount', "A room requires between 1 and {0} members.", MAX_ROOM_WORKERS));
		}
		if (options.memberModels !== undefined && (!Array.isArray(options.memberModels) || options.memberModels.length !== options.workerCount)) {
			throw new Error(localize('rooms.invalidMemberModels', "Provide exactly one model selection per room member."));
		}
		const fallback = options.model === undefined ? undefined : parseRoomModelSelection({ id: options.model });
		const models = Array.from({ length: options.workerCount }, (_, index) => {
			const selected = options.memberModels?.[index];
			const model = selected === undefined ? fallback : parseRoomModelSelection(selected);
			if (model) {
				this._runtime.validateModel(model);
			}
			return model;
		});
		const repository = await this._storage.resolveRepository(options.repositoryUri, options.baseRevision, options.initializeRepository === true);
		for (const model of models) {
			if (model) {
				this._runtime.validateModel(model);
			}
		}
		const id = generateUuid();
		const now = this._now();
		const members: IAgentHostRoomMember[] = Array.from({ length: options.workerCount }, (_, index) => {
			const memberId = generateUuid();
			const sessionUri = AgentSession.uri('copilotcli', generateUuid()).toString();
			return {
				id: memberId, name: `Copilot-${index + 1}`, sessionUri, chatUri: buildDefaultChatUri(sessionUri),
				model: models[index]?.id, pendingModel: models[index], state: 'pending', turns: 0, worktreeUri: this._storage.worktreeUri(id, memberId),
				configuration: { ...newAgentHostRoomConfiguration },
			};
		});
		const room: IAgentHostRoom = {
			id, title: options.title.trim(), goal: options.goal.trim(), instructions: options.instructions ?? '',
			...repository, createdAt: now, updatedAt: now, revision: 1, state: 'created',
			continuous: options.continuous !== false,
			members, artifacts: [], latestMessageSequence: 0,
		};
		const record: IRoomRecord = {
			version: 1, room, messages: [],
			executions: members.map(member => ({ memberId: member.id, initialized: false, needsTurn: true })),
		};
		await this._storage.save(record);
		this._records.set(id, record);
		for (const member of members) {
			this._sessions.set(member.sessionUri, { roomId: id, memberId: member.id });
		}
		this._onDidChangeRoom.fire(room);
		return room;
	}

	async getMessages(roomId: string, query: IAgentHostRoomMessageQuery = {}): Promise<IAgentHostRoomMessagePage> {
		await this._ready;
		const messages = this._record(roomId).messages;
		const limit = Math.max(1, Math.min(200, Number.isInteger(query.limit) ? query.limit! : 100));
		const matching = messages.filter(message => (query.after === undefined || message.sequence > query.after) && (query.before === undefined || message.sequence < query.before));
		const page = query.after !== undefined ? matching.slice(0, limit) : matching.slice(-limit);
		return { messages: page, hasEarlier: !!page.length && messages[0].sequence < page[0].sequence, hasLater: !!page.length && messages[messages.length - 1].sequence > page[page.length - 1].sequence };
	}

	async postMessage(roomId: string, message: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage> {
		await this._ready;
		return this._post(roomId, undefined, message);
	}

	async retryMessage(roomId: string, messageId: string): Promise<IAgentHostRoomMessage> {
		await this._ready;
		const message = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			const record = this._record(roomId);
			const previous = record.messages.find(message => message.id === messageId);
			if (!previous || previous.authorKind !== 'human' || !previous.deliveries.some(delivery => ['pending', 'cancelled', 'failed'].includes(delivery.state))) {
				throw new Error(localize('rooms.notRetryable', "Choose a human message with a pending, cancelled, or failed delivery."));
			}
			if (this._stops.has(roomId) || record.room.state === 'stopping') {
				throw new Error(localize('rooms.waitForStop', "Wait for the room to finish stopping before retrying delivery."));
			}
			const targets = previous.deliveries.filter(delivery => ['pending', 'cancelled', 'failed'].includes(delivery.state)).map(delivery => delivery.memberId);
			const message: IAgentHostRoomMessage = {
				...previous,
				deliveries: previous.deliveries.map(delivery => targets.includes(delivery.memberId)
					? { memberId: delivery.memberId, state: 'pending' }
					: delivery),
			};
			await this._save(this._wakeHumanRecipients({
				...record,
				messages: record.messages.map(item => item.id === messageId ? message : item),
			}, targets));
			return message;
		});
		this._schedule(roomId);
		return message;
	}

	private async _post(roomId: string, memberId: string | undefined, options: IRoomAgentPost): Promise<IAgentHostRoomMessage> {
		const message = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			const record = this._record(roomId);
			this._text(options.id, 200);
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.id)) {
				throw new Error(localize('rooms.invalidMessageId', "Use a message ID containing only letters, numbers, underscores, and hyphens."));
			}
			this._text(options.text, 32000);
			const author = memberId ? this._member(record, memberId) : undefined;
			if (options.mode !== undefined && options.mode !== 'message' && options.mode !== 'steer') {
				throw new Error(localize('rooms.invalidMode', "Choose a message or human steering request."));
			}
			if (author && options.mode === 'steer') {
				throw new Error(localize('rooms.humanSteeringOnly', "Only the human can steer the room. Ask peers for help with a normal message."));
			}
			const existing = record.messages.find(message => message.id === options.id);
			if (existing) {
				if (existing.authorId !== (memberId ?? 'human') || existing.text !== options.text || existing.replyTo !== options.replyTo || (existing.mode ?? 'message') !== (options.mode ?? 'message') || existing.kind !== (author ? options.kind ?? 'message' : 'message') || JSON.stringify(existing.mentions) !== JSON.stringify(this._mentions(record, options, memberId))) {
					throw new Error(localize('rooms.messageConflict', "This message ID is already used by a different message."));
				}
				if (!author) {
					const recipients = existing.deliveries.filter(delivery => delivery.state === 'pending').map(delivery => delivery.memberId);
					const awakened = this._wakeHumanRecipients(record, recipients);
					if (awakened !== record) {
						await this._save(awakened);
					}
				}
				return existing;
			}
			if (author) {
				this._assertMemberTurn(record, author.id);
				const execution = this._execution(record, author.id);
				if (options.kind === 'work' && !execution.announced && record.messages.some(message =>
					message.sequence > (execution.readSequence ?? 0) && message.authorId !== author.id && message.kind === 'work')) {
					throw new Error(localize('rooms.workChanged', "Another peer announced work since you last read the room. Call room_read again and choose complementary work before announcing your plan."));
				}
			}
			if (options.replyTo && !record.messages.some(message => message.id === options.replyTo)) {
				throw new Error(localize('rooms.invalidReply', "The replied-to message does not exist."));
			}
			const mentions = this._mentions(record, options, memberId);
			const kind: AgentHostRoomMessageKind = author ? options.kind ?? 'message' : 'message';
			const message: IAgentHostRoomMessage = {
				id: options.id, sequence: record.room.latestMessageSequence + 1, authorId: memberId ?? 'human',
				authorName: author?.name ?? localize('rooms.human', "You"), authorKind: author ? 'agent' : 'human',
				kind, text: options.text, timestamp: this._now(), mentions, replyTo: options.replyTo,
				...(options.mode === 'steer' ? { mode: 'steer' } : {}),
				deliveries: mentions.map(memberId => ({ memberId, state: 'pending' })),
			};
			if (options.nextStep !== undefined && (typeof options.nextStep !== 'string' || options.nextStep.length > 8000)) {
				throw new Error(localize('rooms.invalidNextStep', "The next step must be a short, substantive description."));
			}
			const isWork = author && (kind === 'work' || kind === 'finding');
			const updated: IRoomRecord = {
				...record,
				room: {
					...record.room, latestMessageSequence: message.sequence,
					state: record.room.state === 'idle' && mentions.length && this._hasRunCapacity(record.room) ? 'running' : record.room.state,
					members: record.room.members.map(member => isWork && member.id === author.id ? {
						...member, work: { description: options.text, nextStep: options.nextStep?.trim() || undefined, blocked: options.blocked === true, updatedAt: this._now() },
					} : member),
				},
				executions: record.executions.map(execution => author && execution.memberId === author.id && kind === 'work' ? { ...execution, announced: true } : execution),
				messages: [...record.messages, message],
			};
			await this._save(author ? updated : this._wakeHumanRecipients(updated, mentions));
			return message;
		});
		this._schedule(roomId);
		return message;
	}

	private _hasRunCapacity(room: IAgentHostRoom): boolean {
		const run = room.run;
		return !!run && (run.deadline === undefined || run.deadline > this._now())
			&& (run.limits.maxTurns === undefined || run.admittedTurns < run.limits.maxTurns);
	}

	/**
	 * A peer added to a room that has already run, and not yet admitted a turn. A run
	 * it was not addressed in must not retire it: it joins instead, so an agent added
	 * later starts working rather than being swept aside as finished. In a room that
	 * has never run every member is still pending, and addressing one there must
	 * start only that one, so this is scoped to rooms that already have a run.
	 */
	private _joinedMidRoom(record: IRoomRecord, member: IAgentHostRoomMember): boolean {
		return !member.removed && record.room.run !== undefined && member.state === 'pending' && member.turns === 0;
	}

	private _wakeHumanRecipients(record: IRoomRecord, recipients: readonly string[]): IRoomRecord {
		const targets = new Set(recipients.filter(id => !this._memberStops.has(id)));
		if (!targets.size || record.room.state === 'paused' || record.room.state === 'stopping' || this._stops.has(record.room.id)) {
			return record;
		}
		const freshRun = !['running', 'idle'].includes(record.room.state) || !this._hasRunCapacity(record.room);
		if (freshRun && record.executions.some(execution => execution.turnId)) {
			return record;
		}
		if (freshRun) {
			this._clearTimer(record.room.id);
		}
		return {
			...record,
			room: {
				...record.room,
				state: 'running',
				error: undefined,
				run: freshRun ? { id: generateUuid(), startedAt: this._now(), limits: {}, admittedTurns: 0 } : record.room.run,
				members: record.room.members.map(member => targets.has(member.id)
					? {
						...member, state: member.state === 'working' || member.state === 'starting' || member.state === 'needsInput' ? member.state : 'idle', error: undefined,
						work: member.work ? { ...member.work, nextStep: undefined } : undefined
					}
					: freshRun && !this._joinedMidRoom(record, member) ? { ...member, state: member.state === 'failed' ? 'failed' : 'stopped' } : member),
			},
			executions: record.executions.map(execution => ({
				...execution,
				needsTurn: targets.has(execution.memberId) || this._joinedMidRoom(record, this._member(record, execution.memberId))
					? true
					: freshRun ? false : execution.needsTurn,
			})),
		};
	}

	private _mentions(record: IRoomRecord, options: IAgentHostRoomPostOptions, authorId?: string): string[] {
		if (!Array.isArray(options.mentions) || options.mentions.length > MAX_ROOM_WORKERS) {
			throw new Error(localize('rooms.invalidMentions', "Mention only members of this room."));
		}
		const names = [...options.mentions];
		for (const match of options.text.matchAll(/@(?<name>Copilot-\d+)\b/gi)) {
			names.push(match.groups!.name);
		}
		if (options.mode === 'steer' && names.length === 0) {
			return record.room.members.filter(member => !member.removed).map(member => member.id);
		}
		return [...new Set(names.map(name => {
			const member = record.room.members.find(member => member.id === name || member.name.toLowerCase() === String(name).toLowerCase());
			if (!member) {
				throw new Error(localize('rooms.unknownMember', "The mentioned member does not exist in this room."));
			}
			return member.id;
		}))].filter(memberId => memberId !== authorId);
	}

	async startRoom(roomId: string, limits: IAgentHostRoomLimits = {}): Promise<IAgentHostRoom> {
		await this._ready;
		if ((limits.maxTurns !== undefined && (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1 || limits.maxTurns > 10000))
			|| (limits.timeoutMinutes !== undefined && (!Number.isFinite(limits.timeoutMinutes) || limits.timeoutMinutes <= 0 || limits.timeoutMinutes > 1440))) {
			throw new Error(localize('rooms.invalidLimits', "Leave limits empty for no cap, or choose a turn limit of 1-10000 and a positive deadline of at most 24 hours."));
		}
		const room = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			const record = this._record(roomId);
			if (record.room.state === 'paused' && record.room.run && !this._stops.has(roomId)
				&& !record.room.members.some(member => this._memberStops.has(member.id)) && record.executions.some(execution => execution.turnId)) {
				if ((limits.maxTurns !== undefined && limits.maxTurns !== record.room.run.limits.maxTurns)
					|| (limits.timeoutMinutes !== undefined && limits.timeoutMinutes !== record.room.run.limits.timeoutMinutes)) {
					throw new Error(localize('rooms.activeRunLimits', "Resume keeps the current run limits. Stop the room before changing limits."));
				}
				await this._applyMemberConfigurations(record);
				return (await this._save({ ...record, room: { ...record.room, state: 'running' } })).room;
			}
			if (record.room.state === 'running' || record.room.state === 'stopping' || this._stops.has(roomId) || record.room.members.some(member => this._memberStops.has(member.id)) || record.executions.some(execution => execution.turnId)) {
				throw new Error(localize('rooms.alreadyRunning', "Wait for the active room turns to finish before starting a new run."));
			}
			const now = this._now();
			return (await this._save({
				...record,
				room: {
					...record.room, state: 'running', error: undefined,
					run: { id: generateUuid(), startedAt: now, deadline: limits.timeoutMinutes === undefined ? undefined : now + Math.ceil(limits.timeoutMinutes * 60000), limits: { ...limits }, admittedTurns: 0 },
					members: record.room.members.map(member => ({ ...member, state: 'idle', error: undefined })),
				},
				executions: record.executions.map(execution => ({ ...execution, needsTurn: true, readSequence: undefined, announced: false })),
			})).room;
		});
		this._clearTimer(roomId);
		this._schedule(roomId);
		return room;
	}

	async pauseRoom(roomId: string): Promise<IAgentHostRoom> {
		await this._ready;
		return this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			return (await this._save({ ...record, room: { ...record.room, state: ['running', 'idle'].includes(record.room.state) ? 'paused' : record.room.state } })).room;
		});
	}

	async stopRoom(roomId: string): Promise<IAgentHostRoom> {
		const existing = this._stops.get(roomId);
		if (existing) {
			return existing;
		}
		const operation = this._stopRoom(roomId);
		this._stops.set(roomId, operation);
		try {
			return await operation;
		} finally {
			this._stops.delete(roomId);
		}
	}

	private async _stopRoom(roomId: string): Promise<IAgentHostRoom> {
		await this._ready;
		this._clearTimer(roomId);
		const pending = await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			await this._save({
				...record, room: { ...record.room, state: 'stopping', members: record.room.members.map(member => ({ ...member, state: 'stopping', activity: undefined })) },
				messages: record.messages.map(message => ({ ...message, deliveries: message.deliveries.map(delivery => ['pending', 'submitted', 'steering', 'delivered'].includes(delivery.state) ? { ...delivery, state: 'cancelled' } : delivery) })),
				executions: record.executions.map(execution => ({ ...execution, needsTurn: false })),
			});
			return record.executions.map(execution => ({ ...execution, sessionUri: this._member(record, execution.memberId).sessionUri }));
		});
		const errors = await Promise.all(pending.map(async execution => {
			try {
				await this._runtime.abort(execution.sessionUri, execution.turnId);
				return undefined;
			} catch (error) {
				return String(error);
			}
		}));
		return this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			return (await this._save({
				...record,
				room: { ...record.room, state: errors.some(Boolean) ? 'interrupted' : 'stopped', error: errors.filter(Boolean).join('\n') || undefined, members: record.room.members.map((member, index) => ({ ...member, state: errors[index] ? 'interrupted' : 'stopped', error: errors[index] })) },
				executions: record.executions.map(execution => ({ ...execution, turnId: undefined, runId: undefined })),
			})).room;
		});
	}

	async stopMember(roomId: string, memberId: string): Promise<IAgentHostRoom> {
		const existing = this._memberStops.get(memberId);
		if (existing) {
			return existing;
		}
		const operation = this._stopMember(roomId, memberId);
		this._memberStops.set(memberId, operation);
		try {
			return await operation;
		} finally {
			this._memberStops.delete(memberId);
		}
	}

	private async _stopMember(roomId: string, memberId: string): Promise<IAgentHostRoom> {
		await this._ready;
		const active = await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			const member = this._member(record, memberId);
			const execution = this._execution(record, memberId);
			await this._save({
				...record, room: { ...record.room, members: record.room.members.map(item => item.id === memberId ? { ...item, state: 'stopping', activity: undefined } : item) },
				executions: record.executions.map(item => item.memberId === memberId ? { ...item, needsTurn: false } : item),
				messages: record.messages.map(message => ({ ...message, deliveries: message.deliveries.map(delivery => delivery.memberId === memberId && ['pending', 'submitted', 'steering', 'delivered'].includes(delivery.state) ? { ...delivery, state: 'cancelled' } : delivery) })),
			});
			return { sessionUri: member.sessionUri, turnId: execution.turnId };
		});
		let error: string | undefined;
		try {
			await this._runtime.abort(active.sessionUri, active.turnId);
		} catch (err) {
			error = String(err);
		}
		return this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			return (await this._save({
				...record, room: { ...record.room, members: record.room.members.map(member => member.id === memberId ? { ...member, state: error ? 'interrupted' : 'stopped', error } : member) },
				executions: record.executions.map(execution => execution.memberId === memberId ? { ...execution, turnId: undefined, runId: undefined } : execution),
			})).room;
		});
	}

	/**
	 * Adds one peer to an existing room. The new member joins with its own session
	 * and worktree, exactly like a member created with the room, and is scheduled a
	 * turn straight away when the room is already running.
	 */
	async addMember(roomId: string, model?: ModelSelection): Promise<IAgentHostRoom> {
		await this._ready;
		this._assertOpen();
		const selection = model === undefined ? undefined : parseRoomModelSelection(model);
		if (selection) {
			this._runtime.validateModel(selection);
		}
		const room = await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			if (record.room.members.filter(member => !member.removed).length >= MAX_ROOM_WORKERS) {
				throw new Error(localize('rooms.memberLimit', "A room can hold at most {0} members.", MAX_ROOM_WORKERS));
			}
			// A stopped room can still be resumed, so it accepts members; only an
			// in-flight cancellation is refused. Admission requires a running room, so a
			// member added to a stopped room waits for Resume rather than starting work.
			if (record.room.state === 'stopping' || this._stops.has(roomId)) {
				throw new Error(localize('rooms.cannotAddMember', "Members cannot be added while the room is stopping."));
			}
			const memberId = generateUuid();
			const sessionUri = AgentSession.uri('copilotcli', generateUuid()).toString();
			// Names identify peers in the shared conversation, so a new member takes the
			// next unused number rather than one an existing peer already answers to.
			const taken = new Set(record.room.members.map(member => member.name));
			let index = record.room.members.length + 1;
			while (taken.has(`Copilot-${index}`)) {
				index++;
			}
			const member: IAgentHostRoomMember = {
				id: memberId, name: `Copilot-${index}`, sessionUri, chatUri: buildDefaultChatUri(sessionUri),
				model: selection?.id, pendingModel: selection, state: 'pending', turns: 0,
				worktreeUri: this._storage.worktreeUri(roomId, memberId),
				configuration: { ...newAgentHostRoomConfiguration },
			};
			const saved = await this._save({
				...record,
				room: { ...record.room, members: [...record.room.members, member] },
				executions: [...record.executions, { memberId, initialized: false, needsTurn: true }],
			});
			this._sessions.set(sessionUri, { roomId, memberId });
			return saved.room;
		});
		this._schedule(roomId);
		return room;
	}

	/**
	 * Retires a peer from the roster. Its messages and published patches remain, so
	 * the identity is kept rather than deleted; it simply takes no further turns and
	 * stops being a recipient. Any in-flight turn is cancelled first.
	 */
	async removeMember(roomId: string, memberId: string): Promise<IAgentHostRoom> {
		await this._ready;
		const record = this._record(roomId);
		const member = this._member(record, memberId);
		if (member.removed) {
			return record.room;
		}
		if (record.room.members.filter(candidate => !candidate.removed).length <= 1) {
			throw new Error(localize('rooms.lastMember', "A room needs at least one agent."));
		}
		if (!['stopped', 'failed', 'interrupted', 'pending'].includes(member.state)) {
			await this.stopMember(roomId, memberId);
		}
		const room = await this._queue.queue(roomId, async () => {
			const current = this._record(roomId);
			return (await this._save({
				...current,
				room: {
					...current.room,
					members: current.room.members.map(item => item.id === memberId
						? { ...item, removed: true, state: 'stopped', activity: undefined, work: undefined } : item),
				},
				executions: current.executions.map(execution => execution.memberId === memberId
					? { ...execution, needsTurn: false, turnId: undefined, runId: undefined } : execution),
			})).room;
		});
		this._schedule(roomId);
		return room;
	}

	async retryMember(roomId: string, memberId: string): Promise<IAgentHostRoom> {
		await this._ready;
		const room = await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			const member = this._member(record, memberId);
			if (member.removed || this._stops.has(roomId) || this._memberStops.has(memberId) || !['failed', 'stopped', 'interrupted', 'blocked'].includes(member.state)) {
				throw new Error(localize('rooms.memberNotRetryable', "This member is not ready to retry."));
			}
			// Resuming one peer takes the same path a human message does, so a stopped or
			// exhausted room starts a fresh run for it instead of leaving the button to
			// mark the member idle in a room that can never admit it.
			const woken = this._wakeHumanRecipients({
				...record,
				executions: record.executions.map(execution => execution.memberId === memberId ? { ...execution, turnId: undefined, runId: undefined } : execution),
			}, [memberId]);
			if (woken !== record) {
				return (await this._save(woken)).room;
			}
			// A paused or still-settling room keeps the peer ready for its next admission.
			return (await this._save({
				...record,
				room: {
					...record.room,
					state: record.room.state === 'idle' && this._hasRunCapacity(record.room) ? 'running' : record.room.state,
					members: record.room.members.map(item => item.id === memberId ? { ...item, state: 'idle', error: undefined } : item),
				},
				executions: record.executions.map(execution => execution.memberId === memberId ? { ...execution, needsTurn: true, turnId: undefined, runId: undefined } : execution),
			})).room;
		});
		this._schedule(roomId);
		return room;
	}

	async getArtifact(roomId: string, artifactId: string): Promise<string> {
		const room = await this.getRoom(roomId);
		const artifact = room.artifacts.find(artifact => artifact.id === artifactId);
		if (!artifact) {
			throw new Error(localize('rooms.artifactNotFound', "The room artifact does not exist."));
		}
		return this._storage.readArtifact(room, artifact);
	}

	isRoomSession(sessionId: string): boolean {
		return this._sessions.has(AgentSession.uri('copilotcli', sessionId).toString());
	}

	isRoomSessionUri(sessionUri: string): boolean {
		return this._sessions.has(sessionUri);
	}

	isAdmittedTurn(sessionUri: string, chatUri: string, turnId: string): boolean {
		const binding = this._sessions.get(sessionUri);
		if (!binding) {
			return false;
		}
		const record = this._record(binding.roomId);
		const member = this._member(record, binding.memberId);
		const execution = this._execution(record, binding.memberId);
		return chatUri === (member.chatUri ?? buildDefaultChatUri(member.sessionUri))
			&& execution.turnId === turnId && !!execution.runId
			&& this._canSubmit(binding.roomId, binding.memberId, turnId, execution.runId);
	}

	async read(sessionId: string, query?: IAgentHostRoomMessageQuery): Promise<IRoomContext> {
		await this._ready;
		const binding = this._binding(sessionId);
		return this._queue.queue(binding.roomId, async () => {
			const record = this._record(binding.roomId);
			this._assertMemberTurn(record, binding.memberId);
			const page = await this.getMessages(binding.roomId, query);
			const inbox = record.messages.filter(message => message.deliveries.some(delivery => delivery.memberId === binding.memberId
				&& ['pending', 'submitted', 'steering', 'delivered'].includes(delivery.state)));
			const humanGuidance = record.messages.filter(message => message.authorKind === 'human' && message.mode === 'steer' && message.mentions.includes(binding.memberId)).slice(-10);
			const turnId = this._execution(record, binding.memberId).turnId;
			await this._save({
				...record, executions: record.executions.map(execution => execution.memberId === binding.memberId
					? { ...execution, readSequence: Math.max(execution.readSequence ?? 0, page.messages.at(-1)?.sequence ?? 0, humanGuidance.at(-1)?.sequence ?? 0) }
					: execution),
				messages: record.messages.map(message => ({
					...message,
					deliveries: message.deliveries.map(delivery => delivery.memberId === binding.memberId && ['pending', 'submitted', 'steering'].includes(delivery.state)
						? { ...delivery, state: message.mode === 'steer' ? 'delivered' : 'submitted', turnId, error: undefined }
						: delivery),
				})),
			});
			return { room: record.room, self: this._member(record, binding.memberId), ...page, inbox, humanGuidance };
		});
	}

	async readArtifact(sessionId: string, artifactId: string, offset = 0): Promise<IRoomArtifactContent> {
		await this._ready;
		const binding = this._binding(sessionId);
		const record = this._record(binding.roomId);
		this._assertMemberTurn(record, binding.memberId);
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new Error(localize('rooms.invalidArtifactOffset', "Use a nonnegative artifact offset."));
		}
		const artifact = record.room.artifacts.find(artifact => artifact.id === artifactId);
		if (!artifact) {
			throw new Error(localize('rooms.artifactNotFound', "The room artifact does not exist."));
		}
		const contents = await this._storage.readArtifact(record.room, artifact, paths => this._assertContentAccess(this._member(record, binding.memberId), paths));
		if (offset > contents.length) {
			throw new Error(localize('rooms.artifactOffsetPastEnd', "The artifact offset is past the end of the published patch."));
		}
		const text = contents.slice(offset, offset + 16000);
		const end = offset + text.length;
		return {
			artifact, patchPath: URI.parse(artifact.uri).fsPath, text, offset, totalCharacters: contents.length,
			...(end < contents.length ? { nextOffset: end } : {})
		};
	}

	async post(sessionId: string, options: IRoomAgentPost): Promise<IAgentHostRoomMessage> {
		await this._ready;
		const binding = this._binding(sessionId);
		const record = this._record(binding.roomId);
		if (this._execution(record, binding.memberId).readSequence === undefined) {
			throw new Error(localize('rooms.readFirst', "Read the room before posting or working."));
		}
		return this._post(binding.roomId, binding.memberId, options);
	}

	async sharePatch(sessionId: string, title: string): Promise<IAgentHostRoomArtifact> {
		await this._ready;
		this._text(title, 200);
		const binding = this._binding(sessionId);
		this.beforeTool(sessionId, 'room_share_patch');
		return this._queue.queue(binding.roomId, async () => {
			const record = this._record(binding.roomId);
			this._assertMemberTurn(record, binding.memberId);
			const member = this._member(record, binding.memberId);
			const artifact = await this._storage.publishPatch(record.room, member, title, paths => this._assertContentAccess(member, paths));
			const message: IAgentHostRoomMessage = {
				id: artifact.id, sequence: record.room.latestMessageSequence + 1, authorId: member.id, authorName: member.name, authorKind: 'agent',
				kind: 'artifact', text: title, timestamp: this._now(), mentions: [], artifactId: artifact.id, deliveries: [],
			};
			await this._save({
				...record, room: { ...record.room, latestMessageSequence: message.sequence, artifacts: [...record.room.artifacts, artifact] },
				messages: [...record.messages, message],
			});
			return artifact;
		});
	}

	beforeTool(sessionId: string, toolName: string, expectedTurnId?: string): void {
		const binding = this._binding(sessionId);
		const record = this._record(binding.roomId);
		this._assertMemberTurn(record, binding.memberId);
		if (expectedTurnId !== undefined && this._execution(record, binding.memberId).turnId !== expectedTurnId) {
			throw new Error(localize('rooms.unadmittedTurn', "This turn was not admitted by the collaboration room."));
		}
		if (roomExcludedTools.some(name => toolName === name || toolName.endsWith(`:${name}`) || toolName.endsWith(`.${name}`))) {
			throw new Error(localize('rooms.noDelegation', "Room members cannot launch nested agents. Collaborate with the existing room members instead."));
		}
		if (toolName === 'room_read' || toolName === 'room_post' || toolName === 'room_read_artifact') {
			return;
		}
		const execution = this._execution(record, binding.memberId);
		if (execution.readSequence === undefined || !execution.announced) {
			throw new Error(localize('rooms.announceFirst', "Read the shared room and post a work intention before using tools."));
		}
		if (record.messages.some(message => message.authorKind === 'human' && message.mode === 'steer'
			&& message.mentions.includes(binding.memberId) && message.sequence > execution.readSequence!)) {
			throw new Error(localize('rooms.newHumanGuidance', "New human guidance arrived. Call room_read, acknowledge it with a reply, and adjust your current work before continuing."));
		}
	}

	/**
	 * Content exclusion is evaluated by the member's own session, and the SDK only
	 * accepts paths inside that session's working directory — which is the member's
	 * worktree. Submitting the source repository's copy as well made every batch
	 * unsupported, so the check reported "unavailable" and, failing closed, rejected
	 * every share. The worktree is a checkout of the same repository, so its copy of
	 * a path carries the same policy.
	 */
	private async _assertContentAccess(member: IAgentHostRoomMember, paths: readonly string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		if (!this._runtime.assertContentAccess) {
			throw new Error(localize('rooms.contentExclusionsUnavailable', "Content exclusion checks are unavailable; the room cannot share this artifact."));
		}
		const worktreeUri = member.worktreeUri;
		if (!worktreeUri) {
			throw new Error(localize('rooms.noWorktreeForContentCheck', "The room member has no worktree to check against its content exclusion policy."));
		}
		await this._runtime.assertContentAccess(member.sessionUri, paths.map(path =>
			URI.joinPath(URI.parse(worktreeUri), path).fsPath));
	}

	private _schedule(roomId: string): void {
		const room = this._record(roomId).room;
		if (!this._closed && room.state === 'running' && room.run?.deadline !== undefined && !this._timers.has(roomId)) {
			this._timers.set(roomId, setTimeout(() => {
				void this.stopRoom(roomId).catch(error => this._logService.error('[AgentHostRooms] Deadline stop failed', error));
			}, Math.max(0, room.run.deadline - this._now())));
		}
		void this._queue.queue(roomId, () => this._admit(roomId)).catch(error => this._logService.error('[AgentHostRooms] Admission failed', error));
	}

	private async _admit(roomId: string): Promise<void> {
		let record = this._record(roomId);
		if (this._closed || this._stops.has(roomId) || record.room.state !== 'running' || !record.room.run) {
			return;
		}
		record = await this._reserveSteering(record);
		const run = record.room.run;
		if (!run) {
			return;
		}
		const remaining = run.limits.maxTurns === undefined ? MAX_ROOM_WORKERS : run.limits.maxTurns - run.admittedTurns;
		if ((run.deadline !== undefined && run.deadline <= this._now()) || remaining <= 0) {
			if (!record.executions.some(execution => execution.turnId)) {
				await this._save({ ...record, room: { ...record.room, state: 'idle' } });
				this._clearTimer(roomId);
			}
			return;
		}
		const ready = record.room.members.filter(member => {
			const execution = this._execution(record, member.id);
			return !member.removed && !this._memberStops.has(member.id) && ['pending', 'idle', 'blocked'].includes(member.state) && !execution.turnId && this._runtime.isIdle(member.sessionUri)
				&& !record.messages.some(message => message.deliveries.some(delivery => delivery.memberId === member.id && delivery.state === 'steering'))
				&& (execution.needsTurn || record.messages.some(message => message.deliveries.some(delivery => delivery.memberId === member.id && delivery.state === 'pending')));
		}).slice(0, remaining);
		if (!ready.length) {
			if (!record.executions.some(execution => execution.turnId)) {
				await this._save({ ...record, room: { ...record.room, state: 'idle' } });
				this._clearTimer(roomId);
			}
			return;
		}
		const turns = new Map(ready.map(member => [member.id, generateUuid()]));
		record = await this._save({
			...record,
			room: { ...record.room, run: { ...run, admittedTurns: run.admittedTurns + ready.length }, members: record.room.members.map(member => turns.has(member.id) ? { ...member, turns: member.turns + 1, state: 'starting', work: member.work ? { ...member.work, nextStep: undefined } : undefined } : member) },
			executions: record.executions.map(execution => turns.has(execution.memberId) ? { ...execution, turnId: turns.get(execution.memberId), runId: run.id, needsTurn: false, readSequence: undefined, announced: false } : execution),
			messages: record.messages.map(message => ({ ...message, deliveries: message.deliveries.map(delivery => turns.has(delivery.memberId) && delivery.state === 'pending' ? { ...delivery, state: 'submitted', turnId: turns.get(delivery.memberId) } : delivery) })),
		});
		for (const member of ready) {
			void this._launch(record, member.id, turns.get(member.id)!, run.id, member.work?.nextStep).catch(error => this._logService.error('[AgentHostRooms] Member launch failed', error));
		}
	}

	private async _reserveSteering(record: IRoomRecord): Promise<IRoomRecord> {
		const requests = record.room.members.flatMap(member => {
			const execution = this._execution(record, member.id);
			if (!execution.turnId || !execution.runId || !['working', 'needsInput'].includes(member.state)
				|| !this._canSubmit(record.room.id, member.id, execution.turnId, execution.runId)
				|| record.messages.some(message => message.deliveries.some(delivery => delivery.memberId === member.id && delivery.state === 'steering'))) {
				return [];
			}
			const messages = record.messages.filter(message => message.authorKind === 'human' && message.mode === 'steer'
				&& message.deliveries.some(delivery => delivery.memberId === member.id && delivery.state === 'pending' && delivery.turnId !== execution.turnId));
			return messages.length ? [{ member, turnId: execution.turnId, runId: execution.runId, messages }] : [];
		});
		if (!requests.length) {
			return record;
		}
		const saved = await this._save({
			...record,
			messages: record.messages.map(message => ({
				...message,
				deliveries: message.deliveries.map(delivery => {
					const request = requests.find(request => request.member.id === delivery.memberId && request.messages.some(item => item.id === message.id));
					return request ? { ...delivery, state: 'steering', turnId: request.turnId } : delivery;
				}),
			})),
		});
		for (const request of requests) {
			void this._sendSteering(saved.room.id, request.member, request.turnId, request.runId, request.messages)
				.catch(error => this._logService.error('[AgentHostRooms] Steering delivery failed', error));
		}
		return saved;
	}

	private async _sendSteering(roomId: string, member: IAgentHostRoomMember, turnId: string, runId: string, messages: readonly IAgentHostRoomMessage[]): Promise<void> {
		let accepted = false;
		let error: string | undefined;
		try {
			if (this._canSubmit(roomId, member.id, turnId, runId)) {
				accepted = await this._runtime.steer(member.sessionUri, turnId, [
					'New human guidance for your current collaboration work:',
					...messages.map(message => `[${message.id}] ${message.authorName}: ${message.text}`),
					'Read room_read for the shared context. Acknowledge this guidance with room_post replyTo the message ID and adjust the current plan at the next safe tool boundary.',
					'Address the human request first; do not restart the original broad task or duplicate completed peer work. Keep normal approvals and preserve unfinished changes.',
				].join('\n\n'));
			}
		} catch (err) {
			error = String(err);
			this._logService.error('[AgentHostRooms] Active-turn steering was not acknowledged', err);
		}
		await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			const execution = this._execution(record, member.id);
			const sameTurn = execution.turnId === turnId && execution.runId === runId;
			const state = error ? 'interrupted' : accepted ? sameTurn ? 'delivered' : 'completed' : 'pending';
			await this._save({
				...record,
				messages: record.messages.map(message => messages.some(sent => sent.id === message.id) ? {
					...message,
					deliveries: message.deliveries.map(delivery => delivery.memberId === member.id && delivery.turnId === turnId && delivery.state === 'steering'
						? { ...delivery, state, turnId, error }
						: delivery),
				} : message),
			});
		});
		this._schedule(roomId);
	}

	private async _launch(reservation: IRoomRecord, memberId: string, turnId: string, runId: string, nextStep?: string): Promise<void> {
		const roomId = reservation.room.id;
		const member = this._member(reservation, memberId);
		try {
			await this._storage.ensureWorktree(reservation.room, member, this._execution(reservation, member.id).initialized);
			if (!this._canSubmit(roomId, member.id, turnId, runId)) {
				await this._releaseUnsent(roomId, member.id, turnId);
				return;
			}
			await this._runtime.prepare(reservation.room, member, this._execution(reservation, member.id).initialized);
			let retryModelChange: boolean;
			do {
				retryModelChange = await this._queue.queue(roomId, async () => {
					const modelVersion = this._modelChangeVersions.get(member.id);
					let current = this._record(roomId);
					current = await this._save({ ...current, executions: current.executions.map(execution => execution.memberId === member.id ? { ...execution, initialized: true } : execution) });
					if (!this._canSubmit(roomId, member.id, turnId, runId)) {
						return false;
					}
					await this._runtime.applyConfiguration(this._member(current, member.id));
					if (!this._canSubmit(roomId, member.id, turnId, runId)) {
						return false;
					}
					if (modelVersion !== this._modelChangeVersions.get(member.id)) {
						return true;
					}
					try {
						current = await this._applyMemberModel(current, member.id);
					} catch (error) {
						if (this._canSubmit(roomId, member.id, turnId, runId) && modelVersion !== this._modelChangeVersions.get(member.id)) {
							return true;
						}
						throw error;
					}
					if (!this._canSubmit(roomId, member.id, turnId, runId)) {
						return false;
					}
					if (modelVersion !== this._modelChangeVersions.get(member.id)) {
						return true;
					}
					const inbox = current.messages.filter(message => message.deliveries.some(delivery => delivery.memberId === member.id && delivery.turnId === turnId && delivery.state === 'submitted'));
					// Advisory island model: peer work is surfaced on an interval so a shared
					// board cannot homogenise every member's approach within a few turns.
					const reviewPeers = this._member(current, member.id).turns % PEER_REVIEW_INTERVAL === 0;
					const continuation = !inbox.length && !nextStep;
					const prompt = [
						`You are ${member.name}, an equal peer in the shared collaboration room "${current.room.title}". There is no required lead.`,
						...(inbox.length ? [
							'PRIORITY: respond to the addressed messages below. This is a follow-up to existing work, not a request to start the whole project again.',
							...inbox.map(message => `${message.authorKind === 'human' ? 'Human' : 'Peer'} ${message.authorName} [${message.id}]: ${message.text}`),
							'Acknowledge the request publicly using room_post with replyTo set to its message ID. Explain concrete actions and results, or ask a focused question if blocked.',
						] : []),
						`Shared goal (background context): ${current.room.goal}`, `Room instructions: ${current.room.instructions}`,
						`Your only working tree is ${URI.parse(member.worktreeUri!).fsPath}. The original repository ${URI.parse(current.room.repositoryUri).fsPath} and other peers' worktrees are not shared writable folders. Do not copy or commit your work there.`,
						'Begin with room_read. It provides your identity, peer work, pending inbox, human guidance, and published artifacts. Empty files in your worktree do NOT mean peers have done nothing.',
						...(reviewPeers
							? ['This is a review turn. Read recent findings and inspect relevant published patches with room_read_artifact. Build on evidence rather than reimplementing completed work. A peer reporting success is a claim to verify, not proof.']
							: ['This is a solo turn. Pursue YOUR OWN approach rather than adopting a peer\'s, even if theirs looks promising; you will get a review turn shortly. Independent approaches are the reason this room has several members. Still avoid duplicating work a peer has already announced.']),
						'For a shared patch, inspect it, then use your normal approved shell tools to check and explicitly apply it ONLY inside your own worktree. Never copy files directly out of another peer workspace. Do not apply or merge into the original repository.',
						'Announce one concrete complementary work item with room_post kind "work" BEFORE edits. Coordinate overlapping work by addressing the existing owner, and reconsider if newer peer work is reported.',
						'Keep room posts short: intent, changed result, question, or evidence. Publish code with room_share_patch and link the artifact ID in findings, including failed approaches. Never claim a server or test works without verifying it.',
						...(current.room.continuous
							? ['The shared goal is open-ended and this room keeps running: there is always a further improvement to attempt. Do not stop because one avenue is finished. Supply nextStep with your intended follow-up, and never post repeated status updates or ask idle peers to confirm finished work.']
							: ['Do not repeat completion/status posts or ask idle peers to confirm a finished task. A finished avenue is a reason to wait, not to loop. Supply nextStep only for a specific unfinished useful action and omit it when done.']),
						...(continuation && current.room.continuous ? [
							'You were woken to continue, not to answer a new request. Review your own most recent result first, then choose ONE concrete improvement on it or a different approach you have not tried. Do not restart the whole task and do not re-announce work you already finished.',
						] : []),
						'Human guidance takes precedence over an older plan. On new guidance, acknowledge it, revise your work, and tell affected peers. Do not spawn nested agents, factories, or hidden teams. Preserve normal approvals and content exclusions.',
						'An earlier turn may have been interrupted. Inspect existing work before retrying any action; never assume an interrupted delivery or external operation completed.',
						...(nextStep ? [`Previously proposed next step: ${nextStep}`] : []),
					].join('\n\n');
					this._runtime.submit(member.sessionUri, turnId, prompt);
					return false;
				});
			} while (retryModelChange);
			if (!this._canSubmit(roomId, member.id, turnId, runId)) {
				await this._releaseUnsent(roomId, member.id, turnId);
			}
		} catch (error) {
			await this._onRuntimeEvent({ sessionUri: member.sessionUri, turnId, state: 'failed', error: String(error) });
		}
	}

	private async _releaseUnsent(roomId: string, memberId: string, turnId: string): Promise<void> {
		await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			if (this._execution(record, memberId).turnId !== turnId || !this._runtime.isIdle(this._member(record, memberId).sessionUri)) {
				return;
			}
			const paused = record.room.state === 'paused';
			await this._save({
				...record,
				room: { ...record.room, members: record.room.members.map(member => member.id === memberId && member.state === 'starting' ? { ...member, state: paused ? 'idle' : 'stopped' } : member) },
				executions: record.executions.map(execution => execution.memberId === memberId ? { ...execution, turnId: undefined, runId: undefined, needsTurn: paused } : execution),
				messages: record.messages.map(message => ({ ...message, deliveries: message.deliveries.map(delivery => delivery.memberId === memberId && delivery.turnId === turnId && delivery.state === 'submitted' ? { ...delivery, state: paused ? 'pending' : 'cancelled', turnId: undefined } : delivery) })),
			});
		});
	}

	private async _onRuntimeEvent(event: IRoomRuntimeEvent): Promise<void> {
		await this._ready;
		const binding = this._sessions.get(event.sessionUri);
		if (!binding || this._closed) {
			return;
		}
		await this._queue.queue(binding.roomId, async () => {
			const record = this._record(binding.roomId);
			const execution = this._execution(record, binding.memberId);
			if (['stopping', 'stopped'].includes(record.room.state) || ['stopping', 'stopped'].includes(this._member(record, binding.memberId).state)
				|| !execution.turnId || !execution.runId || execution.runId !== record.room.run?.id || (event.turnId && execution.turnId !== event.turnId)) {
				return;
			}
			const finished = ['idle', 'failed', 'stopped'].includes(event.state);
			const member = this._member(record, binding.memberId);
			await this._save({
				...record,
				room: {
					...record.room, members: record.room.members.map(item => item.id === member.id ? {
						...item, state: event.state === 'idle' && item.work?.blocked ? 'blocked' : event.state, activity: event.activity, error: event.error,
					} : item),
				},
				executions: record.executions.map(item => item.memberId === member.id && finished ? { ...item, turnId: undefined, runId: undefined, needsTurn: event.state === 'idle' && !member.work?.blocked && (!!member.work?.nextStep || record.room.continuous === true) } : item),
				messages: finished ? record.messages.map(message => ({
					...message, deliveries: message.deliveries.map(delivery => delivery.memberId === member.id && delivery.turnId === execution.turnId && ['submitted', 'delivered'].includes(delivery.state)
						? { ...delivery, state: event.state === 'idle' ? 'completed' : event.state === 'stopped' ? 'cancelled' : 'failed', error: event.error } : delivery),
				})) : record.messages,
			});
		});
		this._schedule(binding.roomId);
	}

	private _canSubmit(roomId: string, memberId: string, turnId: string, runId: string): boolean {
		const record = this._record(roomId);
		const execution = this._execution(record, memberId);
		return !this._closed && !this._stops.has(roomId) && !this._memberStops.has(memberId) && record.room.state === 'running' && record.room.run?.id === runId && (record.room.run.deadline === undefined || record.room.run.deadline > this._now()) && execution.turnId === turnId && execution.runId === runId && this._member(record, memberId).state !== 'stopping';
	}

	private _assertMemberTurn(record: IRoomRecord, memberId: string): void {
		const execution = this._execution(record, memberId);
		if (this._closed || ['stopping', 'stopped'].includes(this._member(record, memberId).state) || !execution.turnId || !execution.runId || execution.runId !== record.room.run?.id || !['running', 'paused'].includes(record.room.state) || (record.room.run.deadline !== undefined && record.room.run.deadline <= this._now())) {
			throw new Error(localize('rooms.noActiveTurn', "This room member has no active authorized turn."));
		}
	}

	private _binding(sessionId: string) {
		const binding = this._sessions.get(AgentSession.uri('copilotcli', sessionId).toString());
		if (!binding) {
			throw new Error(localize('rooms.noBinding', "The session is not a room member."));
		}
		return binding;
	}

	private _record(roomId: string): IRoomRecord {
		const record = this._records.get(roomId);
		if (!record) {
			throw new Error(localize('rooms.notFound', "The room does not exist."));
		}
		return record;
	}

	private _member(record: IRoomRecord, memberId: string): IAgentHostRoomMember {
		const member = record.room.members.find(member => member.id === memberId);
		if (!member) {
			throw new Error(localize('rooms.memberNotFound', "The room member does not exist."));
		}
		return member;
	}

	private _execution(record: IRoomRecord, memberId: string): IRoomMemberExecution {
		return record.executions.find(execution => execution.memberId === memberId)!;
	}

	private async _save(record: IRoomRecord): Promise<IRoomRecord> {
		const next: IRoomRecord = { ...record, room: { ...record.room, revision: record.room.revision + 1, updatedAt: this._now() } };
		try {
			await this._storage.save(next);
		} catch (error) {
			// Do not admit more work when the write-ahead journal is unavailable.
			this._persistenceError = String(error);
			this._closed = true;
			for (const current of this._records.values()) {
				for (const execution of current.executions) {
					if (execution.turnId) {
						void this._runtime.abort(this._member(current, execution.memberId).sessionUri, execution.turnId).catch(abortError => this._logService.error('[AgentHostRooms] Abort after persistence failure failed', abortError));
					}
				}
			}
			throw error;
		}
		this._records.set(next.room.id, next);
		this._onDidChangeRoom.fire(next.room);
		return next;
	}

	private _text(value: string, limit: number): void {
		if (typeof value !== 'string' || !value.trim() || value.length > limit) {
			throw new Error(localize('rooms.invalidText', "Provide nonempty text of at most {0} characters.", limit));
		}
	}

	private _assertOpen(): void {
		if (this._closed) {
			if (this._persistenceError) {
				throw new Error(localize('rooms.persistenceFailed', "The room stopped because its state could not be saved: {0}. Restart the application after resolving the storage error.", this._persistenceError));
			}
			throw new Error(localize('rooms.closed', "The room host is shutting down."));
		}
	}

	private _clearTimer(roomId: string): void {
		clearTimeout(this._timers.get(roomId));
		this._timers.delete(roomId);
	}

	async shutdown(): Promise<void> {
		await this._ready;
		this._closed = true;
		// A room that never ran has nothing to cancel; marking it stopped would claim
		// on the next launch that work had been interrupted.
		const active = [...this._records.values()].filter(record => record.room.run
			|| record.executions.some(execution => execution.turnId)
			|| ['running', 'idle', 'paused', 'stopping'].includes(record.room.state));
		await Promise.all(active.map(record => this.stopRoom(record.room.id)));
	}

	override dispose(): void {
		this._closed = true;
		for (const timer of this._timers.values()) {
			clearTimeout(timer);
		}
		this._timers.clear();
		this._modelChangeVersions.clear();
		super.dispose();
	}
}
