/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isUUID } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomMember } from '../../common/agentHostRooms.js';
import { platformSessionSchema } from '../../common/agentHostSchema.js';
import { buildDefaultChatUri } from '../../common/state/sessionState.js';
import { AgentSession } from '../../common/agentService.js';
import { AgentHostRooms } from '../../node/agentHostRooms.js';
import { AgentHostRoomsStorage } from '../../node/agentHostRoomsStorage.js';
import { IRoomRecord, IRoomRuntime, IRoomRuntimeEvent } from '../../node/agentHostRoomsTypes.js';

suite('AgentHostRoomsStorage', function () {
	this.timeout(60_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let scratch: string;
	let root: string;
	let repository: string;
	let storage: AgentHostRoomsStorage;

	setup(async () => {
		// Keep every fixture, private index and Git temporary file in the checkout.
		scratch = await fs.realpath(await fs.mkdtemp(join(process.cwd(), '.agent-host-rooms-storage-test-')));
		root = join(scratch, 'storage');
		repository = join(scratch, 'repository');
		storage = new AgentHostRoomsStorage(URI.file(root), new NullLogService());
	});

	teardown(async () => {
		await fs.rm(scratch, { recursive: true, force: true });
	});

	function record(id = 'room-one', baseRevision = 'a'.repeat(40)): IRoomRecord {
		return {
			version: 1,
			room: {
				id, revision: 1, title: 'Room', goal: 'Goal', instructions: '',
				repositoryUri: URI.file(repository).toString(), baseRevision,
				createdAt: 1, updatedAt: 2, state: 'running',
				members: [{
					id: 'member-one', name: 'Worker', sessionUri: 'copilotcli:/member-one',
					model: 'test-model', state: 'working', turns: 1,
					worktreeUri: storage.worktreeUri(id, 'member-one'), activity: 'Working',
					work: { description: 'Inspecting', nextStep: 'Report', blocked: false, updatedAt: 2 },
				}],
				artifacts: [],
				latestMessageSequence: 2,
				run: { id: 'run-one', startedAt: 1, deadline: 60_001, limits: { maxTurns: 10, timeoutMinutes: 1 }, admittedTurns: 1 },
			},
			messages: [{
				id: 'message-one', sequence: 1, authorId: 'human', authorName: 'Human', authorKind: 'human',
				kind: 'message', text: 'Please inspect', timestamp: 1, mentions: ['member-one'],
				deliveries: [{ memberId: 'member-one', state: 'completed', turnId: 'turn-one' }],
			}, {
				id: 'message-two', sequence: 2, authorId: 'member-one', authorName: 'Worker', authorKind: 'agent',
				kind: 'finding', text: 'Inspecting', timestamp: 2, mentions: [], replyTo: 'message-one', deliveries: [],
			}],
			executions: [{ memberId: 'member-one', initialized: true, needsTurn: false, turnId: 'turn-two', runId: 'run-one', readSequence: 2, announced: true }],
		};
	}

	function artifact(): IAgentHostRoomArtifact {
		const id = '00000000-0000-4000-8000-000000000001';
		return {
			id, memberId: 'member-one', title: 'Patch', createdAt: 3,
			baseRevision: 'a'.repeat(40), sourceRevision: 'b'.repeat(40),
			uri: URI.file(join(root, 'artifacts', 'room-one', `${id}.patch`)).toString(),
		};
	}

	async function git(cwd: string, args: readonly string[]): Promise<string> {
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.toUpperCase().startsWith('GIT_')) {
				env[key] = value;
			}
		}
		Object.assign(env, {
			GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'no-global-config'),
			GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
			GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
			TMPDIR: scratch, TMP: scratch, TEMP: scratch,
		});
		return new Promise((resolve, reject) => {
			execFile('git', [
				'-c', 'user.name=Room Tests', '-c', 'user.email=rooms@example.invalid',
				'-c', 'core.autocrlf=false',
				'-c', `core.hooksPath=${join(scratch, 'no-hooks')}`, ...args,
			], { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) {
					reject(new Error(`${error.message}\n${stderr}`));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	async function initializeRepository(): Promise<IRoomRecord> {
		await fs.mkdir(repository);
		await git(repository, ['init', '--initial-branch=main']);
		await git(repository, ['config', 'core.autocrlf', 'false']);
		await git(repository, ['config', 'core.hooksPath', join(scratch, 'no-hooks')]);
		await git(repository, ['config', 'core.excludesFile', join(scratch, 'no-excludes')]);
		await fs.writeFile(join(repository, 'committed.txt'), 'base\n');
		await fs.writeFile(join(repository, 'staged.txt'), 'base\n');
		await fs.writeFile(join(repository, 'unstaged.txt'), 'base\n');
		await fs.writeFile(join(repository, 'both.txt'), 'base\n');
		await fs.writeFile(join(repository, 'deleted.txt'), 'base\n');
		await fs.writeFile(join(repository, 'staged-deleted.txt'), 'base\n');
		await fs.writeFile(join(repository, 'binary.dat'), Buffer.from([0, 1, 2, 3, 255]));
		await fs.writeFile(join(repository, 'staged-binary.dat'), Buffer.from([0, 1, 2, 3, 255]));
		await fs.writeFile(join(repository, '.gitignore'), '*.ignored\n');
		await git(repository, ['add', '--all']);
		await git(repository, ['commit', '-m', 'Base']);
		const base = (await git(repository, ['rev-parse', 'HEAD'])).trim();
		return record('room-one', base);
	}

	async function writeRecord(value: unknown, name = 'room-one'): Promise<string> {
		await fs.mkdir(join(root, 'rooms'), { recursive: true });
		const path = join(root, 'rooms', `${name}.json`);
		await fs.writeFile(path, JSON.stringify(value));
		return path;
	}

	test('old journals retain session and worktree identity when the default chat is recorded', async () => {
		const original = record();
		await storage.save(original);
		const upgraded: IRoomRecord = {
			...original,
			room: {
				...original.room, revision: 2,
				members: original.room.members.map(member => ({ ...member, chatUri: buildDefaultChatUri(member.sessionUri) })),
			},
		};
		await storage.save(upgraded);
		assert.deepStrictEqual((await storage.load())[0].room.members, upgraded.room.members);
		await assert.rejects(storage.save({
			...upgraded,
			room: { ...upgraded.room, revision: 3, members: upgraded.room.members.map(member => ({ ...member, chatUri: buildDefaultChatUri('copilotcli:/other') })) },
		}), /default chat/);
		await assert.rejects(storage.save({
			...upgraded,
			room: {
				...upgraded.room, revision: 3,
				members: upgraded.room.members.map(member => ({ ...member, sessionUri: 'copilotcli:/other', chatUri: buildDefaultChatUri('copilotcli:/other') })),
			},
		}), /preserved member identities/);
	});

	test('member configuration roundtrips and upgrades legacy journals without changing identities', async () => {
		const original = record();
		await storage.save(original);
		const configuration: IAgentHostRoomConfiguration = { mode: 'interactive', autoApprove: 'autoApprove', sandboxEnabled: 'off' };
		const updated: IRoomRecord = {
			...original,
			room: { ...original.room, revision: original.room.revision + 1, members: original.room.members.map(member => ({ ...member, configuration })) },
		};
		await storage.save(updated);
		const restored = new AgentHostRoomsStorage(URI.file(root), new NullLogService());
		assert.deepStrictEqual(await restored.load(), [updated]);
	});

	test('content exclusion denial preserves the worktree and real index without publishing a patch', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		const worktree = URI.parse(member.worktreeUri!).fsPath;
		await fs.writeFile(join(worktree, 'blocked.txt'), 'excluded content\n');
		const index = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
		const before = await fs.readFile(index);
		const checked: string[][] = [];
		await assert.rejects(storage.publishPatch(room, member, 'Blocked patch', async paths => {
			checked.push([...paths]);
			throw new Error('Content excluded');
		}), /Content excluded/);
		assert.deepStrictEqual({
			checked,
			index: await fs.readFile(index),
			content: await fs.readFile(join(worktree, 'blocked.txt'), 'utf8'),
		}, { checked: [['blocked.txt']], index: before, content: 'excluded content\n' });
	});

	test('a missing preserved worktree is not silently recreated on recovery', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		const worktree = URI.parse(member.worktreeUri!).fsPath;
		await fs.writeFile(join(worktree, 'unfinished.txt'), 'unfinished work\n');
		const moved = join(scratch, 'preserved-worktree');
		await fs.rename(worktree, moved);
		await assert.rejects(storage.ensureWorktree(room, member, true), /preserved worktree is missing/);
		assert.deepStrictEqual({
			content: await fs.readFile(join(moved, 'unfinished.txt'), 'utf8'),
			recreated: await fs.stat(worktree).then(() => true, () => false),
		}, { content: 'unfinished work\n', recreated: false });
	});

	test('artifact readers check every published path before receiving text', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		await fs.writeFile(join(URI.parse(member.worktreeUri!).fsPath, 'staged.txt'), 'published change\n');
		const artifact = await storage.publishPatch(room, member, 'Patch');
		const publishedRoom = { ...room, artifacts: [artifact] };
		const checked: string[][] = [];
		await assert.rejects(storage.readArtifact(publishedRoom, artifact, async paths => {
			checked.push([...paths]);
			throw new Error('Reader policy denied');
		}), /Reader policy denied/);
		assert.deepStrictEqual(checked, [['staged.txt']]);
	});

	test('controller prepares real worktrees using the admitted member snapshots', async () => {
		await initializeRepository();
		const submitted = new DeferredPromise<void>();
		const resumed = new DeferredPromise<void>();
		const prepared: IAgentHostRoomMember[] = [];
		let sends = 0;
		const runtime = new class extends Disposable implements IRoomRuntime {
			private readonly changed = this._register(new Emitter<IRoomRuntimeEvent>());
			readonly onDidChange = this.changed.event;
			private readonly turns = new Map<string, string>();

			validateModel(): void { }
			getModel(): undefined { return undefined; }
			publishModel(): void { }
			async applyModel(): Promise<void> { }

			async resolveConfiguration(member: IAgentHostRoomMember, configuration?: IAgentHostRoomConfiguration) {
				return { schema: platformSessionSchema.toProtocol(), values: { ...(configuration ?? member.configuration ?? defaultAgentHostRoomConfiguration) } };
			}

			async applyConfiguration(): Promise<void> { }

			async prepare(room: IAgentHostRoom, member: IAgentHostRoomMember): Promise<void> {
				assert.deepStrictEqual(member, room.members.find(candidate => candidate.id === member.id));
				prepared.push(member);
			}

			isIdle(sessionUri: string): boolean { return !this.turns.has(sessionUri); }
			async steer(): Promise<boolean> { throw new Error('Steering is not used by this worktree test'); }

			submit(sessionUri: string, turnId: string): void {
				this.turns.set(sessionUri, turnId);
				this.changed.fire({ sessionUri, turnId, state: 'working' });
				sends++;
				if (sends === 2) {
					void submitted.complete();
				}
				if (sends === 4) {
					void resumed.complete();
				}
			}

			async abort(sessionUri: string): Promise<void> {
				const turnId = this.turns.get(sessionUri);
				this.turns.delete(sessionUri);
				this.changed.fire({ sessionUri, turnId, state: 'stopped' });
			}
		};
		const rooms = disposables.add(new AgentHostRooms(storage, runtime, new NullLogService()));
		const room = await rooms.createRoom({
			title: 'Real worktree admission', goal: 'Inspect the baseline', repositoryUri: URI.file(repository).toString(), workerCount: 2,
		});
		disposables.add(rooms.onDidChangeRoom(snapshot => {
			const failed = snapshot.members.find(member => member.state === 'failed');
			if (failed && !submitted.isSettled) {
				void submitted.error(new Error(failed.error));
			}
		}));
		await rooms.startRoom(room.id, { maxTurns: 2, timeoutMinutes: 1 });
		await submitted.p;
		assert.deepStrictEqual(prepared.map(member => ({ state: member.state, turns: member.turns })), [
			{ state: 'starting', turns: 1 },
			{ state: 'starting', turns: 1 },
		]);
		for (const member of prepared) {
			const cwd = URI.parse(member.worktreeUri!).fsPath;
			assert.strictEqual((await git(cwd, ['rev-parse', 'HEAD'])).trim(), room.baseRevision);
		}
		await rooms.postMessage(room.id, {
			id: 'ordinary-followup', text: 'Check the existing work', mentions: room.members.map(member => member.id),
		});
		for (const member of room.members) {
			await rooms.read(AgentSession.id(member.sessionUri));
		}
		assert.deepStrictEqual({
			deliveries: (await rooms.getMessages(room.id)).messages[0].deliveries.map(delivery => delivery.state),
			available: (await rooms.getCapabilities()).available,
		}, { deliveries: ['submitted', 'submitted'], available: true });
		await rooms.postMessage(room.id, { id: 'still-open', text: 'The room remains usable', mentions: [] });
		await rooms.stopRoom(room.id);
		await rooms.startRoom(room.id, {});
		await resumed.p;
		assert.deepStrictEqual({
			turns: sends,
			sessions: (await rooms.getRoom(room.id)).members.map(member => member.sessionUri),
			available: (await rooms.getCapabilities()).available,
		}, { turns: 4, sessions: room.members.map(member => member.sessionUri), available: true });
		await rooms.stopRoom(room.id);
	});

	test('empty storage does not create directories', async () => {
		assert.deepStrictEqual(await storage.load(), []);
		await assert.rejects(fs.stat(root), { code: 'ENOENT' });
	});

	test('roundtrips complete nested records as immutable snapshots', async () => {
		const snapshot = record();
		await storage.save(snapshot);
		const loaded = await new AgentHostRoomsStorage(URI.file(root), new NullLogService()).load();
		assert.deepStrictEqual({
			records: loaded,
			frozen: [loaded, loaded[0], loaded[0].room, loaded[0].room.members[0].work, loaded[0].messages[0].deliveries, loaded[0].executions[0]].every(Object.isFrozen),
			files: await fs.readdir(join(root, 'rooms')),
		}, { records: [snapshot], frozen: true, files: ['room-one.json'] });
	});

	test('roundtrips an uncapped run without inventing limits or a deadline', async () => {
		const snapshot = record();
		const uncapped: IRoomRecord = {
			...snapshot,
			room: { ...snapshot.room, run: { id: 'run-one', startedAt: 1, admittedTurns: 15, limits: {} } },
		};
		await storage.save(uncapped);
		assert.deepStrictEqual(await storage.load(), [uncapped]);
	});

	test('persists live human steering delivery while accepting legacy discussion records', async () => {
		const original = record();
		const steering: IRoomRecord = {
			...original,
			messages: [{
				...original.messages[0],
				mode: 'steer',
				deliveries: [{ memberId: 'member-one', state: 'delivered', turnId: 'turn-two' }],
			}, original.messages[1]],
		};
		await storage.save(steering);
		assert.deepStrictEqual(await storage.load(), [steering]);
	});

	test('persists model preferences independently of preserved member identities and configuration', async () => {
		const original = record();
		await storage.save(original);
		const configuration: IAgentHostRoomConfiguration = { mode: 'plan', autoApprove: 'assisted', sandboxEnabled: 'on' };
		const selected = { id: 'another-model', config: { thinkingLevel: 'high', contextSize: 1_000_000, adaptive: false } };
		const pending: IRoomRecord = {
			...original,
			room: {
				...original.room, revision: 2,
				members: [{ ...original.room.members[0], model: selected.id, modelSelection: { id: 'test-model' }, pendingModel: selected, configuration, modelError: 'SDK rejected the requested model' }],
			},
		};
		await storage.save(pending);
		const loadedPending = await storage.load();
		const applied: IRoomRecord = {
			...original,
			room: { ...original.room, revision: 3, members: [{ ...original.room.members[0], model: selected.id, modelSelection: selected, configuration }] },
		};
		await storage.save(applied);
		const loadedApplied = await storage.load();
		const reset: IRoomRecord = {
			...applied,
			room: { ...applied.room, revision: 4, members: [{ ...applied.room.members[0], model: 'auto', pendingModel: null }] },
		};
		await storage.save(reset);
		assert.deepStrictEqual({ pending: loadedPending, applied: loadedApplied, reset: await storage.load() }, { pending: [pending], applied: [applied], reset: [reset] });
	});

	test('model updates cannot change member names or session identities', async () => {
		const original = record();
		await storage.save(original);
		for (const identity of [{ name: 'Other worker' }, { sessionUri: 'copilotcli:/different-session' }]) {
			const member = { ...original.room.members[0], ...identity, model: 'other-model', pendingModel: { id: 'other-model' } };
			await assert.rejects(storage.save({
				...original, room: { ...original.room, revision: 2, members: [member] },
				messages: original.messages.map(message => message.authorKind === 'agent' && message.authorId === member.id ? { ...message, authorName: member.name } : message),
			}), /preserved member identities changed/);
		}
		assert.deepStrictEqual(await storage.load(), [original]);
	});

	test('a removed member round-trips through the journal', async () => {
		const original = record();
		await storage.save(original);
		const retired = { ...original.room.members[0], removed: true };

		await storage.save({ ...original, room: { ...original.room, revision: 2, members: [retired] } });

		assert.deepStrictEqual((await storage.load())[0].room.members.map(member => member.removed), [true]);
	});

	test('a room may gain a member, but not lose, reorder, or rewrite one', async () => {
		const original = record();
		await storage.save(original);
		const first = original.room.members[0];
		const joined = {
			...first, id: 'joined-member', name: 'Copilot-2',
			sessionUri: 'copilotcli:/joined-session', chatUri: buildDefaultChatUri('copilotcli:/joined-session'),
			worktreeUri: storage.worktreeUri(original.room.id, 'joined-member'),
		};

		const grown = {
			...original,
			room: { ...original.room, revision: 2, members: [first, joined] },
			executions: [...original.executions, { memberId: joined.id, initialized: false, needsTurn: true }],
		};
		await storage.save(grown);
		assert.deepStrictEqual((await storage.load())[0].room.members.map(member => member.id), [first.id, joined.id]);

		// Appending is the only permitted shape change.
		await assert.rejects(storage.save({
			...grown, room: { ...grown.room, revision: 3, members: [joined, first] },
		}), /preserved member identities changed/);
		await assert.rejects(storage.save({
			...grown, room: { ...grown.room, revision: 3, members: [first] },
			executions: original.executions,
		}), /preserved member identities changed/);
	});

	test('loads legacy selections and unavailable catalog entries without treating them as journal corruption', async () => {
		const original = record();
		await storage.save(original);
		const legacy = await storage.load();
		const retired: IRoomRecord = {
			...original,
			room: { ...original.room, revision: 2, members: [{ ...original.room.members[0], model: 'retired-model', pendingModel: { id: 'retired-model', config: { formerOption: 'old-value' } } }] },
		};
		await storage.save(retired);
		assert.deepStrictEqual({ legacy, retired: await storage.load() }, { legacy: [original], retired: [retired] });
	});

	test('rejects non-finite model configuration before JSON can silently convert it to null', async () => {
		const original = record();
		await storage.save(original);
		for (const contextSize of [NaN, Infinity, -Infinity]) {
			await assert.rejects(storage.save({
				...original,
				room: { ...original.room, revision: 2, members: [{ ...original.room.members[0], pendingModel: { id: 'test-model', config: { contextSize } } }] },
			}), /Invalid room model configuration/);
		}
		assert.deepStrictEqual(await storage.load(), [original]);
	});

	test('accepts a created room with ten workers and no optional runtime fields', async () => {
		const initial = record();
		const members = Array.from({ length: 10 }, (_, index) => ({
			id: `member-${index}`, name: `Worker ${index}`, sessionUri: `copilotcli:/member-${index}`,
			state: 'pending' as const, turns: 0,
		}));
		const snapshot: IRoomRecord = {
			version: 1,
			room: {
				id: initial.room.id, revision: 0, title: 'New room', goal: 'Goal', instructions: '',
				repositoryUri: initial.room.repositoryUri, baseRevision: initial.room.baseRevision,
				createdAt: 0, updatedAt: 0, state: 'created', members, artifacts: [], latestMessageSequence: 0,
			},
			messages: [],
			executions: members.map(member => ({ memberId: member.id, initialized: false, needsTurn: true })),
		};
		await storage.save(snapshot);
		assert.deepStrictEqual(await storage.load(), [snapshot]);
	});

	test('serializes concurrent saves and captures input before queuing', async () => {
		const snapshot = record();
		const first = { ...snapshot, room: { ...snapshot.room, title: 'Captured' } };
		const pending = storage.save(first);
		first.room.title = 'Later mutation';
		await pending;
		assert.strictEqual((await storage.load())[0].room.title, 'Captured');
		await Promise.all(Array.from({ length: 8 }, (_, index) => storage.save({ ...snapshot, room: { ...snapshot.room, revision: index + 2 } })));
		assert.deepStrictEqual({
			revision: (await storage.load())[0].room.revision,
			files: await fs.readdir(join(root, 'rooms')),
		}, { revision: 9, files: ['room-one.json'] });
	});

	test('rejects stale snapshots and recovers the save queue after a failure', async () => {
		const snapshot = record();
		const newer = { ...snapshot, room: { ...snapshot.room, revision: 2 } };
		await storage.save(newer);
		await assert.rejects(storage.save(snapshot), /revision regressed/);
		await storage.save({ ...newer, room: { ...newer.room, revision: 3 } });
		assert.strictEqual((await storage.load())[0].room.revision, 3);
	});

	test('rejects duplicate provider sessions across rooms on save and load', async () => {
		const first = record();
		const second = record('room-two');
		await storage.save(first);
		await assert.rejects(storage.save(second), /sessionUri is duplicated/);
		await writeRecord(second, 'room-two');
		await assert.rejects(storage.load(), /sessionUri is duplicated/);
	});

	test('rejects URI-encoded aliases of the same provider session', async () => {
		const first = record();
		const second = record('room-two');
		await storage.save(first);
		const aliased: IRoomRecord = {
			...second,
			room: { ...second.room, members: [{ ...second.room.members[0], sessionUri: 'copilotcli:/member%2Done' }] },
		};
		await assert.rejects(storage.save(aliased), /sessionUri is duplicated/);
		assert.deepStrictEqual(await storage.load(), [first]);
	});

	test('leaves the persisted snapshot intact when a proposed update is invalid', async () => {
		const snapshot = record();
		await storage.save(snapshot);
		await assert.rejects(storage.save({
			...snapshot,
			room: { ...snapshot.room, revision: 2, latestMessageSequence: 3 },
		}), /latestMessageSequence/);
		assert.deepStrictEqual({
			records: await storage.load(),
			files: await fs.readdir(join(root, 'rooms')),
		}, { records: [snapshot], files: ['room-one.json'] });
	});

	test('ignores an interrupted atomic-write scratch file without replacing the room record', async () => {
		const snapshot = record();
		await storage.save(snapshot);
		const interrupted = join(root, 'rooms', '.interrupted.tmp');
		await fs.writeFile(interrupted, '{ partial');
		assert.deepStrictEqual(await storage.load(), [snapshot]);
		const updated = { ...snapshot, room: { ...snapshot.room, revision: 2 } };
		await storage.save(updated);
		assert.deepStrictEqual({
			records: await storage.load(),
			interrupted: await fs.readFile(interrupted, 'utf8'),
			files: (await fs.readdir(join(root, 'rooms'))).sort(),
		}, { records: [updated], interrupted: '{ partial', files: ['.interrupted.tmp', 'room-one.json'] });
	});

	test('rejects malformed JSON without replacing it', async () => {
		const path = await writeRecord(record());
		await fs.writeFile(path, '{ broken');
		await assert.rejects(storage.load(), SyntaxError);
		await assert.rejects(storage.save(record()), SyntaxError);
		assert.strictEqual(await fs.readFile(path, 'utf8'), '{ broken');
	});

	test('rejects mismatched record filenames without replacing them', async () => {
		await writeRecord(record(), 'different-room');
		await assert.rejects(storage.save(record()), /filename/);
		assert.deepStrictEqual(await fs.readdir(join(root, 'rooms')), ['different-room.json']);
	});

	test('rejects changes to immutable published artifact metadata', async () => {
		const snapshot = record();
		const published = { ...snapshot, room: { ...snapshot.room, artifacts: [artifact()] } };
		await storage.save(published);
		await assert.rejects(storage.save({ ...published, room: { ...published.room, artifacts: [{ ...artifact(), title: 'Rewritten' }] } }), /artifact changed/);
		await assert.rejects(storage.save(snapshot), /artifact changed/);
		assert.deepStrictEqual(await storage.load(), [published]);
	});

	type Corruption = (snapshot: IRoomRecord) => unknown;
	const changeRoom = (fields: Record<string, unknown>): Corruption => snapshot => ({ ...snapshot, room: { ...snapshot.room, ...fields } });
	const changeMember = (fields: Record<string, unknown>): Corruption => snapshot => ({ ...snapshot, room: { ...snapshot.room, members: [{ ...snapshot.room.members[0], ...fields }] } });
	const changeMessage = (fields: Record<string, unknown>): Corruption => snapshot => ({ ...snapshot, messages: [{ ...snapshot.messages[0], ...fields }, snapshot.messages[1]] });
	const changeDelivery = (fields: Record<string, unknown>): Corruption => changeMessage({ deliveries: [{ memberId: 'member-one', state: 'pending', ...fields }] });
	const changeExecution = (fields: Record<string, unknown>): Corruption => snapshot => ({ ...snapshot, executions: [{ ...snapshot.executions[0], ...fields }] });
	const changeRun = (fields: Record<string, unknown>): Corruption => snapshot => ({ ...snapshot, room: { ...snapshot.room, run: { ...snapshot.room.run, ...fields } } });
	const changeArtifact = (fields: Record<string, unknown>): Corruption => snapshot => ({ ...snapshot, room: { ...snapshot.room, artifacts: [{ ...artifact(), ...fields }] } });

	const corruptions: readonly [string, Corruption][] = [
		['unknown version', snapshot => ({ ...snapshot, version: 2 })],
		['missing version', snapshot => ({ ...snapshot, version: undefined })],
		['unknown record fields', snapshot => ({ ...snapshot, unexpected: true })],
		['non-object room', snapshot => ({ ...snapshot, room: null })],
		['non-array members', changeRoom({ members: null })],
		['room traversal ID', changeRoom({ id: '../outside' })],
		['negative revision', changeRoom({ revision: -1 })],
		['fractional revision', changeRoom({ revision: 0.5 })],
		['empty title', changeRoom({ title: '' })],
		['missing goal', changeRoom({ goal: undefined })],
		['invalid instructions', changeRoom({ instructions: false })],
		['remote repository', changeRoom({ repositoryUri: 'https://example.invalid/repo' })],
		['nonlocal file authority', changeRoom({ repositoryUri: 'file://server/repository' })],
		['repository query', changeRoom({ repositoryUri: 'file:///repository?query' })],
		['unpinned base', changeRoom({ baseRevision: 'main' })],
		['invalid creation timestamp', changeRoom({ createdAt: 'now' })],
		['timestamp order', changeRoom({ updatedAt: 0 })],
		['unknown room state', changeRoom({ state: 'unknown' })],
		['invalid room error', changeRoom({ error: [] })],
		['missing members', changeRoom({ members: [] })],
		['too many members', snapshot => ({ ...snapshot, room: { ...snapshot.room, members: Array.from({ length: 11 }, () => snapshot.room.members[0]) } })],
		['duplicate member identity', snapshot => ({ ...snapshot, room: { ...snapshot.room, members: [snapshot.room.members[0], snapshot.room.members[0]] } })],
		['duplicate member session', snapshot => ({ ...snapshot, room: { ...snapshot.room, members: [snapshot.room.members[0], { ...snapshot.room.members[0], id: 'member-two', worktreeUri: undefined }] } })],
		['invalid member ID', changeMember({ id: '/absolute' })],
		['invalid member name', changeMember({ name: 42 })],
		['invalid member model', changeMember({ model: {} })],
		['null applied model', changeMember({ modelSelection: null })],
		['empty applied model ID', changeMember({ modelSelection: { id: '' } })],
		['non-string applied model ID', changeMember({ modelSelection: { id: 42 } })],
		['unknown model selection fields', changeMember({ modelSelection: { id: 'test-model', extra: true } })],
		['null model configuration', changeMember({ modelSelection: { id: 'test-model', config: null } })],
		['array model configuration', changeMember({ modelSelection: { id: 'test-model', config: [] } })],
		['nested model configuration', changeMember({ modelSelection: { id: 'test-model', config: { thinkingLevel: { id: 'high' } } } })],
		['invalid pending model', changeMember({ pendingModel: false })],
		['invalid pending model configuration', changeMember({ pendingModel: { id: 'test-model', config: { tiers: ['high'] } } })],
		['mismatched selected model alias', changeMember({ pendingModel: { id: 'other-model' } })],
		['mismatched applied model alias', changeMember({ modelSelection: { id: 'other-model' } })],
		['mismatched explicit default alias', changeMember({ pendingModel: null })],
		['invalid model error', changeMember({ modelError: { message: 'error' } })],
		['null member configuration', changeMember({ configuration: null })],
		['incomplete member configuration', changeMember({ configuration: { mode: 'plan' } })],
		['invalid member mode', changeMember({ configuration: { ...defaultAgentHostRoomConfiguration, mode: 'other' } })],
		['invalid member approvals', changeMember({ configuration: { ...defaultAgentHostRoomConfiguration, autoApprove: 'autopilot' } })],
		['invalid member sandbox', changeMember({ configuration: { ...defaultAgentHostRoomConfiguration, sandboxEnabled: true } })],
		['configuration cannot change topology', changeMember({ configuration: { ...defaultAgentHostRoomConfiguration, isolation: 'folder' } })],
		['invalid session URI', changeMember({ sessionUri: 'no-scheme' })],
		['legacy Copilot session scheme', changeMember({ sessionUri: 'copilot:/member-one' })],
		['different provider session scheme', changeMember({ sessionUri: 'claude:/member-one' })],
		['incorrect session scheme case', changeMember({ sessionUri: 'Copilotcli:/member-one' })],
		['session URI fragment', changeMember({ sessionUri: 'copilotcli:/member-one#alias' })],
		['unknown member state', changeMember({ state: 'unknown' })],
		['wrong worktree path', changeMember({ worktreeUri: 'file:///unrelated' })],
		['invalid activity', changeMember({ activity: false })],
		['invalid member error', changeMember({ error: [] })],
		['invalid turns', changeMember({ turns: -1 })],
		['invalid work description', changeMember({ work: { description: false, blocked: false, updatedAt: 1 } })],
		['invalid work next step', changeMember({ work: { description: '', nextStep: 1, blocked: false, updatedAt: 1 } })],
		['invalid work blocked flag', changeMember({ work: { description: '', blocked: 1, updatedAt: 1 } })],
		['invalid work timestamp', changeMember({ work: { description: '', blocked: false, updatedAt: -1 } })],
		['message count mismatch', changeRoom({ latestMessageSequence: 3 })],
		['missing messages', snapshot => ({ ...snapshot, messages: undefined })],
		['message sequence gap', changeMessage({ sequence: 2 })],
		['duplicate message ID', changeMessage({ id: 'message-two' })],
		['invalid message ID', changeMessage({ id: '../message' })],
		['invalid author ID', changeMessage({ authorId: null })],
		['unknown author', changeMessage({ authorKind: 'agent', authorId: 'missing-member' })],
		['unknown author kind', changeMessage({ authorKind: 'unknown' })],
		['invalid author name', changeMessage({ authorName: false })],
		['agent author name differs from roster', snapshot => ({ ...snapshot, messages: [snapshot.messages[0], { ...snapshot.messages[1], authorName: 'Different worker' }] })],
		['unknown message kind', changeMessage({ kind: 'unknown' })],
		['unknown message mode', changeMessage({ mode: 'unknown' })],
		['agent impersonates steering', snapshot => ({ ...snapshot, messages: [snapshot.messages[0], { ...snapshot.messages[1], mode: 'steer' }] })],
		['steering delivery on a discussion post', changeDelivery({ state: 'steering', turnId: 'turn-one' })],
		['steering missing turn', changeMessage({ mode: 'steer', deliveries: [{ memberId: 'member-one', state: 'steering' }] })],
		['invalid message text', changeMessage({ text: 1 })],
		['invalid message timestamp', changeMessage({ timestamp: null })],
		['missing mention target', changeMessage({ mentions: ['missing-member'] })],
		['duplicate mentions', changeMessage({ mentions: ['member-one', 'member-one'] })],
		['invalid mentions', changeMessage({ mentions: 'member-one' })],
		['forward reply', changeMessage({ replyTo: 'message-two' })],
		['self reply', changeMessage({ replyTo: 'message-one' })],
		['missing artifact reference', changeMessage({ artifactId: 'missing-artifact' })],
		['artifact message without artifact', changeMessage({ kind: 'artifact' })],
		['missing delivery member', changeDelivery({ memberId: 'missing-member' })],
		['unmentioned delivery recipient', changeMessage({ mentions: [] })],
		['mentioned member without delivery', changeMessage({ deliveries: [] })],
		['invalid delivery state', changeDelivery({ state: 'unknown' })],
		['invalid delivery turn', changeDelivery({ turnId: false })],
		['submitted delivery without turn', changeDelivery({ state: 'submitted' })],
		['invalid delivery error', changeDelivery({ error: false })],
		['duplicate delivery', changeMessage({ deliveries: [{ memberId: 'member-one', state: 'pending' }, { memberId: 'member-one', state: 'pending' }] })],
		['missing executions', snapshot => ({ ...snapshot, executions: [] })],
		['missing execution member', changeExecution({ memberId: 'missing-member' })],
		['invalid initialized flag', changeExecution({ initialized: 1 })],
		['invalid needsTurn flag', changeExecution({ needsTurn: 1 })],
		['invalid announced flag', changeExecution({ announced: 1 })],
		['invalid execution turn', changeExecution({ turnId: '' })],
		['future read cursor', changeExecution({ readSequence: 3 })],
		['negative read cursor', changeExecution({ readSequence: -1 })],
		['fractional read cursor', changeExecution({ readSequence: 0.5 })],
		['missing execution run', changeExecution({ runId: undefined })],
		['wrong execution run', changeExecution({ runId: 'different-run' })],
		['invalid run ID', changeRun({ id: false })],
		['invalid run start', changeRun({ startedAt: -1 })],
		['run deadline order', changeRun({ deadline: 0 })],
		['invalid turn limit', changeRun({ limits: { maxTurns: 0, timeoutMinutes: 1 } })],
		['invalid timeout', changeRun({ limits: { maxTurns: 10, timeoutMinutes: 0 } })],
		['admitted turns exceed limit', changeRun({ admittedTurns: 11 })],
		['invalid admitted turns', changeRun({ admittedTurns: false })],
		['non-UUID artifact ID', changeArtifact({ id: 'artifact-one' })],
		['missing artifact member', changeArtifact({ memberId: 'missing-member' })],
		['invalid artifact title', changeArtifact({ title: '' })],
		['invalid artifact timestamp', changeArtifact({ createdAt: -1 })],
		['wrong artifact base', changeArtifact({ baseRevision: 'b'.repeat(40) })],
		['invalid artifact source', changeArtifact({ sourceRevision: 'HEAD' })],
		['injected artifact URI', changeArtifact({ uri: 'file:///unrelated' })],
		['duplicate artifact ID', snapshot => ({ ...snapshot, room: { ...snapshot.room, artifacts: [artifact(), artifact()] } })],
	];

	for (const [name, corrupt] of corruptions) {
		test(`rejects ${name} on load and refuses to overwrite corrupt data`, async () => {
			const snapshot = record();
			const path = await writeRecord(corrupt(snapshot));
			const before = await fs.readFile(path, 'utf8');
			await assert.rejects(storage.load());
			await assert.rejects(storage.save(snapshot));
			assert.deepStrictEqual({
				contents: await fs.readFile(path, 'utf8'),
				files: await fs.readdir(join(root, 'rooms')),
			}, { contents: before, files: ['room-one.json'] });
		});
	}

	test('rejects unsafe worktree path components and nonlocal storage roots', () => {
		assert.throws(() => storage.worktreeUri('../room', 'member'));
		assert.throws(() => storage.worktreeUri('room', '../member'));
		assert.throws(() => new AgentHostRoomsStorage(URI.parse('vscode-remote://host/storage'), new NullLogService()));
	});

	test('a plain folder is only prepared for collaboration when the caller opts in', async () => {
		// Must live outside any repository: Git resolves a nested folder to its enclosing work tree.
		const outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agent-collab-plain-')));
		try {
			await fs.writeFile(join(outside, 'index.html'), '<h1>Landing</h1>');
			const uri = URI.file(outside).toString();
			const before = await storage.isRepository(uri);
			await assert.rejects(storage.resolveRepository(uri, 'HEAD'));
			const resolved = await storage.resolveRepository(uri, 'HEAD', true);
			assert.deepStrictEqual({
				before, after: await storage.isRepository(uri),
				repository: resolved.repositoryUri, pinned: /^[0-9a-f]{40}$/.test(resolved.baseRevision),
				stable: (await storage.resolveRepository(uri, 'HEAD')).baseRevision === resolved.baseRevision,
			}, { before: false, after: true, repository: URI.file(outside).toString(), pinned: true, stable: true });
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test('preparing an existing repository never adds a second baseline commit', async () => {
		const snapshot = await initializeRepository();
		const resolved = await storage.resolveRepository(snapshot.room.repositoryUri, 'HEAD', true);
		assert.strictEqual(resolved.baseRevision, snapshot.room.baseRevision);
	});

	test('resolves a local repository and strictly pins requested commits', async () => {
		const snapshot = await initializeRepository();
		const nested = join(repository, 'nested');
		await fs.mkdir(nested);
		assert.deepStrictEqual(await storage.resolveRepository(URI.file(nested).toString(), 'main'), {
			repositoryUri: URI.file(repository).toString(), baseRevision: snapshot.room.baseRevision,
		});
		for (const revision of ['missing-ref', '--all', 'HEAD:committed.txt', 'HEAD;echo unsafe', 'HEAD\0bad']) {
			await assert.rejects(storage.resolveRepository(snapshot.room.repositoryUri, revision));
		}
		await assert.rejects(storage.resolveRepository('https://example.invalid/repo', 'HEAD'));
	});

	test('restores a real detached worktree without resetting or deleting member changes', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await Promise.all([storage.ensureWorktree(room, member), storage.ensureWorktree(room, member)]);
		const worktree = URI.parse(storage.worktreeUri(room.id, member.id)).fsPath;
		await fs.writeFile(join(worktree, 'committed.txt'), 'member commit\n');
		await git(worktree, ['add', 'committed.txt']);
		await git(worktree, ['commit', '-m', 'Preserved member commit']);
		const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
		await fs.writeFile(join(worktree, 'preserved.txt'), 'keep me\n');
		const reopened = new AgentHostRoomsStorage(URI.file(root), new NullLogService());
		await reopened.ensureWorktree({ ...room, state: 'stopped' }, member);
		assert.deepStrictEqual({
			head: (await git(worktree, ['rev-parse', 'HEAD'])).trim(),
			branch: (await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
			preserved: await fs.readFile(join(worktree, 'preserved.txt'), 'utf8'),
			location: worktree,
		}, {
			head, branch: 'HEAD', preserved: 'keep me\n',
			location: join(root, 'worktrees', room.id, member.id),
		});
	});

	test('isolates concurrent members editing the same file from each other and the original', async () => {
		const { room } = await initializeRepository();
		const first = room.members[0];
		const second = { ...first, id: 'member-two', sessionUri: 'copilotcli:/member-two', worktreeUri: storage.worktreeUri(room.id, 'member-two') };
		const expanded = { ...room, members: [first, second] };
		await Promise.all([storage.ensureWorktree(expanded, first), storage.ensureWorktree(expanded, second)]);
		const firstPath = URI.parse(storage.worktreeUri(room.id, first.id)).fsPath;
		const secondPath = URI.parse(storage.worktreeUri(room.id, second.id)).fsPath;
		await fs.writeFile(join(firstPath, 'committed.txt'), 'first member\n');
		await fs.writeFile(join(secondPath, 'committed.txt'), 'second member\n');
		assert.deepStrictEqual({
			first: await fs.readFile(join(firstPath, 'committed.txt'), 'utf8'),
			second: await fs.readFile(join(secondPath, 'committed.txt'), 'utf8'),
			original: await fs.readFile(join(repository, 'committed.txt'), 'utf8'),
		}, { first: 'first member\n', second: 'second member\n', original: 'base\n' });
	});

	test('rejects an existing non-repository directory instead of falling back to the original', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		const worktree = URI.parse(member.worktreeUri!).fsPath;
		await fs.mkdir(worktree, { recursive: true });
		await fs.writeFile(join(worktree, 'preserved.txt'), 'keep me\n');
		await assert.rejects(storage.ensureWorktree(room, member));
		assert.strictEqual(await fs.readFile(join(worktree, 'preserved.txt'), 'utf8'), 'keep me\n');
	});

	test('rejects an existing directory inside a repository that is not its toplevel', async () => {
		const { room } = await initializeRepository();
		const nestedRoot = join(repository, 'nested-storage');
		const nestedStorage = new AgentHostRoomsStorage(URI.file(nestedRoot), new NullLogService());
		const member = { ...room.members[0], worktreeUri: nestedStorage.worktreeUri(room.id, room.members[0].id) };
		await fs.mkdir(URI.parse(member.worktreeUri).fsPath, { recursive: true });
		await assert.rejects(nestedStorage.ensureWorktree({ ...room, members: [member] }, member), /not the git toplevel/);
	});

	test('rejects an existing Git worktree from a different common repository', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		const worktree = URI.parse(member.worktreeUri!).fsPath;
		await fs.mkdir(worktree, { recursive: true });
		await git(worktree, ['init', '--initial-branch=main']);
		await assert.rejects(storage.ensureWorktree(room, member), /different repository/);
	});

	test('rejects member HEADs that do not descend from the pinned base', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		const worktree = URI.parse(member.worktreeUri!).fsPath;
		await git(worktree, ['checkout', '--orphan', 'unrelated']);
		await git(worktree, ['commit', '-m', 'Unrelated root']);
		await assert.rejects(storage.ensureWorktree(room, member));
		assert.strictEqual((await git(worktree, ['rev-list', '--count', 'HEAD'])).trim(), '1');
	});

	test('publishes a complete binary patch without changing either real index or working tree', async () => {
		const snapshot = await initializeRepository();
		const { room } = snapshot;
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		const worktree = URI.parse(member.worktreeUri!).fsPath;
		await fs.writeFile(join(worktree, 'committed.txt'), 'committed divergence\n');
		await git(worktree, ['add', 'committed.txt']);
		await git(worktree, ['commit', '-m', 'Member commit']);
		const sourceRevision = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
		await fs.writeFile(join(worktree, 'staged.txt'), 'staged\n');
		await fs.writeFile(join(worktree, 'both.txt'), 'staged first\n');
		await fs.writeFile(join(worktree, 'staged-binary.dat'), Buffer.from([0, 42, 128, 0, 255]));
		await fs.writeFile(join(worktree, 'forced.ignored'), 'force-added ignored file\n');
		await git(worktree, ['add', 'staged.txt', 'both.txt', 'staged-binary.dat']);
		await git(worktree, ['add', '--force', 'forced.ignored']);
		await git(worktree, ['rm', 'staged-deleted.txt']);
		await fs.writeFile(join(worktree, 'both.txt'), 'unstaged after staging\n');
		await fs.writeFile(join(worktree, 'unstaged.txt'), 'unstaged\n');
		await fs.unlink(join(worktree, 'deleted.txt'));
		await fs.writeFile(join(worktree, 'untracked file.txt'), 'new untracked\n');
		await fs.writeFile(join(worktree, 'binary.dat'), Buffer.from([0, 255, 128, 10, 15, 0]));
		await fs.writeFile(join(worktree, 'new-binary.dat'), Buffer.from([0, 200, 42, 0, 255]));
		await fs.writeFile(join(worktree, 'excluded.ignored'), 'must not publish\n');
		await fs.writeFile(join(repository, 'staged.txt'), 'original staged edit\n');
		await git(repository, ['add', 'staged.txt']);
		await fs.writeFile(join(repository, 'unstaged.txt'), 'original unstaged edit\n');
		const memberIndex = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
		const originalIndex = (await git(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
		const before = {
			memberIndex: await fs.readFile(memberIndex), originalIndex: await fs.readFile(originalIndex),
			memberStatus: await git(worktree, ['status', '--porcelain=v1', '-z']),
			originalStatus: await git(repository, ['status', '--porcelain=v1', '-z']),
		};
		const published = await storage.publishPatch(room, member, 'Complete patch');
		const publishedRoom = { ...room, artifacts: [published] };
		await storage.save({ ...snapshot, room: publishedRoom });
		const patch = await storage.readArtifact(publishedRoom, published);
		assert.deepStrictEqual({
			idIsUuid: isUUID(published.id), frozen: Object.isFrozen(published),
			base: published.baseRevision, source: published.sourceRevision,
			binary: patch.includes('GIT binary patch'), privateIndexes: await fs.readdir(join(root, 'indexes')),
			memberIndex: await fs.readFile(memberIndex), originalIndex: await fs.readFile(originalIndex),
			memberStatus: await git(worktree, ['status', '--porcelain=v1', '-z']),
			originalStatus: await git(repository, ['status', '--porcelain=v1', '-z']),
		}, {
			idIsUuid: true, frozen: true, base: room.baseRevision, source: sourceRevision,
			binary: true, privateIndexes: [], ...before,
		});

		const applied = join(scratch, 'applied');
		await git(repository, ['worktree', 'add', '--detach', '--', applied, room.baseRevision]);
		await git(applied, ['apply', '--index', '--binary', URI.parse(published.uri).fsPath]);
		const files = ['committed.txt', 'staged.txt', 'unstaged.txt', 'both.txt', 'forced.ignored', 'untracked file.txt', 'binary.dat', 'staged-binary.dat', 'new-binary.dat'];
		for (const file of files) {
			assert.deepStrictEqual(await fs.readFile(join(applied, file)), await fs.readFile(join(worktree, file)), file);
		}
		for (const file of ['deleted.txt', 'staged-deleted.txt', 'excluded.ignored']) {
			await assert.rejects(fs.stat(join(applied, file)), { code: 'ENOENT' });
		}
		await fs.writeFile(join(worktree, 'untracked file.txt'), 'changed after publication\n');
		const second = await storage.publishPatch(publishedRoom, member, 'Second patch');
		const restoredStorage = new AgentHostRoomsStorage(URI.file(root), new NullLogService());
		const [restored] = await restoredStorage.load();
		assert.deepStrictEqual({
			sameFirstPatch: await storage.readArtifact(publishedRoom, published) === patch,
			restoredFirstPatch: await restoredStorage.readArtifact(restored.room, restored.room.artifacts[0]) === patch,
			distinctIds: published.id !== second.id,
			artifactCount: (await fs.readdir(join(root, 'artifacts', room.id))).length,
		}, { sameFirstPatch: true, restoredFirstPatch: true, distinctIds: true, artifactCount: 2 });
	});

	test('publishes from a split index without changing the index or its shared file', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		const worktree = URI.parse(storage.worktreeUri(room.id, member.id)).fsPath;
		await fs.writeFile(join(worktree, 'staged.txt'), 'split index change\n');
		await git(worktree, ['add', 'staged.txt']);
		await git(worktree, ['update-index', '--split-index']);
		const index = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
		const sharedIndex = (await git(worktree, ['rev-parse', '--path-format=absolute', '--shared-index-path'])).trim();
		assert.ok(sharedIndex, 'expected a shared index file');
		const before = { index: await fs.readFile(index), sharedIndex: await fs.readFile(sharedIndex) };
		const published = await storage.publishPatch(room, member, 'Split index patch');
		const patch = await storage.readArtifact({ ...room, artifacts: [published] }, published);
		assert.deepStrictEqual({
			index: await fs.readFile(index),
			sharedIndex: await fs.readFile(sharedIndex),
			includesStagedChange: patch.includes('+split index change'),
			privateIndexes: await fs.readdir(join(root, 'indexes')),
		}, { ...before, includesStagedChange: true, privateIndexes: [] });
	});

	test('cleans only the private index after a Git failure and allows a subsequent publication', async () => {
		const { room } = await initializeRepository();
		const member = room.members[0];
		await storage.ensureWorktree(room, member);
		const worktree = URI.parse(storage.worktreeUri(room.id, member.id)).fsPath;
		const nested = join(worktree, 'uncommitted-repository');
		await fs.mkdir(nested);
		await git(nested, ['init', '--initial-branch=main']);
		const index = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
		const before = await fs.readFile(index);
		// Git cannot stage an embedded repository with no commit checked out.
		await assert.rejects(storage.publishPatch(room, member, 'Failed patch'));
		assert.deepStrictEqual({
			index: await fs.readFile(index),
			privateIndexes: await fs.readdir(join(root, 'indexes')),
			preserved: (await fs.stat(join(nested, '.git'))).isDirectory(),
		}, { index: before, privateIndexes: [], preserved: true });
		await assert.rejects(fs.stat(join(root, 'artifacts', room.id)), { code: 'ENOENT' });
		await fs.rm(nested, { recursive: true, force: true });
		await fs.writeFile(join(worktree, 'untracked.txt'), 'successful retry\n');
		const published = await storage.publishPatch(room, member, 'Retried patch');
		assert.deepStrictEqual({
			files: await fs.readdir(join(root, 'artifacts', room.id)),
			includesRetry: (await storage.readArtifact({ ...room, artifacts: [published] }, published)).includes('+successful retry'),
			privateIndexes: await fs.readdir(join(root, 'indexes')),
		}, { files: [`${published.id}.patch`], includesRetry: true, privateIndexes: [] });
	});

	test('does not read an injected URI or an artifact absent from the room record', async () => {
		const { room } = await initializeRepository();
		await storage.ensureWorktree(room, room.members[0]);
		const published = await storage.publishPatch(room, room.members[0], 'Patch');
		const publishedRoom = { ...room, artifacts: [published] };
		const injected = { ...published, uri: URI.file(join(repository, 'committed.txt')).toString() };
		await assert.rejects(storage.readArtifact(publishedRoom, injected), /not a published/);
		await assert.rejects(storage.readArtifact(room, published), /not a published/);
		await assert.rejects(storage.readArtifact({ ...room, artifacts: [injected] }, injected), /file identity/);
	});

	test('rejects symlinked records, artifact files and worktree directories', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const snapshot = await initializeRepository();
		const { room } = snapshot;
		const member = room.members[0];
		await fs.mkdir(join(root, 'worktrees', room.id), { recursive: true });
		await fs.symlink(repository, URI.parse(member.worktreeUri!).fsPath, 'dir');
		await assert.rejects(storage.ensureWorktree(room, member), /not a real directory/);
		await fs.unlink(URI.parse(member.worktreeUri!).fsPath);
		await storage.ensureWorktree(room, member);
		const published = await storage.publishPatch(room, member, 'Patch');
		const publishedRoom = { ...room, artifacts: [published] };
		await fs.unlink(URI.parse(published.uri).fsPath);
		await fs.symlink(join(repository, 'committed.txt'), URI.parse(published.uri).fsPath);
		await assert.rejects(storage.readArtifact(publishedRoom, published), /not a regular file/);
		await fs.mkdir(join(root, 'rooms'));
		await fs.symlink(join(repository, 'committed.txt'), join(root, 'rooms', `${room.id}.json`));
		await assert.rejects(storage.save(snapshot), /not a regular file/);
		assert.strictEqual(await fs.readFile(join(repository, 'committed.txt'), 'utf8'), 'base\n');
	});
});
