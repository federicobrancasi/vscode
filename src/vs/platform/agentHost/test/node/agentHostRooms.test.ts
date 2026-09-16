/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { BufferReader, BufferWriter, deserialize, serialize } from '../../../../base/parts/ipc/common/ipc.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAgentModelInfo } from '../../common/agent.js';
import { createAgentHostRoomsClient } from '../../common/agentHostRoomsIpc.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomsService, MAX_ROOM_INBOX_BATCH_CHARACTERS, MAX_ROOM_INBOX_BATCH_SIZE, newAgentHostRoomConfiguration } from '../../common/agentHostRooms.js';
import { AgentHostAutoApprovePolicyRestrictedConfigKey, platformSessionSchema } from '../../common/agentHostSchema.js';
import { AgentSession } from '../../common/agentService.js';
import { ResolveSessionConfigResult } from '../../common/state/protocol/commands.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildChatUri, buildDefaultChatUri, MessageKind, ModelSelection, PolicyState } from '../../common/state/sessionState.js';
import { AgentHostRooms } from '../../node/agentHostRooms.js';
import { createAgentHostRoomsChannel } from '../../node/agentHostRoomsChannel.js';
import { getRoomMemberModel, validateRoomModelSelection } from '../../node/agentHostRoomsModels.js';
import { IRoomArchive, IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomSessionParticipant, IRoomStorage, RoomContentValidator } from '../../node/agentHostRoomsTypes.js';
import { createCopilotRoomTools } from '../../node/copilot/copilotRoomTools.js';
import { createNoopGitService, createNullSessionDataService } from '../common/sessionTestHelpers.js';
import { createTestAgentService, getTestAgentHostRoomsController, getTestAgentServiceComposition, getTestAgentStateManager, registerTestAgentProvider } from './agentServiceTestUtils.js';
import { MockAgent } from './mockAgent.js';

const models: readonly IAgentModelInfo[] = [
	...['model-a', 'model-b'].map((id): IAgentModelInfo => ({
		provider: 'copilotcli', id, name: id, supportsVision: true,
		configSchema: { type: 'object', properties: { thinking: { title: 'Thinking', type: 'string', enum: ['low', 'high'] } } },
	})),
	{ provider: 'copilotcli', id: 'auto', name: 'Auto', supportsVision: false },
];

class MemoryRoomStorage implements IRoomStorage {
	readonly records = new Map<string, IRoomRecord>();
	readonly archives: IRoomArchive[] = [];
	readonly writes: IRoomRecord[] = [];
	readonly worktrees = new Set<string>();
	beforeSave: ((record: IRoomRecord) => Promise<void>) | undefined;
	saveError: Error | undefined;
	worktreeError: Error | undefined;

	async load(): Promise<readonly IRoomRecord[]> { return [...this.records.values()]; }
	async loadArchives(): Promise<readonly IRoomArchive[]> { return this.archives; }
	async save(record: IRoomRecord): Promise<void> {
		assert.strictEqual(record.version, 2);
		assert.ok(!Object.hasOwn(record.room, 'archivedSessions'), 'Executable records must not contain archive-only session links');
		assert.ok(record.messages.every(message => message.deliveries.every(delivery => delivery.state !== 'pending' || delivery.turnId === undefined)));
		assert.ok(record.messages.every(message => message.deliveries.every(delivery => !['reserved', 'submitted'].includes(delivery.state) || typeof delivery.turnId === 'string')));
		await this.beforeSave?.(record);
		if (this.saveError) {
			throw this.saveError;
		}
		this.records.set(record.room.id, structuredClone(record));
		this.writes.push(structuredClone(record));
	}
	async isRepository(): Promise<boolean> { return true; }
	async resolveRepository(repositoryUri: string) { return { repositoryUri, baseRevision: 'a'.repeat(40) }; }
	worktreeUri(roomId: string, memberId: string): string { return `file:///room-worktrees/${roomId}/${memberId}`; }
	async ensureWorktree(room: IAgentHostRoom, member: IRoomSessionParticipant): Promise<void> {
		assert.ok(!room.archived && room.members.some(candidate => candidate.id === member.id));
		if (this.worktreeError) {
			throw this.worktreeError;
		}
		this.worktrees.add(member.worktreeUri!);
	}
	async publishPatch(room: IAgentHostRoom, member: IAgentHostRoomMember, title: string, validate?: RoomContentValidator): Promise<IAgentHostRoomArtifact> {
		await validate?.(['src/file.ts']);
		return { id: 'patch-1', memberId: member.id, title, createdAt: 0, baseRevision: room.baseRevision, sourceRevision: 'b'.repeat(40), uri: 'file:///artifacts/patch-1.patch' };
	}
	async readArtifact(_room: IAgentHostRoom, _artifact: IAgentHostRoomArtifact, validate?: RoomContentValidator): Promise<string> {
		await validate?.(['src/file.ts']);
		return 'immutable patch';
	}
}

class RoomRuntime extends Disposable implements IRoomRuntime {
	private readonly changed = this._register(new Emitter<IRoomRuntimeEvent>());
	readonly onDidChange = this.changed.event;
	private readonly didSubmit = this._register(new Emitter<void>());
	private readonly didPrepare = this._register(new Emitter<void>());
	readonly prepared: string[] = [];
	readonly submitted: { sessionUri: string; turnId: string; prompt: string }[] = [];
	readonly active = new Map<string, string>();
	readonly known = new Set<string>();
	readonly aborted: string[] = [];
	readonly appliedModels = new Map<string, ModelSelection>();
	readonly modelChanges: ModelSelection[] = [];
	readonly configurations = new Map<string, IAgentHostRoomConfiguration>();
	readonly contentChecks: { sessionUri: string; paths: readonly string[] }[] = [];
	catalog = models;
	prepareGate: Promise<void> | undefined;
	abortGate: Promise<void> | undefined;
	abortError: Error | undefined;
	ignoreAbort = false;
	submitError: Error | undefined;
	afterSubmitError: Error | undefined;
	modelError: Error | undefined;
	contentError: Error | undefined;
	beforeSubmit: (() => void) | undefined;
	beforeModelApply: (() => Promise<void>) | undefined;

	validateModel(model: ModelSelection): void { validateRoomModelSelection(model, this.catalog); }
	getModel(member: IRoomSessionParticipant): ModelSelection | undefined { return this.appliedModels.get(member.sessionUri); }
	publishModel(): void { }
	async applyModel(member: IRoomSessionParticipant, model: ModelSelection): Promise<void> {
		assert.ok(this.isIdle(member.sessionUri));
		this.modelChanges.push(model);
		await this.beforeModelApply?.();
		if (this.modelError) {
			throw this.modelError;
		}
		this.appliedModels.set(member.sessionUri, model);
	}
	async resolveConfiguration(member: IRoomSessionParticipant, configuration?: IAgentHostRoomConfiguration): Promise<ResolveSessionConfigResult> {
		return { schema: platformSessionSchema.toProtocol(), values: { ...(configuration ?? this.configurations.get(member.sessionUri) ?? member.configuration ?? defaultAgentHostRoomConfiguration) } };
	}
	async applyConfiguration(member: IRoomSessionParticipant): Promise<void> {
		this.configurations.set(member.sessionUri, { ...defaultAgentHostRoomConfiguration, ...member.configuration });
	}
	async prepare(_room: IAgentHostRoom, member: IRoomSessionParticipant): Promise<void> {
		this.prepared.push(member.sessionUri);
		this.didPrepare.fire();
		await this.prepareGate;
	}
	isIdle(sessionUri: string): boolean { return !this.active.has(sessionUri); }
	hasTurn(sessionUri: string, turnId: string): boolean { return this.known.has(`${sessionUri}:${turnId}`); }
	submit(sessionUri: string, turnId: string, prompt: string): void {
		assert.ok(this.isIdle(sessionUri), 'One active native turn per member');
		assert.ok(!this.hasTurn(sessionUri, turnId), 'A turn identity must never be submitted twice');
		this.beforeSubmit?.();
		if (this.submitError) {
			throw this.submitError;
		}
		this.active.set(sessionUri, turnId);
		this.known.add(`${sessionUri}:${turnId}`);
		this.submitted.push({ sessionUri, turnId, prompt });
		this.changed.fire({ sessionUri, turnId, state: 'working' });
		this.didSubmit.fire();
		if (this.afterSubmitError) {
			throw this.afterSubmitError;
		}
	}
	async abort(sessionUri: string): Promise<void> {
		this.aborted.push(sessionUri);
		await this.abortGate;
		if (this.abortError) {
			throw this.abortError;
		}
		if (!this.ignoreAbort && this.active.has(sessionUri)) {
			this.finish(sessionUri, 'stopped');
		}
	}
	async assertContentAccess(sessionUri: string, paths: readonly string[]): Promise<void> {
		this.contentChecks.push({ sessionUri, paths });
		if (this.contentError) {
			throw this.contentError;
		}
	}
	finish(sessionUri: string, state: 'idle' | 'failed' | 'stopped' = 'idle'): void {
		const turnId = this.active.get(sessionUri);
		assert.ok(turnId);
		this.active.delete(sessionUri);
		this.changed.fire({ sessionUri, turnId, state });
	}
	emit(event: IRoomRuntimeEvent): void { this.changed.fire(event); }
	whenSubmitted(count: number): Promise<void> {
		return this.submitted.length >= count ? Promise.resolve() : Event.toPromise(Event.filter(this.didSubmit.event, () => this.submitted.length >= count));
	}
	whenPrepared(count: number): Promise<void> {
		return this.prepared.length >= count ? Promise.resolve() : Event.toPromise(Event.filter(this.didPrepare.event, () => this.prepared.length >= count));
	}
}

function inboxText(prompt: string): string {
	const start = prompt.indexOf('ROOM_INBOX_JSONL\n\n');
	const end = prompt.lastIndexOf('\n\nEND_ROOM_INBOX_JSONL');
	assert.ok(start >= 0 && end > start, 'Native input must contain the actual attributed inbox');
	return prompt.slice(start + 'ROOM_INBOX_JSONL\n\n'.length, end);
}

function messageInput(message: IAgentHostRoomMessage): string {
	return JSON.stringify({
		id: message.id, sequence: message.sequence, authorId: message.authorId, authorName: message.authorName,
		authorKind: message.authorKind, text: message.text, replyTo: message.replyTo, artifactIds: message.artifactIds,
	});
}

suite('AgentHostRooms inbox v2', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(workerCount = 2, storage = new MemoryRoomStorage(), runtime = new RoomRuntime(), now?: () => number) {
		const rooms = disposables.add(new AgentHostRooms(storage, runtime, new NullLogService(), now, 50));
		const create = () => rooms.createRoom({ title: 'Peer inbox', goal: 'Measure before changing code', repositoryUri: 'file:///repository', workerCount });
		return { storage, runtime, rooms, create };
	}

	function whenRoom(rooms: IAgentHostRoomsService, roomId: string, predicate: (room: IAgentHostRoom) => boolean): Promise<IAgentHostRoom> {
		const listeners = disposables.add(new DisposableStore());
		return new Promise((resolve, reject) => {
			const check = (room: IAgentHostRoom) => {
				if (room.id === roomId && predicate(room)) {
					listeners.dispose();
					resolve(room);
				}
			};
			listeners.add(rooms.onDidChangeRoom(check));
			void rooms.getRoom(roomId).then(check, error => { listeners.dispose(); reject(error); });
		});
	}

	test('creation, passive notes, reads, and an idle room spend zero additional turns', async () => {
		const { rooms, runtime, storage, create } = setup();
		const room = await create();
		await rooms.postMessage(room.id, { id: 'note', text: `@${room.members[0].name} @all this is passive`, mentions: [] });
		await rooms.getMessages(room.id);
		assert.deepStrictEqual({ prepared: runtime.prepared, run: (await rooms.getRoom(room.id)).run }, { prepared: [], run: undefined });
		for (const maxTurns of [undefined, 0, -1, Infinity, NaN, 1.5]) {
			await assert.rejects(rooms.startRoom(room.id, { maxTurns }), /budget|finite/);
		}
		await rooms.startRoom(room.id, { maxTurns: 8 });
		await runtime.whenSubmitted(2);
		for (const member of room.members) {
			runtime.finish(member.sessionUri);
		}
		const idle = await whenRoom(rooms, room.id, room => room.state === 'idle');
		const before = storage.writes.length;
		await rooms.read(AgentSession.id(URI.parse(room.members[0].sessionUri)), { limit: 1 });
		await rooms.getMessages(room.id, { memberId: room.members[0].id });
		await rooms.postMessage(room.id, { id: 'another-note', text: 'No automatic continuation is needed.', mentions: [] });
		assert.deepStrictEqual({
			run: (await rooms.getRoom(room.id)).run, sends: runtime.submitted.length,
			initials: (await rooms.getMessages(room.id)).messages.filter(message => message.id.startsWith('initial-')).map(message => message.mentions),
			writes: storage.writes.length - before,
		}, { run: idle.run, sends: 2, initials: room.members.map(member => [member.id]), writes: 1 });
	});

	test('A to B to A carries actual attributed inbox bodies without a manager or live steering', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		const [a, b] = room.members;
		await rooms.startRoom(room.id, { maxTurns: 10 });
		await runtime.whenSubmitted(2);
		runtime.finish(b.sessionUri);
		await whenRoom(rooms, room.id, room => room.members[1].state === 'idle');
		const question = await rooms.post(AgentSession.id(URI.parse(a.sessionUri)), { id: 'a-question', text: 'Please check that the parser accepts empty input.', mentions: [b.id] });
		await runtime.whenSubmitted(3);
		const answer = await rooms.post(AgentSession.id(URI.parse(b.sessionUri)), { id: 'b-answer', text: 'Empty input returns zero tokens; the focused parser test passes.', mentions: [a.id], replyTo: question.id });
		assert.strictEqual(runtime.submitted.length, 3, 'Busy A receives queued mail, not a second turn');
		runtime.finish(a.sessionUri);
		await runtime.whenSubmitted(4);
		assert.deepStrictEqual({
			exchange: runtime.submitted.slice(2).map(turn => ({ sessionUri: turn.sessionUri, inbox: inboxText(turn.prompt) })),
			participants: [...new Set(runtime.prepared)].sort(),
			tools: createCopilotRoomTools('bound-session', rooms).map(tool => tool.name),
			forcedContinuation: runtime.submitted.some(turn => /room_yield|room_assign|room_coordinator|Before ending this turn/.test(turn.prompt)),
		}, {
			exchange: [{ sessionUri: b.sessionUri, inbox: messageInput(question) }, { sessionUri: a.sessionUri, inbox: messageInput(answer) }],
			participants: room.members.map(member => member.sessionUri).sort(),
			tools: ['room_read', 'room_post', 'room_share_patch', 'room_read_artifact'], forcedContinuation: false,
		});
		runtime.finish(a.sessionUri);
		runtime.finish(b.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual((await rooms.getMessages(room.id)).messages.slice(-2).map(message => message.deliveries[0].state), ['submitted', 'submitted']);
	});

	test('posting and reservation persistence precede sender acknowledgement and native submission', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 5 });
		await runtime.whenSubmitted(1);
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		const writing = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		storage.beforeSave = async record => {
			if (record.messages.some(message => message.id === 'durable') && !storage.records.get(room.id)!.messages.some(message => message.id === 'durable')) {
				await writing.complete();
				await release.p;
			}
		};
		let acknowledged = false;
		const post = async () => {
			await rooms.postMessage(room.id, { id: 'durable', text: 'Check the saved input', mentions: [room.members[0].id] });
			acknowledged = true;
		};
		const posting = post();
		await writing.p;
		assert.deepStrictEqual({ acknowledged, sends: runtime.submitted.length, visible: (await rooms.getMessages(room.id)).messages.some(message => message.id === 'durable') }, { acknowledged: false, sends: 1, visible: false });
		runtime.beforeSubmit = () => {
			const saved = storage.records.get(room.id)!;
			assert.deepStrictEqual({
				admitted: saved.room.run?.admittedTurns,
				reserved: saved.messages.find(message => message.id === 'durable')!.deliveries[0].turnId,
				state: saved.messages.find(message => message.id === 'durable')!.deliveries[0].state,
			}, { admitted: 2, reserved: saved.executions[0].turnId, state: 'reserved' });
			assert.ok(saved.executions[0].turnId);
		};
		await release.complete();
		await posting;
		await runtime.whenSubmitted(2);
	});

	test('failed persistence refuses the post, exposes interruption, and dispatches nothing', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		storage.saveError = new Error('disk full');
		await assert.rejects(rooms.postMessage(room.id, { id: 'lost', text: 'Must not dispatch', mentions: [] }), /disk full/);
		assert.deepStrictEqual({
			available: (await rooms.getCapabilities()).available, state: (await rooms.getRoom(room.id)).state,
			messages: (await rooms.getMessages(room.id)).messages, sends: runtime.submitted,
		}, { available: false, state: 'interrupted', messages: [], sends: [] });
	});

	for (const boundedBy of ['count', 'characters'] as const) {
		test(`busy mail batches are bounded by ${boundedBy} and remaining messages wait for a terminal event`, async () => {
			const { rooms, runtime, create } = setup(1);
			const room = await create();
			const member = room.members[0];
			await rooms.startRoom(room.id, { maxTurns: 8 });
			await runtime.whenSubmitted(1);
			const count = boundedBy === 'count' ? MAX_ROOM_INBOX_BATCH_SIZE + 1 : 3;
			const text = boundedBy === 'characters' ? 'x'.repeat(7000) : 'A useful short message';
			const posted = await Promise.all(Array.from({ length: count }, (_, index) => rooms.postMessage(room.id, { id: `mail-${index}`, text, mentions: [member.id] })));
			assert.strictEqual(runtime.submitted.length, 1);
			runtime.finish(member.sessionUri);
			await runtime.whenSubmitted(2);
			const batch = inboxText(runtime.submitted[1].prompt);
			const firstCount = boundedBy === 'count' ? MAX_ROOM_INBOX_BATCH_SIZE : 2;
			assert.deepStrictEqual({
				text: batch, bounded: batch.length <= MAX_ROOM_INBOX_BATCH_CHARACTERS,
				messages: batch.split('\n').length <= MAX_ROOM_INBOX_BATCH_SIZE,
			}, { text: posted.slice(0, firstCount).map(messageInput).join('\n'), bounded: true, messages: true });
			runtime.finish(member.sessionUri);
			await runtime.whenSubmitted(3);
			assert.strictEqual(inboxText(runtime.submitted[2].prompt), posted.slice(firstCount).map(messageInput).join('\n'));
		});
	}

	test('paged reads and transient tool activity never rewrite the journal or consume receipts', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 5 });
		await runtime.whenSubmitted(1);
		const member = room.members[0];
		const queued = await rooms.postMessage(room.id, { id: 'waiting', text: 'Arrived while busy', mentions: [member.id] });
		const previous = structuredClone(storage.records.get(room.id));
		const writes = storage.writes.length;
		const notifications: IAgentHostRoom[] = [];
		disposables.add(rooms.onDidChangeRoom(room => notifications.push(room)));
		const first = await rooms.read(AgentSession.id(URI.parse(member.sessionUri)), { after: 0, limit: 1 });
		const last = await rooms.getMessages(room.id, { after: first.messages[0].sequence, limit: 1, memberId: member.id });
		const event: IRoomRuntimeEvent = { sessionUri: member.sessionUri, turnId: runtime.active.get(member.sessionUri), state: 'working', activity: 'Read file' };
		runtime.emit(event);
		await whenRoom(rooms, room.id, room => room.members[0].activity === 'Read file');
		runtime.emit(event);
		await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			saved: storage.records.get(room.id), writes: storage.writes.length - writes,
			notifications: notifications.length, page: last.messages.map(message => message.id),
			flags: [first.hasEarlier, first.hasLater, last.hasEarlier, last.hasLater],
			receipt: (await rooms.getMessages(room.id)).messages.find(message => message.id === queued.id)!.deliveries[0],
		}, { saved: previous, writes: 0, notifications: 1, page: ['waiting'], flags: [false, true, true, false], receipt: { memberId: member.id, state: 'pending' } });
	});

	test('idempotent messages and repeated Start preserve identities and never spend a fresh budget', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		const [started] = await Promise.all([rooms.startRoom(room.id, { maxTurns: 5 }), rooms.startRoom(room.id, { maxTurns: 5 })]);
		await runtime.whenSubmitted(1);
		const message = { id: 'same-id', text: 'Handle once', mentions: [room.members[0].id] };
		const first = await rooms.postMessage(room.id, message);
		const writes = storage.writes.length;
		const duplicate = await rooms.postMessage(room.id, message);
		await assert.rejects(rooms.postMessage(room.id, { ...message, text: 'Different input' }), /already used/);
		await assert.rejects(rooms.postMessage(room.id, { ...message, id: 'name-not-id', mentions: [room.members[0].name] }), /member does not exist/);
		assert.deepStrictEqual({ first, duplicate, writes: storage.writes.length }, { first, duplicate: first, writes });
		runtime.finish(room.members[0].sessionUri);
		await runtime.whenSubmitted(2);
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.startRoom(room.id, {});
		await rooms.stopRoom(room.id);
		await rooms.startRoom(room.id, { maxTurns: 5 });
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		const resumed = await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			run: resumed.run, sessions: resumed.members.map(member => member.sessionUri), sends: runtime.submitted.length,
			messages: (await rooms.getMessages(room.id)).messages.map(message => message.id),
		}, { run: { ...started.run!, admittedTurns: 2 }, sessions: room.members.map(member => member.sessionUri), sends: 2, messages: [`initial-${started.run!.id}-${room.members[0].id}`, first.id] });
	});

	test('human Send resumes only addressed stopped peers and preserves the run and budget', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		const [a, b] = room.members;
		const run = (await rooms.startRoom(room.id, { maxTurns: 8 })).run!;
		await runtime.whenSubmitted(2);
		await rooms.stopRoom(room.id);
		const message = { id: 'resume-a', text: 'Focus on URI formatting now.', mentions: [a.id] };
		await rooms.postMessage(room.id, message);
		await runtime.whenSubmitted(3);
		const active = await rooms.getRoom(room.id);
		assert.deepStrictEqual({
			runId: active.run?.id, limit: active.run?.limits.maxTurns, admitted: active.run?.admittedTurns,
			target: runtime.submitted[2].sessionUri, input: runtime.submitted[2].prompt.includes(message.text),
			unaddressed: active.members[1].state,
		}, { runId: run.id, limit: 8, admitted: 3, target: a.sessionUri, input: true, unaddressed: 'stopped' });
		await rooms.stopRoom(room.id);
		await rooms.postMessage(room.id, message);
		assert.deepStrictEqual({ sends: runtime.submitted.length, state: (await rooms.getRoom(room.id)).state, b: runtime.active.has(b.sessionUri) },
			{ sends: 3, state: 'stopped', b: false });
	});

	test('human Send resumes a paused room while a new Pause still wins an in-flight send', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		const member = room.members[0];
		await rooms.startRoom(room.id, { maxTurns: 6 });
		await runtime.whenSubmitted(1);
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		await rooms.pauseRoom(room.id);
		await rooms.postMessage(room.id, { id: 'resume-paused', text: 'Continue the URI implementation.', mentions: [member.id] });
		await runtime.whenSubmitted(2);
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		const saving = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		storage.beforeSave = async record => {
			if (record.messages.some(message => message.id === 'pause-race') && !saving.isSettled) {
				await saving.complete();
				await release.p;
			}
		};
		const sending = rooms.postMessage(room.id, { id: 'pause-race', text: 'Pause may supersede this input.', mentions: [member.id] });
		await saving.p;
		const pausing = rooms.pauseRoom(room.id);
		await release.complete();
		await Promise.all([sending, pausing]);
		assert.deepStrictEqual({
			state: (await rooms.getRoom(room.id)).state, sends: runtime.submitted.length,
			pending: (await rooms.getMessages(room.id)).messages.find(message => message.id === 'pause-race')?.deliveries[0].state,
		}, { state: 'paused', sends: 2, pending: 'pending' });
	});

	test('human Send cannot create an unbudgeted run or replenish an exhausted budget', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		const options = { id: 'requires-budget', text: 'Please work on URI formatting.', mentions: [room.members[0].id] };
		await assert.rejects(rooms.postMessage(room.id, options), /finite turn budget/);
		await rooms.startRoom(room.id, { maxTurns: 1 });
		await runtime.whenSubmitted(1);
		runtime.finish(room.members[0].sessionUri);
		await whenRoom(rooms, room.id, room => room.members[0].state === 'idle');
		await assert.rejects(rooms.postMessage(room.id, options), /budget is exhausted/);
		await rooms.postMessage(room.id, { ...options, mentions: [] });
		assert.deepStrictEqual({ sends: runtime.submitted.length, cap: (await rooms.getRoom(room.id)).run?.limits.maxTurns }, { sends: 1, cap: 1 });
	});

	test('human Send retries a failed peer with new input, not its previous submitted input', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		const member = room.members[0];
		await rooms.startRoom(room.id, { maxTurns: 4 });
		await runtime.whenSubmitted(1);
		runtime.finish(member.sessionUri, 'failed');
		await whenRoom(rooms, room.id, room => room.members[0].state === 'failed');
		const request = await rooms.postMessage(room.id, { id: 'after-failure', text: 'Continue with the URI review.', mentions: [member.id] });
		await runtime.whenSubmitted(2);
		assert.deepStrictEqual({
			input: inboxText(runtime.submitted[1].prompt),
			turns: (await rooms.getRoom(room.id)).run?.admittedTurns,
			original: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state,
		}, { input: messageInput(request), turns: 2, original: 'submitted' });
	});

	test('human Send refuses unsettled stopping without storing or launching new work', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 4 });
		await runtime.whenSubmitted(1);
		const abort = new DeferredPromise<void>();
		runtime.abortGate = abort.p;
		const stopping = rooms.stopRoom(room.id);
		await whenRoom(rooms, room.id, room => room.state === 'stopping');
		await assert.rejects(rooms.postMessage(room.id, { id: 'during-stop', text: 'Wait for cancellation.', mentions: [room.members[0].id] }), /stopping to finish/);
		await abort.complete();
		await stopping;
		assert.deepStrictEqual({
			sends: runtime.submitted.length,
			stored: (await rooms.getMessages(room.id)).messages.some(message => message.id === 'during-stop'),
			state: (await rooms.getRoom(room.id)).state,
		}, { sends: 1, stored: false, state: 'stopped' });
	});

	test('finite-budget ping-pong pauses with pending mail until an explicit extension of the same run', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		const [a, b] = room.members;
		const run = (await rooms.startRoom(room.id, { maxTurns: 4 })).run!;
		await runtime.whenSubmitted(2);
		const post = (from: IAgentHostRoomMember, to: IAgentHostRoomMember, id: string) => rooms.post(AgentSession.id(URI.parse(from.sessionUri)), { id, text: 'Useful next evidence', mentions: [to.id] });
		await post(a, b, 'a-to-b');
		runtime.finish(b.sessionUri);
		await runtime.whenSubmitted(3);
		await post(b, a, 'b-to-a');
		runtime.finish(a.sessionUri);
		await runtime.whenSubmitted(4);
		await post(a, b, 'held-at-budget');
		runtime.finish(a.sessionUri);
		runtime.finish(b.sessionUri);
		await whenRoom(rooms, room.id, room => room.members.every(member => member.state === 'idle'));
		const paused = await rooms.startRoom(room.id, {});
		await assert.rejects(rooms.startRoom(room.id, { maxTurns: 100 }), /Extend Run/);
		assert.deepStrictEqual({ state: paused.state, reason: paused.pauseReason, run: paused.run, sends: runtime.submitted.length }, { state: 'paused', reason: 'budget', run: { ...run, admittedTurns: 4 }, sends: 4 });
		await rooms.extendRun(room.id, 1);
		await runtime.whenSubmitted(5);
		assert.deepStrictEqual({ run: (await rooms.getRoom(room.id)).run, lastRecipient: runtime.submitted[4].sessionUri }, {
			run: { ...run, limits: { maxTurns: 5 }, admittedTurns: 5 }, lastRecipient: b.sessionUri,
		});
	});

	test('peer mail cannot undo Pause or member Stop; failure and removal do not affect unrelated peers', async () => {
		const { rooms, runtime, storage, create } = setup();
		const room = await create();
		const [a, b] = room.members;
		await rooms.startRoom(room.id, { maxTurns: 10 });
		await runtime.whenSubmitted(2);
		await rooms.pauseRoom(room.id);
		await rooms.post(AgentSession.id(URI.parse(b.sessionUri)), { id: 'paused-mail', text: 'For A after Resume', mentions: [a.id] });
		runtime.finish(a.sessionUri);
		await whenRoom(rooms, room.id, room => room.members[0].state === 'idle');
		assert.strictEqual(runtime.submitted.length, 2);
		await rooms.startRoom(room.id, {});
		await runtime.whenSubmitted(3);
		storage.worktreeError = new Error('new worktree unavailable');
		const expanded = await rooms.addMember(room.id);
		await whenRoom(rooms, room.id, room => room.members[2].state === 'failed');
		await rooms.stopMember(room.id, a.id);
		await rooms.post(AgentSession.id(URI.parse(b.sessionUri)), { id: 'stopped-mail', text: 'Hold for A', mentions: [a.id] });
		const removed = await rooms.removeMember(room.id, a.id);
		await assert.rejects(rooms.postMessage(room.id, { id: 'removed-mail', text: 'Must reject', mentions: [a.id] }), /removed/);
		assert.deepStrictEqual({
			busyB: runtime.active.has(b.sessionUri), removedA: removed.members[0].removed,
			abortedB: runtime.aborted.includes(b.sessionUri), newIdentity: expanded.members[2].sessionUri !== a.sessionUri,
			held: (await rooms.getMessages(room.id)).messages.find(message => message.id === 'stopped-mail')!.deliveries[0].state,
		}, { busyB: true, removedA: true, abortedB: false, newIdentity: true, held: 'cancelled' });
	});

	test('deadline expiration closes admission without resetting the deadline or the finite run', async () => {
		let now = 0;
		const { rooms, runtime, create } = setup(1, new MemoryRoomStorage(), new RoomRuntime(), () => now);
		const room = await create();
		const member = room.members[0];
		const run = (await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 1 })).run!;
		await runtime.whenSubmitted(1);
		now = 60000;
		assert.throws(() => rooms.beforeTool(AgentSession.id(URI.parse(member.sessionUri)), 'read_file'), /no active authorized turn/);
		await assert.rejects(rooms.postMessage(room.id, { id: 'expired', text: 'Hold after the deadline', mentions: [member.id] }), /deadline has elapsed/);
		await rooms.startRoom(room.id, {});
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.members[0].state === 'idle');
		await rooms.startRoom(room.id, {});
		await rooms.extendRun(room.id, 1);
		const expired = await rooms.getRoom(room.id);
		assert.deepStrictEqual({ reason: expired.pauseReason, run: expired.run, sends: runtime.submitted.length }, {
			reason: 'deadline', run: { ...run, limits: { maxTurns: 4, timeoutMinutes: 1 }, admittedTurns: 1 }, sends: 1,
		});
	});

	test('the deadline timer only pauses admission and never creates a continuation turn', async () => runWithFakedTimers({}, async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3, timeoutMinutes: 0.001 });
		await runtime.whenSubmitted(1);
		const paused = await whenRoom(rooms, room.id, room => room.pauseReason === 'deadline');
		assert.deepStrictEqual({ state: paused.state, turns: paused.run?.admittedTurns, sends: runtime.submitted.length }, { state: 'paused', turns: 1, sends: 1 });
	}));

	test('Stop closes admission before an outstanding preparation and ignores late native events', async () => {
		const { rooms, runtime, create } = setup(1);
		const gate = new DeferredPromise<void>();
		runtime.prepareGate = gate.p;
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await runtime.whenPrepared(1);
		const reserved = (await rooms.getMessages(room.id)).messages[0];
		assert.strictEqual(reserved.deliveries[0].state, 'reserved');
		await assert.rejects(rooms.retryMessage(room.id, reserved.id), /reserved for an active turn/);
		const stopped = await rooms.stopRoom(room.id);
		const afterPreparation = whenRoom(rooms, room.id, room => room.revision > stopped.revision);
		await gate.complete();
		await afterPreparation;
		runtime.emit({ sessionUri: room.members[0].sessionUri, turnId: 'late-turn', state: 'working' });
		runtime.emit({ sessionUri: room.members[0].sessionUri, turnId: 'late-turn', state: 'idle' });
		assert.deepStrictEqual({
			state: (await rooms.getRoom(room.id)).state, sends: runtime.submitted.length, budget: stopped.run?.admittedTurns,
			delivery: (await rooms.getMessages(room.id)).messages[0].deliveries[0],
		}, { state: 'stopped', sends: 0, budget: 1, delivery: { memberId: room.members[0].id, state: 'pending', turnId: undefined, error: undefined } });
	});

	test('reserved receipts become submitted only after the native input call returns', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const gate = new DeferredPromise<void>();
		runtime.prepareGate = gate.p;
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await runtime.whenPrepared(1);
		const reserved = (await rooms.getMessages(room.id)).messages[0];
		assert.deepStrictEqual({
			state: reserved.deliveries[0].state, submitted: runtime.submitted.length,
			durableState: storage.records.get(room.id)!.messages[0].deliveries[0].state,
		}, { state: 'reserved', submitted: 0, durableState: 'reserved' });
		runtime.beforeSubmit = () => assert.strictEqual(storage.records.get(room.id)!.messages[0].deliveries[0].state, 'reserved');
		await gate.complete();
		await runtime.whenSubmitted(1);
		await whenRoom(rooms, room.id, () => storage.records.get(room.id)!.messages[0].deliveries[0].state === 'submitted');
		assert.deepStrictEqual((await rooms.getMessages(room.id)).messages[0], {
			...reserved, deliveries: [{ ...reserved.deliveries[0], state: 'submitted' }],
		});
	});

	test('a throwing native input call never publishes a submitted receipt even if a native turn exists', async () => {
		const { rooms, runtime, storage, create } = setup(1);
		const room = await create();
		runtime.afterSubmitError = new Error('Disconnected after the input call');
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await whenRoom(rooms, room.id, room => room.members[0].state === 'interrupted');
		await assert.rejects(rooms.retryMember(room.id, room.members[0].id), /previous turn/);
		const delivery = (await rooms.getMessages(room.id)).messages[0].deliveries[0];
		assert.deepStrictEqual({
			state: delivery.state, nativeCalls: runtime.submitted.length, budget: (await rooms.getRoom(room.id)).run?.admittedTurns,
			everSubmitted: storage.writes.some(record => record.messages.some(message => message.deliveries.some(delivery => delivery.state === 'submitted'))),
		}, { state: 'interrupted', nativeCalls: 1, budget: 1, everSubmitted: false });
	});

	for (const failure of ['rejection', 'timeout', 'unconfirmed'] as const) {
		test(`Stop surfaces interrupted state on ${failure}, and late events cannot revive the room`, async () => runWithFakedTimers({}, async () => {
			const { rooms, runtime, create } = setup(1);
			const room = await create();
			await rooms.startRoom(room.id, { maxTurns: 3 });
			await runtime.whenSubmitted(1);
			const turnId = runtime.submitted[0].turnId;
			if (failure === 'rejection') {
				runtime.abortError = new Error('abort failed');
			} else if (failure === 'timeout') {
				runtime.abortGate = new DeferredPromise<void>().p;
			} else {
				runtime.ignoreAbort = true;
			}
			const stopped = await rooms.stopRoom(room.id);
			runtime.emit({ sessionUri: room.members[0].sessionUri, turnId, state: 'idle' });
			await assert.rejects(rooms.startRoom(room.id, {}), /may still be running/);
			assert.deepStrictEqual({
				room: stopped.state, member: stopped.members[0].state, error: !!stopped.error,
				late: (await rooms.getRoom(room.id)).state, sends: runtime.submitted.length,
			}, { room: 'interrupted', member: 'interrupted', error: true, late: 'interrupted', sends: 1 });
		}));
	}

	test('submission uncertainty is explicit and only a human retry spends another reserved turn', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		runtime.submitError = new Error('transport disconnected');
		const run = (await rooms.startRoom(room.id, { maxTurns: 3 })).run!;
		await whenRoom(rooms, room.id, room => room.members[0].state === 'interrupted');
		const interrupted = (await rooms.getMessages(room.id)).messages[0];
		assert.strictEqual(interrupted.deliveries[0].state, 'interrupted');
		runtime.submitError = undefined;
		await rooms.retryMember(room.id, room.members[0].id);
		await runtime.whenSubmitted(1);
		assert.deepStrictEqual({ run: (await rooms.getRoom(room.id)).run, input: inboxText(runtime.submitted[0].prompt) }, {
			run: { ...run, admittedTurns: 2 }, input: messageInput(interrupted),
		});
	});

	test('retrying an interrupted message and posting notes cannot replenish an exhausted run', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		runtime.submitError = new Error('submission uncertain');
		const run = (await rooms.startRoom(room.id, { maxTurns: 1 })).run!;
		await whenRoom(rooms, room.id, room => room.members[0].state === 'interrupted');
		const message = (await rooms.getMessages(room.id)).messages[0];
		runtime.submitError = undefined;
		await rooms.retryMessage(room.id, message.id);
		await rooms.postMessage(room.id, { id: 'passive', text: 'No fresh run', mentions: [] });
		await rooms.startRoom(room.id, {});
		assert.deepStrictEqual({ run: (await rooms.getRoom(room.id)).run, sends: runtime.submitted.length }, { run: { ...run, admittedTurns: 1 }, sends: 0 });
		await rooms.extendRun(room.id, 1);
		await runtime.whenSubmitted(1);
		assert.deepStrictEqual({ run: (await rooms.getRoom(room.id)).run, input: inboxText(runtime.submitted[0].prompt) }, {
			run: { ...run, limits: { maxTurns: 2 }, admittedTurns: 2 }, input: messageInput(message),
		});
	});

	test('a failed native turn does not undo submission or automatically replay its input', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 4 });
		await runtime.whenSubmitted(1);
		runtime.finish(room.members[0].sessionUri, 'failed');
		await whenRoom(rooms, room.id, room => room.members[0].state === 'failed');
		await rooms.retryMember(room.id, room.members[0].id);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual({
			receipt: (await rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			sends: runtime.submitted.length, admitted: (await rooms.getRoom(room.id)).run?.admittedTurns,
		}, { receipt: 'submitted', sends: 1, admitted: 1 });
	});

	test('recovery marks ambiguous reservations interrupted without replay or fresh session identities', async () => {
		const first = setup(1);
		const preparing = new DeferredPromise<void>();
		first.runtime.prepareGate = preparing.p;
		const room = await first.create();
		await first.rooms.startRoom(room.id, { maxTurns: 3 });
		await first.runtime.whenPrepared(1);
		await first.rooms.postMessage(room.id, { id: 'after-crash', text: 'Keep this queued', mentions: [room.members[0].id] });
		const saved = structuredClone(first.storage.records.get(room.id)!);
		first.rooms.dispose();
		await preparing.complete();
		const second = setup(1, first.storage);
		const restored = await second.rooms.getRoom(room.id);
		assert.deepStrictEqual({
			state: restored.state, run: restored.run, sessions: restored.members.map(member => member.sessionUri),
			receipts: (await second.rooms.getMessages(room.id)).messages.map(message => message.deliveries[0].state),
			prepared: second.runtime.prepared, sends: second.runtime.submitted,
		}, {
			state: 'interrupted', run: saved.room.run, sessions: room.members.map(member => member.sessionUri),
			receipts: ['interrupted', 'pending'], prepared: [], sends: [],
		});
	});

	test('recovery retains a persisted submission even with a cold native turn cache', async () => {
		const first = setup(1);
		const room = await first.create();
		await first.rooms.startRoom(room.id, { maxTurns: 3 });
		await first.runtime.whenSubmitted(1);
		await whenRoom(first.rooms, room.id, () => first.storage.records.get(room.id)!.messages[0].deliveries[0].state === 'submitted');
		const runtime = new RoomRuntime();
		first.rooms.dispose();
		const restored = setup(1, first.storage, runtime);
		await restored.rooms.getRoom(room.id);
		assert.deepStrictEqual({
			receipts: (await restored.rooms.getMessages(room.id)).messages.map(message => message.deliveries[0].state),
			turns: (await restored.rooms.getRoom(room.id)).run?.admittedTurns,
			prepared: runtime.prepared, submitted: runtime.submitted,
		}, { receipts: ['submitted'], turns: 1, prepared: [], submitted: [] });
	});

	test('recovery reconciles a reservation with existing native input evidence without a new turn', async () => {
		const first = setup(1);
		const preparing = new DeferredPromise<void>();
		first.runtime.prepareGate = preparing.p;
		const room = await first.create();
		await first.rooms.startRoom(room.id, { maxTurns: 3 });
		await first.runtime.whenPrepared(1);
		const reservation = first.storage.records.get(room.id)!.executions[0];
		const runtime = new RoomRuntime();
		runtime.known.add(`${room.members[0].sessionUri}:${reservation.turnId}`);
		first.rooms.dispose();
		await preparing.complete();
		const restored = setup(1, first.storage, runtime);
		await restored.rooms.getRoom(room.id);
		assert.deepStrictEqual({
			delivery: (await restored.rooms.getMessages(room.id)).messages[0].deliveries[0].state,
			budget: (await restored.rooms.getRoom(room.id)).run?.admittedTurns,
			prepared: runtime.prepared, nativeInputs: runtime.submitted,
		}, { delivery: 'submitted', budget: 1, prepared: [], nativeInputs: [] });
	});

	test('archive rooms and historical coordinator sessions are display-only on every admission path', async () => {
		const seed = setup(1);
		const original = await seed.create();
		const historic = AgentSession.uri('copilotcli', 'historical-coordinator').toString();
		const coordinator = { id: 'old-coordinator', name: 'Historical coordinator', sessionUri: historic, chatUri: buildDefaultChatUri(historic) };
		const worker = original.members[0];
		const history: readonly IAgentHostRoomMessage[] = [
			{
				id: 'historical-request', sequence: 1, authorId: coordinator.id, authorName: coordinator.name, authorKind: 'agent',
				kind: 'message', text: 'Review the saved parser evidence.', timestamp: 1, mentions: [worker.id],
				deliveries: [{ memberId: worker.id, state: 'submitted', turnId: 'historical-worker-turn' }],
			},
			{
				id: 'historical-reply', sequence: 2, authorId: worker.id, authorName: worker.name, authorKind: 'agent',
				kind: 'message', text: 'The recorded parser evidence is available.', timestamp: 2, mentions: [coordinator.id], replyTo: 'historical-request',
				deliveries: [{ memberId: coordinator.id, state: 'submitted', turnId: 'historical-coordinator-turn' }],
			},
		];
		const archiveRoom: IAgentHostRoom = {
			...original, archived: true, state: 'stopped', latestMessageSequence: history.length,
			archivedSessions: [
				...original.members.map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
				coordinator,
			],
		};
		const storage = new MemoryRoomStorage();
		storage.archives.push({ room: archiveRoom, messages: history, sessionUris: [worker.sessionUri, historic] });
		const preservedArchive = structuredClone(storage.archives[0]);
		const { rooms, runtime } = setup(1, storage);
		assert.deepStrictEqual(await rooms.listRooms(), [archiveRoom]);
		for (const operation of [
			() => rooms.startRoom(original.id, { maxTurns: 2 }), () => rooms.extendRun(original.id, 2),
			() => rooms.pauseRoom(original.id), () => rooms.stopRoom(original.id), () => rooms.addMember(original.id),
			() => rooms.removeMember(original.id, original.members[0].id), () => rooms.retryMember(original.id, original.members[0].id),
			() => rooms.setMemberModel(original.id, original.members[0].id, { id: 'model-a' }),
			() => rooms.setRoomConfiguration(original.id, { mode: 'plan' }),
			() => rooms.postMessage(original.id, { id: 'archive-write', text: 'Must reject', mentions: [] }),
			() => rooms.retryMessage(original.id, history[0].id),
			() => rooms.setMemberConfiguration(historic, { mode: 'plan' }),
			() => rooms.setMemberModelForChat(historic, coordinator.chatUri, { id: 'model-a' }),
			() => rooms.post('historical-coordinator', { id: 'coordinator-write', text: 'Must reject', mentions: [] }),
		]) {
			await assert.rejects(operation, /read-only/);
		}
		assert.deepStrictEqual({
			coordinatorIsWorker: archiveRoom.members.some(member => member.id === coordinator.id),
			bound: [worker.sessionUri, historic].map(session => rooms.isRoomSessionUri(session)),
			toolBindings: [worker.sessionUri, historic].map(session => rooms.isRoomSession(AgentSession.id(URI.parse(session)))),
			admitted: [worker.sessionUri, historic].map(session => rooms.isAdmittedTurn(session, buildDefaultChatUri(session), 'forged')),
			firstPage: await rooms.getMessages(original.id, { limit: 1, before: 2 }),
			coordinatorInbox: await rooms.getMessages(original.id, { memberId: coordinator.id, after: 1 }),
			archive: storage.archives[0], prepared: runtime.prepared, sends: runtime.submitted, aborts: runtime.aborted, writes: storage.writes,
		}, {
			coordinatorIsWorker: false, bound: [true, true], toolBindings: [true, true], admitted: [false, false],
			firstPage: { messages: [history[0]], hasEarlier: false, hasLater: true },
			coordinatorInbox: { messages: [history[1]], hasEarlier: false, hasLater: false },
			archive: preservedArchive, prepared: [], sends: [], aborts: [], writes: [],
		});
		assert.throws(() => rooms.beforeTool('historical-coordinator', 'room_post'), /read-only/);
	});

	test('tool authors are session-bound, recipient IDs are explicit, and content exclusions remain authoritative', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		await rooms.startRoom(room.id, { maxTurns: 8 });
		await runtime.whenSubmitted(2);
		const member = room.members[0];
		const sessionId = AgentSession.id(URI.parse(member.sessionUri));
		const tools = createCopilotRoomTools(sessionId, rooms);
		const post = tools.find(tool => tool.name === 'room_post')!;
		const handler = post.handler;
		assert.ok(handler);
		const invokePost = (args: Record<string, unknown>) => handler(args, { sessionId, toolCallId: 'post', toolName: post.name, arguments: args });
		await assert.rejects(async () => invokePost({ id: 'forged', text: 'Spoof', mentions: [], authorId: room.members[1].id }), /Invalid room tool arguments/);
		await assert.rejects(rooms.post('not-a-member', { id: 'not-bound', text: 'Spoof', mentions: [] }), /not a room member/);
		assert.throws(() => rooms.beforeTool(sessionId, 'namespace:run_factory'), /cannot launch nested/);
		assert.throws(() => rooms.beforeTool(sessionId, 'read_file', 'forged-turn'), /no active authorized turn/);
		await invokePost({ id: 'own-note', text: `@${room.members[1].name} is plain text`, mentions: [] });
		const patch = await rooms.sharePatch(sessionId, 'Parser change');
		runtime.contentError = new Error('excluded by policy');
		await assert.rejects(rooms.readArtifact(sessionId, patch.id), /excluded by policy/);
		assert.deepStrictEqual({
			author: (await rooms.getMessages(room.id)).messages.find(message => message.id === 'own-note')!.authorId,
			receipt: (await rooms.getMessages(room.id)).messages.find(message => message.id === 'own-note')!.deliveries,
			checks: runtime.contentChecks, sends: runtime.submitted.length,
		}, {
			author: member.id, receipt: [], sends: 2,
			checks: Array.from({ length: 2 }, () => ({ sessionUri: member.sessionUri, paths: [URI.joinPath(URI.parse(member.worktreeUri!), 'src/file.ts').fsPath] })),
		});
	});

	test('per-member model selection persists without preparing or starting a run, including Auto', async () => {
		const { rooms, runtime, create } = setup();
		const room = await create();
		await rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-a', config: { thinking: 'high' } });
		await rooms.setMemberModel(room.id, room.members[1].id, undefined);
		const selected = await rooms.getRoom(room.id);
		await assert.rejects(rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-a', config: { thinking: 'unsupported' } }), /does not support/);
		runtime.catalog = models.map(model => model.id === 'model-b' ? { ...model, policyState: PolicyState.Disabled } : model);
		await assert.rejects(rooms.setMemberModel(room.id, room.members[1].id, { id: 'model-b' }), /disabled by policy/);
		assert.deepStrictEqual({
			selected: selected.members.map(getRoomMemberModel), applied: selected.members.map(member => member.modelSelection),
			run: selected.run, prepared: runtime.prepared, sends: runtime.submitted,
		}, { selected: [{ id: 'model-a', config: { thinking: 'high' } }, { id: 'auto' }], applied: [undefined, undefined], run: undefined, prepared: [], sends: [] });
		await rooms.startRoom(room.id, { maxTurns: 5 });
		await runtime.whenSubmitted(2);
		assert.deepStrictEqual((await rooms.getRoom(room.id)).members.map(member => member.modelSelection), [{ id: 'model-a', config: { thinking: 'high' } }, { id: 'auto' }]);
	});

	test('busy model changes wait for addressed input, and failed SDK changes retain acknowledged and pending selections', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		const member = room.members[0];
		await rooms.setMemberModel(room.id, member.id, { id: 'model-a' });
		await rooms.startRoom(room.id, { maxTurns: 5 });
		await runtime.whenSubmitted(1);
		await rooms.setMemberModel(room.id, member.id, { id: 'model-b' });
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		assert.deepStrictEqual({ applied: (await rooms.getRoom(room.id)).members[0].modelSelection, sends: runtime.submitted.length }, { applied: { id: 'model-a' }, sends: 1 });
		await rooms.postMessage(room.id, { id: 'next-model', text: 'Use the next chosen model', mentions: [member.id] });
		await runtime.whenSubmitted(2);
		runtime.finish(member.sessionUri);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		runtime.modelError = new Error('SDK rejected selection');
		await assert.rejects(rooms.setMemberModel(room.id, member.id, { id: 'model-a' }), /SDK rejected/);
		const failed = (await rooms.getRoom(room.id)).members[0];
		assert.deepStrictEqual({ applied: failed.modelSelection, pending: failed.pendingModel, error: failed.modelError, sends: runtime.submitted.length }, {
			applied: { id: 'model-b' }, pending: { id: 'model-a' }, error: 'Error: SDK rejected selection', sends: 2,
		});
	});

	test('newer model selection during SDK acknowledgement wins; Stop never waits on that acknowledgement', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		await rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-a' });
		const entered = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		runtime.beforeModelApply = async () => { await entered.complete(); await release.p; };
		await rooms.startRoom(room.id, { maxTurns: 5 });
		await entered.p;
		const selecting = rooms.setMemberModel(room.id, room.members[0].id, { id: 'model-b' });
		await rooms.stopRoom(room.id);
		await release.complete();
		await selecting;
		assert.deepStrictEqual({ sends: runtime.submitted.length, selected: getRoomMemberModel((await rooms.getRoom(room.id)).members[0]), state: (await rooms.getRoom(room.id)).state }, {
			sends: 0, selected: { id: 'model-b' }, state: 'stopped',
		});
	});

	test('a model selection arriving during SDK acknowledgement is applied before the reserved input submits', async () => {
		const { rooms, runtime, create } = setup(1);
		const room = await create();
		const member = room.members[0];
		await rooms.setMemberModel(room.id, member.id, { id: 'model-a' });
		const entered = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		runtime.beforeModelApply = async () => { await entered.complete(); await release.p; };
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await entered.p;
		const selected = rooms.setMemberModel(room.id, member.id, { id: 'model-b' });
		runtime.beforeModelApply = undefined;
		runtime.beforeSubmit = () => assert.deepStrictEqual(runtime.appliedModels.get(member.sessionUri), { id: 'model-b' });
		await release.complete();
		await selected;
		await runtime.whenSubmitted(1);
		assert.deepStrictEqual({ changes: runtime.modelChanges, admitted: (await rooms.getRoom(room.id)).run?.admittedTurns }, {
			changes: [{ id: 'model-a' }, { id: 'model-b' }], admitted: 1,
		});
	});

	test('configuration selection is durable, restricted by every peer, and never starts an unstarted member', async () => {
		const { rooms, runtime, storage, create } = setup();
		const room = await create();
		const selected: IAgentHostRoomConfiguration = { mode: 'plan', autoApprove: 'assisted', sandboxEnabled: 'on' };
		await rooms.setRoomConfiguration(room.id, selected);
		assert.deepStrictEqual({ saved: storage.records.get(room.id)!.room.members.map(member => member.configuration), prepared: runtime.prepared }, { saved: [selected, selected], prepared: [] });
		runtime.resolveConfiguration = async (member, configuration) => {
			const schema = platformSessionSchema.toProtocol();
			if (member.id === room.members[1].id) {
				schema.properties.mode = { ...schema.properties.mode, readOnly: true };
			}
			return { schema, values: { ...(configuration ?? selected) } };
		};
		await assert.rejects(rooms.setRoomConfiguration(room.id, { mode: 'interactive' }), /does not allow/);
		assert.deepStrictEqual((await rooms.getRoom(room.id)).members.map(member => member.configuration), [selected, selected]);
	});

	test('real IPC preserves model slots and explicit inbox data and rejects private or removed APIs', async () => {
		const { rooms, runtime } = setup();
		const server = createAgentHostRoomsChannel(rooms, disposables.add(new DisposableStore()));
		const roundTrip = <T>(value: T): T => {
			const writer = new BufferWriter();
			try {
				serialize(writer, value);
				return deserialize(new BufferReader(writer.buffer));
			} finally {
				writer.dispose();
			}
		};
		const client = createAgentHostRoomsClient({
			call: async <T>(command: string, args?: unknown): Promise<T> => roundTrip(await server.call<T>('room-test-client', command, roundTrip(args))),
			listen: (event, args) => server.listen('room-test-client', event, args),
		});
		const room = await client.createRoom({
			title: 'IPC', goal: 'Preserve protocol data', repositoryUri: 'file:///repository', workerCount: 3,
			memberModels: [{ id: 'model-a', config: { thinking: 'high' } }, undefined, { id: 'auto' }],
		});
		const run = (await client.startRoom(room.id, { maxTurns: 5 })).run!;
		await runtime.whenSubmitted(3);
		const posted = await client.postMessage(room.id, { id: 'via-ipc', text: 'Only the third peer', mentions: [room.members[2].id] });
		for (const command of ['beforeTool', 'post', 'setMemberConfiguration', 'isAdmittedTurn', 'ensureCoordinator', 'getCoordinatorSnapshot', 'verifyResult', 'yieldTurn']) {
			await assert.rejects(server.call('room-test-client', command, []), /Unknown room method/);
		}
		await client.extendRun(room.id, 2);
		assert.deepStrictEqual({
			models: room.members.map(getRoomMemberModel), posted: posted.mentions,
			run: (await client.getRoom(room.id)).run,
			capabilities: await client.getCapabilities(),
		}, {
			models: [{ id: 'model-a', config: { thinking: 'high' } }, undefined, { id: 'auto' }], posted: [room.members[2].id],
			run: { ...run, limits: { maxTurns: 7 }, admittedTurns: 3 },
			capabilities: { version: 2, available: true, maxWorkers: 10, supportsInbox: true, supportsConfiguration: true, supportsMemberModels: true },
		});
	});

	test('an older host cannot receive an inbox mutation through the v2 client', async () => {
		const calls: string[] = [];
		const legacy = upcastPartial<IAgentHostRoomsService>({
			getCapabilities: async () => ({ version: 1, available: true, maxWorkers: 10 }),
			postMessage: async () => { calls.push('postMessage'); throw new Error('Must not call'); },
		});
		const server = createAgentHostRoomsChannel(legacy, disposables.add(new DisposableStore()));
		const client = createAgentHostRoomsClient({ call: (command, args) => server.call('room-test-client', command, args), listen: () => Event.None });
		await assert.rejects(client.postMessage('old-room', { id: 'no', text: 'Must not execute', mentions: [] }), /does not support executable inbox rooms/);
		assert.deepStrictEqual(calls, []);
	});

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
		provider.setModels(models);
		const selected = new Map<string, ModelSelection>();
		const createChat = provider.chats.createChat;
		provider.chats.createChat = async (chat, context, options) => {
			const result = await createChat(chat, context, options);
			if (options?.model) {
				selected.set(chat.toString(), options.model);
			}
			return result;
		};
		const changeModel = provider.chats.changeModel;
		provider.chats.changeModel = async (chat, model, context) => { await changeModel(chat, model, context); selected.set(chat.toString(), model); };
		provider.chats.getModel = chat => selected.get(chat.toString());
		provider.resolveChatConfig = async params => ({ schema: platformSessionSchema.toProtocol(), values: params.config ?? {} });
		provider.chats.applyConfiguration = async () => { };
		registerTestAgentProvider(service, provider);
		const rooms = getTestAgentHostRoomsController(service);
		const state = getTestAgentStateManager(service);
		const whenSent = async (count: number) => {
			if (provider.sendMessageCalls.length < count) {
				await Event.toPromise(Event.filter(provider.onDidSendMessage, () => provider.sendMessageCalls.length >= count));
			}
		};
		const finish = (member: IAgentHostRoomMember) => provider.fireProgress({
			kind: 'action', resource: URI.parse(member.chatUri!),
			action: { type: ActionType.ChatTurnComplete, turnId: state.getActiveTurnId(member.chatUri!)!, duration: 1 },
		});
		return { rooms, service, provider, state, storage, whenSent, finish, configuration: getTestAgentServiceComposition(service).configurationService };
	}

	test('real runtime and contribution graph deliver peer bodies and reject unreserved native input', async () => {
		const { rooms, service, provider, state, whenSent, finish } = setupProduction();
		const room = await rooms.createRoom({ title: 'Native inbox', goal: 'Use normal admission', repositoryUri: 'file:///repository', workerCount: 2, model: 'model-a' });
		await rooms.startRoom(room.id, { maxTurns: 8 });
		await whenSent(2);
		const [a, b] = room.members;
		finish(b);
		await whenRoom(rooms, room.id, room => room.members[1].state === 'idle');
		const question = await rooms.post(AgentSession.id(URI.parse(a.sessionUri)), { id: 'native-a-b', text: 'Actual peer text through AgentHostRoomsRuntime', mentions: [b.id] });
		await whenSent(3);
		const answer = await rooms.post(AgentSession.id(URI.parse(b.sessionUri)), { id: 'native-b-a', text: 'Native response includes the evidence', mentions: [a.id] });
		finish(a);
		await whenSent(4);
		finish(a);
		finish(b);
		await whenRoom(rooms, room.id, room => room.state === 'idle');
		service.dispatchAction(a.chatUri!, { type: ActionType.ChatTurnStarted, turnId: 'forged', startedAt: new Date(0).toISOString(), message: { text: 'Bypass room budget', origin: { kind: MessageKind.User } } }, 'untrusted-client', 1);
		assert.deepStrictEqual({
			exchange: provider.sendMessageCalls.slice(2).map(call => inboxText(call.prompt)),
			models: (await rooms.getRoom(room.id)).members.map(member => member.modelSelection),
			sends: provider.sendMessageCalls.length, bypassActive: state.getActiveTurnId(a.chatUri!) === 'forged',
		}, { exchange: [messageInput(question), messageInput(answer)], models: [{ id: 'model-a' }, { id: 'model-a' }], sends: 4, bypassActive: false });
	});

	test('native model picker persists only the bound member and managed room permissions stay restricted', async () => {
		const { rooms, service, configuration, whenSent } = setupProduction();
		const room = await rooms.createRoom({ title: 'Native settings', goal: 'Keep policy', repositoryUri: 'file:///repository', workerCount: 2, model: 'model-a' });
		await rooms.startRoom(room.id, { maxTurns: 8 });
		await whenSent(2);
		const member = room.members[1];
		service.dispatchAction(member.chatUri!, { type: ActionType.ChatDraftChanged, draft: { text: 'Keep this draft', origin: { kind: MessageKind.User }, model: { id: 'model-b' } } }, 'picker-client', 1);
		await whenRoom(rooms, room.id, room => room.members[1].pendingModel?.id === 'model-b');
		await assert.rejects(rooms.setMemberModelForChat(member.sessionUri, buildChatUri(member.sessionUri, 'other'), { id: 'model-a' }), /preserved default chat/);
		configuration.updateRootConfig({ [AgentHostAutoApprovePolicyRestrictedConfigKey]: true });
		await assert.rejects(rooms.setRoomConfiguration(room.id, { autoApprove: 'autoApprove' }), /does not allow/);
		assert.deepStrictEqual({
			selected: (await rooms.getRoom(room.id)).members.map(getRoomMemberModel),
			approvals: (await rooms.getRoom(room.id)).members.map(member => member.configuration?.autoApprove),
		}, { selected: [{ id: 'model-a' }, { id: 'model-b' }], approvals: [newAgentHostRoomConfiguration.autoApprove, newAgentHostRoomConfiguration.autoApprove] });
		await rooms.stopRoom(room.id);
	});

	test('real runtime keeps failed provider cancellation unconfirmed even after AHP clears its active turn', async () => {
		const { rooms, provider, state, whenSent } = setupProduction();
		const room = await rooms.createRoom({ title: 'Abort failure', goal: 'Do not confuse UI cancellation with provider cancellation', repositoryUri: 'file:///repository', workerCount: 1 });
		await rooms.startRoom(room.id, { maxTurns: 3 });
		await whenSent(1);
		const abort = provider.chats.abort;
		provider.chats.abort = async () => { throw new Error('Provider abort failed'); };
		const interrupted = await rooms.stopRoom(room.id);
		await assert.rejects(rooms.startRoom(room.id, {}), /may still be running/);
		assert.deepStrictEqual({
			active: state.getActiveTurnId(room.members[0].chatUri!), room: interrupted.state, member: interrupted.members[0].state,
			error: interrupted.error?.includes('Provider abort failed'), sends: provider.sendMessageCalls.length,
		}, { active: undefined, room: 'interrupted', member: 'interrupted', error: true, sends: 1 });
		provider.chats.abort = abort;
		await rooms.stopRoom(room.id);
	});
});
