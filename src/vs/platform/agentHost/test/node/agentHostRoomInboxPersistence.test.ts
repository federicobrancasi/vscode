/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { DeferredPromise } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ChannelClient, ChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentHostRoomDeliveryState, AgentHostRoomsChannelName, defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomMessage, IAgentHostRoomsService } from '../../common/agentHostRooms.js';
import { createAgentHostRoomsClient } from '../../common/agentHostRoomsIpc.js';
import { platformSessionSchema } from '../../common/agentHostSchema.js';
import { ResolveSessionConfigResult } from '../../common/state/protocol/commands.js';
import { AgentHostRooms } from '../../node/agentHostRooms.js';
import { createAgentHostRoomsChannel } from '../../node/agentHostRoomsChannel.js';
import { AgentHostRoomsStorage } from '../../node/agentHostRoomsStorage.js';
import { IRoomRecord, IRoomRuntime, IRoomRuntimeEvent, IRoomSessionParticipant } from '../../node/agentHostRoomsTypes.js';

interface INativeInput {
	readonly sessionUri: string;
	readonly turnId: string;
	readonly prompt: string;
}

/** Native state is independent of the host journal; this runtime never calls a model. */
class PersistenceRuntime extends Disposable implements IRoomRuntime {
	private readonly changed = this._register(new Emitter<IRoomRuntimeEvent>());
	readonly onDidChange = this.changed.event;
	readonly preparationStarted = new DeferredPromise<void>();
	readonly inputs: INativeInput[] = [];
	readonly prepared: string[] = [];
	readonly aborted: string[] = [];
	private readonly active = new Map<string, string>();
	prepareGate: Promise<void> | undefined;

	constructor(readonly nativeHistory = new Map<string, INativeInput>()) {
		super();
	}

	validateModel(): void { throw new Error('Unexpected model selection'); }
	getModel(): undefined { return undefined; }
	publishModel(): void { }
	async applyModel(): Promise<void> { throw new Error('Unexpected model change'); }
	async resolveConfiguration(member: IRoomSessionParticipant, configuration?: IAgentHostRoomConfiguration): Promise<ResolveSessionConfigResult> {
		return { schema: platformSessionSchema.toProtocol(), values: { ...(configuration ?? member.configuration ?? defaultAgentHostRoomConfiguration) } };
	}
	async applyConfiguration(): Promise<void> { }
	async prepare(_room: IAgentHostRoom, member: IRoomSessionParticipant): Promise<void> {
		this.prepared.push(member.sessionUri);
		await this.preparationStarted.complete();
		await this.prepareGate;
	}
	isIdle(sessionUri: string): boolean { return !this.active.has(sessionUri); }
	hasTurn(sessionUri: string, turnId: string): boolean { return this.nativeHistory.get(turnId)?.sessionUri === sessionUri; }
	submit(sessionUri: string, turnId: string, prompt: string): void {
		assert.ok(this.isIdle(sessionUri));
		assert.ok(!this.nativeHistory.has(turnId), 'Native inputs must not be silently resubmitted');
		const input = { sessionUri, turnId, prompt };
		this.inputs.push(input);
		this.nativeHistory.set(turnId, input);
		this.active.set(sessionUri, turnId);
		this.changed.fire({ sessionUri, turnId, state: 'working' });
	}
	async abort(sessionUri: string): Promise<void> {
		this.aborted.push(sessionUri);
		const turnId = this.active.get(sessionUri);
		this.active.delete(sessionUri);
		if (turnId) {
			this.changed.fire({ sessionUri, turnId, state: 'stopped' });
		}
	}
}

/** All reached writes use real storage; the injected failure leaves the prior disk snapshot intact. */
class SubmissionInterruptedStorage extends AgentHostRoomsStorage {
	constructor(root: URI, private readonly interruptSubmission: boolean) {
		super(root, new NullLogService());
	}

	override async save(record: IRoomRecord): Promise<void> {
		if (this.interruptSubmission && record.messages.some(message => message.deliveries.some(delivery => delivery.state === 'submitted'))) {
			throw new Error('Simulated host interruption before persisting native submission');
		}
		await super.save(record);
	}
}

suite('AgentHostRoomInboxPersistence', function () {
	this.timeout(60_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let scratch: string;
	let repository: string;
	let storageRoot: URI;
	let lifetime: DisposableStore;

	setup(async () => {
		lifetime = disposables.add(new DisposableStore());
		scratch = await fs.realpath(await fs.mkdtemp(join(process.cwd(), '.agent-host-room-inbox-persistence-')));
		repository = join(scratch, 'repository');
		storageRoot = URI.file(join(scratch, 'storage'));
		await fs.mkdir(repository);
		await git(['init', '--initial-branch=main']);
		await git(['config', 'core.autocrlf', 'false']);
		await git(['config', 'core.hooksPath', join(scratch, 'no-hooks')]);
		await git(['config', 'core.excludesFile', join(scratch, 'no-excludes')]);
		await fs.writeFile(join(repository, 'input.txt'), 'durable inbox fixture\n');
		await git(['add', 'input.txt']);
		await git(['commit', '-m', 'Inbox persistence fixture']);
	});

	teardown(async () => {
		lifetime.dispose();
		await fs.rm(scratch, { recursive: true, force: true });
	});

	async function git(args: readonly string[]): Promise<void> {
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
		await new Promise<void>((resolve, reject) => {
			execFile('git', [
				'-c', 'user.name=Room Tests', '-c', 'user.email=rooms@example.invalid',
				'-c', 'core.autocrlf=false', '-c', `core.hooksPath=${join(scratch, 'no-hooks')}`, ...args,
			], { cwd: repository, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
				if (error) {
					reject(new Error(`${error.message}\n${stderr}`));
				} else {
					resolve();
				}
			});
		});
	}

	function openHost(storage: AgentHostRoomsStorage, runtime: PersistenceRuntime) {
		const store = lifetime.add(new DisposableStore());
		const rooms = store.add(new AgentHostRooms(storage, runtime, new NullLogService()));
		const toServer = store.add(new Emitter<VSBuffer>());
		const toClient = store.add(new Emitter<VSBuffer>());
		const client = store.add(new ChannelClient({ onMessage: toClient.event, send: message => toServer.fire(message) }));
		const server = store.add(new ChannelServer({ onMessage: toServer.event, send: message => toClient.fire(message) }, 'inbox-restart-test'));
		server.registerChannel(AgentHostRoomsChannelName, createAgentHostRoomsChannel(rooms, store));
		return { client: createAgentHostRoomsClient(client.getChannel(AgentHostRoomsChannelName)), dispose: () => store.dispose() };
	}

	async function waitForValue<T>(client: IAgentHostRoomsService, roomId: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
		const listeners = lifetime.add(new DisposableStore());
		const result = new DeferredPromise<T>();
		let finished = false;
		const check = async () => {
			const value = await read();
			if (!finished && matches(value)) {
				finished = true;
				await result.complete(value);
			}
		};
		const refresh = () => {
			void check().catch(error => {
				if (!finished) {
					finished = true;
					void result.error(error);
				}
			});
		};
		listeners.add(client.onDidChangeRoom(room => {
			if (room.id === roomId) {
				refresh();
			}
		}));
		refresh();
		try {
			return await result.p;
		} finally {
			listeners.dispose();
		}
	}

	function messageContent({ deliveries, ...message }: IAgentHostRoomMessage) { return message; }

	test('human Send resumes a stopped peer through IPC with a durable existing budget', async () => {
		const storage = new AgentHostRoomsStorage(storageRoot, new NullLogService());
		const runtime = new PersistenceRuntime();
		const { client } = openHost(storage, runtime);
		const room = await client.createRoom({
			title: 'Send resumes', goal: 'Keep the same worktree', repositoryUri: URI.file(repository).toString(), workerCount: 1,
		});
		const run = (await client.startRoom(room.id, { maxTurns: 4 })).run!;
		await waitForValue(client, room.id, () => client.getMessages(room.id),
			page => page.messages[0]?.deliveries[0]?.state === 'submitted');
		await client.stopRoom(room.id);
		const message = await client.postMessage(room.id, {
			id: 'resume-with-human-input', text: 'Focus exclusively on URI formatting.', mentions: [room.members[0].id],
		});
		await waitForValue(client, room.id, () => client.getMessages(room.id),
			page => page.messages.find(candidate => candidate.id === message.id)?.deliveries[0]?.state === 'submitted');
		const [saved] = await new AgentHostRoomsStorage(storageRoot, new NullLogService()).load();
		assert.deepStrictEqual({
			runId: saved.room.run?.id, limit: saved.room.run?.limits.maxTurns, admitted: saved.room.run?.admittedTurns,
			sessions: saved.room.members.map(member => member.sessionUri),
			inputs: runtime.inputs.length, actualMessage: runtime.inputs[1].prompt.includes(message.text),
			receipt: saved.messages.find(candidate => candidate.id === message.id)?.deliveries[0].state,
		}, {
			runId: run.id, limit: 4, admitted: 2, sessions: room.members.map(member => member.sessionUri),
			inputs: 2, actualMessage: true, receipt: 'submitted',
		});
	});

	const scenarios = [
		{ name: 'pre-submission reservation', window: 'preparation', nativeEvidence: false, diskState: 'reserved', restoredState: 'interrupted', nativeCalls: 0 },
		{ name: 'native submission without a persisted marker or native evidence', window: 'submissionWrite', nativeEvidence: false, diskState: 'reserved', restoredState: 'interrupted', nativeCalls: 1 },
		{ name: 'native submission without a persisted marker but with native evidence', window: 'submissionWrite', nativeEvidence: true, diskState: 'reserved', restoredState: 'submitted', nativeCalls: 1 },
		{ name: 'persisted native submission with a cold runtime cache', window: 'submitted', nativeEvidence: false, diskState: 'submitted', restoredState: 'submitted', nativeCalls: 1 },
	] as const;

	for (const scenario of scenarios) {
		test(`IPC restart after ${scenario.name} preserves disk budget and never replays input`, async () => {
			const prepareGate = new DeferredPromise<void>();
			const runtime = new PersistenceRuntime();
			if (scenario.window === 'preparation') {
				runtime.prepareGate = prepareGate.p;
			}
			const storage = new SubmissionInterruptedStorage(storageRoot, scenario.window === 'submissionWrite');
			const first = openHost(storage, runtime);
			const room = await first.client.createRoom({
				title: 'Durable inbox restart', goal: 'Inspect the persisted input once', repositoryUri: URI.file(repository).toString(), workerCount: 1,
			});
			const authorization = (await first.client.startRoom(room.id, { maxTurns: 4 })).run;
			assert.ok(authorization);
			const requested = (await first.client.getMessages(room.id)).messages[0];
			assert.ok(requested);
			if (scenario.window === 'preparation') {
				await runtime.preparationStarted.p;
			} else if (scenario.window === 'submissionWrite') {
				await waitForValue(first.client, room.id, () => first.client.getRoom(room.id), room => room.state === 'interrupted' && !!room.error);
			} else {
				await waitForValue(first.client, room.id, () => first.client.getMessages(room.id),
					page => page.messages.length === 1 && page.messages.every(message => message.deliveries[0].state === 'submitted'));
			}

			const journal = join(storageRoot.fsPath, 'v2', 'rooms', `${room.id}.json`);
			assert.ok((await fs.stat(journal)).isFile(), 'The room must have a physical v2 journal');
			const [before] = await new AgentHostRoomsStorage(storageRoot, new NullLogService()).load();
			assert.ok(before);
			const turnId = before.executions[0].turnId;
			assert.ok(turnId);
			assert.deepStrictEqual({
				run: before.room.run,
				deliveries: before.messages.map(message => message.deliveries[0]),
				nativeInputs: runtime.inputs.map(input => ({ sessionUri: input.sessionUri, turnId: input.turnId, containsBody: input.prompt.includes(requested.text) })),
			}, {
				run: { ...authorization, admittedTurns: 1 },
				deliveries: before.messages.map(() => ({ memberId: room.members[0].id, state: scenario.diskState, turnId })),
				nativeInputs: Array.from({ length: scenario.nativeCalls }, () => ({ sessionUri: room.members[0].sessionUri, turnId, containsBody: true })),
			});

			first.dispose();
			await prepareGate.complete();
			const nativeHistory = scenario.nativeEvidence ? new Map(runtime.nativeHistory) : new Map<string, INativeInput>();
			const restoredRuntime = new PersistenceRuntime(nativeHistory);
			const restoredStorage = new AgentHostRoomsStorage(storageRoot, new NullLogService());
			const second = openHost(restoredStorage, restoredRuntime);
			const restored = await second.client.getRoom(room.id);
			const messages = (await second.client.getMessages(room.id)).messages;
			const bytesAfterRecovery = await fs.readFile(journal, 'utf8');
			await second.client.listRooms();
			await second.client.getCapabilities();
			await second.client.getMessages(room.id, { after: 0, limit: 1, memberId: room.members[0].id });
			assert.strictEqual(await fs.readFile(journal, 'utf8'), bytesAfterRecovery, 'IPC reads must not change disk receipts');

			const [recoveredDisk] = await restoredStorage.load();
			assert.ok(recoveredDisk);
			const expectedState: AgentHostRoomDeliveryState = scenario.restoredState;
			assert.deepStrictEqual({
				state: restored.state, run: restored.run,
				identity: restored.members.map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
				messages: messages.map(messageContent),
				deliveries: messages.map(message => ({ state: message.deliveries[0].state, turnId: message.deliveries[0].turnId, error: !!message.deliveries[0].error })),
				diskRun: recoveredDisk.room.run, diskStates: recoveredDisk.messages.map(message => message.deliveries[0].state),
				executions: recoveredDisk.executions,
				prepared: restoredRuntime.prepared, inferred: restoredRuntime.inputs, aborted: restoredRuntime.aborted,
			}, {
				state: 'interrupted', run: before.room.run,
				identity: room.members.map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
				messages: before.messages.map(messageContent),
				deliveries: before.messages.map(() => ({ state: expectedState, turnId, error: expectedState === 'interrupted' })),
				diskRun: before.room.run, diskStates: before.messages.map(() => expectedState),
				executions: before.executions.map(({ memberId, initialized }) => ({ memberId, initialized })),
				prepared: [], inferred: [], aborted: [],
			});

			await second.client.startRoom(room.id, {});
			await waitForValue(second.client, room.id, () => second.client.getRoom(room.id), room => room.state === 'idle');
			const [resumedDisk] = await new AgentHostRoomsStorage(storageRoot, new NullLogService()).load();
			assert.ok(resumedDisk);
			assert.deepStrictEqual({
				run: resumedDisk.room.run, messages: resumedDisk.messages.map(message => message.id),
				prepared: restoredRuntime.prepared, nativeInputs: restoredRuntime.inputs,
			}, { run: before.room.run, messages: before.messages.map(message => message.id), prepared: [], nativeInputs: [] });
		});
	}
});
