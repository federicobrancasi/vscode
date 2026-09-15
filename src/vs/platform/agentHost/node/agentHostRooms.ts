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
import { generateAgentHostRoomMemberName, isAgentHostRoomMemberName } from '../common/agentHostRoomNames.js';
import { AgentHostRoomCoordinatorEventKind, AgentHostRoomMessageKind, AgentHostRoomVerificationState, defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomAssignOptions, IAgentHostRoomConfiguration, IAgentHostRoomCoordinator, IAgentHostRoomCoordinatorSnapshot, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery, IAgentHostRoomPostOptions, IAgentHostRoomPublishResultOptions, IAgentHostRoomsService, IAgentHostRoomVerifyResultOptions, MAX_ROOM_WORKERS, newAgentHostRoomConfiguration } from '../common/agentHostRooms.js';
import { AgentSession } from '../common/agentService.js';
import { ResolveSessionConfigResult } from '../common/state/protocol/commands.js';
import { buildDefaultChatUri, ModelSelection } from '../common/state/sessionState.js';
import { intersectRoomConfigurations, parseRoomConfiguration, validateRoomConfigurationChange } from './agentHostRoomsConfiguration.js';
import { projectAgentHostRoomCoordinatorSnapshot } from './agentHostRoomCoordinator.js';
import { getRoomMemberModel, parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomMemberExecution, IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomSessionParticipant, IRoomStorage, roomCoordinatorExclusiveTools, roomCoordinatorTools, roomExcludedTools } from './agentHostRoomsTypes.js';

export interface IRoomAgentPost extends IAgentHostRoomPostOptions {
	readonly kind?: 'message' | 'work' | 'finding';
	readonly blocked?: boolean;
}

/** Narrow, host-only capability captured by a member's SDK tool handlers. */
export interface IRoomSessionTools {
	isRoomSession(sessionId: string): boolean;
	read(sessionId: string, query?: IAgentHostRoomMessageQuery): Promise<IRoomContext>;
	readArtifact(sessionId: string, artifactId: string, offset?: number): Promise<IRoomArtifactContent>;
	post(sessionId: string, options: IRoomAgentPost): Promise<IAgentHostRoomMessage>;
	publishResult(sessionId: string, options: IAgentHostRoomPublishResultOptions): Promise<IAgentHostRoomMessage>;
	reviewResult(sessionId: string, options: IAgentHostRoomVerifyResultOptions): Promise<IAgentHostRoomMessage>;
	sharePatch(sessionId: string, title: string): Promise<IAgentHostRoomArtifact>;
	beforeTool(sessionId: string, toolName: string, expectedTurnId?: string): void;
}

export interface IRoomCoordinatorTools {
	isCoordinatorSession(sessionId: string): boolean;
	coordinatorSnapshot(sessionId: string): Promise<IAgentHostRoomCoordinatorSnapshot>;
	assign(sessionId: string, options: IAgentHostRoomAssignOptions): Promise<IAgentHostRoomMessage>;
	postCoordinationNote(sessionId: string, id: string, text: string): Promise<IAgentHostRoomMessage>;
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

const CONTINUE_ROOM_PROMPT = 'Continue working in the existing collaboration room.';
const MAX_ACTIVE_COORDINATOR_ASSIGNMENTS = 20;
const CONTINUE_AFTER_TURN_PROMPT = [
	'Share meaningful completed work with room_publish_result, including evidence, and publish changed code with room_share_patch. Use room_post for focused questions and conversational replies.',
	'Call room_read with after set to the latest sequence you saw, review peer ideas and feedback, and independently verify a useful peer result when appropriate. Never verify your own result.',
	'Ask a focused question in the room if you need help.',
].join('\n\n');

function buildHumanGuidancePrompt(messages: readonly IAgentHostRoomMessage[]): string {
	return [
		'New human guidance for your current collaboration work:',
		...messages.map(message => `[${message.id}] ${message.authorName}: ${message.text}`),
		'Prioritize the human request. Call room_read for the shared context, then continue from the existing work without restarting the original task.',
	].join('\n\n');
}

function resolveRoomMemberNames(value: unknown, workerCount: number): string[] {
	if (value === undefined) {
		const names: string[] = [];
		for (let index = 0; index < workerCount; index++) {
			names.push(generateAgentHostRoomMemberName(names));
		}
		return names;
	}
	if (!Array.isArray(value) || value.length !== workerCount) {
		throw new Error(localize('rooms.invalidMemberNames', "Provide exactly one name per room member."));
	}
	const names: string[] = [];
	const normalized = new Set<string>();
	for (const name of value) {
		if (typeof name !== 'string' || !isAgentHostRoomMemberName(name)) {
			throw new Error(localize('rooms.invalidMemberName', "Room member names must be lowercase kebab-case identifiers."));
		}
		const key = name.toLowerCase();
		if (normalized.has(key)) {
			throw new Error(localize('rooms.duplicateMemberName', "Room member names must be unique."));
		}
		normalized.add(key);
		names.push(name);
	}
	return names;
}

function buildRoomTurnPrompt(room: IAgentHostRoom, member: IAgentHostRoomMember, inbox: readonly IAgentHostRoomMessage[], briefed: boolean, resumed: boolean): string {
	if (briefed) {
		const humanGuidance = inbox.filter(message => message.authorKind === 'human');
		return humanGuidance.length ? buildHumanGuidancePrompt(humanGuidance) : resumed ? CONTINUE_ROOM_PROMPT : CONTINUE_AFTER_TURN_PROMPT;
	}
	return [
		`You are ${member.name} in the shared collaboration room "${room.title}".`,
		`Shared goal: ${room.goal}`,
		`Room instructions: ${room.instructions}`,
		`Your only working tree is ${URI.parse(member.worktreeUri!).fsPath}. The original repository ${URI.parse(room.repositoryUri).fsPath} and other peers' worktrees are not shared writable folders. Do not copy or commit your work there.`,
		'Begin by calling room_read. It provides your identity, peer work, pending inbox, human guidance, published artifacts, and ordered message sequences.',
		'Work privately for as many turns as needed. Do not post routine progress or announce work before editing.',
		'After meaningful implementation or investigation, publish a structured result with room_publish_result, including evidence, and share a Git patch when code changed. Use room_post for focused questions and conversational replies.',
		'After publishing, read newer room entries and independently verify a useful peer result when appropriate. Never verify your own result.',
		'Use useful peer evidence or reply when that improves the result. If peer ideas are not useful, continue improving your own approach. Human guidance has priority; peer messages are optional evidence.',
		'For a shared patch, inspect it with room_read_artifact, then use your normal approved shell tools to check and explicitly apply it ONLY inside your own worktree. Never copy files directly out of another peer workspace. Do not apply or merge into the original repository.',
		'Do not spawn nested agents, factories, or hidden teams. Preserve normal approvals and content exclusions.',
		'An earlier turn may have been interrupted. Inspect existing work before retrying any action; never assume an interrupted delivery or external operation completed.',
	].join('\n\n');
}

/**
 * The room is a separate durable authority, not an AHP queued message.
 * All admissions are journalled before touching the runtime.
 */
export class AgentHostRooms extends Disposable implements IAgentHostRoomsService, IRoomSessionTools, IRoomCoordinatorTools {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeRoom = this._register(new Emitter<IAgentHostRoom>());
	readonly onDidChangeRoom = this._onDidChangeRoom.event;
	private readonly _records = new Map<string, IRoomRecord>();
	private readonly _sessions = new Map<string, { roomId: string; memberId: string }>();
	private readonly _coordinatorSessions = new Map<string, string>();
	private readonly _queue = new SequencerByKey<string>();
	private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _stops = new Map<string, Promise<IAgentHostRoom>>();
	private readonly _memberStops = new Map<string, Promise<IAgentHostRoom>>();
	private readonly _coordinatorPreparations = new Map<string, Promise<IAgentHostRoomCoordinator>>();
	private readonly _modelChangeVersions = new Map<string, number>();
	private readonly _resumePrompts = new Set<string>();
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
					coordinator: stored.room.coordinator ? {
						...stored.room.coordinator,
						chatUri: stored.room.coordinator.chatUri ?? buildDefaultChatUri(stored.room.coordinator.sessionUri),
					} : undefined,
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
			const coordinatorInterrupted = record.room.coordinator?.turnId !== undefined;
			const restored: IRoomRecord = interrupted || coordinatorInterrupted ? {
				...record,
				room: {
					...record.room, revision: record.room.revision + 1, updatedAt: this._now(), state: interrupted ? 'interrupted' : record.room.state,
					coordinator: coordinatorInterrupted ? {
						...record.room.coordinator,
						state: 'interrupted',
						turnId: undefined,
						activeEventSequence: undefined,
						activeEvents: undefined,
						pendingEvents: [...new Set([...record.room.coordinator.pendingEvents, ...(record.room.coordinator.activeEvents ?? [])])],
						nextEventTurnAt: undefined,
						error: localize('rooms.coordinatorInterrupted', "The coordinator turn was interrupted when the host stopped."),
					} : record.room.coordinator,
					members: interrupted
						? record.room.members.map(member => ['starting', 'working', 'needsInput', 'stopping'].includes(member.state) ? { ...member, state: 'interrupted', activity: undefined } : member)
						: record.room.members,
				},
				executions: interrupted ? record.executions.map(execution => ({ ...execution, turnId: undefined, runId: undefined })) : record.executions,
				messages: interrupted ? record.messages.map(message => ({
					...message,
					deliveries: message.deliveries.map(delivery => ['submitted', 'steering', 'delivered'].includes(delivery.state) ? { ...delivery, state: 'interrupted' } : delivery),
				})) : record.messages,
			} : record;
			if (interrupted || coordinatorInterrupted) {
				await this._storage.save(restored);
			}
			this._records.set(restored.room.id, restored);
			for (const member of restored.room.members) {
				this._sessions.set(member.sessionUri, { roomId: restored.room.id, memberId: member.id });
			}
			if (restored.room.coordinator) {
				this._coordinatorSessions.set(restored.room.coordinator.sessionUri, restored.room.id);
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
		return {
			version: 1 as const,
			available: !this._closed,
			maxWorkers: MAX_ROOM_WORKERS,
			supportsSteering: true,
			supportsConfiguration: true,
			supportsMemberModels: true,
			supportsStructuredResults: true,
			supportsResultVerification: true,
			supportsCoordinator: true,
		};
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

	async ensureCoordinator(roomId: string): Promise<IAgentHostRoomCoordinator> {
		await this._ready;
		this._assertOpen();
		const existing = this._coordinatorPreparations.get(roomId);
		if (existing) {
			return existing;
		}
		const preparation = this._ensureCoordinator(roomId);
		this._coordinatorPreparations.set(roomId, preparation);
		try {
			return await preparation;
		} finally {
			this._coordinatorPreparations.delete(roomId);
		}
	}

	private async _ensureCoordinator(roomId: string): Promise<IAgentHostRoomCoordinator> {
		let coordinator = await this._queue.queue(roomId, async () => {
			let record = this._record(roomId);
			if (!record.room.coordinator) {
				const id = generateUuid();
				const sessionUri = AgentSession.uri('copilotcli', generateUuid()).toString();
				record = await this._save({
					...record,
					room: {
						...record.room,
						coordinator: {
							id,
							name: localize('rooms.coordinatorName', "Coordinator"),
							sessionUri,
							chatUri: buildDefaultChatUri(sessionUri),
							worktreeUri: this._storage.worktreeUri(roomId, id),
							state: 'pending',
							initialized: false,
							cursor: 0,
							eventSequence: 0,
							eventCursor: 0,
							pendingEvents: [],
						},
					},
				});
				this._coordinatorSessions.set(sessionUri, roomId);
			}
			return record.room.coordinator!;
		});
		const participant = this._coordinatorParticipant(coordinator);
		try {
			await this._storage.ensureWorktree(this._record(roomId).room, participant, coordinator.initialized);
			await this._runtime.prepare(this._record(roomId).room, participant, coordinator.initialized);
			await this._runtime.applyConfiguration(participant);
			coordinator = await this._queue.queue(roomId, async () => {
				let record = this._record(roomId);
				record = await this._applyCoordinatorModel(record);
				const prepared = {
					...record.room.coordinator!,
					initialized: true,
					state: 'idle' as const,
					error: undefined,
				};
				return (await this._save({ ...record, room: { ...record.room, coordinator: prepared } })).room.coordinator!;
			});
		} catch (error) {
			await this._queue.queue(roomId, async () => {
				const record = this._record(roomId);
				if (!record.room.coordinator) {
					return;
				}
				await this._save({
					...record,
					room: {
						...record.room,
						coordinator: { ...record.room.coordinator, state: 'offline', turnId: undefined, activeEventSequence: undefined, activeEvents: undefined, error: String(error) },
					},
				});
			});
			throw error;
		}
		this._scheduleCoordinator(roomId);
		return coordinator;
	}

	async getCoordinator(roomId: string): Promise<IAgentHostRoomCoordinator | undefined> {
		await this._ready;
		return this._record(roomId).room.coordinator;
	}

	async setCoordinatorModel(roomId: string, model: ModelSelection | undefined): Promise<IAgentHostRoomCoordinator> {
		await this._ready;
		this._assertOpen();
		const selection = parseRoomModelSelection(model ?? { id: 'auto' });
		this._runtime.validateModel(selection);
		return this._queue.queue(roomId, async () => {
			let record = this._record(roomId);
			if (!record.room.coordinator) {
				throw new Error(localize('rooms.noCoordinator', "The room coordinator has not been created."));
			}
			const current = record.room.coordinator;
			if (equals(current.desiredModel, selection) && !current.modelError) {
				return current;
			}
			record = await this._save({
				...record,
				room: {
					...record.room,
					coordinator: { ...current, desiredModel: selection, pendingModel: selection, modelError: undefined },
				},
			});
			this._runtime.publishModel(this._coordinatorParticipant(record.room.coordinator!));
			if (record.room.coordinator!.initialized && !record.room.coordinator!.turnId && this._runtime.isIdle(record.room.coordinator!.sessionUri)) {
				record = await this._applyCoordinatorModel(record);
			}
			return record.room.coordinator!;
		});
	}

	async getCoordinatorSnapshot(roomId: string): Promise<IAgentHostRoomCoordinatorSnapshot> {
		await this._ready;
		return projectAgentHostRoomCoordinatorSnapshot(this._record(roomId));
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

	private _coordinatorParticipant(coordinator: IAgentHostRoomCoordinator): IRoomSessionParticipant {
		return {
			id: coordinator.id,
			sessionUri: coordinator.sessionUri,
			chatUri: coordinator.chatUri,
			worktreeUri: coordinator.worktreeUri,
			model: coordinator.desiredModel?.id,
			modelSelection: coordinator.appliedModel,
			pendingModel: coordinator.pendingModel,
			configuration: { ...newAgentHostRoomConfiguration },
		};
	}

	private async _applyCoordinatorModel(record: IRoomRecord): Promise<IRoomRecord> {
		const coordinator = record.room.coordinator;
		if (!coordinator) {
			return record;
		}
		const participant = this._coordinatorParticipant(coordinator);
		let applied: ModelSelection | undefined;
		try {
			const requested = coordinator.pendingModel ?? coordinator.desiredModel ?? this._runtime.getModel(participant);
			if (requested) {
				this._runtime.validateModel(requested);
				await this._runtime.applyModel(participant, requested);
			}
			applied = requested ?? this._runtime.getModel(participant);
		} catch (error) {
			await this._save({
				...record,
				room: {
					...record.room,
					coordinator: { ...coordinator, modelError: String(error) },
				},
			});
			throw error;
		}
		const updated = { ...coordinator, appliedModel: applied, pendingModel: undefined, modelError: undefined };
		return equals(coordinator, updated) ? record : this._save({
			...record,
			room: { ...record.room, coordinator: updated },
		});
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
		const memberNames = resolveRoomMemberNames(options.memberNames, options.workerCount);
		const fallback = options.model === undefined ? undefined : parseRoomModelSelection({ id: options.model });
		const coordinatorModel = options.coordinatorModel === undefined ? undefined : parseRoomModelSelection(options.coordinatorModel);
		if (coordinatorModel) {
			this._runtime.validateModel(coordinatorModel);
		}
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
		const coordinatorId = generateUuid();
		const coordinatorSessionUri = AgentSession.uri('copilotcli', generateUuid()).toString();
		const coordinator: IAgentHostRoomCoordinator = {
			id: coordinatorId,
			name: localize('rooms.coordinatorName', "Coordinator"),
			sessionUri: coordinatorSessionUri,
			chatUri: buildDefaultChatUri(coordinatorSessionUri),
			worktreeUri: this._storage.worktreeUri(id, coordinatorId),
			desiredModel: coordinatorModel,
			pendingModel: coordinatorModel,
			state: 'pending',
			initialized: false,
			cursor: 0,
			eventSequence: 0,
			eventCursor: 0,
			pendingEvents: [],
		};
		const members: IAgentHostRoomMember[] = Array.from({ length: options.workerCount }, (_, index) => {
			const memberId = generateUuid();
			const sessionUri = AgentSession.uri('copilotcli', generateUuid()).toString();
			return {
				id: memberId, name: memberNames[index], sessionUri, chatUri: buildDefaultChatUri(sessionUri),
				model: models[index]?.id, pendingModel: models[index], state: 'pending', turns: 0, worktreeUri: this._storage.worktreeUri(id, memberId),
				configuration: { ...newAgentHostRoomConfiguration },
			};
		});
		const room: IAgentHostRoom = {
			id, title: options.title.trim(), goal: options.goal.trim(), instructions: options.instructions ?? '',
			...repository, createdAt: now, updatedAt: now, revision: 1, state: 'created',
			coordinator, members, artifacts: [], latestMessageSequence: 0,
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
		this._coordinatorSessions.set(coordinator.sessionUri, id);
		this._onDidChangeRoom.fire(room);
		return room;
	}

	async getMessages(roomId: string, query: IAgentHostRoomMessageQuery = {}): Promise<IAgentHostRoomMessagePage> {
		await this._ready;
		const messages = this._record(roomId).messages;
		const limit = Math.max(1, Math.min(200, Number.isInteger(query.limit) ? query.limit! : 100));
		const matching = messages.filter(message => (query.after === undefined || message.sequence > query.after) && (query.before === undefined || message.sequence < query.before));
		const page = query.after !== undefined ? matching.slice(0, limit) : matching.slice(-limit);
		return {
			messages: page.map(message => message.result ? {
				...message,
				result: { ...message.result, verificationState: this._verificationState(messages, message.id) },
			} : message),
			hasEarlier: !!page.length && messages[0].sequence < page[0].sequence,
			hasLater: !!page.length && messages[messages.length - 1].sequence > page[page.length - 1].sequence,
		};
	}

	async postMessage(roomId: string, message: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage> {
		await this._ready;
		return this._post(roomId, undefined, message);
	}

	async verifyResult(roomId: string, verification: IAgentHostRoomVerifyResultOptions): Promise<IAgentHostRoomMessage> {
		await this._ready;
		return this._verifyResult(roomId, undefined, verification);
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
			this._messageId(options.id);
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
			const isWork = author && (kind === 'work' || kind === 'finding');
			const updated: IRoomRecord = {
				...record,
				room: {
					...record.room, latestMessageSequence: message.sequence,
					state: record.room.state === 'idle' && mentions.length && this._hasRunCapacity(record.room) ? 'running' : record.room.state,
					members: record.room.members.map(member => isWork && member.id === author.id ? {
						...member, work: { description: options.text, blocked: options.blocked === true, updatedAt: this._now() },
					} : member),
				},
				messages: [...record.messages, message],
			};
			const events: AgentHostRoomCoordinatorEventKind[] = ['activity'];
			if (options.blocked === true) {
				events.push('blocked');
			}
			const persisted = author ? this._withCoordinatorEvents(updated, events) : this._wakeHumanRecipients(updated, mentions);
			await this._save(persisted);
			return message;
		});
		this._schedule(roomId);
		if (memberId) {
			this._scheduleCoordinator(roomId);
		}
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

	private _wakeHumanRecipients(record: IRoomRecord, recipients: readonly string[], resumeStopped = false): IRoomRecord {
		const targets = new Set(recipients.filter(id => !this._memberStops.has(id)
			&& (resumeStopped || !['stopped', 'interrupted'].includes(this._member(record, id).state))));
		if (!targets.size || record.room.state === 'paused' || record.room.state === 'stopping' || this._stops.has(record.room.id)
			|| (!resumeStopped && ['stopped', 'interrupted'].includes(record.room.state))) {
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
		for (const match of options.text.matchAll(/@(?<name>[a-z0-9]+(?:-[a-z0-9]+)+)\b/gi)) {
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
		const resumedMembers: string[] = [];
		const room = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			const record = this._record(roomId);
			if (record.room.state === 'paused' && record.room.run && !this._stops.has(roomId)
				&& !record.room.members.some(member => this._memberStops.has(member.id)) && record.executions.some(execution => execution.turnId)) {
				if ((limits.maxTurns !== undefined && limits.maxTurns !== record.room.run.limits.maxTurns)
					|| (limits.timeoutMinutes !== undefined && limits.timeoutMinutes !== record.room.run.limits.timeoutMinutes)) {
					throw new Error(localize('rooms.activeRunLimits', "Resume keeps the current run limits. Stop the room before changing limits."));
				}
				for (const execution of record.executions) {
					if (execution.needsTurn && !execution.turnId) {
						resumedMembers.push(execution.memberId);
					}
				}
				await this._applyMemberConfigurations(record);
				return (await this._save({ ...record, room: { ...record.room, state: 'running' } })).room;
			}
			if (record.room.state === 'running' || record.room.state === 'stopping' || this._stops.has(roomId) || record.room.members.some(member => this._memberStops.has(member.id)) || record.executions.some(execution => execution.turnId)) {
				throw new Error(localize('rooms.alreadyRunning', "Wait for the active room turns to finish before starting a new run."));
			}
			const now = this._now();
			for (const execution of record.executions) {
				resumedMembers.push(execution.memberId);
			}
			return (await this._save({
				...record,
				room: {
					...record.room, state: 'running', error: undefined,
					run: { id: generateUuid(), startedAt: now, deadline: limits.timeoutMinutes === undefined ? undefined : now + Math.ceil(limits.timeoutMinutes * 60000), limits: { ...limits }, admittedTurns: 0 },
					members: record.room.members.map(member => ({ ...member, state: 'idle', error: undefined })),
				},
				executions: record.executions.map(execution => ({ ...execution, needsTurn: true })),
			})).room;
		});
		for (const memberId of resumedMembers) {
			this._resumePrompts.add(memberId);
		}
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
			const taken = new Set(record.room.members.map(member => member.name));
			const member: IAgentHostRoomMember = {
				id: memberId, name: generateAgentHostRoomMemberName(taken), sessionUri, chatUri: buildDefaultChatUri(sessionUri),
				model: selection?.id, pendingModel: selection, state: 'pending', turns: 0,
				worktreeUri: this._storage.worktreeUri(roomId, memberId),
				configuration: { ...newAgentHostRoomConfiguration },
			};
			const saved = await this._save(this._withCoordinatorEvents({
				...record,
				room: { ...record.room, members: [...record.room.members, member] },
				executions: [...record.executions, { memberId, initialized: false, needsTurn: true }],
			}, ['memberAdded']));
			this._sessions.set(sessionUri, { roomId, memberId });
			return saved.room;
		});
		this._schedule(roomId);
		this._scheduleCoordinator(roomId);
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
			return (await this._save(this._withCoordinatorEvents({
				...current,
				room: {
					...current.room,
					members: current.room.members.map(item => item.id === memberId
						? { ...item, removed: true, state: 'stopped', activity: undefined, work: undefined } : item),
				},
				executions: current.executions.map(execution => execution.memberId === memberId
					? { ...execution, needsTurn: false, turnId: undefined, runId: undefined } : execution),
			}, ['memberRemoved']))).room;
		});
		this._resumePrompts.delete(memberId);
		this._schedule(roomId);
		this._scheduleCoordinator(roomId);
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
			// Resume explicitly reopens admission for a stopped peer. Human messages
			// alone stay pending while that peer is stopped.
			const woken = this._wakeHumanRecipients({
				...record,
				executions: record.executions.map(execution => execution.memberId === memberId ? { ...execution, turnId: undefined, runId: undefined } : execution),
			}, [memberId], true);
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
		this._resumePrompts.add(memberId);
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

	isCoordinatorSession(sessionId: string): boolean {
		return this._coordinatorSessions.has(AgentSession.uri('copilotcli', sessionId).toString());
	}

	isCoordinatorSessionUri(sessionUri: string): boolean {
		return this._coordinatorSessions.has(sessionUri);
	}

	isCoordinatorChat(sessionUri: string, chatUri: string): boolean {
		const roomId = this._coordinatorSessions.get(sessionUri);
		return roomId !== undefined && this._record(roomId).room.coordinator?.chatUri === chatUri;
	}

	isCoordinatorAdmittedTurn(sessionUri: string, chatUri: string, turnId: string): boolean {
		const roomId = this._coordinatorSessions.get(sessionUri);
		const coordinator = roomId === undefined ? undefined : this._record(roomId).room.coordinator;
		return coordinator?.chatUri === chatUri && coordinator.turnId === turnId;
	}

	isCoordinatorDirectTurnAvailable(sessionUri: string, chatUri: string): boolean {
		const roomId = this._coordinatorSessions.get(sessionUri);
		const coordinator = roomId === undefined ? undefined : this._record(roomId).room.coordinator;
		return coordinator?.chatUri === chatUri && coordinator.turnId === undefined;
	}

	async getCoordinatorModelForChat(sessionUri: string, chatUri: string): Promise<ModelSelection | undefined> {
		await this._ready;
		const roomId = this._coordinatorSessions.get(sessionUri);
		const coordinator = roomId === undefined ? undefined : this._record(roomId).room.coordinator;
		return coordinator?.chatUri === chatUri ? coordinator.desiredModel ?? coordinator.appliedModel : undefined;
	}

	async setCoordinatorModelForChat(sessionUri: string, chatUri: string, model: ModelSelection): Promise<void> {
		await this._ready;
		const roomId = this._coordinatorSessions.get(sessionUri);
		if (roomId !== undefined && this._record(roomId).room.coordinator?.chatUri === chatUri) {
			await this.setCoordinatorModel(roomId, model);
		}
	}

	async getCoordinatorTurnSnapshot(sessionUri: string, chatUri: string, turnId: string): Promise<IAgentHostRoomCoordinatorSnapshot | undefined> {
		await this._ready;
		const roomId = this._coordinatorSessions.get(sessionUri);
		if (roomId === undefined) {
			return undefined;
		}
		return this._queue.queue(roomId, async () => {
			let record = this._record(roomId);
			const coordinator = record.room.coordinator;
			if (!coordinator || coordinator.chatUri !== chatUri || (coordinator.turnId !== undefined && coordinator.turnId !== turnId)) {
				return undefined;
			}
			const snapshot = projectAgentHostRoomCoordinatorSnapshot(record);
			if (coordinator.cursor < record.room.latestMessageSequence) {
				record = await this._save({
					...record,
					room: { ...record.room, coordinator: { ...coordinator, cursor: record.room.latestMessageSequence } },
				});
			}
			return snapshot;
		});
	}

	async coordinatorSnapshot(sessionId: string): Promise<IAgentHostRoomCoordinatorSnapshot> {
		await this._ready;
		this.beforeTool(sessionId, 'room_coordinator_snapshot');
		const roomId = this._coordinatorBinding(sessionId);
		return projectAgentHostRoomCoordinatorSnapshot(this._record(roomId));
	}

	async assign(sessionId: string, options: IAgentHostRoomAssignOptions): Promise<IAgentHostRoomMessage> {
		await this._ready;
		this.beforeTool(sessionId, 'room_assign');
		const roomId = this._coordinatorBinding(sessionId);
		const message = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			let record = this._record(roomId);
			const coordinator = record.room.coordinator!;
			this._messageId(options.id);
			this._text(options.description, 8000);
			const expectedEvidence = this._evidence(options.expectedEvidence);
			const existing = record.messages.find(candidate => candidate.id === options.id);
			if (options.kind !== 'work' && options.kind !== 'verification') {
				throw new Error(localize('rooms.invalidAssignmentKind', "Choose a work or verification assignment."));
			}
			if (!Array.isArray(options.assignees) || options.assignees.length < 1 || options.assignees.length > MAX_ROOM_WORKERS) {
				throw new Error(localize('rooms.invalidAssignmentAssignees', "Assign one or more current room members."));
			}
			const assigneeIds = [...new Set(options.assignees.map(value => {
				const member = record.room.members.find(candidate => !candidate.removed && (candidate.id === value || candidate.name.toLowerCase() === String(value).toLowerCase()));
				if (!member) {
					throw new Error(localize('rooms.invalidAssignmentAssignee', "An assignment assignee is not a current room member."));
				}
				return member.id;
			}))];
			if (assigneeIds.length !== options.assignees.length) {
				throw new Error(localize('rooms.duplicateAssignmentAssignee', "Assignment assignees must be unique."));
			}
			const resultMessage = options.resultId === undefined ? undefined : record.messages.find(candidate => candidate.id === options.resultId && candidate.result);
			if ((options.kind === 'verification') !== !!resultMessage) {
				throw new Error(localize('rooms.assignmentResult', "Verification assignments require an existing structured result; work assignments must not include one."));
			}
			if (resultMessage && assigneeIds.includes(resultMessage.authorId)) {
				throw new Error(localize('rooms.assignmentSelfVerification', "A result author cannot be assigned to verify their own result."));
			}
			const superseded = options.supersedes === undefined ? undefined : record.messages.find(candidate => candidate.id === options.supersedes && candidate.assignment);
			if (options.supersedes !== undefined && (!superseded || record.messages.some(candidate => candidate.id !== options.id && candidate.assignment?.supersedes === options.supersedes))) {
				throw new Error(localize('rooms.assignmentSupersedes', "Choose a current assignment to supersede."));
			}
			if (options.note !== undefined) {
				this._text(options.note, 32000);
			}
			const assignment = {
				assigneeIds,
				kind: options.kind,
				description: options.description,
				expectedEvidence,
				resultId: options.resultId,
				supersedes: options.supersedes,
				note: options.note,
			} as const;
			if (existing) {
				if (existing.authorId !== coordinator.id || existing.kind !== 'work' || !equals(existing.assignment, assignment)) {
					throw new Error(localize('rooms.messageConflict', "This message ID is already used by a different message."));
				}
				return existing;
			}
			if (!options.supersedes && projectAgentHostRoomCoordinatorSnapshot(record).assignments.filter(candidate => candidate.state === 'pending').length >= MAX_ACTIVE_COORDINATOR_ASSIGNMENTS) {
				throw new Error(localize('rooms.tooManyActiveAssignments', "Supersede or complete an existing assignment before creating more coordinator work."));
			}
			const message: IAgentHostRoomMessage = {
				id: options.id,
				sequence: record.room.latestMessageSequence + 1,
				authorId: coordinator.id,
				authorName: coordinator.name,
				authorKind: 'agent',
				kind: 'work',
				text: options.note ?? options.description,
				timestamp: this._now(),
				mentions: assigneeIds,
				assignment,
				deliveries: assigneeIds.map(memberId => ({ memberId, state: 'pending' })),
			};
			record = {
				...record,
				room: { ...record.room, latestMessageSequence: message.sequence },
				messages: [...record.messages, message],
			};
			await this._save(record);
			return message;
		});
		return message;
	}

	async postCoordinationNote(sessionId: string, id: string, text: string): Promise<IAgentHostRoomMessage> {
		await this._ready;
		this.beforeTool(sessionId, 'room_post');
		const roomId = this._coordinatorBinding(sessionId);
		return this._queue.queue(roomId, async () => {
			this._assertOpen();
			const record = this._record(roomId);
			const coordinator = record.room.coordinator!;
			this._messageId(id);
			this._text(text, 32000);
			const existing = record.messages.find(message => message.id === id);
			if (existing) {
				if (existing.authorId !== coordinator.id || existing.kind !== 'message' || existing.text !== text || existing.assignment) {
					throw new Error(localize('rooms.messageConflict', "This message ID is already used by a different message."));
				}
				return existing;
			}
			const message: IAgentHostRoomMessage = {
				id,
				sequence: record.room.latestMessageSequence + 1,
				authorId: coordinator.id,
				authorName: coordinator.name,
				authorKind: 'agent',
				kind: 'message',
				text,
				timestamp: this._now(),
				mentions: [],
				deliveries: [],
			};
			await this._save({
				...record,
				room: { ...record.room, latestMessageSequence: message.sequence },
				messages: [...record.messages, message],
			});
			return message;
		});
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

	async publishResult(sessionId: string, options: IAgentHostRoomPublishResultOptions): Promise<IAgentHostRoomMessage> {
		await this._ready;
		const binding = this._binding(sessionId);
		this.beforeTool(sessionId, 'room_publish_result');
		return this._publishResult(binding.roomId, binding.memberId, options);
	}

	async reviewResult(sessionId: string, options: IAgentHostRoomVerifyResultOptions): Promise<IAgentHostRoomMessage> {
		await this._ready;
		const binding = this._binding(sessionId);
		this.beforeTool(sessionId, 'room_verify_result');
		return this._verifyResult(binding.roomId, binding.memberId, options);
	}

	private async _publishResult(roomId: string, memberId: string, options: IAgentHostRoomPublishResultOptions): Promise<IAgentHostRoomMessage> {
		const message = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			let record = this._record(roomId);
			const member = this._member(record, memberId);
			this._assertMemberTurn(record, memberId);
			this._messageId(options.id);
			this._text(options.title, 200);
			this._text(options.summary, 8000);
			if (!['success', 'negative', 'inconclusive', 'blocked'].includes(options.outcome)) {
				throw new Error(localize('rooms.invalidResultOutcome', "Choose a success, negative, inconclusive, or blocked result outcome."));
			}
			const evidence = this._evidence(options.evidence);
			const artifactIds = this._resultArtifacts(record, member, options.artifactIds);
			if (options.assignmentId !== undefined) {
				this._messageId(options.assignmentId);
				const assignment = record.messages.find(message => message.id === options.assignmentId)?.assignment;
				if (assignment?.kind !== 'work' || !assignment.assigneeIds.includes(memberId)) {
					throw new Error(localize('rooms.invalidResultAssignment', "The result assignment must be an earlier work assignment for this member."));
				}
				if (record.messages.some(message => message.id !== options.id && message.result?.assignmentId === options.assignmentId && message.authorId === memberId)) {
					throw new Error(localize('rooms.completedResultAssignment', "This member already published a result for the assignment."));
				}
			}
			const result = {
				title: options.title,
				summary: options.summary,
				outcome: options.outcome,
				evidence,
				artifactIds,
				...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
			} as const;
			const existing = record.messages.find(message => message.id === options.id);
			if (existing) {
				if (existing.authorId !== memberId || existing.kind !== 'result' || !equals(existing.result, result)) {
					throw new Error(localize('rooms.messageConflict', "This message ID is already used by a different message."));
				}
				return { ...existing, result: { ...result, verificationState: this._verificationState(record.messages, existing.id) } };
			}
			const message: IAgentHostRoomMessage = {
				id: options.id,
				sequence: record.room.latestMessageSequence + 1,
				authorId: member.id,
				authorName: member.name,
				authorKind: 'agent',
				kind: 'result',
				text: `${result.title}\n\n${result.summary}`,
				timestamp: this._now(),
				mentions: [],
				result,
				deliveries: [],
			};
			record = {
				...record,
				room: {
					...record.room,
					latestMessageSequence: message.sequence,
					members: record.room.members.map(candidate => candidate.id === member.id ? {
						...candidate,
						work: { description: result.summary, blocked: result.outcome === 'blocked', updatedAt: this._now() },
					} : candidate),
				},
				messages: [...record.messages, message],
			};
			const events: AgentHostRoomCoordinatorEventKind[] = ['result'];
			if (result.outcome === 'blocked') {
				events.push('blocked');
			}
			if (result.assignmentId && this._assignmentState(record, result.assignmentId) === 'completed') {
				events.push('assignmentCompleted');
			}
			await this._save(this._withCoordinatorEvents(record, events));
			return { ...message, result: { ...result, verificationState: 'pending' as const } };
		});
		this._scheduleCoordinator(roomId);
		return message;
	}

	private async _verifyResult(roomId: string, memberId: string | undefined, options: IAgentHostRoomVerifyResultOptions): Promise<IAgentHostRoomMessage> {
		const message = await this._queue.queue(roomId, async () => {
			this._assertOpen();
			let record = this._record(roomId);
			this._messageId(options.id);
			this._messageId(options.resultId);
			if (options.verdict !== 'verified' && options.verdict !== 'rejected') {
				throw new Error(localize('rooms.invalidResultVerdict', "Choose verified or rejected for the result review."));
			}
			const evidence = this._evidence(options.evidence);
			const verification = { resultId: options.resultId, verdict: options.verdict, evidence } as const;
			const author = memberId ? this._member(record, memberId) : undefined;
			if (author) {
				this._assertMemberTurn(record, author.id);
			}
			const existing = record.messages.find(message => message.id === options.id);
			if (existing) {
				if (existing.authorId !== (memberId ?? 'human') || existing.kind !== 'verification' || !equals(existing.verification, verification)) {
					throw new Error(localize('rooms.messageConflict', "This message ID is already used by a different message."));
				}
				return existing;
			}
			const resultMessage = record.messages.find(message => message.id === options.resultId && message.kind === 'result' && message.result);
			if (!resultMessage) {
				throw new Error(localize('rooms.resultNotFound', "The room result does not exist."));
			}
			const result = resultMessage.result;
			if (!result) {
				throw new Error(localize('rooms.resultNotFound', "The room result does not exist."));
			}
			if (author) {
				if (resultMessage.authorId === author.id) {
					throw new Error(localize('rooms.selfResultVerification', "A result must be verified by another agent or by the human."));
				}
				if ((this._execution(record, author.id).readSequence ?? 0) < resultMessage.sequence) {
					throw new Error(localize('rooms.readResultBeforeVerification', "Read the result before verifying it."));
				}
			}
			const text = options.verdict === 'verified'
				? localize('rooms.resultVerified', "Verified result \"{0}\".\n\n{1}", result.title, evidence.join('\n'))
				: localize('rooms.resultRejected', "Rejected result \"{0}\".\n\n{1}", result.title, evidence.join('\n'));
			const message: IAgentHostRoomMessage = {
				id: options.id,
				sequence: record.room.latestMessageSequence + 1,
				authorId: memberId ?? 'human',
				authorName: author?.name ?? localize('rooms.human', "You"),
				authorKind: author ? 'agent' : 'human',
				kind: 'verification',
				text,
				timestamp: this._now(),
				mentions: [],
				verification,
				deliveries: [],
			};
			record = {
				...record,
				room: { ...record.room, latestMessageSequence: message.sequence },
				messages: [...record.messages, message],
			};
			const events: AgentHostRoomCoordinatorEventKind[] = ['verification'];
			for (const assignmentMessage of record.messages) {
				if (assignmentMessage.assignment?.kind === 'verification' && assignmentMessage.assignment.resultId === options.resultId
					&& this._assignmentState(record, assignmentMessage.id) === 'completed') {
					events.push('assignmentCompleted');
				}
			}
			await this._save(this._withCoordinatorEvents(record, events));
			return message;
		});
		this._scheduleCoordinator(roomId);
		return message;
	}

	private _verificationState(messages: readonly IAgentHostRoomMessage[], resultId: string): AgentHostRoomVerificationState {
		const verifications = messages.filter(message => message.verification?.resultId === resultId);
		const human = verifications.filter(message => message.authorKind === 'human').at(-1);
		if (human?.verification) {
			return human.verification.verdict;
		}
		if (verifications.some(message => message.verification?.verdict === 'rejected')) {
			return 'rejected';
		}
		return verifications.some(message => message.verification?.verdict === 'verified') ? 'verified' : 'pending';
	}

	async sharePatch(sessionId: string, title: string): Promise<IAgentHostRoomArtifact> {
		await this._ready;
		this._text(title, 200);
		const binding = this._binding(sessionId);
		this.beforeTool(sessionId, 'room_share_patch');
		const artifact = await this._queue.queue(binding.roomId, async () => {
			const record = this._record(binding.roomId);
			this._assertMemberTurn(record, binding.memberId);
			const member = this._member(record, binding.memberId);
			const artifact = await this._storage.publishPatch(record.room, member, title, paths => this._assertContentAccess(member, paths));
			const message: IAgentHostRoomMessage = {
				id: artifact.id, sequence: record.room.latestMessageSequence + 1, authorId: member.id, authorName: member.name, authorKind: 'agent',
				kind: 'artifact', text: title, timestamp: this._now(), mentions: [], artifactId: artifact.id, deliveries: [],
			};
			await this._save(this._withCoordinatorEvents({
				...record, room: { ...record.room, latestMessageSequence: message.sequence, artifacts: [...record.room.artifacts, artifact] },
				messages: [...record.messages, message],
			}, ['activity']));
			return artifact;
		});
		this._scheduleCoordinator(binding.roomId);
		return artifact;
	}

	beforeTool(sessionId: string, toolName: string, expectedTurnId?: string): void {
		const coordinatorRoomId = this._coordinatorSessions.get(AgentSession.uri('copilotcli', sessionId).toString());
		if (coordinatorRoomId !== undefined) {
			const coordinator = this._record(coordinatorRoomId).room.coordinator!;
			if (!coordinator.turnId || (expectedTurnId !== undefined && coordinator.turnId !== expectedTurnId)) {
				throw new Error(localize('rooms.unadmittedCoordinatorTurn', "This coordinator turn is not active."));
			}
			if (!roomCoordinatorTools.some(name => toolName === name || toolName.endsWith(`:${name}`) || toolName.endsWith(`.${name}`))) {
				throw new Error(localize('rooms.coordinatorToolRestricted', "The room coordinator can only inspect room state, create structured assignments, and post informational notes."));
			}
			return;
		}
		const binding = this._binding(sessionId);
		const record = this._record(binding.roomId);
		this._assertMemberTurn(record, binding.memberId);
		if (expectedTurnId !== undefined && this._execution(record, binding.memberId).turnId !== expectedTurnId) {
			throw new Error(localize('rooms.unadmittedTurn', "This turn was not admitted by the collaboration room."));
		}
		if (roomExcludedTools.some(name => toolName === name || toolName.endsWith(`:${name}`) || toolName.endsWith(`.${name}`))) {
			throw new Error(localize('rooms.noDelegation', "Room members cannot launch nested agents. Collaborate with the existing room members instead."));
		}
		if (roomCoordinatorExclusiveTools.some(name => toolName === name || toolName.endsWith(`:${name}`) || toolName.endsWith(`.${name}`))) {
			throw new Error(localize('rooms.coordinatorToolOnly', "Only the room coordinator can use coordinator tools."));
		}
		if (toolName === 'room_read' || toolName === 'room_post' || toolName === 'room_read_artifact') {
			return;
		}
		const execution = this._execution(record, binding.memberId);
		if (execution.readSequence === undefined) {
			throw new Error(localize('rooms.readBeforeTool', "Read the shared room before using tools."));
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

	private _withCoordinatorEvents(record: IRoomRecord, events: readonly AgentHostRoomCoordinatorEventKind[]): IRoomRecord {
		const coordinator = record.room.coordinator;
		if (!coordinator || events.length === 0) {
			return record;
		}
		return {
			...record,
			room: {
				...record.room,
				coordinator: {
					...coordinator,
					eventSequence: coordinator.eventSequence + 1,
					pendingEvents: [...new Set([...coordinator.pendingEvents, ...events])],
					nextEventTurnAt: undefined,
				},
			},
		};
	}

	private _assignmentState(record: IRoomRecord, assignmentId: string): 'pending' | 'completed' | 'superseded' {
		return record.room.coordinator
			? projectAgentHostRoomCoordinatorSnapshot(record).assignments.find(assignment => assignment.id === assignmentId)?.state ?? 'pending'
			: 'pending';
	}

	private _scheduleCoordinator(roomId: string): void {
		const record = this._record(roomId);
		const coordinator = record.room.coordinator;
		if (!coordinator?.pendingEvents.length) {
			return;
		}
		const members = new Set(record.room.members.filter(member => !member.removed).map(member => member.id));
		const quorum = Math.ceil(members.size / 2);
		const authors = new Set(record.messages
			.filter(message => message.sequence > coordinator.cursor && members.has(message.authorId))
			.map(message => message.authorId));
		if (quorum === 0 || authors.size < quorum) {
			return;
		}
		void this._queue.queue(roomId, () => this._admitCoordinator(roomId))
			.catch(error => this._logService.warn('[AgentHostRooms] Coordinator scheduling failed', error));
	}

	private async _admitCoordinator(roomId: string): Promise<void> {
		const record = this._record(roomId);
		const coordinator = record.room.coordinator;
		if (this._closed || !coordinator?.initialized || coordinator.pendingEvents.length === 0 || coordinator.turnId || !this._runtime.isIdle(coordinator.sessionUri)) {
			return;
		}
		const turnId = generateUuid();
		const saved = await this._save({
			...record,
			room: {
				...record.room,
				coordinator: {
					...coordinator,
					state: 'starting',
					turnId,
					activeEventSequence: coordinator.eventSequence,
					activeEvents: coordinator.pendingEvents,
					pendingEvents: [],
					nextEventTurnAt: undefined,
					error: undefined,
				},
			},
		});
		void this._launchCoordinator(saved, turnId).catch(error => this._logService.warn('[AgentHostRooms] Coordinator launch failed', error));
	}

	private async _launchCoordinator(reservation: IRoomRecord, turnId: string): Promise<void> {
		const roomId = reservation.room.id;
		const coordinator = reservation.room.coordinator!;
		try {
			const participant = this._coordinatorParticipant(coordinator);
			await this._storage.ensureWorktree(reservation.room, participant, true);
			await this._runtime.prepare(reservation.room, participant, true);
			await this._runtime.applyConfiguration(participant);
			await this._queue.queue(roomId, async () => {
				let record = this._record(roomId);
				if (record.room.coordinator?.turnId !== turnId || !this._runtime.isIdle(coordinator.sessionUri)) {
					return;
				}
				if (record.room.coordinator.pendingModel) {
					record = await this._applyCoordinatorModel(record);
				}
				if (record.room.coordinator?.turnId === turnId) {
					this._runtime.submit(coordinator.sessionUri, turnId, 'Review the new meaningful room events and coordinate the next explicit assignments.');
				}
			});
		} catch (error) {
			await this._onCoordinatorRuntimeEvent(roomId, { sessionUri: coordinator.sessionUri, turnId, state: 'failed', error: String(error) });
		}
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
			return !member.removed && !this._memberStops.has(member.id) && ['pending', 'idle'].includes(member.state) && !execution.turnId && this._runtime.isIdle(member.sessionUri)
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
		const resumed = new Set(ready.filter(member => this._resumePrompts.has(member.id)).map(member => member.id));
		record = await this._save({
			...record,
			room: { ...record.room, run: { ...run, admittedTurns: run.admittedTurns + ready.length }, members: record.room.members.map(member => turns.has(member.id) ? { ...member, turns: member.turns + 1, state: 'starting', work: member.work ? { ...member.work, nextStep: undefined } : undefined } : member) },
			executions: record.executions.map(execution => turns.has(execution.memberId) ? { ...execution, turnId: turns.get(execution.memberId), runId: run.id, needsTurn: false } : execution),
			messages: record.messages.map(message => ({ ...message, deliveries: message.deliveries.map(delivery => turns.has(delivery.memberId) && delivery.state === 'pending' ? { ...delivery, state: 'submitted', turnId: turns.get(delivery.memberId) } : delivery) })),
		});
		for (const member of ready) {
			this._resumePrompts.delete(member.id);
			void this._launch(record, member.id, turns.get(member.id)!, run.id, resumed.has(member.id)).catch(error => this._logService.error('[AgentHostRooms] Member launch failed', error));
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
				accepted = await this._runtime.steer(member.sessionUri, turnId, buildHumanGuidancePrompt(messages));
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

	private async _launch(reservation: IRoomRecord, memberId: string, turnId: string, runId: string, resumed: boolean): Promise<void> {
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
					let execution = this._execution(current, member.id);
					if (!execution.briefed && execution.briefingTurnId && this._runtime.hasTurn(member.sessionUri, execution.briefingTurnId)) {
						current = await this._save({
							...current,
							executions: current.executions.map(item => item.memberId === member.id ? { ...item, briefed: true, briefingTurnId: undefined } : item),
						});
						execution = this._execution(current, member.id);
					}
					const briefed = execution.briefed === true;
					const prompt = buildRoomTurnPrompt(current.room, member, inbox, briefed, resumed);
					if (!briefed) {
						current = await this._save({
							...current,
							executions: current.executions.map(item => item.memberId === member.id ? { ...item, briefingTurnId: turnId } : item),
						});
					}
					this._runtime.submit(member.sessionUri, turnId, prompt);
					if (!briefed) {
						await this._save({
							...current,
							executions: current.executions.map(item => item.memberId === member.id ? { ...item, briefed: true, briefingTurnId: undefined } : item),
						});
					}
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
		const coordinatorRoomId = this._coordinatorSessions.get(event.sessionUri);
		if (coordinatorRoomId !== undefined) {
			await this._onCoordinatorRuntimeEvent(coordinatorRoomId, event);
			return;
		}
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
			let updated: IRoomRecord = {
				...record,
				room: {
					...record.room, members: record.room.members.map(item => item.id === member.id ? {
						...item, state: event.state === 'idle' && item.work?.blocked ? 'blocked' : event.state, activity: event.activity, error: event.error,
					} : item),
				},
				executions: record.executions.map(item => item.memberId === member.id && finished ? { ...item, turnId: undefined, runId: undefined, needsTurn: event.state === 'idle' && !member.work?.blocked } : item),
				messages: finished ? record.messages.map(message => ({
					...message, deliveries: message.deliveries.map(delivery => delivery.memberId === member.id && delivery.turnId === execution.turnId && ['submitted', 'delivered'].includes(delivery.state)
						? { ...delivery, state: event.state === 'idle' ? 'completed' : event.state === 'stopped' ? 'cancelled' : 'failed', error: event.error } : delivery),
				})) : record.messages,
			};
			const coordinatorEvent = event.state === 'failed'
				? 'failed'
				: event.state === 'needsInput' ? 'needsInput' : event.state === 'idle' && member.work?.blocked ? 'blocked' : undefined;
			if (coordinatorEvent) {
				updated = this._withCoordinatorEvents(updated, [coordinatorEvent]);
			}
			await this._save(updated);
		});
		this._schedule(binding.roomId);
		if (event.state === 'failed' || event.state === 'needsInput' || event.state === 'idle' && this._member(this._record(binding.roomId), binding.memberId).work?.blocked) {
			this._scheduleCoordinator(binding.roomId);
		}
	}

	private async _onCoordinatorRuntimeEvent(roomId: string, event: IRoomRuntimeEvent): Promise<void> {
		if (this._closed) {
			return;
		}
		let applyPendingModel = false;
		await this._queue.queue(roomId, async () => {
			const record = this._record(roomId);
			const coordinator = record.room.coordinator;
			if (!coordinator || coordinator.sessionUri !== event.sessionUri || (coordinator.turnId && event.turnId && coordinator.turnId !== event.turnId)) {
				return;
			}
			const finished = event.state === 'idle' || event.state === 'failed' || event.state === 'stopped';
			const completed = event.state === 'idle';
			const state = event.state === 'stopped' ? 'interrupted' : event.state;
			const updatedCoordinator: IAgentHostRoomCoordinator = {
				...coordinator,
				state,
				turnId: finished ? undefined : event.turnId ?? coordinator.turnId,
				activeEventSequence: finished ? undefined : coordinator.activeEventSequence,
				activeEvents: finished ? undefined : coordinator.activeEvents,
				pendingEvents: finished && !completed
					? [...new Set([...coordinator.pendingEvents, ...(coordinator.activeEvents ?? [])])]
					: coordinator.pendingEvents,
				nextEventTurnAt: undefined,
				eventCursor: completed && coordinator.activeEventSequence !== undefined
					? Math.max(coordinator.eventCursor, coordinator.activeEventSequence)
					: coordinator.eventCursor,
				error: event.error,
			};
			applyPendingModel = finished && updatedCoordinator.pendingModel !== undefined;
			let updatedRecord: IRoomRecord = { ...record, room: { ...record.room, coordinator: updatedCoordinator } };
			if (finished) {
				const assignmentRecipients = record.messages.flatMap(message => message.assignment
					? message.deliveries.filter(delivery => delivery.state === 'pending').map(delivery => delivery.memberId)
					: []);
				updatedRecord = this._wakeHumanRecipients(updatedRecord, assignmentRecipients);
			}
			await this._save(updatedRecord);
		});
		if (applyPendingModel) {
			void this.ensureCoordinator(roomId).catch(error => this._logService.warn('[AgentHostRooms] Coordinator model application failed', error));
		}
		if (event.state === 'idle') {
			this._scheduleCoordinator(roomId);
		}
		if (event.state === 'idle' || event.state === 'failed' || event.state === 'stopped') {
			this._schedule(roomId);
		}
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

	private _coordinatorBinding(sessionId: string): string {
		const roomId = this._coordinatorSessions.get(AgentSession.uri('copilotcli', sessionId).toString());
		if (roomId === undefined) {
			throw new Error(localize('rooms.noCoordinatorBinding', "The session is not a room coordinator."));
		}
		return roomId;
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
				if (current.room.coordinator?.turnId) {
					void this._runtime.abort(current.room.coordinator.sessionUri, current.room.coordinator.turnId)
						.catch(abortError => this._logService.error('[AgentHostRooms] Coordinator abort after persistence failure failed', abortError));
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

	private _messageId(value: string): void {
		if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
			throw new Error(localize('rooms.invalidMessageId', "Use a message ID containing only letters, numbers, underscores, and hyphens."));
		}
	}

	private _evidence(value: readonly string[]): readonly string[] {
		if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
			throw new Error(localize('rooms.invalidResultEvidence', "Provide between 1 and 20 result evidence entries."));
		}
		for (const item of value) {
			this._text(item, 2000);
		}
		return [...value];
	}

	private _resultArtifacts(record: IRoomRecord, member: IAgentHostRoomMember, value: readonly string[]): readonly string[] {
		if (!Array.isArray(value) || value.length > 20 || new Set(value).size !== value.length) {
			throw new Error(localize('rooms.invalidResultArtifacts', "Reference at most 20 unique published patch IDs."));
		}
		for (const artifactId of value) {
			this._messageId(artifactId);
			if (!record.room.artifacts.some(artifact => artifact.id === artifactId && artifact.memberId === member.id)) {
				throw new Error(localize('rooms.invalidResultArtifact', "A result can reference only patches published by its author."));
			}
		}
		return [...value];
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
		const coordinators = [...this._records.values()].flatMap(record => record.room.coordinator?.turnId
			? [{ roomId: record.room.id, sessionUri: record.room.coordinator.sessionUri, turnId: record.room.coordinator.turnId }]
			: []);
		await Promise.all(active.map(record => this.stopRoom(record.room.id)));
		await Promise.all(coordinators.map(coordinator => this._runtime.abort(coordinator.sessionUri, coordinator.turnId)
			.catch(error => this._logService.warn('[AgentHostRooms] Coordinator shutdown failed', error))));
		for (const coordinator of coordinators) {
			await this._queue.queue(coordinator.roomId, async () => {
				const record = this._record(coordinator.roomId);
				if (record.room.coordinator?.turnId === coordinator.turnId) {
					await this._save({
						...record,
						room: {
							...record.room,
							coordinator: {
								...record.room.coordinator,
								state: 'interrupted',
								turnId: undefined,
								activeEventSequence: undefined,
								activeEvents: undefined,
								pendingEvents: [...new Set([...record.room.coordinator.pendingEvents, ...(record.room.coordinator.activeEvents ?? [])])],
								nextEventTurnAt: undefined,
							},
						},
					});
				}
			});
		}
	}

	override dispose(): void {
		this._closed = true;
		for (const timer of this._timers.values()) {
			clearTimeout(timer);
		}
		this._timers.clear();
		this._modelChangeVersions.clear();
		this._coordinatorPreparations.clear();
		super.dispose();
	}
}
