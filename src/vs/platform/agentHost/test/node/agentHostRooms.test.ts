/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { URI } from '../../../../base/common/uri.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomMember, IAgentHostRoomsService } from '../../common/agentHostRooms.js';
import { AgentSession } from '../../common/agentService.js';
import { AgentHostRooms } from '../../node/agentHostRooms.js';
import { IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomStorage } from '../../node/agentHostRoomsTypes.js';
import { createCopilotRoomTools } from '../../node/copilot/copilotRoomTools.js';
import { createNoopGitService, createNullSessionDataService } from '../common/sessionTestHelpers.js';
import { MockAgent } from './mockAgent.js';
import { createTestAgentService, getTestAgentHostRoomsController, getTestAgentStateManager, registerTestAgentProvider } from './agentServiceTestUtils.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildChatUri, buildDefaultChatUri, MessageKind, PendingMessageKind } from '../../common/state/sessionState.js';

class MemoryRoomStorage implements IRoomStorage {
	readonly records = new Map<string, IRoomRecord>();
	worktreeError: Error | undefined;
	readonly worktrees = new Set<string>();

	async load(): Promise<readonly IRoomRecord[]> { return [...this.records.values()]; }
	async save(record: IRoomRecord): Promise<void> {
		this.records.set(record.room.id, structuredClone(record));
	}
	async resolveRepository(repositoryUri: string) { return { repositoryUri, baseRevision: 'a'.repeat(40) }; }
	worktreeUri(roomId: string, memberId: string): string { return `file:///room-worktrees/${roomId}/${memberId}`; }
	async ensureWorktree(room: IAgentHostRoom, member: IAgentHostRoomMember): Promise<void> {
		assert.deepStrictEqual(member, room.members.find(candidate => candidate.id === member.id));
		if (this.worktreeError) {
			throw this.worktreeError;
		}
		this.worktrees.add(member.worktreeUri!);
	}
	async publishPatch(_room: IAgentHostRoom, _member: IAgentHostRoomMember, _title: string): Promise<IAgentHostRoomArtifact> { throw new Error('Not used'); }
	async readArtifact(): Promise<string> { return 'patch'; }
}

class RoomRuntime extends Disposable implements IRoomRuntime {
	private readonly _onDidChange = this._register(new Emitter<IRoomRuntimeEvent>());
	readonly onDidChange = this._onDidChange.event;
	readonly prepared: string[] = [];
	readonly submitted: { sessionUri: string; turnId: string; prompt: string }[] = [];
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

	async prepare(_room: IAgentHostRoom, member: IAgentHostRoomMember): Promise<void> {
		this.prepared.push(member.sessionUri);
		this._preparedWaiters.get(this.prepared.length)?.complete();
		if (this.blockPrepare) {
			await this.prepareGate.p;
		}
	}
	isIdle(sessionUri: string): boolean { return !this.active.has(sessionUri); }
	submit(sessionUri: string, turnId: string, prompt: string): void {
		assert.ok(!this.active.has(sessionUri), 'Only one admitted turn per member');
		this.active.set(sessionUri, turnId);
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
		const create = () => rooms.createRoom({ title: 'Shared work', goal: 'Measure before changing code', repositoryUri: 'file:///repository', workerCount });
		return { storage, runtime, rooms, create };
	}

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

	test('only explicit mentions wake a dormant peer and IDs are idempotent', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 8, timeoutMinutes: 1 });
		await runtime.whenSubmitted(2);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.postMessage(room.id, { id: 'broadcast', text: 'Background context, no wakeup', mentions: [] });
		const options = { id: 'targeted', text: '@Copilot-2 Please check this finding', mentions: [] };
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
		registerTestAgentProvider(service, provider);
		const rooms = getTestAgentHostRoomsController(service);
		const state = getTestAgentStateManager(service);
		const room = await rooms.createRoom({ title: 'Shared work', goal: 'Inspect the form', repositoryUri: 'file:///repository', workerCount: 10 });
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
		}, {
			steered: expected, chats: expected.map(member => member.chat),
			activeTurns: expected.map(member => member.turnId), sends: 10, worktrees: 10,
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
		await assert.rejects(service.createChat(URI.parse(member.sessionUri), URI.parse(buildChatUri(member.sessionUri, 'extra'))), /preserved chat/);
		await assert.rejects(service.disposeSession(URI.parse(member.sessionUri)), /preserved session/);
		await rooms.stopRoom(room.id);
		assert.deepStrictEqual({
			sends: provider.sendMessageCalls.length, worktrees: storage.worktrees.size,
			sessions: (await rooms.getRoom(room.id)).members.map(member => member.sessionUri),
			deleted: provider.disposeSessionCalls.length,
			active: state.getActiveTurnId(chat),
		}, { sends: 10, worktrees: 10, sessions: room.members.map(member => member.sessionUri), deleted: 0, active: undefined });
	});

	test('steering targets only mentioned peers and requires fresh guidance before further tools', async () => {
		const { rooms, runtime, storage, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		const sessionId = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(sessionId);
		await rooms.post(sessionId, { id: 'intent', text: 'Implementing animation', kind: 'work', mentions: [] });
		await rooms.postMessage(room.id, { id: 'redirect', text: '@Copilot-1 Stop animations and fix the form.', mode: 'steer', mentions: [] });
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
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual({
			state: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			turns: runtime.submitted.length,
		}, { state: 'completed', turns: 1 });
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

	test('agents cannot impersonate human steering and must re-read newly announced peer work', async () => {
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
		await assert.rejects(rooms.post(second, { id: 'stale', text: 'Implementing the form too', kind: 'work', mentions: [] }), /Another peer announced work/);
		await rooms.read(second);
		await rooms.post(second, { id: 'complementary', text: 'Testing the form', kind: 'work', mentions: [] });
		assert.deepStrictEqual((await rooms.getMessages(room.id)).messages.map(message => message.id), ['claim', 'complementary']);
	});

	test('an agent mentioning itself cannot create a self-waking message loop', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		const sessionId = AgentSession.id(room.members[0].sessionUri);
		await rooms.read(sessionId);
		const message = await rooms.post(sessionId, { id: 'self', text: '@Copilot-1 Finished my work', kind: 'finding', mentions: [room.members[0].id] });
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual({ mentions: message.mentions, deliveries: message.deliveries, turns: runtime.submitted.length }, { mentions: [], deliveries: [], turns: 1 });
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
		const initial = await rooms.readArtifact(second, published.id);
		const remainder = await rooms.readArtifact(second, published.id, initial.nextOffset);
		assert.deepStrictEqual({
			oldMessages: context.messages.map(message => message.id), hasLater: context.hasLater,
			artifact: initial.artifact.id, path: initial.patchPath,
			firstLength: initial.text.length, restLength: remainder.text.length, total: remainder.totalCharacters,
		}, { oldMessages: ['work'], hasLater: true, artifact: 'published-patch', path: URI.parse('file:///published/patch.diff').fsPath, firstLength: 16000, restLength: 4000, total: 20000 });
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

	test('a human mention restarts only its addressed stopped peer with no implicit run limits', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 1 });
		await runtime.whenSubmitted(3);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.stopRoom(room.id);
		const message = { id: 'follow-up', text: '@Copilot-1 Check the page', mentions: [] };
		await rooms.postMessage(room.id, message);
		await runtime.whenSubmitted(4);
		await rooms.postMessage(room.id, message);
		const current = await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			recipient: runtime.submitted[3].sessionUri,
			limits: current.run?.limits,
			deadline: current.run?.deadline,
			otherPeers: current.members.slice(1).map(member => member.state),
			posts: (await rooms.getMessages(room.id)).messages.length,
			turns: runtime.submitted.length,
		}, { recipient: room.members[0].sessionUri, limits: {}, deadline: undefined, otherPeers: ['stopped', 'stopped'], posts: 1, turns: 4 });
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.postMessage(room.id, message);
		assert.strictEqual(runtime.submitted.length, 4, 'Retrying a completed delivery must not run it again');
	});

	test('a targeted message starts only its peer in a newly created room', async () => {
		const { rooms, runtime, create } = setup(3);
		const room = await create();
		await rooms.postMessage(room.id, { id: 'first-request', text: 'Inspect the goal', mentions: [room.members[1].id] });
		await runtime.whenSubmitted(1);
		assert.deepStrictEqual(runtime.submitted.map(turn => turn.sessionUri), [room.members[1].sessionUri]);
	});

	test('a run without optional limits can continue and remains available for later human follow-ups', async () => {
		let now = 1000;
		const { rooms, runtime, create } = setup(1, new MemoryRoomStorage(), () => now);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(1);
		for (let turn = 1; turn < 8; turn++) {
			const session = room.members[0].sessionUri;
			await rooms.read(AgentSession.id(session));
			await rooms.post(AgentSession.id(session), { id: `next-${turn}`, kind: 'finding', text: 'Measured progress', nextStep: 'Continue the experiment', mentions: [] });
			runtime.finish(session);
			await runtime.whenSubmitted(turn + 1);
		}
		const session = room.members[0].sessionUri;
		await rooms.read(AgentSession.id(session));
		await rooms.post(AgentSession.id(session), { id: 'done', kind: 'finding', text: 'Finished this avenue', mentions: [] });
		runtime.finish(session);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		const runId = (await rooms.getRoom(room.id)).run?.id;
		now += 3 * 24 * 60 * 60000;
		await rooms.postMessage(room.id, { id: 'later', text: 'Please check another detail', mentions: [room.members[0].id] });
		await runtime.whenSubmitted(9);
		assert.deepStrictEqual({
			runId: (await rooms.getRoom(room.id)).run?.id,
			limits: (await rooms.getRoom(room.id)).run?.limits,
			turns: runtime.submitted.length,
		}, { runId, limits: {}, turns: 9 });
	});

	test('retrying a pending human delivery does not duplicate its post', async () => {
		const storage = new MemoryRoomStorage();
		const original = setup(1, storage);
		const room = await original.create();
		await original.rooms.startRoom(room.id, {});
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
		await restored.runtime.whenSubmitted(1);
		assert.deepStrictEqual({
			posts: (await restored.rooms.getMessages(room.id)).messages.length,
			turns: restored.runtime.submitted.length,
		}, { posts: 1, turns: 1 });
	});

	test('explicit retry can restore a cancelled human delivery without waking other stopped members', async () => {
		const { rooms, runtime, create } = setup(2);
		const room = await create();
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(2);
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'retry-after-stop', text: 'Check the page', mentions: [room.members[0].id] });
		await rooms.stopRoom(room.id);
		assert.strictEqual((await rooms.getMessages(room.id)).messages[0].deliveries[0].state, 'cancelled');
		await rooms.retryMessage(room.id, 'retry-after-stop');
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
		await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 1 });
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

	test('a substantive next step continues after ordinary SDK idle, within finite limits', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 2, timeoutMinutes: 1 });
		await runtime.whenSubmitted(1);
		const member = room.members[0];
		const sessionId = AgentSession.id(member.sessionUri);
		await assert.rejects(rooms.post(sessionId, { id: 'early', kind: 'work', text: 'Work', mentions: [] }), /Read the room/);
		await rooms.read(sessionId);
		assert.throws(() => rooms.beforeTool(sessionId, 'bash'), /post a work intention/);
		await rooms.post(sessionId, { id: 'intent', kind: 'work', text: 'Measure startup', mentions: [] });
		assert.doesNotThrow(() => rooms.beforeTool(sessionId, 'bash'));
		assert.throws(() => rooms.beforeTool(sessionId, 'task'), /nested agents/);
		assert.throws(() => rooms.beforeTool(sessionId, 'search_code_subagent'), /nested agents/);
		await rooms.post(sessionId, { id: 'finding', kind: 'finding', text: 'The baseline is 20ms', nextStep: 'Measure the extension activation path', mentions: [] });
		runtime.finish(member.sessionUri);
		await runtime.whenSubmitted(2);
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.postMessage(room.id, { id: 'budget', text: 'The optional limit is still respected for autonomous continuation', mentions: [] });
		assert.deepStrictEqual({
			turns: runtime.submitted.length,
			admitted: (await rooms.getRoom(room.id)).run?.admittedTurns,
			preservedNextStep: runtime.submitted[1].prompt.includes('Previously proposed next step: Measure the extension activation path'),
		}, { turns: 2, admitted: 2, preservedNextStep: true });
	});

	test('recovery interrupts ambiguous deliveries and requires explicit bounded resume', async () => {
		const storage = new MemoryRoomStorage();
		const first = setup(1, storage);
		const room = await first.create();
		await first.rooms.postMessage(room.id, { id: 'before-start', text: 'A targeted request', mentions: [room.members[0].id] });
		await first.runtime.whenSubmitted(1);
		await whenRoom(first.rooms, room.id, room => room.members[0].state === 'working');
		first.rooms.dispose();
		const restored = setup(1, storage);
		const recovered = await restored.rooms.getRoom(room.id);
		assert.deepStrictEqual({
			state: recovered.state, member: recovered.members[0].state,
			delivery: (await restored.rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			submitted: restored.runtime.submitted.length, session: recovered.members[0].sessionUri,
		}, { state: 'interrupted', member: 'interrupted', delivery: 'interrupted', submitted: 0, session: room.members[0].sessionUri });
		await restored.rooms.startRoom(room.id, { maxTurns: 1, timeoutMinutes: 1 });
		await restored.runtime.whenSubmitted(1);
		assert.ok(!restored.runtime.submitted[0].prompt.includes('Addressed messages'));
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

});
