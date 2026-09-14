/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { constants, promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { Sequencer, SequencerByKey } from '../../../base/common/async.js';
import { Schemas } from '../../../base/common/network.js';
import { deepFreeze, equals } from '../../../base/common/objects.js';
import { isWindows } from '../../../base/common/platform.js';
import { extUri, extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid, isUUID } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomMember, MAX_ROOM_WORKERS } from '../common/agentHostRooms.js';
import { buildDefaultChatUri } from '../common/state/sessionState.js';
import { parseRoomConfiguration } from './agentHostRoomsConfiguration.js';
import { parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomRecord, IRoomStorage, RoomContentValidator } from './agentHostRoomsTypes.js';

/**
 * Durable room authority. Worktrees and published patches outlive individual
 * provider sessions; this storage deliberately has no session cleanup operation.
 */
export class AgentHostRoomsStorage implements IRoomStorage {
	private readonly recordsQueue = new Sequencer();
	private readonly worktreeQueue = new SequencerByKey<string>();
	private readonly root: string;

	constructor(storageRoot: URI, private readonly logService: ILogService) {
		this.root = localFile(storageRoot.toString(), 'storageRoot').fsPath;
	}

	load(): Promise<readonly IRoomRecord[]> {
		return this.recordsQueue.queue(() => this.loadRecords());
	}

	async save(record: IRoomRecord): Promise<void> {
		this.validateRecord(record);
		// Capture the snapshot before yielding so a queued save never observes
		// subsequent mutations by its caller.
		const contents = JSON.stringify(record);
		const snapshot = this.parseRecord(contents);
		return this.recordsQueue.queue(async () => {
			const existing = await this.loadRecords();
			const previous = existing.find(value => value.room.id === snapshot.room.id);
			if (previous) {
				check(snapshot.room.revision >= previous.room.revision, 'room.revision regressed');
				check(extUriBiasedIgnorePathCase.isEqual(URI.parse(snapshot.room.repositoryUri), URI.parse(previous.room.repositoryUri)) && snapshot.room.baseRevision === previous.room.baseRevision, 'room repository changed');
				// A room may gain members, but never lose, reorder, or rewrite one: the
				// existing identities must survive unchanged as a leading prefix, so a
				// member's session or worktree can never be swapped out from under it.
				const identities = (room: IAgentHostRoom) => room.members.map(member => [member.id, member.name, member.sessionUri, member.chatUri ?? buildDefaultChatUri(member.sessionUri), member.worktreeUri]);
				const preserved = identities(previous.room);
				const current = identities(snapshot.room);
				check(current.length >= preserved.length && equals(preserved, current.slice(0, preserved.length)), 'preserved member identities changed');
				for (const artifact of previous.room.artifacts) {
					check(equals(snapshot.room.artifacts.find(value => value.id === artifact.id), artifact), 'published artifact changed');
				}
			}
			this.validateIdentities([...existing.filter(value => value.room.id !== snapshot.room.id), snapshot]);
			const directory = await this.directory('rooms');
			await this.atomicWrite(join(directory, `${snapshot.room.id}.json`), contents, false);
			this.logService.trace('[AgentHostRoomsStorage] Saved room', snapshot.room.id, snapshot.room.revision);
		});
	}

	/** True when the folder is already inside a Git work tree with at least one commit. */
	async isRepository(folderUri: string): Promise<boolean> {
		const requested = localFile(folderUri, 'folderUri');
		try {
			const toplevel = (await this.git(requested.fsPath, ['rev-parse', '--show-toplevel'])).trim();
			if (!toplevel.length) {
				return false;
			}
			await this.git(toplevel, ['rev-parse', '--verify', 'HEAD^{commit}']);
			return true;
		} catch {
			return false;
		}
	}

	async resolveRepository(repositoryUri: string, revision = 'HEAD', initialize = false): Promise<{ repositoryUri: string; baseRevision: string }> {
		const requested = localFile(repositoryUri, 'repositoryUri');
		text(revision, 'revision', false);
		check(!revision.startsWith('-') && !revision.includes('\0'), 'revision');
		if (initialize && !(await this.isRepository(repositoryUri))) {
			await this.initializeRepository(requested.fsPath);
		}
		const toplevel = (await this.git(requested.fsPath, ['rev-parse', '--show-toplevel'])).trim();
		check(toplevel.length > 0, 'repository toplevel');
		const repository = await fs.realpath(toplevel);
		const baseRevision = (await this.git(repository, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
		commit(baseRevision, 'baseRevision');
		return { repositoryUri: URI.file(repository).toString(), baseRevision };
	}

	/**
	 * Prepare a plain folder for collaboration. Worktrees require Git, so a room
	 * cannot isolate members without a repository and at least one commit. Only
	 * ever reached through an explicit caller opt-in.
	 */
	private async initializeRepository(path: string): Promise<void> {
		const stats = await statIfPresent(path);
		check(stats?.isDirectory() === true, 'folder does not exist');
		const inside = (await this.git(path, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
		if (!inside.length) {
			await this.git(path, ['init', '--quiet']);
		}
		const root = (await this.git(path, ['rev-parse', '--show-toplevel'])).trim();
		check(root.length > 0, 'repository toplevel');
		const identity = ['-c', 'user.name=Agent Collab', '-c', 'user.email=agent-collab@localhost'];
		await this.git(root, ['add', '--all', '--', '.']).catch(() => undefined);
		await this.git(root, [...identity, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Baseline for Agent Collab']);
		this.logService.info('[AgentHostRoomsStorage] Initialized a repository for collaboration', root);
	}

	worktreeUri(roomId: string, memberId: string): string {
		identifier(roomId, 'roomId');
		identifier(memberId, 'memberId');
		return URI.file(join(this.root, 'worktrees', roomId, memberId)).toString();
	}

	ensureWorktree(room: IAgentHostRoom, member: IAgentHostRoomMember, requireExisting = false): Promise<void> {
		return this.worktreeQueue.queue(room.id, () => this.prepareWorktree(room, member, requireExisting));
	}

	publishPatch(room: IAgentHostRoom, member: IAgentHostRoomMember, title: string, validateContent?: RoomContentValidator): Promise<IAgentHostRoomArtifact> {
		return this.worktreeQueue.queue(room.id, async () => {
			text(title, 'artifact.title', false);
			await this.prepareWorktree(room, member, true);
			const cwd = localFile(this.worktreeUri(room.id, member.id), 'worktreeUri').fsPath;
			const sourceRevision = (await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
			commit(sourceRevision, 'sourceRevision');
			await this.git(cwd, ['merge-base', '--is-ancestor', room.baseRevision, sourceRevision]);
			check((await this.git(cwd, ['ls-files', '--unmerged', '-z'])).length === 0, 'worktree has unresolved conflicts');
			if (validateContent) {
				const changed = await this.git(cwd, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', room.baseRevision, '--']);
				const untracked = await this.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
				await validateContent([...new Set((changed + untracked).split('\0').filter(path => path.length > 0))]);
			}

			const index = join(await this.directory('indexes'), `${generateUuid()}.index`);
			const env = { GIT_INDEX_FILE: index };
			let patch: string;
			try {
				// Rebuild a private index from the real index's entries, including
				// force-added ignored files, without updating the user's index.
				const entries = await this.git(cwd, ['ls-files', '--stage', '--full-name', '-z']);
				await this.git(cwd, ['read-tree', '--empty'], env);
				await this.git(cwd, ['update-index', '-z', '--index-info'], env, entries);
				await this.git(cwd, ['add', '--all', '--', '.'], env);
				if (validateContent) {
					const paths = await this.git(cwd, ['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', room.baseRevision, '--'], env);
					await validateContent(paths.split('\0').filter(path => path.length > 0));
				}
				patch = await this.git(cwd, ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', room.baseRevision, '--'], env);
				check((await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() === sourceRevision, 'member HEAD changed during patch publication');
			} finally {
				await removePrivateFile(index);
				await removePrivateFile(`${index}.lock`);
			}

			const id = generateUuid();
			const directory = await this.directory('artifacts', room.id);
			const uri = URI.file(join(directory, `${id}.patch`)).toString();
			await this.atomicWrite(localFile(uri, 'artifact.uri').fsPath, patch, true);
			return deepFreeze({ id, memberId: member.id, title, createdAt: Date.now(), baseRevision: room.baseRevision, sourceRevision, uri });
		});
	}

	async readArtifact(room: IAgentHostRoom, artifact: IAgentHostRoomArtifact, validateContent?: RoomContentValidator): Promise<string> {
		this.validateRoom(room);
		const recorded = room.artifacts.find(value => value.id === artifact.id);
		check(recorded !== undefined && equals(recorded, artifact), 'artifact is not a published room artifact');
		// Never use a caller-provided URI as a filesystem read capability.
		const path = join(this.root, 'artifacts', room.id, `${artifact.id}.patch`);
		await this.checkDirectory('artifacts', room.id);
		const contents = await this.readFile(path);
		if (validateContent && contents.length) {
			const numstat = await this.git(localFile(room.repositoryUri, 'repositoryUri').fsPath, ['apply', '--numstat', '-z', '--'], undefined, contents);
			const paths = numstat.split('\0').filter(entry => entry.length > 0).map(entry => {
				const match = /^(?:\d+|-)\t(?:\d+|-)\t(?<path>[\s\S]+)$/.exec(entry);
				const relativePath = match?.groups?.path;
				check(typeof relativePath === 'string' && !isAbsolute(relativePath) && !relativePath.split(/[\\/]/).includes('..'), 'artifact path is not repository-relative');
				return relativePath;
			});
			await validateContent(paths);
		}
		return contents;
	}

	private async loadRecords(): Promise<readonly IRoomRecord[]> {
		if (!await this.checkDirectory('rooms')) {
			return Object.freeze([]);
		}
		const directory = join(this.root, 'rooms');
		const records: IRoomRecord[] = [];
		for (const name of (await fs.readdir(directory)).sort()) {
			if (!name.endsWith('.json')) {
				continue;
			}
			const id = name.slice(0, -5);
			identifier(id, 'room filename');
			const record = this.parseRecord(await this.readFile(join(directory, name)));
			check(record.room.id === id, 'room filename does not match its identity');
			records.push(record);
		}
		this.validateIdentities(records);
		return Object.freeze(records);
	}

	private validateIdentities(records: readonly IRoomRecord[]): void {
		const sessions = new Set<string>();
		const artifacts = new Set<string>();
		for (const record of records) {
			for (const member of record.room.members) {
				unique(sessions, extUri.getComparisonKey(URI.parse(member.sessionUri, true)), 'member.sessionUri');
			}
			for (const artifact of record.room.artifacts) {
				unique(artifacts, artifact.id, 'artifact.id');
			}
		}
	}

	private parseRecord(contents: string): IRoomRecord {
		const value: unknown = JSON.parse(contents);
		this.validateRecord(value);
		return deepFreeze(value);
	}

	private validateRecord(value: unknown): asserts value is IRoomRecord {
		const record = object(value, 'record', ['version', 'room', 'messages', 'executions']);
		check(record.version === 1, 'unsupported room record version');
		this.validateRoom(record.room);
		const room = record.room;
		const memberIds = new Set(room.members.map(member => member.id));
		const artifactIds = new Set(room.artifacts.map(artifact => artifact.id));
		const messages = array(record.messages, 'messages');
		check(messages.length === room.latestMessageSequence, 'latestMessageSequence does not match messages');
		const messageIds = new Set<string>();
		for (const [index, value] of messages.entries()) {
			const message = object(value, 'message', ['id', 'sequence', 'authorId', 'authorName', 'authorKind', 'kind', 'mode', 'text', 'timestamp', 'mentions', 'replyTo', 'artifactId', 'deliveries']);
			identifier(message.id, 'message.id');
			check(message.sequence === index + 1, 'message.sequence');
			identifier(message.authorId, 'message.authorId');
			text(message.authorName, 'message.authorName', false);
			enumValue(message.authorKind, ['human', 'agent', 'system'], 'message.authorKind');
			if (message.authorKind === 'agent') {
				check(memberIds.has(message.authorId), 'message author is not a member');
				check(room.members.find(member => member.id === message.authorId)?.name === message.authorName, 'message author name does not match its member');
			} else {
				check(message.authorId === message.authorKind, 'message author identity');
			}
			enumValue(message.kind, ['message', 'work', 'finding', 'artifact', 'system'], 'message.kind');
			if (message.mode !== undefined) {
				enumValue(message.mode, ['message', 'steer'], 'message.mode');
				check(message.mode !== 'steer' || message.authorKind === 'human', 'only human messages may steer');
			}
			text(message.text, 'message.text');
			count(message.timestamp, 'message.timestamp');
			references(message.mentions, memberIds, 'message.mentions');
			if (message.replyTo !== undefined) {
				identifier(message.replyTo, 'message.replyTo');
				check(messageIds.has(message.replyTo), 'message.replyTo is not an earlier message');
			}
			unique(messageIds, message.id, 'message.id');
			if (message.artifactId !== undefined) {
				identifier(message.artifactId, 'message.artifactId');
				check(artifactIds.has(message.artifactId), 'message artifact does not exist');
			}
			check(message.kind !== 'artifact' || message.artifactId !== undefined, 'artifact message has no artifact');
			const delivered = new Set<string>();
			for (const value of array(message.deliveries, 'message.deliveries')) {
				const delivery = object(value, 'delivery', ['memberId', 'state', 'turnId', 'error']);
				identifier(delivery.memberId, 'delivery.memberId');
				check(memberIds.has(delivery.memberId), 'delivery member does not exist');
				unique(delivered, delivery.memberId, 'delivery.memberId');
				enumValue(delivery.state, ['pending', 'submitted', 'steering', 'delivered', 'completed', 'failed', 'cancelled', 'interrupted'], 'delivery.state');
				optional(delivery.turnId, identifier, 'delivery.turnId');
				check(!['submitted', 'steering', 'delivered', 'completed'].includes(String(delivery.state)) || delivery.turnId !== undefined, 'delivery has no submitted turn');
				check((delivery.state !== 'steering' && delivery.state !== 'delivered') || message.mode === 'steer', 'steering delivery requires a steering message');
				optional(delivery.error, text, 'delivery.error');
			}
			check(delivered.size === (message.mentions as readonly string[]).length && (message.mentions as readonly string[]).every(memberId => delivered.has(memberId)), 'deliveries do not match mentions');
		}
		const executions = array(record.executions, 'executions');
		check(executions.length === room.members.length, 'execution count does not match members');
		const executionIds = new Set<string>();
		for (const value of executions) {
			const execution = object(value, 'execution', ['memberId', 'initialized', 'needsTurn', 'turnId', 'runId', 'readSequence', 'announced']);
			identifier(execution.memberId, 'execution.memberId');
			check(memberIds.has(execution.memberId), 'execution member does not exist');
			unique(executionIds, execution.memberId, 'execution.memberId');
			boolean(execution.initialized, 'execution.initialized');
			boolean(execution.needsTurn, 'execution.needsTurn');
			optional(execution.turnId, identifier, 'execution.turnId');
			optional(execution.runId, identifier, 'execution.runId');
			optional(execution.announced, boolean, 'execution.announced');
			if (execution.readSequence !== undefined) {
				count(execution.readSequence, 'execution.readSequence');
				check(execution.readSequence <= room.latestMessageSequence, 'execution.readSequence exceeds messages');
			}
			check((execution.turnId === undefined) === (execution.runId === undefined), 'execution turn/run mismatch');
			check(execution.runId === undefined || execution.runId === room.run?.id, 'execution references a different run');
		}
	}

	private validateRoom(value: unknown): asserts value is IAgentHostRoom {
		const room = object(value, 'room', ['id', 'revision', 'title', 'goal', 'instructions', 'repositoryUri', 'baseRevision', 'createdAt', 'updatedAt', 'state', 'continuous', 'members', 'artifacts', 'latestMessageSequence', 'run', 'error']);
		identifier(room.id, 'room.id');
		count(room.revision, 'room.revision');
		text(room.title, 'room.title', false);
		text(room.goal, 'room.goal', false);
		text(room.instructions, 'room.instructions');
		localFile(room.repositoryUri, 'room.repositoryUri');
		commit(room.baseRevision, 'room.baseRevision');
		count(room.createdAt, 'room.createdAt');
		count(room.updatedAt, 'room.updatedAt');
		check(room.updatedAt >= room.createdAt, 'room.updatedAt precedes creation');
		enumValue(room.state, ['created', 'running', 'idle', 'paused', 'stopping', 'stopped', 'interrupted'], 'room.state');
		check(room.continuous === undefined || typeof room.continuous === 'boolean', 'room.continuous');
		count(room.latestMessageSequence, 'room.latestMessageSequence');
		optional(room.error, text, 'room.error');
		const members = array(room.members, 'room.members');
		check(members.length > 0 && members.length <= MAX_ROOM_WORKERS, 'room member count');
		const memberIds = new Set<string>();
		const sessions = new Set<string>();
		for (const value of members) {
			const member = object(value, 'member', ['id', 'name', 'sessionUri', 'chatUri', 'model', 'modelSelection', 'pendingModel', 'modelError', 'state', 'worktreeUri', 'activity', 'work', 'error', 'turns', 'removed', 'configuration']);
			identifier(member.id, 'member.id');
			unique(memberIds, member.id, 'member.id');
			text(member.name, 'member.name', false);
			text(member.sessionUri, 'member.sessionUri', false);
			const session = URI.parse(member.sessionUri, true);
			check(session.scheme === 'copilotcli' && !session.authority && session.path.length > 1 && !session.query && !session.fragment, 'member.sessionUri');
			identifier(session.path.slice(1), 'member.sessionId');
			unique(sessions, extUri.getComparisonKey(session), 'member.sessionUri');
			if (member.chatUri !== undefined) {
				check(member.chatUri === buildDefaultChatUri(member.sessionUri), 'member.chatUri must be the preserved session default chat');
			}
			optional(member.model, text, 'member.model');
			const modelSelection = member.modelSelection === undefined ? undefined : parseRoomModelSelection(member.modelSelection);
			const pendingModel = member.pendingModel === undefined || member.pendingModel === null ? member.pendingModel : parseRoomModelSelection(member.pendingModel);
			if (modelSelection !== undefined || pendingModel !== undefined) {
				const selected = pendingModel === null ? 'auto' : (pendingModel ?? modelSelection)?.id;
				check(member.model === selected, 'member.model does not match its selected model');
			}
			optional(member.modelError, text, 'member.modelError');
			if (member.configuration !== undefined) {
				parseRoomConfiguration(member.configuration, true);
			}
			enumValue(member.state, ['pending', 'starting', 'working', 'idle', 'blocked', 'needsInput', 'stopping', 'stopped', 'failed', 'interrupted'], 'member.state');
			if (member.worktreeUri !== undefined) {
				check(sameFile(localFile(member.worktreeUri, 'member.worktreeUri').fsPath, localFile(this.worktreeUri(room.id, member.id), 'member worktree').fsPath), 'member worktree identity');
			}
			optional(member.activity, text, 'member.activity');
			optional(member.error, text, 'member.error');
			count(member.turns, 'member.turns');
			optional(member.removed, boolean, 'member.removed');
			if (member.work !== undefined) {
				const work = object(member.work, 'member.work', ['description', 'nextStep', 'blocked', 'updatedAt']);
				text(work.description, 'work.description');
				optional(work.nextStep, text, 'work.nextStep');
				boolean(work.blocked, 'work.blocked');
				count(work.updatedAt, 'work.updatedAt');
			}
		}
		const artifactIds = new Set<string>();
		for (const value of array(room.artifacts, 'room.artifacts')) {
			const artifact = object(value, 'artifact', ['id', 'memberId', 'title', 'createdAt', 'baseRevision', 'sourceRevision', 'uri']);
			identifier(artifact.id, 'artifact.id');
			check(isUUID(artifact.id), 'artifact.id must be a UUID');
			unique(artifactIds, artifact.id, 'artifact.id');
			identifier(artifact.memberId, 'artifact.memberId');
			check(memberIds.has(artifact.memberId), 'artifact member does not exist');
			text(artifact.title, 'artifact.title', false);
			count(artifact.createdAt, 'artifact.createdAt');
			commit(artifact.baseRevision, 'artifact.baseRevision');
			check(artifact.baseRevision === room.baseRevision, 'artifact baseRevision differs from room');
			commit(artifact.sourceRevision, 'artifact.sourceRevision');
			check(sameFile(localFile(artifact.uri, 'artifact.uri').fsPath, join(this.root, 'artifacts', room.id, `${artifact.id}.patch`)), 'artifact file identity');
		}
		if (room.run !== undefined) {
			const run = object(room.run, 'room.run', ['id', 'startedAt', 'deadline', 'limits', 'admittedTurns']);
			identifier(run.id, 'run.id');
			count(run.startedAt, 'run.startedAt');
			if (run.deadline !== undefined) {
				count(run.deadline, 'run.deadline');
				check(run.deadline >= run.startedAt, 'run.deadline precedes start');
			}
			const limits = object(run.limits, 'run.limits', ['maxTurns', 'timeoutMinutes']);
			if (limits.maxTurns !== undefined) {
				count(limits.maxTurns, 'limits.maxTurns');
				check(limits.maxTurns > 0, 'limits.maxTurns');
			}
			if (limits.timeoutMinutes !== undefined) {
				check(typeof limits.timeoutMinutes === 'number' && Number.isFinite(limits.timeoutMinutes) && limits.timeoutMinutes > 0, 'limits.timeoutMinutes');
			}
			check((run.deadline === undefined) === (limits.timeoutMinutes === undefined), 'run deadline does not match timeout setting');
			count(run.admittedTurns, 'run.admittedTurns');
			check(limits.maxTurns === undefined || run.admittedTurns <= limits.maxTurns, 'run.admittedTurns exceeds limit');
		}
	}

	private async prepareWorktree(room: IAgentHostRoom, member: IAgentHostRoomMember, requireExisting: boolean): Promise<void> {
		this.validateRoom(room);
		check(room.members.some(value => equals(value, member)), 'worktree member is not in room');
		const repository = await this.resolveRepository(room.repositoryUri, room.baseRevision);
		check(repository.baseRevision === room.baseRevision, 'room baseRevision is not pinned');
		const original = localFile(repository.repositoryUri, 'repositoryUri').fsPath;
		const worktree = localFile(this.worktreeUri(room.id, member.id), 'worktreeUri').fsPath;
		check(!sameFile(original, worktree), 'worktree must be isolated from the original repository');
		await this.directory('worktrees', room.id);
		const existing = await statIfPresent(worktree);
		if (existing) {
			check(existing.isDirectory() && !existing.isSymbolicLink(), 'worktree is not a real directory');
		} else {
			check(!requireExisting, 'preserved worktree is missing; restore it before retrying');
			await this.git(original, ['worktree', 'add', '--detach', '--', worktree, room.baseRevision]);
		}
		const toplevel = (await this.git(worktree, ['rev-parse', '--show-toplevel'])).trim();
		check(sameFile(await fs.realpath(toplevel), await fs.realpath(worktree)), 'worktree is not the git toplevel');
		const originalCommon = (await this.git(original, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		const worktreeCommon = (await this.git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		check(sameFile(await fs.realpath(originalCommon), await fs.realpath(worktreeCommon)), 'worktree belongs to a different repository');
		await this.git(worktree, ['merge-base', '--is-ancestor', room.baseRevision, 'HEAD']);
	}

	private async directory(...segments: string[]): Promise<string> {
		const created = await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		check((await fs.lstat(this.root)).isDirectory(), 'storageRoot is not a real directory');
		if (created) {
			let parent = this.root;
			do {
				parent = dirname(parent);
				await this.syncDirectory(parent);
			} while (!sameFile(parent, dirname(created)));
		}
		let path = this.root;
		for (const segment of segments) {
			identifier(segment, 'storage directory');
			path = join(path, segment);
			const entry = await statIfPresent(path);
			if (!entry) {
				try {
					await fs.mkdir(path, { mode: 0o700 });
					await this.syncDirectory(dirname(path));
				} catch (error) {
					if (!hasCode(error, 'EEXIST')) {
						throw error;
					}
				}
			}
			check((await fs.lstat(path)).isDirectory(), 'storage directory is not a real directory');
		}
		return path;
	}

	private async checkDirectory(...segments: string[]): Promise<boolean> {
		let path = this.root;
		for (const segment of ['', ...segments]) {
			path = join(path, segment);
			const entry = await statIfPresent(path);
			if (!entry) {
				return false;
			}
			check(entry.isDirectory(), 'storage directory is not a real directory');
		}
		return true;
	}

	private async readFile(path: string): Promise<string> {
		const entry = await fs.lstat(path);
		check(entry.isFile() && !entry.isSymbolicLink(), 'stored record is not a regular file');
		const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			check((await file.stat()).isFile(), 'stored record is not a regular file');
			return await file.readFile('utf8');
		} finally {
			await file.close();
		}
	}

	private async atomicWrite(path: string, contents: string, exclusive: boolean): Promise<void> {
		const temporary = join(dirname(path), `.${generateUuid()}.tmp`);
		const file = await fs.open(temporary, 'wx', 0o600);
		try {
			try {
				await file.writeFile(contents, 'utf8');
				if (exclusive) {
					await file.chmod(0o400);
				}
				await file.sync();
			} finally {
				await file.close();
			}
			if (exclusive) {
				// Linking a complete file is atomic and refuses an existing name.
				await fs.link(temporary, path);
			} else {
				await fs.rename(temporary, path);
			}
		} finally {
			await removePrivateFile(temporary);
		}
		await this.syncDirectory(dirname(path));
	}

	private async syncDirectory(path: string): Promise<void> {
		if (!isWindows) {
			const directory = await fs.open(path, 'r');
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} else {
			this.logService.trace('[AgentHostRoomsStorage] File flushed; directory fsync is unavailable on Windows');
		}
	}

	private async git(cwd: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv, input?: string): Promise<string> {
		const temporaryDirectory = await this.directory('git');
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.toUpperCase().startsWith('GIT_')) {
				env[key] = value;
			}
		}
		Object.assign(env, {
			GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
			TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory,
		}, extraEnv);
		return new Promise((resolve, reject) => {
			const child = execFile('git', [
				'-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false',
				'-c', `core.hooksPath=${join(temporaryDirectory, 'no-hooks')}`, ...args,
			], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
				if (error) {
					reject(new Error(localize('agentHostRooms.gitFailed', "Room Git operation failed: {0}", stderr.trim() || error.message)));
				} else {
					resolve(stdout);
				}
			});
			child.stdin?.on('error', error => {
				if (!hasCode(error, 'EPIPE')) {
					reject(error);
				}
			});
			child.stdin?.end(input);
		});
	}
}

function check(condition: unknown, field: string): asserts condition {
	if (!condition) {
		throw new Error(localize('agentHostRooms.invalidStorage', "Invalid room storage data: {0}.", field));
	}
}

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
	check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
	check(Object.keys(value).every(key => keys.includes(key)), `${field} contains unknown fields`);
	return value as Record<string, unknown>;
}

function array(value: unknown, field: string): readonly unknown[] {
	check(Array.isArray(value), field);
	return value;
}

function text(value: unknown, field: string, empty = true): asserts value is string {
	check(typeof value === 'string' && (empty || value.trim().length > 0), field);
}

function identifier(value: unknown, field: string): asserts value is string {
	text(value, field, false);
	check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), field);
	check(!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), field);
}

function commit(value: unknown, field: string): asserts value is string {
	text(value, field, false);
	check(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value), field);
}

function count(value: unknown, field: string): asserts value is number {
	check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, field);
}

function boolean(value: unknown, field: string): void {
	check(typeof value === 'boolean', field);
}

function optional(value: unknown, validate: (value: unknown, field: string) => void, field: string): void {
	if (value !== undefined) {
		validate(value, field);
	}
}

function enumValue(value: unknown, values: readonly string[], field: string): void {
	check(typeof value === 'string' && values.includes(value), field);
}

function unique(values: Set<string>, value: string, field: string): void {
	check(!values.has(value), `${field} is duplicated`);
	values.add(value);
}

function references(value: unknown, members: ReadonlySet<string>, field: string): void {
	const seen = new Set<string>();
	for (const id of array(value, field)) {
		identifier(id, field);
		check(members.has(id), `${field} references a missing member`);
		unique(seen, id, field);
	}
}

function localFile(value: unknown, field: string): URI {
	text(value, field, false);
	const uri = URI.parse(value, true);
	check(uri.scheme === Schemas.file && !uri.authority && !uri.query && !uri.fragment && uri.path.startsWith('/') && !uri.path.includes('\0'), field);
	check(sameFile(uri.fsPath, resolve(uri.fsPath)), field);
	return uri;
}

function sameFile(left: string, right: string): boolean {
	return extUriBiasedIgnorePathCase.isEqual(URI.file(left), URI.file(right));
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === code;
}

async function statIfPresent(path: string) {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if (hasCode(error, 'ENOENT')) {
			return undefined;
		}
		throw error;
	}
}

async function removePrivateFile(path: string): Promise<void> {
	try {
		await fs.unlink(path);
	} catch (error) {
		if (!hasCode(error, 'ENOENT')) {
			throw error;
		}
	}
}
