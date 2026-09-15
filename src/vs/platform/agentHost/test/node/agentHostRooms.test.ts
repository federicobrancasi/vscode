/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { equals } from '../../../../base/common/objects.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { URI } from '../../../../base/common/uri.js';
import { BufferReader, BufferWriter, deserialize, serialize } from '../../../../base/parts/ipc/common/ipc.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAgentModelInfo } from '../../common/agent.js';
import { createAgentHostRoomsClient } from '../../common/agentHostRoomsIpc.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomMember, IAgentHostRoomsService, MAX_ROOM_WORKERS, newAgentHostRoomConfiguration } from '../../common/agentHostRooms.js';
import { AgentHostAutoApprovePolicyRestrictedConfigKey, platformSessionSchema } from '../../common/agentHostSchema.js';
import { ResolveSessionConfigResult } from '../../common/state/protocol/commands.js';
import { AgentSession } from '../../common/agentService.js';
import { AgentHostRooms } from '../../node/agentHostRooms.js';
import { createAgentHostRoomsChannel } from '../../node/agentHostRoomsChannel.js';
import { IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomSessionParticipant, IRoomStorage, RoomContentValidator } from '../../node/agentHostRoomsTypes.js';
import { getRoomMemberModel, validateRoomModelSelection } from '../../node/agentHostRoomsModels.js';
import { createCopilotRoomCoordinatorTools, createCopilotRoomTools } from '../../node/copilot/copilotRoomTools.js';
import { createNoopGitService, createNullSessionDataService } from '../common/sessionTestHelpers.js';
import { MockAgent } from './mockAgent.js';
import { createTestAgentService, getTestAgentHostRoomsController, getTestAgentServiceComposition, getTestAgentStateManager, registerTestAgentProvider } from './agentServiceTestUtils.js';
import { ActionEnvelope, ActionType } from '../../common/state/sessionActions.js';
import { buildChatUri, buildDefaultChatUri, MessageKind, ModelSelection, PendingMessageKind, PolicyState, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus } from '../../common/state/sessionState.js';

const continueRoomPrompt = 'Continue working in the existing collaboration room.';
const continueAfterTurnPrompt = [
	'Share meaningful completed work with room_publish_result, including evidence, and publish changed code with room_share_patch. Use room_post for focused questions and conversational replies.',
	'Call room_read with after set to the latest sequence you saw, review peer ideas and feedback, and independently verify a useful peer result when appropriate. Never verify your own result.',
	'Ask a focused question in the room if you need help.',
].join('\n\n');

const roomModelCatalog: readonly IAgentModelInfo[] = [
	...['model-a', 'model-b', 'model-c'].map((id): IAgentModelInfo => ({
		provider: 'copilotcli', id, name: id, supportsVision: true,
		configSchema: {
			type: 'object',
			properties: {
				thinkingLevel: { title: 'Thinking', type: 'string', enum: ['low', 'high'] },
				contextSize: { title: 'Context size', type: 'number', enum: [200_000, 1_000_000] },
				adaptive: { title: 'Adaptive', type: 'boolean' },
			},
		},
	})),
	{
		provider: 'copilotcli', id: 'auto', name: 'Auto', supportsVision: false,
		configSchema: { type: 'object', properties: { tier: { title: 'Tier', type: 'string', enum: ['efficiency', 'balance', 'intelligence'] } } },
	},
];

class MemoryRoomStorage implements IRoomStorage {
	readonly records = new Map<string, IRoomRecord>();
	worktreeError: Error | undefined;
	readonly worktrees = new Set<string>();

	async load(): Promise<readonly IRoomRecord[]> { return [...this.records.values()]; }
	async save(record: IRoomRecord): Promise<void> {
		this.records.set(record.room.id, structuredClone(record));
	}
	async isRepository(): Promise<boolean> { return true; }
	async resolveRepository(repositoryUri: string) { return { repositoryUri, baseRevision: 'a'.repeat(40) }; }
	worktreeUri(roomId: string, memberId: string): string { return `file:///room-worktrees/${roomId}/${memberId}`; }
	async ensureWorktree(room: IAgentHostRoom, member: IRoomSessionParticipant): Promise<void> {
		assert.ok(room.members.some(candidate => candidate.id === member.id) || room.coordinator?.id === member.id);
		if (this.worktreeError) {
			throw this.worktreeError;
		}
		this.worktrees.add(member.worktreeUri!);
	}
	async publishPatch(_room: IAgentHostRoom, _member: IAgentHostRoomMember, _title: string, _validateContent?: RoomContentValidator): Promise<IAgentHostRoomArtifact> { throw new Error('Not used'); }
	async readArtifact(): Promise<string> { return 'patch'; }
}

class RoomRuntime extends Disposable implements IRoomRuntime {
	private readonly _onDidChange = this._register(new Emitter<IRoomRuntimeEvent>());
	readonly onDidChange = this._onDidChange.event;
	readonly prepared: string[] = [];
	readonly submitted: { sessionUri: string; turnId: string; prompt: string }[] = [];
	readonly knownTurns = new Set<string>();
	readonly aborted: string[] = [];
	readonly steered: { sessionUri: string; turnId: string; prompt: string }[] = [];
	readonly steeringGate = new DeferredPromise<boolean>();
	blockSteering = false;
	steeringError: Error | undefined;
	steeringAccepted = true;
	readonly active = new Map<string, string>();
	readonly prepareGate = new DeferredPromise<void>();
	readonly abortGate = new DeferredPromise<void>();
	private readonly _preparedWaiters = new Map<number, DeferredPromise<void>>();
	private readonly _submittedWaiters = new Map<number, DeferredPromise<void>>();
	blockPrepare = false;
	blockAbort = false;
	readonly contentChecks: { sessionUri: string; paths: readonly string[] }[] = [];
	contentAccessError: Error | undefined;
	readonly configurations = new Map<string, IAgentHostRoomConfiguration>();
	models = roomModelCatalog;
	readonly appliedModels = new Map<string, ModelSelection>();
	readonly modelChanges: { sessionUri: string; model: ModelSelection }[] = [];
	modelError: Error | undefined;
	beforeApplyModel: (() => void | Promise<void>) | undefined;
	configurationError: Error | undefined;
	beforeApplyConfiguration: (() => void) | undefined;

	async assertContentAccess(sessionUri: string, paths: readonly string[]): Promise<void> {
		this.contentChecks.push({ sessionUri, paths: [...paths] });
		if (this.contentAccessError) {
			throw this.contentAccessError;
		}
	}
	validateModel(model: ModelSelection): void { validateRoomModelSelection(model, this.models); }
	getModel(member: IRoomSessionParticipant): ModelSelection | undefined { return this.appliedModels.get(member.sessionUri); }
	publishModel(): void { }
	async applyModel(member: IRoomSessionParticipant, model: ModelSelection): Promise<void> {
		assert.ok(this.isIdle(member.sessionUri), 'A model change cannot affect an active execution');
		if (equals(this.appliedModels.get(member.sessionUri), model) && !this.modelError) {
			return;
		}
		this.modelChanges.push({ sessionUri: member.sessionUri, model });
		await this.beforeApplyModel?.();
		if (this.modelError) {
			throw this.modelError;
		}
		this.appliedModels.set(member.sessionUri, model);
	}

	async resolveConfiguration(member: IRoomSessionParticipant, configuration?: IAgentHostRoomConfiguration): Promise<ResolveSessionConfigResult> {
		return {
			schema: platformSessionSchema.toProtocol(),
			values: { ...(configuration ?? this.configurations.get(member.sessionUri) ?? member.configuration ?? defaultAgentHostRoomConfiguration) },
		};
	}

	async applyConfiguration(member: IRoomSessionParticipant): Promise<void> {
		this.beforeApplyConfiguration?.();
		if (this.configurationError) {
			throw this.configurationError;
		}
		this.configurations.set(member.sessionUri, { ...defaultAgentHostRoomConfiguration, ...member.configuration });
	}

	async prepare(_room: IAgentHostRoom, member: IRoomSessionParticipant): Promise<void> {
		this.prepared.push(member.sessionUri);
		this._preparedWaiters.get(this.prepared.length)?.complete();
		if (this.blockPrepare) {
			await this.prepareGate.p;
		}
	}
	isIdle(sessionUri: string): boolean { return !this.active.has(sessionUri); }
	hasTurn(sessionUri: string, turnId: string): boolean { return this.knownTurns.has(`${sessionUri}:${turnId}`); }
	submit(sessionUri: string, turnId: string, prompt: string): void {
		assert.ok(!this.active.has(sessionUri), 'Only one admitted turn per member');
		this.active.set(sessionUri, turnId);
		this.knownTurns.add(`${sessionUri}:${turnId}`);
		this.submitted.push({ sessionUri, turnId, prompt });
		this._onDidChange.fire({ sessionUri, turnId, state: 'working' });
		this._submittedWaiters.get(this.submitted.length)?.complete();
	}
	async abort(sessionUri: string): Promise<void> {
		this.aborted.push(sessionUri);
		if (this.blockAbort) {
			await this.abortGate.p;
		}
		this.finish(sessionUri, 'stopped');
	}
	async steer(sessionUri: string, turnId: string, prompt: string): Promise<boolean> {
		if (this.active.get(sessionUri) !== turnId) {
			return false;
		}
		this.steered.push({ sessionUri, turnId, prompt });
		if (this.steeringError) {
			throw this.steeringError;
		}
		return this.blockSteering ? this.steeringGate.p : this.steeringAccepted;
	}
	finish(sessionUri: string, state: 'idle' | 'stopped' | 'failed' = 'idle'): void {
		const turnId = this.active.get(sessionUri);
		this.active.delete(sessionUri);
		this._onDidChange.fire({ sessionUri, turnId, state });
	}
	emit(event: IRoomRuntimeEvent): void { this._onDidChange.fire(event); }
	whenPrepared(count: number): Promise<void> {
		if (this.prepared.length >= count) {
			return Promise.resolve();
		}
		const waiter = new DeferredPromise<void>();
		this._preparedWaiters.set(count, waiter);
		return waiter.p;
	}
	whenSubmitted(count: number): Promise<void> {
		if (this.submitted.length >= count) {
			return Promise.resolve();
		}
		const waiter = new DeferredPromise<void>();
		this._submittedWaiters.set(count, waiter);
		return waiter.p;
	}
}

function whenRoom(rooms: IAgentHostRoomsService, roomId: string, predicate: (room: IAgentHostRoom) => boolean): Promise<IAgentHostRoom> {
	return new Promise((resolve, reject) => {
		const subscription = rooms.onDidChangeRoom(room => {
			if (room.id === roomId && predicate(room)) {
				subscription.dispose();
				resolve(room);
			}
		});
		void rooms.getRoom(roomId).then(room => {
			if (predicate(room)) {
				subscription.dispose();
				resolve(room);
			}
		}, error => {
			subscription.dispose();
			reject(error);
		});
	});
}

suite('AgentHostRooms', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(workerCount = 2, storage = new MemoryRoomStorage(), now?: () => number) {
		const runtime = new RoomRuntime();
		const rooms = disposables.add(new AgentHostRooms(storage, runtime, new NullLogService(), now));
		// These suites describe wind-down semantics; continuous rooms are covered separately.
		const create = (continuous = false) => rooms.createRoom({ title: 'Shared work', goal: 'Measure before changing code', repositoryUri: 'file:///repository', workerCount, continuous });
		return { storage, runtime, rooms, create };
	}

	function setupProduction() {
		const log = new NullLogService();
		const files = disposables.add(new FileService(log));
		disposables.add(files.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const storage = new MemoryRoomStorage();
		const service = disposables.add(createTestAgentService(
			log, files, createNullSessionDataService(), upcastPartial<IProductService>({ _serviceBrand: undefined }), createNoopGitService(),
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
			{ roomsStorage: storage },
		));
		const provider = new MockAgent('copilotcli');
		provider.setModels(roomModelCatalog);
		const createdModels = new Map<string, ModelSelection | undefined>();
		const chatModels = new Map<string, ModelSelection>();
		const createChat = provider.chats.createChat;
		provider.chats.createChat = async (chat, context, options) => {
			const result = await createChat(chat, context, options);
			createdModels.set(chat.toString(), options?.model);
			if (options?.model) {
				chatModels.set(chat.toString(), options.model);
			}
			return result;
		};
		const changeModel = provider.chats.changeModel;
		provider.chats.changeModel = async (chat, model, context) => {
			await changeModel(chat, model, context);
			chatModels.set(chat.toString(), model);
		};
		provider.chats.getModel = chat => chatModels.get(chat.toString());
		provider.resolveChatConfig = async params => ({ schema: platformSessionSchema.toProtocol(), values: params.config ?? {} });
		provider.chats.applyConfiguration = async () => { };
		registerTestAgentProvider(service, provider);
		const rooms = getTestAgentHostRoomsController(service);
		const state = getTestAgentStateManager(service);
		const configuration = getTestAgentServiceComposition(service).configurationService;
		let clientSequence = 0;
		const changeConfiguration = async (session: string, config: Record<string, unknown>, replace?: boolean): Promise<ActionEnvelope> => {
			const sequence = ++clientSequence;
			const receipt = new DeferredPromise<ActionEnvelope>();
			const listener = disposables.add(service.onDidAction(envelope => {
				if (envelope.origin?.clientId === 'configuration-client' && envelope.origin.clientSeq === sequence) {
					receipt.complete(envelope);
				}
			}));
			try {
				service.dispatchAction(session, { type: ActionType.SessionConfigChanged, config, replace }, 'configuration-client', sequence);
				return await receipt.p;
			} finally {
				listener.dispose();
			}
		};
		const whenSent = async (count: number) => {
			if (provider.sendMessageCalls.length < count) {
				await Event.toPromise(Event.filter(provider.onDidSendMessage, () => provider.sendMessageCalls.length >= count));
			}
		};
		return { storage, service, provider, rooms, state, configuration, changeConfiguration, whenSent, createdModels, chatModels };
	}

	test('coordinator identity, model lifecycle, capability, and worker accounting are independent', async () => {
		const { rooms, runtime, storage } = setup(MAX_ROOM_WORKERS);
		const room = await rooms.createRoom({
			title: 'Coordinator',
			goal: 'Coordinate ten workers',
			repositoryUri: 'file:///repository',
			workerCount: MAX_ROOM_WORKERS,
			coordinatorModel: { id: 'model-a', config: { thinkingLevel: 'high' } },
		});
		const coordinator = await rooms.ensureCoordinator(room.id);
		runtime.active.set(coordinator.sessionUri, 'model-turn');
		runtime.emit({ sessionUri: coordinator.sessionUri, turnId: 'model-turn', state: 'working' });
		await whenRoom(rooms, room.id, value => value.coordinator?.turnId === 'model-turn');
		const pending = await rooms.setCoordinatorModel(room.id, { id: 'model-b', config: { adaptive: true } });
		runtime.finish(coordinator.sessionUri);
		const applied = await whenRoom(rooms, room.id, value => value.coordinator?.appliedModel?.id === 'model-b');
		await assert.rejects(rooms.addMember(room.id), /at most/);

		assert.deepStrictEqual({
			workers: room.members.length,
			coordinatorInRoster: room.members.some(member => member.id === coordinator.id),
			coordinator: {
				sessionUri: applied.coordinator!.sessionUri,
				chatUri: applied.coordinator!.chatUri,
				desiredModel: applied.coordinator!.desiredModel,
				appliedModel: applied.coordinator!.appliedModel,
				pendingModel: applied.coordinator!.pendingModel,
				state: applied.coordinator!.state,
				initialized: applied.coordinator!.initialized,
			},
			pending: { desired: pending.desiredModel, applied: pending.appliedModel, pending: pending.pendingModel },
			prepared: runtime.prepared,
			modelChanges: runtime.modelChanges,
			worktrees: [...storage.worktrees],
			supportsCoordinator: (await rooms.getCapabilities()).supportsCoordinator,
		}, {
			workers: MAX_ROOM_WORKERS,
			coordinatorInRoster: false,
			coordinator: {
				sessionUri: room.coordinator!.sessionUri,
				chatUri: room.coordinator!.chatUri,
				desiredModel: { id: 'model-b', config: { adaptive: true } },
				appliedModel: { id: 'model-b', config: { adaptive: true } },
				pendingModel: undefined,
				state: 'idle',
				initialized: true,
			},
			pending: {
				desired: { id: 'model-b', config: { adaptive: true } },
				applied: { id: 'model-a', config: { thinkingLevel: 'high' } },
				pending: { id: 'model-b', config: { adaptive: true } },
			},
			prepared: [coordinator.sessionUri, coordinator.sessionUri],
			modelChanges: [
				{ sessionUri: coordinator.sessionUri, model: { id: 'model-a', config: { thinkingLevel: 'high' } } },
				{ sessionUri: coordinator.sessionUri, model: { id: 'model-b', config: { adaptive: true } } },
			],
			worktrees: [coordinator.worktreeUri],
			supportsCoordinator: true,
		});
	});

	test('assignments drive pairings and meaningful events coalesce one non-blocking coordinator follow-up', async () => {
		const { rooms, runtime } = setup(2);
		const room = await rooms.createRoom({
			title: 'Coordinator',
			goal: 'Implement and verify',
			repositoryUri: 'file:///repository',
			workerCount: 2,
			continuous: false,
		});
		const coordinator = await rooms.ensureCoordinator(room.id);
		runtime.active.set(coordinator.sessionUri, 'human-coordinator-turn');
		runtime.emit({ sessionUri: coordinator.sessionUri, turnId: 'human-coordinator-turn', state: 'working' });
		await whenRoom(rooms, room.id, value => value.coordinator?.turnId === 'human-coordinator-turn');
		const tools = createCopilotRoomCoordinatorTools(AgentSession.id(coordinator.sessionUri), rooms);
		assert.throws(() => rooms.beforeTool(AgentSession.id(coordinator.sessionUri), 'bash'), /only inspect room state/);
		await tools.find(tool => tool.name === 'room_assign')!.handler!({
			id: 'pair-parser',
			assignees: room.members.map(member => member.name),
			kind: 'work',
			description: 'Implement and cross-check the parser.',
			expectedEvidence: ['Focused parser tests', 'A published patch when code changes'],
			note: 'Pair on the parser and report independent evidence.',
		}, { sessionId: 'forged', toolCallId: 'assign', toolName: 'room_assign', arguments: {} });
		await tools.find(tool => tool.name === 'room_post')!.handler!({
			id: 'coordination-note',
			text: 'The parser pair is active.',
		}, { sessionId: 'forged', toolCallId: 'note', toolName: 'room_post', arguments: {} });
		await runtime.whenSubmitted(2);
		const assignmentPost = (await rooms.getMessages(room.id)).messages.find(message => message.id === 'pair-parser')!;
		const coordinationNote = (await rooms.getMessages(room.id)).messages.find(message => message.id === 'coordination-note')!;
		const [first, second] = room.members.map(member => AgentSession.id(member.sessionUri));
		await rooms.read(first);
		await rooms.read(second);
		await rooms.publishResult(first, {
			id: 'parser-result',
			title: 'Parser result',
			summary: 'The parser passes the focused suite.',
			outcome: 'success',
			evidence: ['Focused parser tests passed.'],
			artifactIds: [],
			assignmentId: 'pair-parser',
		});
		const eventSequence = (await rooms.getCoordinator(room.id))!.eventSequence;
		await rooms.post(second, { id: 'ordinary-chatter', kind: 'message', text: 'I am reading the parser result.', mentions: [] });
		const toolSnapshot = await tools.find(tool => tool.name === 'room_coordinator_snapshot')!.handler!(
			{}, { sessionId: 'forged', toolCallId: 'snapshot', toolName: 'room_coordinator_snapshot', arguments: {} });
		const snapshot = await rooms.coordinatorSnapshot(AgentSession.id(coordinator.sessionUri));
		assert.deepStrictEqual(toolSnapshot, snapshot);
		runtime.finish(coordinator.sessionUri);
		await runtime.whenSubmitted(3);
		const followUps = runtime.submitted.filter(submission => submission.sessionUri === coordinator.sessionUri);
		runtime.finish(coordinator.sessionUri, 'failed');
		await whenRoom(rooms, room.id, value => value.coordinator?.state === 'failed');

		assert.deepStrictEqual({
			tools: tools.map(tool => tool.name),
			coordinationNote: {
				text: coordinationNote.text,
				mentions: coordinationNote.mentions,
				deliveries: coordinationNote.deliveries,
			},
			assignmentTargets: {
				mentions: assignmentPost.mentions,
				deliveries: assignmentPost.deliveries.map(delivery => delivery.memberId),
			},
			eventSequenceAfterChatter: (await rooms.getCoordinator(room.id))!.eventSequence,
			pairings: snapshot.workers.map(worker => [worker.id, worker.pairedWith]),
			assignment: snapshot.assignments.map(assignment => ({
				id: assignment.id,
				assignees: assignment.assigneeIds,
				state: assignment.state,
				completed: assignment.completedAssigneeIds,
			})),
			result: snapshot.results.map(result => ({ id: result.id, assignmentId: result.assignmentId, verification: result.verificationState })),
			followUps: followUps.map(submission => submission.prompt),
			coordinatorState: (await rooms.getCoordinator(room.id))!.state,
			pendingEventsAfterFailure: (await rooms.getCoordinator(room.id))!.pendingEvents,
			roomState: (await rooms.getRoom(room.id)).state,
		}, {
			tools: ['room_coordinator_snapshot', 'room_assign', 'room_post'],
			coordinationNote: {
				text: 'The parser pair is active.',
				mentions: [],
				deliveries: [],
			},
			assignmentTargets: {
				mentions: room.members.map(member => member.id),
				deliveries: room.members.map(member => member.id),
			},
			eventSequenceAfterChatter: eventSequence,
			pairings: [
				[room.members[0].id, [room.members[1].id]],
				[room.members[1].id, [room.members[0].id]],
			],
			assignment: [{
				id: 'pair-parser',
				assignees: room.members.map(member => member.id),
				state: 'pending',
				completed: [room.members[0].id],
			}],
			result: [{ id: 'parser-result', assignmentId: 'pair-parser', verification: 'pending' }],
			followUps: ['Review the new meaningful room events and coordinate the next explicit assignments.'],
			coordinatorState: 'failed',
			pendingEventsAfterFailure: ['result'],
			roomState: 'running',
		});
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
	});

	test('superseding assignments remain idempotent', async () => {
		const { rooms, runtime } = setup(1);
		const room = await rooms.createRoom({
			title: 'Redirect',
			goal: 'Redirect work safely',
			repositoryUri: 'file:///repository',
			workerCount: 1,
			continuous: false,
		});
		const coordinator = await rooms.ensureCoordinator(room.id);
		runtime.active.set(coordinator.sessionUri, 'human-coordinator-turn');
		runtime.emit({ sessionUri: coordinator.sessionUri, turnId: 'human-coordinator-turn', state: 'working' });
		await whenRoom(rooms, room.id, value => value.coordinator?.turnId === 'human-coordinator-turn');
		const sessionId = AgentSession.id(coordinator.sessionUri);
		await rooms.assign(sessionId, {
			id: 'initial-work',
			assignees: [room.members[0].id],
			kind: 'work',
			description: 'Inspect the parser.',
			expectedEvidence: ['Parser evidence'],
		});
		const redirect = {
			id: 'redirected-work',
			assignees: [room.members[0].id],
			kind: 'work' as const,
			description: 'Inspect the tokenizer instead.',
			expectedEvidence: ['Tokenizer evidence'],
			supersedes: 'initial-work',
		};
		const first = await rooms.assign(sessionId, redirect);
		const retry = await rooms.assign(sessionId, redirect);
		const snapshot = await rooms.getCoordinatorSnapshot(room.id);
		assert.deepStrictEqual({
			first: first.id,
			retry: retry.id,
			assignments: snapshot.assignments.map(assignment => [assignment.id, assignment.state]),
			messages: (await rooms.getMessages(room.id)).messages.map(message => message.id),
		}, {
			first: 'redirected-work',
			retry: 'redirected-work',
			assignments: [['initial-work', 'superseded'], ['redirected-work', 'pending']],
			messages: ['initial-work', 'redirected-work'],
		});
		runtime.finish(coordinator.sessionUri);
		runtime.finish(room.members[0].sessionUri);
	});

	test('coordinator issues cite only the worker record that describes the blocker', async () => {
		const { rooms, runtime } = setup(1);
		const room = await rooms.createRoom({
			title: 'Evidence',
			goal: 'Keep evidence attributable',
			repositoryUri: 'file:///repository',
			workerCount: 1,
			continuous: false,
		});
		await rooms.ensureCoordinator(room.id);
		await rooms.startRoom(room.id, { maxTurns: 1 });
		await runtime.whenSubmitted(1);
		const sessionId = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(sessionId);
		await rooms.post(sessionId, { id: 'unrelated-chatter', kind: 'message', text: 'I checked an older result.', mentions: [] });
		await rooms.post(sessionId, { id: 'actual-blocker', kind: 'work', text: 'The fixture is unavailable.', mentions: [], blocked: true });
		const snapshot = await rooms.getCoordinatorSnapshot(room.id);
		assert.deepStrictEqual({
			issues: snapshot.issues,
			unownedWork: snapshot.unownedWork,
		}, {
			issues: [{
				memberId: room.members[0].id,
				kind: 'blocked',
				description: 'The fixture is unavailable.',
				evidenceIds: ['actual-blocker'],
			}],
			unownedWork: [{
				id: 'room-goal',
				description: 'Keep evidence attributable',
				evidenceIds: [],
			}, {
				id: `worker-work:${room.members[0].id}`,
				description: 'The fixture is unavailable.',
				memberId: room.members[0].id,
				evidenceIds: ['actual-blocker'],
			}],
		});
		runtime.finish(room.members[0].sessionUri);
	});

	test('coordinator snapshots bound superseded history and model-facing text', async () => {
		const { rooms, runtime } = setup(1);
		const room = await rooms.createRoom({
			title: 'Bounded snapshot',
			goal: 'Keep coordinator prompts bounded',
			repositoryUri: 'file:///repository',
			workerCount: 1,
			continuous: false,
		});
		const coordinator = await rooms.ensureCoordinator(room.id);
		runtime.active.set(coordinator.sessionUri, 'human-coordinator-turn');
		runtime.emit({ sessionUri: coordinator.sessionUri, turnId: 'human-coordinator-turn', state: 'working' });
		await whenRoom(rooms, room.id, value => value.coordinator?.turnId === 'human-coordinator-turn');
		const sessionId = AgentSession.id(coordinator.sessionUri);
		for (let index = 0; index < 60; index++) {
			await rooms.assign(sessionId, {
				id: `assignment-${index}`,
				assignees: [room.members[0].id],
				kind: 'work',
				description: 'd'.repeat(3000),
				expectedEvidence: ['e'.repeat(1500)],
				...(index ? { supersedes: `assignment-${index - 1}` } : {}),
			});
		}
		const snapshot = await rooms.getCoordinatorSnapshot(room.id);
		assert.deepStrictEqual({
			assignments: snapshot.assignments.length,
			first: snapshot.assignments[0].id,
			last: snapshot.assignments.at(-1)?.id,
			descriptionLength: snapshot.assignments.at(-1)?.description.length,
			evidenceLength: snapshot.assignments.at(-1)?.expectedEvidence[0].length,
			evidenceIds: snapshot.evidenceIds.length,
		}, {
			assignments: 50,
			first: 'assignment-10',
			last: 'assignment-59',
			descriptionLength: 2000,
			evidenceLength: 1000,
			evidenceIds: 50,
		});
		runtime.finish(coordinator.sessionUri);
		runtime.finish(room.members[0].sessionUri);
	});

	suite('member models', () => {
		test('three peers retain distinct model IDs and SDK configuration before creation and after starting', async () => {
			const { rooms, provider, createdModels, storage, whenSent } = setupProduction();
			const models: ModelSelection[] = [
				{ id: 'model-a', config: { thinkingLevel: 'high', contextSize: 1_000_000 } },
				{ id: 'model-b', config: { thinkingLevel: 'low', contextSize: 200_000 } },
				{ id: 'auto', config: { tier: 'efficiency' } },
			];
			const memberNames = ['chaotic-cyborg', 'disciplined-neuron', 'caffeinated-compiler'];
			const room = await rooms.createRoom({
				title: 'Models', goal: 'Use independent choices', repositoryUri: 'file:///repository',
				workerCount: 3, memberNames, memberModels: models, continuous: false,
			});
			assert.deepStrictEqual({
				names: room.members.map(member => member.name),
				models: room.members.map(getRoomMemberModel),
				applied: room.members.map(member => member.modelSelection),
				created: createdModels.size, sends: provider.sendMessageCalls.length, worktrees: storage.worktrees.size,
			}, { names: memberNames, models, applied: [undefined, undefined, undefined], created: 0, sends: 0, worktrees: 0 });
			await rooms.startRoom(room.id, { maxTurns: 3 });
			await whenSent(3);
			assert.deepStrictEqual({
				created: room.members.map(member => createdModels.get(member.chatUri!)),
				applied: (await rooms.getRoom(room.id)).members.map(member => member.modelSelection),
				pending: (await rooms.getRoom(room.id)).members.map(member => member.pendingModel),
				changes: room.members.map(member => provider.changeModelCalls.filter(call => call.session.toString() === member.sessionUri).map(call => call.model)),
			}, { created: models, applied: models, pending: [undefined, undefined, undefined], changes: models.map(model => [model]) });
			await rooms.stopRoom(room.id);
		});

		test('invalid lists, unavailable models, disabled policy, and unsupported configuration reject before creating anything', async () => {
			const { rooms, runtime, storage } = setup();
			runtime.models = roomModelCatalog.map(model => model.id === 'model-b' ? { ...model, policyState: PolicyState.Disabled } : model);
			const channel = createAgentHostRoomsChannel(rooms, disposables.add(new DisposableStore()));
			const invalid: readonly Record<string, unknown>[] = [
				{ memberNames: [] }, { memberNames: ['chaotic-cyborg'] },
				{ memberNames: ['Chaotic-Cyborg', 'disciplined-neuron'] },
				{ memberNames: ['chaotic-cyborg', 'chaotic-cyborg'] },
				{ memberModels: [] }, { memberModels: [{ id: 'model-a' }] },
				{ memberModels: [{ id: 'model-a' }, { id: 'model-b' }] },
				{ memberModels: [{ id: 'missing' }, undefined] },
				{ memberModels: [{ id: '' }, undefined] },
				{ memberModels: [null, undefined] },
				{ memberModels: [{ id: 'model-a', config: [] }, undefined] },
				{ memberModels: [{ id: 'model-a', config: { thinkingLevel: 'unsupported' } }, undefined] },
				{ memberModels: [{ id: 'model-a', config: { contextSize: '1000000' } }, undefined] },
				{ memberModels: [{ id: 'model-a', config: { adaptive: {} } }, undefined] },
				{ memberModels: [{ id: 'model-a', config: { other: true } }, undefined] },
				{ memberModels: [{ id: 'model-a', other: true }, undefined] },
				{ model: 'missing' }, { model: 123 },
			];
			for (const options of invalid) {
				await assert.rejects(channel.call('room-client', 'createRoom', [{
					title: 'Invalid', goal: 'Do not create', repositoryUri: 'file:///repository', workerCount: 2, ...options,
				}]));
			}
			assert.deepStrictEqual({
				rooms: storage.records.size, worktrees: storage.worktrees.size, prepared: runtime.prepared, submitted: runtime.submitted,
			}, { rooms: 0, worktrees: 0, prepared: [], submitted: [] });
		});

		test('the local IPC codec preserves mixed and all-default slots, legacy fallback, and explicit Auto resets', async () => {
			const { rooms, runtime } = setup();
			runtime.models = roomModelCatalog.filter(model => model.id !== 'auto');
			const server = createAgentHostRoomsChannel(rooms, disposables.add(new DisposableStore()));
			const client = createAgentHostRoomsClient({
				call: (command, args) => {
					const writer = disposables.add(new BufferWriter());
					serialize(writer, args);
					return server.call('room-client', command, deserialize(new BufferReader(writer.buffer)));
				},
				listen: (event, args) => server.listen('room-client', event, args),
			});
			const first: ModelSelection = { id: 'model-a', config: { thinkingLevel: 'high', contextSize: 1_000_000 } };
			const last: ModelSelection = { id: 'model-b', config: { adaptive: true } };
			const mixed: readonly (ModelSelection | undefined)[] = [first, undefined, last];
			const defaults: readonly (ModelSelection | undefined)[] = [undefined, undefined, undefined];
			const memberNames = ['chaotic-cyborg', 'disciplined-neuron', 'caffeinated-compiler'];
			const created: IAgentHostRoom[] = [];
			for (const memberModels of [mixed, defaults]) {
				for (const model of [undefined, 'model-c']) {
					created.push(await client.createRoom({
						title: 'IPC', goal: 'Keep absence distinct', repositoryUri: 'file:///repository',
						workerCount: 3, memberNames, memberModels, model, continuous: false,
					}));
				}
			}
			const room = created[0];
			await assert.rejects(client.setMemberModel(room.id, room.members[2].id, undefined), /unavailable/);
			runtime.models = roomModelCatalog;
			const reset = await client.setMemberModel(room.id, room.members[2].id, undefined);
			assert.deepStrictEqual({
				names: created.map(room => room.members.map(member => member.name)),
				models: created.map(room => room.members.map(getRoomMemberModel)),
				reset: reset.members.map(getRoomMemberModel),
				submitted: runtime.submitted,
				capability: (await client.getCapabilities()).supportsMemberModels,
			}, {
				names: created.map(() => memberNames),
				models: [
					[first, undefined, last],
					[first, { id: 'model-c' }, last],
					[undefined, undefined, undefined],
					[{ id: 'model-c' }, { id: 'model-c' }, { id: 'model-c' }],
				],
				reset: [first, undefined, { id: 'auto' }], submitted: [], capability: true,
			});
		});

		test('the legacy all-model option remains a fallback for unspecified peers', async () => {
			const { rooms } = setup();
			const legacy = await rooms.createRoom({ title: 'Legacy', goal: 'Keep choices', repositoryUri: 'file:///repository', workerCount: 3, model: 'model-a', continuous: false });
			const mixed = await rooms.createRoom({
				title: 'Mixed', goal: 'Keep choices', repositoryUri: 'file:///repository', workerCount: 3, model: 'model-a',
				memberModels: [undefined, { id: 'model-b' }, { id: 'auto' }], continuous: false,
			});
			assert.deepStrictEqual({
				legacy: legacy.members.map(getRoomMemberModel), mixed: mixed.members.map(getRoomMemberModel),
			}, {
				legacy: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-a' }],
				mixed: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'auto' }],
			});
		});

		test('legacy room journals distinguish an applied selection from an unstarted preference', async () => {
			const { rooms, storage } = setup();
			const room = await rooms.createRoom({ title: 'Legacy journal', goal: 'Restore selections', repositoryUri: 'file:///repository', workerCount: 2, model: 'model-a', continuous: false });
			const record = storage.records.get(room.id)!;
			storage.records.set(room.id, {
				...record,
				room: { ...record.room, members: record.room.members.map(member => ({ ...member, modelSelection: undefined, pendingModel: undefined })) },
				executions: record.executions.map((execution, index) => ({ ...execution, initialized: index === 1 })),
			});
			rooms.dispose();
			const restored = setup(2, storage);
			const loaded = await restored.rooms.getRoom(room.id);
			assert.deepStrictEqual({
				selected: loaded.members.map(getRoomMemberModel),
				applied: loaded.members.map(member => member.modelSelection),
				pending: loaded.members.map(member => member.pendingModel),
				submitted: restored.runtime.submitted,
			}, {
				selected: [{ id: 'model-a' }, { id: 'model-a' }],
				applied: [undefined, { id: 'model-a' }], pending: [{ id: 'model-a' }, undefined], submitted: [],
			});
		});

		test('changing an unstarted peer persists its choice without preparing or submitting work', async () => {
			const { rooms, runtime, storage, create } = setup(3);
			const room = await create();
			const chosen = { id: 'model-b', config: { thinkingLevel: 'high', adaptive: false } };
			const changed = await rooms.setMemberModel(room.id, room.members[1].id, chosen);
			assert.deepStrictEqual({
				selected: changed.members.map(getRoomMemberModel),
				applied: changed.members.map(member => member.modelSelection),
				identities: changed.members.map(member => [member.id, member.sessionUri, member.chatUri, member.worktreeUri]),
				executions: storage.records.get(room.id)!.executions,
				prepared: runtime.prepared, changes: runtime.modelChanges, submitted: runtime.submitted,
			}, {
				selected: [undefined, chosen, undefined], applied: [undefined, undefined, undefined],
				identities: room.members.map(member => [member.id, member.sessionUri, member.chatUri, member.worktreeUri]),
				executions: room.members.map(member => ({ memberId: member.id, initialized: false, needsTurn: true })),
				prepared: [], changes: [], submitted: [],
			});
		});

		test('an idle model update only affects the intended peer and never creates a turn', async () => {
			const { rooms, runtime, create } = setup();
			const room = await create();
			await rooms.startRoom(room.id, { maxTurns: 2 });
			await runtime.whenSubmitted(2);
			for (const member of room.members) {
				runtime.finish(member.sessionUri);
			}
			await whenRoom(rooms, room.id, room => room.state === 'idle');
			const chosen = { id: 'model-b', config: { thinkingLevel: 'low' } };
			const updated = await rooms.setMemberModel(room.id, room.members[1].id, chosen);
			assert.deepStrictEqual({
				applied: updated.members.map(member => member.modelSelection),
				pending: updated.members.map(member => member.pendingModel),
				changes: runtime.modelChanges, submits: runtime.submitted.length,
				turns: updated.members.map(member => member.turns), room: updated.state,
			}, {
				applied: [undefined, chosen], pending: [undefined, undefined],
				changes: [{ sessionUri: room.members[1].sessionUri, model: chosen }], submits: 2, turns: [1, 1], room: 'idle',
			});
		});

		test('busy updates apply on the automatic next turn without changing the current execution', async () => {
			const { rooms, runtime, storage } = setup(1);
			const initial = { id: 'model-a' };
			const next = { id: 'model-b', config: { thinkingLevel: 'high' } };
			const room = await rooms.createRoom({ title: 'Busy', goal: 'Finish the current turn', repositoryUri: 'file:///repository', workerCount: 1, memberModels: [initial], continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 2 });
			await runtime.whenSubmitted(1);
			const executions = storage.records.get(room.id)!.executions;
			const pending = await rooms.setMemberModel(room.id, room.members[0].id, next);
			assert.deepStrictEqual({
				applied: pending.members[0].modelSelection, pending: pending.members[0].pendingModel,
				current: runtime.appliedModels.get(room.members[0].sessionUri),
				executions: storage.records.get(room.id)!.executions, changes: runtime.modelChanges.length, submits: runtime.submitted.length,
			}, { applied: initial, pending: next, current: initial, executions, changes: 1, submits: 1 });
			runtime.finish(room.members[0].sessionUri);
			await runtime.whenSubmitted(2);
			const current = (await rooms.getRoom(room.id)).members[0];
			assert.deepStrictEqual({
				applied: current.modelSelection, pending: current.pendingModel, changes: runtime.modelChanges.map(change => change.model),
			}, { applied: next, pending: undefined, changes: [initial, next] });
			await rooms.stopRoom(room.id);
		});

		test('the latest choice during preparation applies once before submission', async () => {
			const { rooms, runtime } = setup(1);
			runtime.blockPrepare = true;
			const room = await rooms.createRoom({ title: 'Preparing', goal: 'Use the latest choice', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await runtime.whenPrepared(1);
			await rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-b' });
			await rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-c', config: { thinkingLevel: 'high' } });
			await runtime.prepareGate.complete();
			await runtime.whenSubmitted(1);
			assert.deepStrictEqual(runtime.modelChanges.map(change => change.model), [{ id: 'model-c', config: { thinkingLevel: 'high' } }]);
			await rooms.stopRoom(room.id);
		});

		test('a newer choice arriving during the SDK acknowledgment is applied before the reserved turn submits', async () => {
			const { rooms, runtime } = setup(1);
			const applying = new DeferredPromise<void>();
			const applied = new DeferredPromise<void>();
			runtime.beforeApplyModel = async () => {
				runtime.beforeApplyModel = undefined;
				await applying.complete();
				await applied.p;
			};
			const room = await rooms.createRoom({ title: 'Ack', goal: 'Use the newest model', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await applying.p;
			const updated = rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-b' });
			await Promise.resolve();
			await applied.complete();
			await updated;
			await runtime.whenSubmitted(1);
			assert.deepStrictEqual({
				model: (await rooms.getRoom(room.id)).members[0].modelSelection,
				applied: runtime.modelChanges.map(change => change.model),
				submits: runtime.submitted.length,
			}, { model: { id: 'model-b' }, applied: [{ id: 'model-a' }, { id: 'model-b' }], submits: 1 });
			await rooms.stopRoom(room.id);
		});

		test('Stop during a model acknowledgment prevents the reserved turn from starting', async () => {
			const { rooms, runtime } = setup(1);
			const applying = new DeferredPromise<void>();
			const applied = new DeferredPromise<void>();
			runtime.beforeApplyModel = async () => {
				await applying.complete();
				await applied.p;
			};
			const room = await rooms.createRoom({ title: 'Stop', goal: 'Do not send', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await applying.p;
			const stopped = rooms.stopRoom(room.id);
			await applied.complete();
			assert.deepStrictEqual({ state: (await stopped).state, submits: runtime.submitted }, { state: 'stopped', submits: [] });
		});

		test('pending choices survive restart and Stop/Resume without changing modes or permissions', async () => {
			const { rooms, runtime, storage } = setup(1);
			const initial = { id: 'model-a' };
			const next = { id: 'auto', config: { tier: 'intelligence' } };
			const configuration: IAgentHostRoomConfiguration = { mode: 'plan', autoApprove: 'assisted', sandboxEnabled: 'on' };
			const room = await rooms.createRoom({ title: 'Restart', goal: 'Preserve selections', repositoryUri: 'file:///repository', workerCount: 1, memberModels: [initial], continuous: false });
			await rooms.setRoomConfiguration(room.id, configuration);
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await runtime.whenSubmitted(1);
			await rooms.setMemberModel(room.id, room.members[0].id, next);
			rooms.dispose();
			const restored = setup(1, storage);
			const interrupted = await restored.rooms.getRoom(room.id);
			assert.deepStrictEqual({
				state: interrupted.state, model: interrupted.members[0].modelSelection,
				pending: interrupted.members[0].pendingModel, submits: restored.runtime.submitted.length,
			}, { state: 'interrupted', model: initial, pending: next, submits: 0 });
			await restored.rooms.startRoom(room.id, { maxTurns: 1 });
			await restored.runtime.whenSubmitted(1);
			await restored.rooms.stopRoom(room.id);
			await restored.rooms.startRoom(room.id, { maxTurns: 1 });
			await restored.runtime.whenSubmitted(2);
			const current = (await restored.rooms.getRoom(room.id)).members[0];
			assert.deepStrictEqual({
				applied: current.modelSelection, pending: current.pendingModel, configuration: current.configuration,
				liveConfiguration: restored.runtime.configurations.get(current.sessionUri),
				identity: [current.id, current.sessionUri, current.chatUri, current.worktreeUri],
				appliedChoices: restored.runtime.modelChanges.map(change => change.model),
			}, {
				applied: next, pending: undefined, configuration, liveConfiguration: configuration,
				identity: [room.members[0].id, room.members[0].sessionUri, room.members[0].chatUri, room.members[0].worktreeUri],
				appliedChoices: [next],
			});
			await restored.rooms.stopRoom(room.id);
		});

		test('SDK rejection keeps the applied model and pending retry while exposing the error', async () => {
			const { rooms, runtime, storage } = setup(1);
			const room = await rooms.createRoom({ title: 'Rejected', goal: 'Do not fall back', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await runtime.whenSubmitted(1);
			runtime.finish(room.members[0].sessionUri);
			await whenRoom(rooms, room.id, room => room.state === 'idle');
			runtime.modelError = new Error('SDK rejected model-b');
			await assert.rejects(rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-b' }), /SDK rejected/);
			const rejected = storage.records.get(room.id)!.room.members[0];
			runtime.modelError = undefined;
			const retried = await rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-b' });
			assert.deepStrictEqual({
				rejected: [rejected.modelSelection, rejected.pendingModel, rejected.modelError],
				retried: [retried.members[0].modelSelection, retried.members[0].pendingModel, retried.members[0].modelError],
				submits: runtime.submitted.length, aborted: runtime.aborted,
			}, {
				rejected: [{ id: 'model-a' }, { id: 'model-b' }, 'Error: SDK rejected model-b'],
				retried: [{ id: 'model-b' }, undefined, undefined], submits: 1, aborted: [],
			});
		});

		test('a rejected pending model blocks the next turn without replacing the current model or scheduling a model-only turn', async () => {
			const { rooms, runtime } = setup(1);
			const room = await rooms.createRoom({ title: 'Next turn rejection', goal: 'Do not fall back', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 3 });
			await runtime.whenSubmitted(1);
			await rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-b' });
			runtime.modelError = new Error('SDK rejected the next model');
			await rooms.postMessage(room.id, { id: 'pending-request', text: 'A real follow-up', mentions: [room.members[0].id] });
			runtime.finish(room.members[0].sessionUri);
			const failed = await whenRoom(rooms, room.id, room => room.members[0].state === 'failed');
			assert.deepStrictEqual({
				applied: failed.members[0].modelSelection, pending: failed.members[0].pendingModel,
				error: failed.members[0].modelError, submits: runtime.submitted.length,
			}, {
				applied: { id: 'model-a' }, pending: { id: 'model-b' }, error: 'Error: SDK rejected the next model', submits: 1,
			});
			runtime.modelError = undefined;
			await rooms.retryMember(room.id, room.members[0].id);
			await runtime.whenSubmitted(2);
			assert.deepStrictEqual((await rooms.getRoom(room.id)).members[0].modelSelection, { id: 'model-b' });
			await rooms.stopRoom(room.id);
		});

		test('unsupported live configuration changes reject without mutating the saved preference', async () => {
			const { rooms, runtime, storage, create } = setup(1);
			const room = await create();
			const readonlyModel: IAgentModelInfo = {
				provider: 'copilotcli', id: 'readonly-model', name: 'Read-only model', supportsVision: false,
				configSchema: {
					type: 'object',
					properties: { thinkingLevel: { title: 'Thinking', type: 'string', enum: ['low'], readOnly: true } },
				},
			};
			runtime.models = [...roomModelCatalog, readonlyModel];
			const record = storage.records.get(room.id);
			await assert.rejects(rooms.setMemberModel(room.id, room.members[0].id, { id: readonlyModel.id, config: { thinkingLevel: 'low' } }), /does not support/);
			assert.strictEqual(storage.records.get(room.id), record);
		});

		test('a pending choice disabled by policy fails before submission without corrupting the journal or shutting down rooms', async () => {
			const { rooms, runtime, storage } = setup(1);
			const room = await rooms.createRoom({ title: 'Policy changed', goal: 'Fail closed', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			runtime.models = roomModelCatalog.map(model => ({ ...model, policyState: PolicyState.Disabled }));
			await rooms.startRoom(room.id, { maxTurns: 1 });
			const failed = await whenRoom(rooms, room.id, room => room.state === 'idle' && room.members[0].state === 'failed');
			assert.deepStrictEqual({
				pending: failed.members[0].pendingModel, applied: failed.members[0].modelSelection,
				error: failed.members[0].modelError?.includes('disabled by policy'), sends: runtime.submitted.length,
				available: (await rooms.getCapabilities()).available, saved: storage.records.get(room.id)!.room.members[0].pendingModel,
			}, { pending: { id: 'model-a' }, applied: undefined, error: true, sends: 0, available: true, saved: { id: 'model-a' } });
			runtime.models = roomModelCatalog;
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await runtime.whenSubmitted(1);
			await rooms.stopRoom(room.id);
		});

		test('reset requires the live Auto catalog entry and never falls back to an arbitrary model', async () => {
			const { rooms, runtime } = setup(1);
			const room = await rooms.createRoom({ title: 'Reset', goal: 'Use explicit Auto', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			runtime.models = roomModelCatalog.filter(model => model.id !== 'auto');
			await assert.rejects(rooms.setMemberModel(room.id, room.members[0].id, undefined), /unavailable/);
			assert.deepStrictEqual((await rooms.getRoom(room.id)).members.map(getRoomMemberModel), [{ id: 'model-a' }]);
		});

		test('native member chat picker changes are journalled and survive Stop/Resume', async () => {
			const { rooms, service, provider, state, whenSent } = setupProduction();
			const room = await rooms.createRoom({ title: 'Native', goal: 'Keep picker changes', repositoryUri: 'file:///repository', workerCount: 2, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 2 });
			await whenSent(2);
			const selected = { id: 'model-b', config: { thinkingLevel: 'high' } };
			const chat = room.members[1].chatUri!;
			service.dispatchAction(chat, { type: ActionType.ChatDraftChanged, draft: { text: 'Keep this draft', origin: { kind: MessageKind.User }, model: selected } }, 'model-picker', 1);
			const pending = await whenRoom(rooms, room.id, room => room.members[1].pendingModel?.id === 'model-b');
			assert.deepStrictEqual({
				pending: pending.members.map(member => member.pendingModel),
				applied: pending.members.map(member => member.modelSelection),
				sends: provider.sendMessageCalls.length,
			}, { pending: [undefined, selected], applied: [{ id: 'model-a' }, { id: 'model-a' }], sends: 2 });
			await rooms.stopRoom(room.id);
			await rooms.startRoom(room.id, { maxTurns: 2 });
			await whenSent(4);
			assert.deepStrictEqual({
				models: (await rooms.getRoom(room.id)).members.map(member => member.modelSelection),
				providerModels: room.members.map(member => provider.chats.getModel!(URI.parse(member.chatUri!), URI.parse(member.sessionUri))),
				draftModel: state.getChatState(chat)?.draft?.model,
			}, { models: [{ id: 'model-a' }, selected], providerModels: [{ id: 'model-a' }, selected], draftModel: selected });
			await rooms.stopRoom(room.id);
		});

		test('provider-native applied choices are reconciled rather than overwritten on Resume', async () => {
			const { rooms, provider, whenSent } = setupProduction();
			const room = await rooms.createRoom({ title: 'Reconcile', goal: 'Keep provider choices', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await whenSent(1);
			await rooms.stopRoom(room.id);
			await provider.chats.changeModel(URI.parse(room.members[0].chatUri!), { id: 'model-c' }, URI.parse(room.members[0].sessionUri));
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await whenSent(2);
			assert.deepStrictEqual((await rooms.getRoom(room.id)).members[0].modelSelection, { id: 'model-c' });
			await rooms.stopRoom(room.id);
		});

		test('native draft clearing and other chat identities cannot reset a member model', async () => {
			const { rooms, service, whenSent } = setupProduction();
			const room = await rooms.createRoom({ title: 'Identity', goal: 'Keep selections', repositoryUri: 'file:///repository', workerCount: 1, model: 'model-a', continuous: false });
			await rooms.startRoom(room.id, { maxTurns: 1 });
			await whenSent(1);
			const member = room.members[0];
			service.dispatchAction(member.chatUri!, { type: ActionType.ChatDraftChanged, draft: undefined }, 'model-picker', 1);
			await rooms.setMemberModelForChat(member.sessionUri, buildChatUri(member.sessionUri, 'other-chat'), { id: 'model-b' });
			assert.deepStrictEqual({
				selected: getRoomMemberModel((await rooms.getRoom(room.id)).members[0]),
				otherChat: await rooms.getMemberModelForChat(member.sessionUri, buildChatUri(member.sessionUri, 'other-chat')),
			}, { selected: { id: 'model-a' }, otherChat: undefined });
			await rooms.stopRoom(room.id);
		});
	});

	test('room configuration is journalled for all peers before application and restored across runs', async () => {
		const { rooms, runtime, storage, create } = setup();
		const room = await create();
		const selected: IAgentHostRoomConfiguration = { mode: 'plan', autoApprove: 'assisted', sandboxEnabled: 'on' };
		runtime.beforeApplyConfiguration = () => assert.deepStrictEqual(storage.records.get(room.id)!.room.members.map(member => member.configuration), [selected, selected]);
		await rooms.setRoomConfiguration(room.id, selected);
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(2);
		await rooms.pauseRoom(room.id);
		await rooms.startRoom(room.id, {});
		await rooms.stopRoom(room.id);
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(4);
		await rooms.stopRoom(room.id);
		rooms.dispose();
		const restored = setup(2, storage);
		assert.deepStrictEqual({
			values: (await restored.rooms.getRoomConfiguration(room.id)).values,
			members: (await restored.rooms.getRoom(room.id)).members.map(member => member.configuration),
			applied: [...runtime.configurations.values()],
			spontaneousSends: restored.runtime.submitted.length,
		}, { values: selected, members: [selected, selected], applied: [selected, selected], spontaneousSends: 0 });
	});

	test('legacy rooms default to Autopilot and Manual without overwriting explicit member selections', async () => {
		const { rooms, storage, create } = setup();
		const room = await create();
		const stored = storage.records.get(room.id)!;
		const explicit: IAgentHostRoomConfiguration = { mode: 'interactive', autoApprove: 'autoApprove', sandboxEnabled: 'off' };
		storage.records.set(room.id, {
			...stored, room: { ...stored.room, members: stored.room.members.map((member, index) => ({ ...member, configuration: index ? explicit : undefined })) },
		});
		rooms.dispose();
		const restored = setup(2, storage);
		assert.deepStrictEqual({
			members: (await restored.rooms.getRoom(room.id)).members.map(member => member.configuration),
			mixed: (await restored.rooms.getRoomConfiguration(room.id)).values,
		}, { members: [defaultAgentHostRoomConfiguration, explicit], mixed: {} });
	});

	test('a read-only setting on any peer cannot be changed by the room-wide menu', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		runtime.resolveConfiguration = async (member, configuration) => {
			const schema = platformSessionSchema.toProtocol();
			if (member.id === room.members[1].id) {
				schema.properties.mode = { ...schema.properties.mode, readOnly: true };
			}
			return { schema, values: { ...(configuration ?? defaultAgentHostRoomConfiguration) } };
		};
		await assert.rejects(rooms.setRoomConfiguration(room.id, { mode: 'plan' }), /does not allow/);
		assert.deepStrictEqual({
			readOnly: (await rooms.getRoomConfiguration(room.id)).schema.properties.mode.readOnly,
			modes: (await rooms.getRoom(room.id)).members.map(member => member.configuration?.mode),
		}, { readOnly: true, modes: ['autopilot', 'autopilot'] });
	});

	test('configuration changed during preparation wins over the reserved member snapshot', async () => {
		const { rooms, runtime, create } = setup();
		runtime.blockPrepare = true;
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenPrepared(2);
		await rooms.setRoomConfiguration(room.id, { mode: 'plan', autoApprove: 'assisted' });
		await runtime.prepareGate.complete();
		await runtime.whenSubmitted(2);
		assert.deepStrictEqual([...runtime.configurations.values()], room.members.map(() => ({ mode: 'plan', autoApprove: 'assisted', sandboxEnabled: 'default' })));
		await rooms.stopRoom(room.id);
	});

	test('failed configuration application rejects but keeps the desired selections for explicit resume', async () => {
		const { rooms, runtime, storage, create } = setup();
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(2);
		runtime.configurationError = new Error('SDK refused mode');
		await assert.rejects(rooms.setRoomConfiguration(room.id, { mode: 'interactive' }), /SDK refused mode/);
		const failed = await rooms.getRoom(room.id);
		const effective = await rooms.getRoomConfiguration(room.id);
		runtime.configurationError = undefined;
		await rooms.stopRoom(room.id);
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(4);
		assert.deepStrictEqual({
			failedState: failed.state, effective: effective.values.mode,
			saved: storage.records.get(room.id)!.room.members.map(member => member.configuration?.mode),
			retried: [...runtime.configurations.values()].map(configuration => configuration.mode),
		}, { failedState: 'paused', effective: 'autopilot', saved: ['interactive', 'interactive'], retried: ['interactive', 'interactive'] });
		await rooms.stopRoom(room.id);
	});

	test('the public room channel permits configuration but rejects malformed and host-only operations', async () => {
		const { rooms, create } = setup();
		const room = await create();
		const channel = createAgentHostRoomsChannel(rooms, disposables.add(new DisposableStore()));
		for (const configuration of [null, [], { mode: 'invalid' }, { autoApprove: true }, { sandboxEnabled: 'disabled' }, { isolation: 'folder' }, { workingDirectories: [] }]) {
			await assert.rejects(channel.call('room-client', 'setRoomConfiguration', [room.id, configuration]), /Invalid/);
		}
		for (const command of ['setMemberConfiguration', '_setConfiguration', 'getMemberModelForChat', 'setMemberModelForChat', '_applyMemberModel', '_binding', 'isRoomSessionUri', 'isCoordinatorSessionUri', 'getCoordinatorTurnSnapshot', 'beforeTool', 'assign']) {
			await assert.rejects(channel.call('room-client', command, [room.members[0].sessionUri, { mode: 'plan' }]), /Unknown room method/);
		}
		await channel.call('room-client', 'setRoomConfiguration', [room.id, { mode: 'plan' }]);
		await channel.call('room-client', 'ensureCoordinator', [room.id]);
		await channel.call('room-client', 'getCoordinatorSnapshot', [room.id]);
		const coordinator = await rooms.getCoordinator(room.id);
		const snapshot = await rooms.getCoordinatorSnapshot(room.id);
		const capabilities = await rooms.getCapabilities();
		assert.deepStrictEqual({
			configuration: (await rooms.getRoomConfiguration(room.id)).values,
			coordinator: coordinator!.id,
			snapshot: snapshot.coordinator.id,
			capability: capabilities.supportsCoordinator,
		}, {
			configuration: { ...newAgentHostRoomConfiguration, mode: 'plan' },
			coordinator: room.coordinator!.id,
			snapshot: room.coordinator!.id,
			capability: true,
		});
	});

	test('two preserved sessions apply room and individual choices immediately and retain them after Stop and Resume', async () => {
		const { rooms, state, storage, provider, changeConfiguration, whenSent } = setupProduction();
		const applied = new Map<string, Record<string, unknown>>();
		provider.chats.applyConfiguration = async (_chat, context) => {
			const session = URI.isUri(context) ? context.toString() : context.configurationResource.toString();
			applied.set(session, { ...state.getSessionState(session)!.config!.values });
		};
		const room = await rooms.createRoom({ title: 'Configuration', goal: 'Keep selections', repositoryUri: 'file:///repository', workerCount: 2, continuous: false });
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await whenSent(2);
		const shared: IAgentHostRoomConfiguration = { mode: 'interactive', autoApprove: 'autoApprove', sandboxEnabled: 'off' };
		await rooms.setRoomConfiguration(room.id, shared);
		assert.deepStrictEqual(room.members.map(member => applied.get(member.sessionUri)), room.members.map(() => ({ isolation: 'folder', ...shared })));
		await rooms.pauseRoom(room.id);
		const individual: IAgentHostRoomConfiguration = { mode: 'plan', autoApprove: 'assisted', sandboxEnabled: 'on' };
		const receipt = await changeConfiguration(room.members[0].sessionUri, { ...individual });
		const mixed = await rooms.getRoomConfiguration(room.id);
		await rooms.startRoom(room.id, {});
		await rooms.stopRoom(room.id);
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await whenSent(4);
		assert.deepStrictEqual({
			rejection: receipt.rejectionReason,
			mixed: mixed.values,
			stored: storage.records.get(room.id)!.room.members.map(member => member.configuration),
			applied: room.members.map(member => applied.get(member.sessionUri)),
			sessions: (await rooms.getRoom(room.id)).members.map(member => member.sessionUri),
			sends: provider.sendMessageCalls.length,
		}, {
			rejection: undefined, mixed: {}, stored: [individual, shared],
			applied: [{ isolation: 'folder', ...individual }, { isolation: 'folder', ...shared }],
			sessions: room.members.map(member => member.sessionUri), sends: 4,
		});
		await rooms.stopRoom(room.id);
	});

	test('configuration receipts reject invalid, immutable, and policy-restricted selections without changing the journal', async () => {
		const { rooms, storage, configuration, changeConfiguration, whenSent } = setupProduction();
		const room = await rooms.createRoom({ title: 'Policy', goal: 'Preserve restrictions', repositoryUri: 'file:///repository', workerCount: 2, continuous: false });
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await whenSent(2);
		const session = room.members[0].sessionUri;
		const invalid: Record<string, unknown>[] = [
			{ mode: 'unknown' }, { autoApprove: false }, { sandboxEnabled: 'unknown' },
			{ isolation: 'worktree' }, { branch: 'other' }, { workingDirectories: ['file:///elsewhere'] }, { permissions: { allow: ['*'] } },
		];
		const rejected = [];
		for (const patch of invalid) {
			rejected.push(!!(await changeConfiguration(session, patch)).rejectionReason);
		}
		rejected.push(!!(await changeConfiguration(session, { mode: 'plan' }, true)).rejectionReason);
		configuration.updateRootConfig({ [AgentHostAutoApprovePolicyRestrictedConfigKey]: true });
		configuration.setSessionSandboxPolicy(session, { enabled: true, allowBypass: false });
		const before = storage.records.get(room.id);
		for (const autoApprove of ['assisted', 'autoApprove'] as const) {
			await assert.rejects(rooms.setRoomConfiguration(room.id, { autoApprove }), /policy/);
			rejected.push(!!(await changeConfiguration(session, { autoApprove })).rejectionReason);
		}
		await assert.rejects(rooms.setRoomConfiguration(room.id, { sandboxEnabled: 'off' }), /policy/);
		rejected.push(!!(await changeConfiguration(session, { sandboxEnabled: 'off' })).rejectionReason);
		const resolved = await rooms.getRoomConfiguration(room.id);
		assert.deepStrictEqual({
			rejected, journalUnchanged: storage.records.get(room.id) === before,
			approvals: resolved.schema.properties.autoApprove.enum,
			approvalLabels: resolved.schema.properties.autoApprove.enumLabels,
			sandbox: resolved.schema.properties.sandboxEnabled.enum,
			values: resolved.values,
		}, {
			rejected: Array(invalid.length + 4).fill(true), journalUnchanged: true,
			approvals: ['default'], approvalLabels: [platformSessionSchema.definition.autoApprove.protocol.enumLabels![0]],
			sandbox: ['default', 'on'], values: defaultAgentHostRoomConfiguration,
		});
		await rooms.stopRoom(room.id);
	});

	test('provider choices are intersected and validated for every member before changing the journal', async () => {
		const { rooms, storage, provider } = setupProduction();
		const room = await rooms.createRoom({ title: 'Provider choices', goal: 'Use supported modes', repositoryUri: 'file:///repository', workerCount: 2, continuous: false });
		provider.resolveChatConfig = async params => {
			const modes = params.workingDirectory?.toString() === room.members[0].worktreeUri ? ['interactive', 'plan'] : ['plan', 'autopilot'];
			const schema = platformSessionSchema.toProtocol();
			return {
				schema: { ...schema, properties: { ...schema.properties, mode: { ...schema.properties.mode, enum: modes, enumLabels: modes, enumDescriptions: modes } } },
				values: { ...params.config, mode: modes.find(mode => mode === params.config?.mode) ?? 'plan' },
			};
		};
		const before = storage.records.get(room.id);
		await assert.rejects(rooms.setRoomConfiguration(room.id, { mode: 'interactive' }), /provider/);
		const resolved = await rooms.getRoomConfiguration(room.id);
		assert.deepStrictEqual({
			unchanged: storage.records.get(room.id) === before,
			choices: resolved.schema.properties.mode.enum,
			labels: resolved.schema.properties.mode.enumLabels,
			mixedMode: resolved.values.mode,
		}, { unchanged: true, choices: ['plan'], labels: ['plan'], mixedMode: undefined });
		await rooms.setRoomConfiguration(room.id, { mode: 'plan' });
		assert.strictEqual((await rooms.getRoomConfiguration(room.id)).values.mode, 'plan');
	});

	test('a rejected SDK update rolls back live configuration and rejects the client receipt while preserving the desired retry', async () => {
		const { rooms, state, storage, provider, changeConfiguration, whenSent } = setupProduction();
		const room = await rooms.createRoom({ title: 'Failure', goal: 'Do not acknowledge failed SDK changes', repositoryUri: 'file:///repository', workerCount: 2, continuous: false });
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await whenSent(2);
		let rejectNext = true;
		provider.chats.applyConfiguration = async () => {
			if (rejectNext) {
				rejectNext = false;
				throw new Error('SDK configuration failed');
			}
		};
		const session = room.members[0].sessionUri;
		const receipt = await changeConfiguration(session, { mode: 'plan', autoApprove: 'autoApprove' });
		assert.deepStrictEqual({
			rejected: receipt.rejectionReason?.includes('SDK configuration failed'),
			live: state.getSessionState(session)?.config?.values,
			desired: storage.records.get(room.id)!.room.members[0].configuration,
		}, {
			rejected: true,
			live: { isolation: 'folder', ...newAgentHostRoomConfiguration },
			desired: { mode: 'plan', autoApprove: 'autoApprove', sandboxEnabled: 'default' },
		});
		await rooms.stopRoom(room.id);
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await whenSent(4);
		assert.strictEqual(state.getSessionState(session)?.config?.values.mode, 'plan');
		await rooms.stopRoom(room.id);
	});

	test('ten peers all enter preparation before any is released, with distinct stable sessions and worktrees', async () => {
		const { rooms, runtime, storage, create } = setup(10);
		runtime.blockPrepare = true;
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 10, timeoutMinutes: 1 });
		await runtime.whenPrepared(10);
		assert.deepStrictEqual({
			entered: runtime.prepared.length, submitted: runtime.submitted.length,
			sessions: new Set(runtime.prepared).size, worktrees: storage.worktrees.size,
		}, { entered: 10, submitted: 0, sessions: 10, worktrees: 10 });
		await runtime.prepareGate.complete();
		await runtime.whenSubmitted(10);
		assert.deepStrictEqual(runtime.submitted.map(turn => turn.sessionUri).sort(), room.members.map(member => member.sessionUri).sort());
		await rooms.stopRoom(room.id);
		assert.strictEqual(storage.worktrees.size, 10);
	});

	test('explicit recipients wake a dormant peer and legacy context-only posts remain idempotent', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2, timeoutMinutes: 1 });
		await runtime.whenSubmitted(2);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.postMessage(room.id, { id: 'broadcast', text: 'Background context, no wakeup', mentions: [] });
		const options = { id: 'targeted', text: `@${room.members[1].name} Please check this finding`, mentions: [] };
		const first = await rooms.postMessage(room.id, options);
		const duplicate = await rooms.postMessage(room.id, options);
		await runtime.whenSubmitted(3);
		assert.deepStrictEqual({
			posts: (await rooms.getMessages(room.id)).messages.length,
			duplicate: duplicate.id, original: first.id,
			recipient: runtime.submitted[2].sessionUri,
			mentions: first.mentions,
		}, { posts: 2, duplicate: 'targeted', original: 'targeted', recipient: room.members[1].sessionUri, mentions: [room.members[1].id] });
		await assert.rejects(rooms.postMessage(room.id, { ...options, text: 'Changed message' }), /already used/);
	});

	test('a normal room-wide follow-up reaches every finished peer and accepts their replies', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 1 });
		await runtime.whenSubmitted(3);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		const request = { id: 'room-follow-up', text: 'One more question about the result', mentions: room.members.map(member => member.id) };
		const message = await rooms.postMessage(room.id, request);
		await runtime.whenSubmitted(6);
		const followups = runtime.submitted.slice(3);
		for (const member of room.members) {
			const sessionId = AgentSession.id(member.sessionUri);
			await rooms.read(sessionId);
			await rooms.post(sessionId, { id: `reply-${member.id}`, text: 'Here is my response', mentions: [], replyTo: message.id });
		}
		await rooms.stopRoom(room.id);
		await rooms.postMessage(room.id, request);
		const current = await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			recipients: followups.map(turn => turn.sessionUri).sort(),
			newRequestInEveryPrompt: followups.every(turn => turn.prompt.includes(request.text) && turn.prompt.includes('New human guidance')),
			replies: (await rooms.getMessages(room.id)).messages.filter(post => post.replyTo === message.id).map(post => post.authorId).sort(),
			turns: runtime.submitted.length,
			limits: current.run?.limits,
		}, {
			recipients: room.members.map(member => member.sessionUri).sort(), newRequestInEveryPrompt: true,
			replies: room.members.map(member => member.id).sort(), turns: 6, limits: {},
		});
	});

	test('normal room-wide messages queue for busy peers without steering or starting parallel turns', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(3);
		await rooms.postMessage(room.id, { id: 'queued-for-everyone', text: 'Please react when you finish', mentions: room.members.map(member => member.id) });
		assert.deepStrictEqual({ turns: runtime.submitted.length, steering: runtime.steered.length }, { turns: 3, steering: 0 });
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await runtime.whenSubmitted(6);
		assert.deepStrictEqual(runtime.submitted.slice(3).map(turn => turn.sessionUri).sort(), room.members.map(member => member.sessionUri).sort());
	});

	test('Pause holds a room-wide follow-up until the human resumes', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await runtime.whenSubmitted(3);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'paused-broadcast', text: 'Please answer after resuming', mentions: room.members.map(member => member.id) });
		assert.deepStrictEqual({
			state: (await rooms.getRoom(room.id)).state,
			submitted: runtime.submitted.length,
			deliveries: (await rooms.getMessages(room.id)).messages[0].deliveries.map(delivery => delivery.state),
		}, { state: 'paused', submitted: 3, deliveries: ['pending', 'pending', 'pending'] });
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(6);
		assert.ok(runtime.submitted.slice(3).every(turn => turn.prompt.includes('Please answer after resuming')));
	});

	test('human steering without mentions reaches every active peer without starting extra turns', async () => {
		const { rooms, runtime, storage, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await runtime.whenSubmitted(3);
		await rooms.postMessage(room.id, { id: 'human-guidance', mode: 'steer', text: 'Prioritize accessibility over new animations.', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries.every(delivery => delivery.state === 'delivered'));
		assert.deepStrictEqual({
			recipients: runtime.steered.map(call => call.sessionUri).sort(),
			activeTurns: runtime.steered.map(call => call.turnId).sort(),
			turns: runtime.submitted.length,
			admitted: (await rooms.getRoom(room.id)).run?.admittedTurns,
			mentions: (await rooms.getMessages(room.id)).messages[0].mentions,
		}, {
			recipients: room.members.map(member => member.sessionUri).sort(),
			activeTurns: runtime.submitted.map(call => call.turnId).sort(),
			turns: 3, admitted: 3, mentions: room.members.map(member => member.id),
		});

		await rooms.stopRoom(room.id);
	});

	test('production runtime overlaps ten preserved chats and steers only their admitted turns', async () => {
		const { storage, service, provider, rooms, state, changeConfiguration } = setupProduction();
		const steered: { chat: string; turnId: string; session: string }[] = [];
		provider.chats.sendSteeringInCurrentTurn = async (chat, turnId, _prompt, context) => {
			steered.push({ chat: chat.toString(), turnId, session: URI.isUri(context) ? context.toString() : context.configurationResource.toString() });
			return true;
		};
		const started = new DeferredPromise<void>();
		disposables.add(provider.onDidSendMessage(() => {
			if (provider.sendMessageCalls.length === 10) {
				started.complete();
			}
		}));
		const room = await rooms.createRoom({ title: 'Shared work', goal: 'Inspect the form', repositoryUri: 'file:///repository', workerCount: 10, continuous: false });
		await rooms.startRoom(room.id, { maxTurns: 10 });
		await started.p;
		const expected = room.members.map(member => ({
			chat: buildDefaultChatUri(member.sessionUri),
			turnId: state.getActiveTurnId(buildDefaultChatUri(member.sessionUri)),
			session: member.sessionUri,
		}));
		await rooms.postMessage(room.id, { id: 'bridge-guidance', text: 'Check accessibility first', mode: 'steer', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries.every(delivery => delivery.state === 'delivered'));
		assert.deepStrictEqual({
			steered, chats: room.members.map(member => member.chatUri),
			activeTurns: room.members.map(member => state.getActiveTurnId(buildDefaultChatUri(member.sessionUri))),
			sends: provider.sendMessageCalls.length, worktrees: storage.worktrees.size,
			modes: room.members.map(member => state.getSessionState(member.sessionUri)?.config?.values.mode),
			approvals: room.members.map(member => state.getSessionState(member.sessionUri)?.config?.values.autoApprove),
		}, {
			steered: expected, chats: expected.map(member => member.chat),
			activeTurns: expected.map(member => member.turnId), sends: 10, worktrees: 10,
			modes: Array(10).fill('autopilot'), approvals: Array(10).fill('assisted'),
		});
		const member = room.members[0];
		const chat = buildDefaultChatUri(member.sessionUri);
		const rejected: ActionType[] = [];
		const pendingRejected = new DeferredPromise<void>();
		disposables.add(service.onDidAction(envelope => {
			if (envelope.channel === chat && envelope.rejectionReason) {
				rejected.push(envelope.action.type);
				if (rejected.length === 6) {
					pendingRejected.complete();
				}
			}
		}));
		service.dispatchAction(chat, {
			type: ActionType.ChatTurnStarted, turnId: 'unadmitted', startedAt: new Date().toISOString(),
			message: { text: 'Bypass room admission', origin: { kind: MessageKind.User } },
		}, 'raw-client', 1);
		let clientSequence = 2;
		for (const kind of [PendingMessageKind.Steering, PendingMessageKind.Queued]) {
			service.dispatchAction(chat, {
				type: ActionType.ChatPendingMessageSet, kind, id: `native-${kind}`,
				message: { text: 'Bypass room journal', origin: { kind: MessageKind.User } },
			}, 'raw-client', clientSequence++);
			service.dispatchAction(chat, {
				type: ActionType.ChatPendingMessageRemoved, kind, id: `native-${kind}`,
			}, 'raw-client', clientSequence++);
		}
		service.dispatchAction(chat, { type: ActionType.ChatQueuedMessagesReordered, order: [] }, 'raw-client', clientSequence++);
		await pendingRejected.p;
		assert.deepStrictEqual({
			rejected, nativePendingCalls: provider.setPendingMessagesCalls.length,
			steering: state.getChatState(chat)?.steeringMessage,
			queued: state.getChatState(chat)?.queuedMessages?.length ?? 0,
		}, {
			rejected: [
				ActionType.ChatTurnStarted,
				ActionType.ChatPendingMessageSet, ActionType.ChatPendingMessageRemoved,
				ActionType.ChatPendingMessageSet, ActionType.ChatPendingMessageRemoved,
				ActionType.ChatQueuedMessagesReordered,
			],
			nativePendingCalls: 0, steering: undefined, queued: 0,
		});
		const turnId = state.getActiveTurnId(chat)!;
		provider.fireProgress({
			kind: 'action', resource: URI.parse(chat),
			action: { type: ActionType.ChatToolCallStart, turnId, toolCallId: 'room-allow', toolName: 'read_file', displayName: 'Read a file' },
		});
		provider.fireProgress({
			kind: 'action', resource: URI.parse(chat),
			action: { type: ActionType.ChatToolCallReady, turnId, toolCallId: 'room-allow', invocationMessage: 'Read the project file' },
		});
		const confirmed = new DeferredPromise<void>();
		disposables.add(service.onDidAction(envelope => {
			if (envelope.channel === chat && envelope.action.type === ActionType.ChatToolCallConfirmed && envelope.origin?.clientId === 'room-screen') {
				if (envelope.rejectionReason) {
					confirmed.error(new Error(envelope.rejectionReason));
				} else {
					confirmed.complete();
				}
			}
		}));
		service.dispatchAction(chat, {
			type: ActionType.ChatToolCallConfirmed, turnId, toolCallId: 'room-allow', approved: true, confirmed: ToolCallConfirmationReason.UserAction,
		}, 'room-screen', 1);
		await confirmed.p;
		const call = state.getChatState(chat)?.activeTurn?.responseParts.find(part => part.kind === ResponsePartKind.ToolCall);
		assert.deepStrictEqual({
			status: call?.kind === ResponsePartKind.ToolCall ? call.toolCall.status : undefined,
			responses: provider.respondToPermissionCalls,
			turn: state.getActiveTurnId(chat),
		}, { status: ToolCallStatus.Running, responses: [{ requestId: 'room-allow', approved: true }], turn: turnId });
		await assert.rejects(service.createChat(URI.parse(member.sessionUri), URI.parse(buildChatUri(member.sessionUri, 'extra'))), /preserved chat/);
		await assert.rejects(service.disposeSession(URI.parse(member.sessionUri)), /preserved session/);
		await rooms.stopRoom(room.id);
		assert.deepStrictEqual({
			sends: provider.sendMessageCalls.length, worktrees: storage.worktrees.size,
			sessions: (await rooms.getRoom(room.id)).members.map(member => member.sessionUri),
			deleted: provider.disposeSessionCalls.length,
			active: state.getActiveTurnId(chat),
		}, { sends: 10, worktrees: 10, sessions: room.members.map(member => member.sessionUri), deleted: 0, active: undefined });
		assert.strictEqual((await changeConfiguration(member.sessionUri, { mode: 'interactive' })).rejectionReason, undefined);
		const resumed = new DeferredPromise<void>();
		disposables.add(provider.onDidSendMessage(() => {
			if (provider.sendMessageCalls.length === 20) {
				resumed.complete();
			}
		}));
		await rooms.startRoom(room.id, { maxTurns: 10 });
		await resumed.p;
		assert.deepStrictEqual({
			modes: room.members.map(member => state.getSessionState(member.sessionUri)?.config?.values.mode),
			approvals: room.members.map(member => state.getSessionState(member.sessionUri)?.config?.values.autoApprove),
			sessions: (await rooms.getRoom(room.id)).members.map(member => member.sessionUri),
			sends: provider.sendMessageCalls.length,
		}, {
			modes: ['interactive', ...Array(9).fill('autopilot')], approvals: Array(10).fill('assisted'),
			sessions: room.members.map(member => member.sessionUri), sends: 20,
		});
		await rooms.stopRoom(room.id);
	});

	test('resuming a paused active room preserves the admitted turns and delivers held guidance', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		const started = await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(2);
		const admitted = runtime.submitted.map(turn => turn.turnId);
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'paused-resume', text: 'Review the current changes', mode: 'steer', mentions: [] });
		await rooms.startRoom(room.id, {});
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries.every(delivery => delivery.state === 'delivered'));
		assert.deepStrictEqual({
			run: (await rooms.getRoom(room.id)).run?.id,
			turns: runtime.submitted.map(turn => turn.turnId),
			steered: runtime.steered.length,
		}, { run: started.run?.id, turns: admitted, steered: 2 });
	});

	test('Resume retries failed peers without requiring individual retries', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		storage.worktreeError = new Error('Temporary worktree failure');
		const room = await create();
		await rooms.startRoom(room.id, {});
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		storage.worktreeError = undefined;
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		await whenRoom(rooms, room.id, room => room.members.every(member => member.state === 'working'));
		assert.deepStrictEqual({
			sessions: runtime.submitted.map(turn => turn.sessionUri),
			states: (await rooms.getRoom(room.id)).members.map(member => member.state),
		}, { sessions: room.members.map(member => member.sessionUri), states: ['working', 'working'] });
	});

	test('steering targets only mentioned peers and requires fresh guidance before further tools', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		const sessionId = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(sessionId);
		await rooms.post(sessionId, { id: 'intent', text: 'Implementing animation', kind: 'work', mentions: [] });
		await rooms.postMessage(room.id, { id: 'redirect', text: `@${room.members[0].name} Stop animations and fix the form.`, mode: 'steer', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages.at(-1)!.deliveries[0].state === 'delivered');
		assert.throws(() => rooms.beforeTool(sessionId, 'edit'), /New human guidance/);
		const context = await rooms.read(sessionId);
		assert.doesNotThrow(() => rooms.beforeTool(sessionId, 'edit'));
		assert.deepStrictEqual({
			recipients: runtime.steered.map(call => call.sessionUri),
			guidance: context.humanGuidance.map(message => message.id),
			inbox: context.inbox.map(message => message.id),
			self: context.self.id,
		}, { recipients: [room.members[0].sessionUri], guidance: ['redirect'], inbox: ['redirect'], self: room.members[0].id });
	});

	test('steering a peer that just finished falls back to its next turn without a retry loop', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		runtime.steeringAccepted = false;
		await rooms.postMessage(room.id, { id: 'steer-late', text: 'Check the result', mode: 'steer', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries[0].state === 'pending' && !!storage.records.get(room.id)!.messages[0].deliveries[0].turnId);
		assert.strictEqual(runtime.steered.length, 1);
		runtime.finish(room.members[0].sessionUri);
		await runtime.whenSubmitted(2);
		assert.deepStrictEqual({ steeringCalls: runtime.steered.length, turns: runtime.submitted.length, promptContainsGuidance: runtime.submitted[1].prompt.includes('Check the result') },
			{ steeringCalls: 1, turns: 2, promptContainsGuidance: true });
	});

	test('Stop cancels in-flight steering and late acceptance cannot restart the room', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		runtime.blockSteering = true;
		await rooms.postMessage(room.id, { id: 'in-flight', text: 'Human redirection', mode: 'steer', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries[0].state === 'steering');
		await rooms.stopRoom(room.id);
		await runtime.steeringGate.complete(true);
		await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			state: (await rooms.getRoom(room.id)).state,
			delivery: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			turns: runtime.submitted.length,
		}, { state: 'stopped', delivery: 'cancelled', turns: 1 });
	});

	test('reading deferred guidance acknowledges delivery and does not start a duplicate follow-up', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		runtime.steeringAccepted = false;
		await rooms.postMessage(room.id, { id: 'read-guidance', text: 'Inspect the existing patch', mode: 'steer', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries[0].state === 'pending'
			&& !!storage.records.get(room.id)!.messages[0].deliveries[0].turnId);
		await rooms.read(AgentSession.id(room.members[0].sessionUri));
		runtime.finish(room.members[0].sessionUri);
		await runtime.whenSubmitted(2);
		assert.deepStrictEqual({
			state: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			turns: runtime.submitted.length,
			prompt: runtime.submitted[1].prompt,
		}, { state: 'completed', turns: 2, prompt: continueAfterTurnPrompt });
		await rooms.stopRoom(room.id);
	});

	test('old room journals expose host-resolved chat identities without changing preserved sessions or worktrees', async () => {
		const { storage, create } = setup(1);
		const room = await create();
		const record = storage.records.get(room.id)!;
		storage.records.set(room.id, {
			...record,
			room: { ...record.room, members: record.room.members.map(member => ({ ...member, chatUri: undefined })) },
		});
		const restored = setup(1, storage);
		const member = (await restored.rooms.getRoom(room.id)).members[0];
		assert.deepStrictEqual({
			session: member.sessionUri, chat: member.chatUri, worktree: member.worktreeUri,
			started: restored.runtime.submitted.length,
		}, {
			session: room.members[0].sessionUri, chat: buildDefaultChatUri(room.members[0].sessionUri),
			worktree: room.members[0].worktreeUri, started: 0,
		});
	});

	test('failed active steering is surfaced as interrupted rather than reported as delivered', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		runtime.steeringError = new Error('SDK steering unavailable');
		await rooms.postMessage(room.id, { id: 'failure', text: 'Please change direction', mode: 'steer', mentions: [] });
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries[0].state === 'interrupted');
		const delivery = (await rooms.getMessages(room.id)).messages[0].deliveries[0];
		assert.match(delivery.error!, /SDK steering unavailable/);
		assert.strictEqual(runtime.submitted.length, 1);
	});

	test('paused rooms retain human steering without injecting it into the active turn', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'paused-guidance', text: 'Use this approach when resumed', mode: 'steer', mentions: [] });
		assert.deepStrictEqual({ steering: runtime.steered.length, delivery: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state }, { steering: 0, delivery: 'pending' });
	});

	test('agents cannot impersonate human steering and peer findings do not block private work', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		const first = AgentSession.id(room.members[0].sessionUri);
		const second = AgentSession.id(room.members[1].sessionUri);
		await rooms.read(first);
		await rooms.read(second);
		await assert.rejects(rooms.post(first, { id: 'spoof', text: 'Everyone change direction', mode: 'steer', mentions: [] }), /Only the human/);
		await rooms.post(first, { id: 'claim', text: 'Implementing the form', kind: 'work', mentions: [] });
		await rooms.post(second, { id: 'independent', text: 'Testing another parser path', kind: 'work', mentions: [] });
		assert.deepStrictEqual((await rooms.getMessages(room.id)).messages.map(message => message.id), ['claim', 'independent']);
	});

	test('an agent mentioning itself cannot create a self-waking message loop', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 1 });
		await runtime.whenSubmitted(1);
		const sessionId = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(sessionId);
		const message = await rooms.post(sessionId, { id: 'self', text: `@${room.members[0].name} Finished my work`, kind: 'finding', mentions: [room.members[0].id] });
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual({ mentions: message.mentions, deliveries: message.deliveries, turns: runtime.submitted.length }, { mentions: [], deliveries: [], turns: 1 });
	});

	test('publishing checks only the sharing member\'s own worktree, which is the session the policy is evaluated in', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		const first = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(first);
		await rooms.post(first, { id: 'work', text: 'Implementing the shared form', kind: 'work', mentions: [] });
		storage.publishPatch = async (current, member, title, validateContent) => {
			await validateContent?.(['solver.py']);
			return {
				id: 'published-patch', memberId: member.id, title, baseRevision: current.baseRevision,
				sourceRevision: current.baseRevision, createdAt: 1, uri: 'file:///published/patch.diff',
			};
		};

		await rooms.sharePatch(first, 'Form patch');

		assert.deepStrictEqual(runtime.contentChecks, [{
			sessionUri: room.members[0].sessionUri,
			paths: [URI.joinPath(URI.parse(room.members[0].worktreeUri!), 'solver.py').fsPath],
		}], 'the source repository is outside the session working directory, so submitting it fails the whole batch closed');
	});

	test('a content exclusion rejection keeps the patch unpublished', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		const first = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(first);
		await rooms.post(first, { id: 'work', text: 'Implementing the shared form', kind: 'work', mentions: [] });
		storage.publishPatch = async (_current, _member, _title, validateContent) => {
			await validateContent?.(['secret.env']);
			throw new Error('unreachable');
		};
		runtime.contentAccessError = new Error('Content exclusion policy does not allow sharing');

		await assert.rejects(rooms.sharePatch(first, 'Form patch'), /Content exclusion policy/);
		assert.deepStrictEqual(storage.records.get(room.id)!.room.artifacts, []);
	});

	test('an added member joins with its own session and worktree and is scheduled a turn', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);

		const added = (await rooms.addMember(room.id)).members[2];
		await runtime.whenSubmitted(3);

		// The room addMember returns predates scheduling; read it back for the turn.
		const current = await rooms.getRoom(room.id);
		const scheduled = current.members[2];
		assert.deepStrictEqual({
			count: current.members.length,
			generatedName: /^[a-z]+-[a-z]+$/.test(scheduled.name),
			uniqueNames: new Set(current.members.map(member => member.name)).size,
			state: scheduled.state,
			turns: scheduled.turns,
			uniqueSessions: new Set(current.members.map(member => member.sessionUri)).size,
			uniqueWorktrees: new Set(current.members.map(member => member.worktreeUri)).size,
			submitted: runtime.submitted.some(entry => entry.sessionUri === added.sessionUri),
			receivedFullBrief: runtime.submitted.find(entry => entry.sessionUri === added.sessionUri)?.prompt.includes('Shared goal: Measure before changing code'),
		}, {
			count: 3, generatedName: true, uniqueNames: 3, state: 'starting', turns: 1,
			uniqueSessions: 3, uniqueWorktrees: 3, submitted: true, receivedFullBrief: true,
		});
	});

	test('an added member takes the next unused name and cannot exceed the room limit', async () => {
		const { rooms, create } = setup(MAX_ROOM_WORKERS);
		const room = await create();

		await assert.rejects(rooms.addMember(room.id), /at most/);
		assert.strictEqual((await rooms.getRoom(room.id)).members.length, MAX_ROOM_WORKERS);

		const smaller = setup(1);
		const second = await smaller.create();
		const grown = await smaller.rooms.addMember(second.id);
		assert.deepStrictEqual({
			count: grown.members.length,
			unique: new Set(grown.members.map(member => member.name)).size,
			format: grown.members.every(member => /^[a-z]+-[a-z]+$/.test(member.name)),
		}, { count: 2, unique: 2, format: true });
	});

	test('a removed peer keeps its posts but takes no further turns and is no longer a recipient', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(3);
		const retired = room.members[2];
		const first = AgentSession.id(retired.sessionUri);
		await rooms.read(first);
		await rooms.post(first, { id: 'work', text: 'Looked at the parser', kind: 'work', mentions: [] });

		await rooms.removeMember(room.id, retired.id);
		const submittedBefore = runtime.submitted.length;
		// An unaddressed steering broadcast is the path that derives recipients from the
		// roster, so it is where a retired peer must stop appearing.
		const message = await rooms.postMessage(room.id, { id: 'broadcast', text: 'keep going', mentions: [], mode: 'steer' });

		const current = await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			removed: current.members[2].removed,
			state: current.members[2].state,
			postSurvives: (await rooms.getMessages(room.id)).messages.some(item => item.id === 'work' && item.authorId === retired.id),
			addressed: message.deliveries.some(delivery => delivery.memberId === retired.id),
			remainingRecipients: message.deliveries.length,
			neverResubmitted: runtime.submitted.length === submittedBefore
				|| !runtime.submitted.slice(submittedBefore).some(entry => entry.sessionUri === retired.sessionUri),
			resumeRejected: await rooms.retryMember(room.id, retired.id).then(() => false, () => true),
		}, { removed: true, state: 'stopped', postSurvives: true, addressed: false, remainingRecipients: 2, neverResubmitted: true, resumeRejected: true });
	});

	test('a room keeps at least one agent', async () => {
		const { rooms, create } = setup(2);
		const room = await create();
		await rooms.removeMember(room.id, room.members[1].id);
		await assert.rejects(rooms.removeMember(room.id, room.members[0].id), /at least one agent/);
	});

	test('resuming a peer in a stopped room starts a run for it and leaves the others stopped', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		await rooms.stopRoom(room.id);

		const resumed = await rooms.retryMember(room.id, room.members[1].id);
		await runtime.whenSubmitted(3);

		const current = await rooms.getRoom(room.id);
		const prompt = runtime.submitted.at(-1)!.prompt;
		assert.deepStrictEqual({
			roomState: resumed.state,
			states: current.members.map(member => member.state),
			lastSubmitted: runtime.submitted.at(-1)?.sessionUri === room.members[1].sessionUri,
			continuedExistingChat: prompt,
			repeatedFullBrief: prompt.includes('Shared goal:'),
		}, { roomState: 'running', states: ['stopped', 'starting'], lastSubmitted: true, continuedExistingChat: continueRoomPrompt, repeatedFullBrief: false });
	});

	test('a stopped room gains the member but starts it only on resume', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		await rooms.stopRoom(room.id);

		const grown = await rooms.addMember(room.id);
		const added = grown.members[2];
		const submittedWhileStopped = runtime.submitted.some(entry => entry.sessionUri === added.sessionUri);

		// Resume gives all three members a turn, on top of the two from the first run.
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(5);

		assert.deepStrictEqual({
			count: grown.members.length,
			submittedWhileStopped,
			submittedAfterResume: runtime.submitted.some(entry => entry.sessionUri === added.sessionUri),
		}, { count: 3, submittedWhileStopped: false, submittedAfterResume: true });
	});

	test('peers can inspect published patches and older messages instead of copying private worktrees', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		const first = AgentSession.id(room.members[0].sessionUri);
		const second = AgentSession.id(room.members[1].sessionUri);
		await rooms.read(first);
		await rooms.post(first, { id: 'work', text: 'Implementing the shared form', kind: 'work', mentions: [] });
		storage.publishPatch = async (current, member, title) => ({
			id: 'published-patch', memberId: member.id, title, baseRevision: current.baseRevision,
			sourceRevision: current.baseRevision, createdAt: 1, uri: 'file:///published/patch.diff',
		});
		const published = await rooms.sharePatch(first, 'Form patch');
		storage.readArtifact = async () => 'x'.repeat(20000);
		const context = await rooms.read(second, { before: 2 });
		const latest = await rooms.read(second, { limit: 1 });
		const newer = await rooms.read(second, { after: 1, limit: 1 });
		const initial = await rooms.readArtifact(second, published.id);
		const remainder = await rooms.readArtifact(second, published.id, initial.nextOffset);
		assert.deepStrictEqual({
			oldMessages: context.messages.map(message => message.id), hasLater: context.hasLater,
			latestMessages: latest.messages.map(message => message.id), hasEarlier: latest.hasEarlier,
			newerMessages: newer.messages.map(message => message.id),
			artifact: initial.artifact.id, path: initial.patchPath,
			firstLength: initial.text.length, restLength: remainder.text.length, total: remainder.totalCharacters,
		}, {
			oldMessages: ['work'], hasLater: true,
			latestMessages: ['published-patch'], hasEarlier: true, newerMessages: ['published-patch'],
			artifact: 'published-patch', path: URI.parse('file:///published/patch.diff').fsPath, firstLength: 16000, restLength: 4000, total: 20000,
		});
		await assert.rejects(rooms.readArtifact(second, 'not-published'), /does not exist/);
		await assert.rejects(rooms.readArtifact(second, published.id, -1), /nonnegative/);
	});

	test('busy inbox waits, pause stops admission without aborting, and stop blocks late idle events', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 5, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		const member = room.members[0];
		const oldTurn = runtime.submitted[0].turnId;
		await rooms.postMessage(room.id, { id: 'busy', text: 'Please read later', mentions: [member.id] });
		await rooms.pauseRoom(room.id);
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.members[0].state === 'idle');
		assert.deepStrictEqual({ submissions: runtime.submitted.length, aborts: runtime.aborted.length, delivery: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state }, { submissions: 1, aborts: 0, delivery: 'pending' });
		await rooms.stopRoom(room.id);
		runtime.emit({ sessionUri: member.sessionUri, turnId: oldTurn, state: 'idle' });
		await rooms.postMessage(room.id, { id: 'stopped', text: 'Background context is not a request', mentions: [] });
		assert.deepStrictEqual({ submissions: runtime.submitted.length, state: (await rooms.getRoom(room.id)).state }, { submissions: 1, state: 'stopped' });
	});

	test('a human mention remains pending while stopped and reaches only its peer after Resume', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 1 });
		await runtime.whenSubmitted(3);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.stopRoom(room.id);
		const message = { id: 'follow-up', text: `@${room.members[0].name} Check the page`, mentions: [] };
		await rooms.postMessage(room.id, message);
		const pending = await rooms.getMessages(room.id);
		assert.deepStrictEqual({
			turns: runtime.submitted.length,
			state: (await rooms.getRoom(room.id)).state,
			delivery: pending.messages[0].deliveries[0].state,
		}, { turns: 3, state: 'stopped', delivery: 'pending' });
		await rooms.retryMember(room.id, room.members[0].id);
		await runtime.whenSubmitted(4);
		await rooms.postMessage(room.id, message);
		const current = await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			recipient: runtime.submitted[3].sessionUri,
			promptContainsGuidance: runtime.submitted[3].prompt.includes('Check the page'),
			limits: current.run?.limits,
			deadline: current.run?.deadline,
			otherPeers: current.members.slice(1).map(member => member.state),
			posts: (await rooms.getMessages(room.id)).messages.length,
			turns: runtime.submitted.length,
		}, { recipient: room.members[0].sessionUri, promptContainsGuidance: true, limits: {}, deadline: undefined, otherPeers: ['stopped', 'stopped'], posts: 1, turns: 4 });
	});

	test('a human mention cannot bypass an individual member Stop', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id);
		await runtime.whenSubmitted(2);
		const member = room.members[0];
		await rooms.stopMember(room.id, member.id);
		await rooms.postMessage(room.id, { id: 'stopped-member-guidance', text: 'Check this after Resume', mentions: [member.id] });
		const pending = await rooms.getMessages(room.id);
		assert.deepStrictEqual({
			turns: runtime.submitted.length,
			memberState: (await rooms.getRoom(room.id)).members[0].state,
			delivery: pending.messages[0].deliveries[0].state,
		}, { turns: 2, memberState: 'stopped', delivery: 'pending' });
		await rooms.retryMember(room.id, member.id);
		await runtime.whenSubmitted(3);
		assert.deepStrictEqual({
			recipient: runtime.submitted[2].sessionUri,
			promptContainsGuidance: runtime.submitted[2].prompt.includes('Check this after Resume'),
		}, { recipient: member.sessionUri, promptContainsGuidance: true });
	});

	test('a targeted message starts only its peer in a newly created room', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.postMessage(room.id, { id: 'first-request', text: 'Inspect the goal', mentions: [room.members[1].id] });
		await runtime.whenSubmitted(1);
		assert.deepStrictEqual(runtime.submitted.map(turn => turn.sessionUri), [room.members[1].sessionUri]);
	});

	test('ordinary completion keeps admitting turns without a saved next step', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		for (let turn = 1; turn < 8; turn++) {
			const session = room.members[0].sessionUri;
			runtime.finish(session);
			await runtime.whenSubmitted(turn + 1);
		}
		const runId = (await rooms.getRoom(room.id)).run?.id;
		runtime.finish(room.members[0].sessionUri);
		await runtime.whenSubmitted(9);
		assert.deepStrictEqual({
			runId: (await rooms.getRoom(room.id)).run?.id,
			limits: (await rooms.getRoom(room.id)).run?.limits,
			turns: runtime.submitted.length,
		}, { runId, limits: {}, turns: 9 });
		await rooms.stopRoom(room.id);
	});

	test('retrying a pending human delivery does not duplicate its post', async () => {
		const storage = new MemoryRoomStorage();
		const original = setup(1, storage);
		const room = await original.create();
		await original.rooms.startRoom(room.id, { maxTurns: 1 });
		await original.runtime.whenSubmitted(1);
		original.runtime.finish(room.members[0].sessionUri);
		await whenRoom(original.rooms, room.id, room => room.state === 'idle');
		await original.rooms.pauseRoom(room.id);
		const request = { id: 'pending', text: 'Check this', mentions: [room.members[0].id] };
		await original.rooms.postMessage(room.id, request);
		original.rooms.dispose();
		const paused = storage.records.get(room.id)!;
		storage.records.set(room.id, { ...paused, room: { ...paused.room, state: 'stopped', members: paused.room.members.map(member => ({ ...member, state: 'stopped' })) } });
		const restored = setup(1, storage);
		await restored.rooms.retryMessage(room.id, request.id);
		assert.strictEqual(restored.runtime.submitted.length, 0);
		await restored.rooms.retryMember(room.id, room.members[0].id);
		await restored.runtime.whenSubmitted(1);
		assert.deepStrictEqual({
			posts: (await restored.rooms.getMessages(room.id)).messages.length,
			turns: restored.runtime.submitted.length,
		}, { posts: 1, turns: 1 });
	});

	test('explicit delivery retry waits for Resume and does not wake other stopped members', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'retry-after-stop', text: 'Check the page', mentions: [room.members[0].id] });
		await rooms.stopRoom(room.id);
		assert.strictEqual((await rooms.getMessages(room.id)).messages[0].deliveries[0].state, 'cancelled');
		await rooms.retryMessage(room.id, 'retry-after-stop');
		assert.strictEqual(runtime.submitted.length, 2);
		await rooms.retryMember(room.id, room.members[0].id);
		await runtime.whenSubmitted(3);
		assert.deepStrictEqual({
			posts: (await rooms.getMessages(room.id)).messages.length,
			recipient: runtime.submitted[2].sessionUri,
			otherPeer: (await rooms.getRoom(room.id)).members[1].state,
		}, { posts: 1, recipient: room.members[0].sessionUri, otherPeer: 'stopped' });
	});

	test('pausing a dormant room prevents a mention from waking its member', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 1, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'paused-idle', text: 'Wait until resume', mentions: [room.members[0].id] });
		assert.deepStrictEqual({ state: (await rooms.getRoom(room.id)).state, submissions: runtime.submitted.length }, { state: 'paused', submissions: 1 });
	});

	test('pause and stop during preparation never submit a late SDK turn', async () => {
		const { rooms, runtime, create } = setup();
		runtime.blockPrepare = true;
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 4, timeoutMinutes: 1 });
		await runtime.whenPrepared(2);
		await rooms.pauseRoom(room.id);
		await runtime.prepareGate.complete();
		await whenRoom(rooms, room.id, room => room.members.every(member => member.state === 'idle'));
		await rooms.stopRoom(room.id);
		assert.deepStrictEqual({ submitted: runtime.submitted.length, state: (await rooms.getRoom(room.id)).state }, { submitted: 0, state: 'stopped' });
	});

	test('stop closes admission before awaiting abort and canceled events cannot resume work', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 4, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		runtime.blockAbort = true;
		const stopped = rooms.stopRoom(room.id);
		await whenRoom(rooms, room.id, room => room.state === 'stopping');
		const turn = runtime.submitted[0];
		runtime.finish(turn.sessionUri);
		await rooms.postMessage(room.id, { id: 'stopping', text: 'Wait', mentions: [room.members[0].id] });
		await runtime.abortGate.complete();
		await stopped;
		assert.deepStrictEqual({ submissions: runtime.submitted.length, state: (await rooms.getRoom(room.id)).state }, { submissions: 1, state: 'stopped' });
	});

	test('shutting down leaves a room that never ran in its created state', async () => {
		const storage = new MemoryRoomStorage();
		const first = setup(2, storage);
		const room = await first.create();
		await first.rooms.shutdown();
		first.rooms.dispose();
		const restored = setup(2, storage);
		const reopened = await restored.rooms.getRoom(room.id);
		assert.deepStrictEqual({
			state: reopened.state, members: reopened.members.map(member => [member.state, member.turns]),
		}, { state: 'created', members: [['pending', 0], ['pending', 0]] });
	});

	test('ordinary completion asks members to share, review peers and keep improving', async () => {
		const { rooms, runtime } = setup(1);
		const room = await rooms.createRoom({ title: 'Open ended', goal: 'Keep improving the result', repositoryUri: 'file:///repository', workerCount: 1, continuous: false });
		await rooms.startRoom(room.id, { maxTurns: 3 });
		const member = room.members[0];
		for (let turn = 1; turn <= 3; turn++) {
			await runtime.whenSubmitted(turn);
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		const [first, ...continuations] = runtime.submitted.map(submission => submission.prompt);
		assert.deepStrictEqual({
			turns: runtime.submitted.length,
			firstHasFullBrief: first.includes('Shared goal: Keep improving the result') && first.includes('Your only working tree is'),
			bootstrapExplainsPrivateWork: first.includes('Work privately for as many turns as needed'),
			bootstrapAvoidsRoutineProgress: first.includes('Do not post routine progress or announce work before editing'),
			removedLeadLanguage: !first.includes('no required lead'),
			continuations,
		}, {
			turns: 3,
			firstHasFullBrief: true,
			bootstrapExplainsPrivateWork: true,
			bootstrapAvoidsRoutineProgress: true,
			removedLeadLanguage: true,
			continuations: [
				continueAfterTurnPrompt,
				continueAfterTurnPrompt,
			],
		});
	});

	test('peer messages stay out of prompts and are discovered through room_read', async () => {
		const { rooms, runtime } = setup(2);
		const room = await rooms.createRoom({ title: 'Peers', goal: 'Keep improving', repositoryUri: 'file:///repository', workerCount: 2 });
		await rooms.startRoom(room.id, { maxTurns: 4 });
		await runtime.whenSubmitted(2);
		const first = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(first);
		await rooms.post(first, { id: 'peer-result', kind: 'finding', text: 'The parser path is faster', mentions: [room.members[1].id] });
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await runtime.whenSubmitted(4);
		const secondContinuation = runtime.submitted.find((submission, index) => index >= 2 && submission.sessionUri === room.members[1].sessionUri)!;
		const secondContext = await rooms.read(AgentSession.id(room.members[1].sessionUri));
		assert.deepStrictEqual({
			prompt: secondContinuation.prompt,
			inbox: secondContext.inbox.map(message => message.id),
		}, { prompt: continueAfterTurnPrompt, inbox: ['peer-result'] });
	});

	test('one initial room read permits private work across continuation turns', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		const member = room.members[0];
		const sessionId = AgentSession.id(member.sessionUri);
		await assert.rejects(rooms.post(sessionId, { id: 'early', kind: 'work', text: 'Work', mentions: [] }), /Read the room/);
		assert.throws(() => rooms.beforeTool(sessionId, 'bash'), /Read the shared room/);
		await rooms.read(sessionId);
		assert.doesNotThrow(() => rooms.beforeTool(sessionId, 'bash'));
		assert.throws(() => rooms.beforeTool(sessionId, 'task'), /nested agents/);
		assert.throws(() => rooms.beforeTool(sessionId, 'search_code_subagent'), /nested agents/);
		assert.throws(() => rooms.beforeTool(sessionId, 'room_assign'), /Only the room coordinator/);
		await rooms.post(sessionId, { id: 'finding', kind: 'finding', text: 'The baseline is 20ms', mentions: [] });
		runtime.finish(member.sessionUri);
		await runtime.whenSubmitted(2);
		assert.doesNotThrow(() => rooms.beforeTool(sessionId, 'bash'));
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual({
			turns: runtime.submitted.length,
			admitted: (await rooms.getRoom(room.id)).run?.admittedTurns,
			continuation: runtime.submitted[1].prompt,
		}, { turns: 2, admitted: 2, continuation: continueAfterTurnPrompt });
	});

	test('publishes idempotent structured results with evidence and author-owned patches', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(2);
		const first = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(first);
		storage.publishPatch = async (current, member, title) => ({
			id: 'result-patch',
			memberId: member.id,
			title,
			baseRevision: current.baseRevision,
			sourceRevision: current.baseRevision,
			createdAt: 1,
			uri: 'file:///published/result.patch',
		});
		await rooms.sharePatch(first, 'Parser implementation');
		const options = {
			id: 'parser-result',
			title: 'Parser implementation',
			summary: 'The parser handles the complete fixture set.',
			outcome: 'success' as const,
			evidence: ['Focused parser tests passed.', 'The benchmark completed in 18 ms.'],
			artifactIds: ['result-patch'],
		};
		const published = await rooms.publishResult(first, options);
		const retried = await rooms.publishResult(first, options);
		await assert.rejects(rooms.publishResult(first, { ...options, summary: 'Different claim' }), /already used/);
		await assert.rejects(rooms.publishResult(first, { ...options, id: 'missing-patch', artifactIds: ['other-patch'] }), /patches published by its author/);
		const page = await rooms.getMessages(room.id, { after: 1 });
		const work = (await rooms.getRoom(room.id)).members[0].work;
		assert.deepStrictEqual({
			published,
			retried,
			page,
			work,
		}, {
			published: {
				id: 'parser-result', sequence: 2, authorId: room.members[0].id, authorName: room.members[0].name, authorKind: 'agent',
				kind: 'result', text: 'Parser implementation\n\nThe parser handles the complete fixture set.', timestamp: published.timestamp,
				mentions: [],
				result: {
					title: options.title, summary: options.summary, outcome: options.outcome,
					evidence: options.evidence, artifactIds: options.artifactIds, verificationState: 'pending',
				},
				deliveries: [],
			},
			retried: published,
			page: { messages: [published], hasEarlier: true, hasLater: false },
			work: { description: options.summary, blocked: false, updatedAt: work?.updatedAt },
		});
	});

	test('derives verification state from independent reviews with human precedence', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await runtime.whenSubmitted(3);
		const [first, second, third] = room.members.map(member => AgentSession.id(member.sessionUri));
		await rooms.read(first);
		await rooms.read(second);
		const result = await rooms.publishResult(first, {
			id: 'measured-result',
			title: 'Measured result',
			summary: 'The optimized path is faster.',
			outcome: 'success',
			evidence: ['Benchmark mean improved from 30 ms to 20 ms.'],
			artifactIds: [],
		});
		await assert.rejects(rooms.reviewResult(first, {
			id: 'self-review', resultId: result.id, verdict: 'verified', evidence: ['I checked my own work.'],
		}), /another agent or by the human/);
		await assert.rejects(rooms.reviewResult(second, {
			id: 'unread-review', resultId: result.id, verdict: 'verified', evidence: ['I checked the benchmark.'],
		}), /Read the result/);
		await rooms.read(second, { after: 0 });
		await rooms.read(third, { after: 0 });
		const verified = await rooms.reviewResult(second, {
			id: 'peer-verification', resultId: result.id, verdict: 'verified', evidence: ['Re-ran the benchmark independently.'],
		});
		await rooms.reviewResult(third, {
			id: 'peer-rejection', resultId: result.id, verdict: 'rejected', evidence: ['The control run regressed.'],
		});
		const rejectedState = (await rooms.getMessages(room.id)).messages.find(message => message.id === result.id)?.result?.verificationState;
		const human = await rooms.verifyResult(room.id, {
			id: 'human-verification', resultId: result.id, verdict: 'verified', evidence: ['Reviewed both runs and repeated the control.'],
		});
		const retry = await rooms.verifyResult(room.id, {
			id: 'human-verification', resultId: result.id, verdict: 'verified', evidence: ['Reviewed both runs and repeated the control.'],
		});
		await assert.rejects(rooms.verifyResult(room.id, {
			id: 'human-verification', resultId: result.id, verdict: 'rejected', evidence: ['Conflicting retry.'],
		}), /already used/);
		const messages = (await rooms.getMessages(room.id)).messages;
		assert.deepStrictEqual({
			peer: verified.verification,
			rejectedState,
			human: { authorKind: human.authorKind, verification: human.verification },
			retry,
			finalState: messages.find(message => message.id === result.id)?.result?.verificationState,
			kinds: messages.map(message => message.kind),
			submissions: runtime.submitted.length,
			reviewDeliveries: messages.filter(message => message.verification).map(message => message.deliveries),
		}, {
			peer: { resultId: result.id, verdict: 'verified', evidence: ['Re-ran the benchmark independently.'] },
			rejectedState: 'rejected',
			human: { authorKind: 'human', verification: { resultId: result.id, verdict: 'verified', evidence: ['Reviewed both runs and repeated the control.'] } },
			retry: human,
			finalState: 'verified',
			kinds: ['result', 'verification', 'verification', 'verification'],
			submissions: 3,
			reviewDeliveries: [[], [], []],
		});
	});

	test('a blocked structured result uses the existing blocked member lifecycle', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(1);
		const member = room.members[0];
		const sessionId = AgentSession.id(member.sessionUri);
		await rooms.read(sessionId);
		await rooms.publishResult(sessionId, {
			id: 'blocked-result',
			title: 'Missing external fixture',
			summary: 'The required fixture is not available in the worktree.',
			outcome: 'blocked',
			evidence: ['The expected fixture path does not exist.'],
			artifactIds: [],
		});
		runtime.finish(member.sessionUri);
		const blocked = await whenRoom(rooms, room.id, current => current.members[0].state === 'blocked');
		assert.deepStrictEqual({
			state: blocked.members[0].state,
			work: blocked.members[0].work,
			submissions: runtime.submitted.length,
		}, {
			state: 'blocked',
			work: { description: 'The required fixture is not available in the worktree.', blocked: true, updatedAt: blocked.members[0].work?.updatedAt },
			submissions: 1,
		});
	});

	test('recovery interrupts ambiguous deliveries and requires explicit bounded resume', async () => {
		const storage = new MemoryRoomStorage();
		const first = setup(1, storage);
		const room = await first.create();
		await first.rooms.postMessage(room.id, { id: 'before-start', text: 'A targeted request', mentions: [room.members[0].id] });
		await first.runtime.whenSubmitted(1);
		await whenRoom(first.rooms, room.id, room => room.members[0].state === 'working');
		const submittedTurn = first.runtime.submitted[0].turnId;
		first.rooms.dispose();
		const interrupted = storage.records.get(room.id)!;
		storage.records.set(room.id, {
			...interrupted,
			executions: interrupted.executions.map(execution => ({ ...execution, briefed: undefined, briefingTurnId: submittedTurn })),
		});
		const restored = setup(1, storage);
		restored.runtime.knownTurns.add(`${room.members[0].sessionUri}:${submittedTurn}`);
		const recovered = await restored.rooms.getRoom(room.id);
		assert.deepStrictEqual({
			state: recovered.state, member: recovered.members[0].state,
			delivery: (await restored.rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			submitted: restored.runtime.submitted.length, session: recovered.members[0].sessionUri,
		}, { state: 'interrupted', member: 'interrupted', delivery: 'interrupted', submitted: 0, session: room.members[0].sessionUri });
		await restored.rooms.startRoom(room.id, { maxTurns: 1, timeoutMinutes: 1 });
		await restored.runtime.whenSubmitted(1);
		const prompt = restored.runtime.submitted[0].prompt;
		assert.deepStrictEqual({
			briefed: storage.records.get(room.id)!.executions[0].briefed,
			briefingTurnId: storage.records.get(room.id)!.executions[0].briefingTurnId,
			continuedExistingChat: prompt,
			repeatedFullBrief: prompt.includes('Shared goal:'),
			repeatedInterruptedInbox: prompt.includes('A targeted request'),
		}, { briefed: true, briefingTurnId: undefined, continuedExistingChat: continueRoomPrompt, repeatedFullBrief: false, repeatedInterruptedInbox: false });
	});

	test('worktree failures are explicit and cannot run in the shared repository', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		storage.worktreeError = new Error('Git worktree creation failed');
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 1, timeoutMinutes: 1 });
		const failed = await whenRoom(rooms, room.id, room => room.members[0].state === 'failed');
		assert.deepStrictEqual({ state: failed.members[0].state, submitted: runtime.submitted.length, worktrees: storage.worktrees.size }, { state: 'failed', submitted: 0, worktrees: 0 });
	});

	test('explicit failed-member retry retains identity and uses the remaining run budget', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		storage.worktreeError = new Error('Temporary Git failure');
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2, timeoutMinutes: 1 });
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		storage.worktreeError = undefined;
		await rooms.retryMember(room.id, room.members[0].id);
		await runtime.whenSubmitted(1);
		assert.deepStrictEqual({
			session: runtime.submitted[0].sessionUri, admitted: (await rooms.getRoom(room.id)).run?.admittedTurns,
		}, { session: room.members[0].sessionUri, admitted: 2 });
	});

	test('duplicate stops share one abort and do not interfere with a subsequent explicit run', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		runtime.blockAbort = true;
		const first = rooms.stopRoom(room.id);
		const second = rooms.stopRoom(room.id);
		await whenRoom(rooms, room.id, room => room.state === 'stopping');
		await runtime.abortGate.complete();
		await Promise.all([first, second]);
		await rooms.startRoom(room.id, { maxTurns: 1, timeoutMinutes: 1 });
		await runtime.whenSubmitted(2);
		assert.deepStrictEqual({ aborts: runtime.aborted.length, submitted: runtime.submitted.length }, { aborts: 1, submitted: 2 });
	});

	test('deadline prevents admission even when preparation completes later', async () => {
		let now = 1000;
		const { rooms, runtime, create } = setup(1, undefined, () => now);
		runtime.blockPrepare = true;
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 1 });
		await runtime.whenPrepared(1);
		now += 60001;
		await runtime.prepareGate.complete();
		await whenRoom(rooms, room.id, room => room.members[0].state === 'stopped');
		assert.strictEqual(runtime.submitted.length, 0);
	});

	test('host-native tools bind author identity and never take an author from model arguments', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 1, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		const member = room.members[0];
		const sessionId = AgentSession.id(member.sessionUri);
		const tools = createCopilotRoomTools(sessionId, rooms);
		await rooms.read(sessionId);
		const invocation = { sessionId: 'forged-session', toolCallId: 'tool', toolName: 'room_post', arguments: {} };
		await tools.find(tool => tool.name === 'room_post')!.handler!({ id: 'bound', kind: 'work', text: 'My work', mentions: [], authorId: 'forged' }, invocation);
		assert.deepStrictEqual((await rooms.getMessages(room.id)).messages.map(message => ({ authorId: message.authorId, authorName: message.authorName, kind: message.authorKind })), [{ authorId: member.id, authorName: member.name, kind: 'agent' }]);
	});

	test('structured result tools use bound identities and strict inputs', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2 });
		await runtime.whenSubmitted(2);
		const firstSession = AgentSession.id(room.members[0].sessionUri);
		const secondSession = AgentSession.id(room.members[1].sessionUri);
		await rooms.read(firstSession);
		const firstTools = createCopilotRoomTools(firstSession, rooms);
		const secondTools = createCopilotRoomTools(secondSession, rooms);
		const publish = firstTools.find(tool => tool.name === 'room_publish_result')!;
		const invocation = { sessionId: 'forged-session', toolCallId: 'tool', toolName: 'room_publish_result', arguments: {} };
		await assert.rejects(() => Promise.resolve(publish.handler!({
			id: 'invalid-result', title: 'Invalid', summary: 'No evidence', outcome: 'success', evidence: [], artifactIds: [],
		}, invocation)), /result evidence/);
		await publish.handler!({
			id: 'tool-result',
			title: 'Tool result',
			summary: 'The bound agent produced this result.',
			outcome: 'negative',
			evidence: ['The attempted optimization regressed the benchmark.'],
			artifactIds: [],
			authorId: 'forged',
		}, invocation);
		await rooms.read(secondSession, { after: 0 });
		await secondTools.find(tool => tool.name === 'room_verify_result')!.handler!({
			id: 'tool-verification',
			resultId: 'tool-result',
			verdict: 'verified',
			evidence: ['Repeated the regression in the second worktree.'],
			authorId: 'forged',
		}, { ...invocation, toolName: 'room_verify_result' });
		assert.deepStrictEqual({
			tools: firstTools.map(tool => tool.name),
			authors: (await rooms.getMessages(room.id)).messages.map(message => message.authorId),
		}, {
			tools: ['room_read', 'room_read_artifact', 'room_post', 'room_publish_result', 'room_verify_result', 'room_share_patch'],
			authors: [room.members[0].id, room.members[1].id],
		});
	});

});
