/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Sequencer } from '../../../base/common/async.js';
import { deepFreeze, equals } from '../../../base/common/objects.js';
import { join } from '../../../base/common/path.js';
import { extUri } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { isUUID } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomMember, IAgentHostRoomMessage, MAX_ROOM_MESSAGE_LENGTH, MAX_ROOM_WORKERS } from '../common/agentHostRooms.js';
import { buildDefaultChatUri } from '../common/state/sessionState.js';
import { parseRoomArchive } from './agentHostRoomArchive.js';
import { checkRoomData as check, roomArray as array, roomCommit as commit, roomCount as count, RoomFiles, roomId as identifier, roomLocalFile as localFile, roomObject as object, roomText as text, sameRoomFile } from './agentHostRoomStorageUtils.js';
import { AgentHostRoomWorktrees } from './agentHostRoomWorktrees.js';
import { parseRoomConfiguration } from './agentHostRoomsConfiguration.js';
import { parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomArchive, IRoomRecord, IRoomSessionParticipant, IRoomStorage, RoomContentValidator } from './agentHostRoomsTypes.js';

/** Atomic mailbox journals. V1 files are indexed only as immutable, read-only archives. */
export class AgentHostRoomsStorage implements IRoomStorage {
	private readonly queue = new Sequencer();
	private readonly legacyFiles: RoomFiles;
	private readonly files: RoomFiles;
	private readonly worktrees: AgentHostRoomWorktrees;
	private records: ReadonlyMap<string, IRoomRecord> | undefined;
	private archives: readonly IRoomArchive[] | undefined;
	private readonly sessionOwners = new Map<string, string>();
	private readonly artifactOwners = new Map<string, string>();

	constructor(storageRoot: URI, private readonly logService: ILogService) {
		this.legacyFiles = new RoomFiles(localFile(storageRoot.toString(), 'storageRoot').fsPath);
		this.files = new RoomFiles(this.legacyFiles.path('v2'), this.legacyFiles);
		this.worktrees = new AgentHostRoomWorktrees(this.files, logService);
	}

	load(): Promise<readonly IRoomRecord[]> {
		return this.queue.queue(async () => {
			await this.loadRecords();
			return Object.freeze([...this.records!.values()]);
		});
	}

	loadArchives(): Promise<readonly IRoomArchive[]> {
		return this.queue.queue(async () => {
			if (!this.records) {
				await this.loadRecords();
			}
			return this.archives!;
		});
	}

	async save(record: IRoomRecord): Promise<void> {
		this.validateRecord(record);
		const contents = JSON.stringify({
			version: record.version, room: record.room, executions: record.executions,
			messages: record.messages.map(({ deliveries, ...message }) => message),
			receipts: record.messages.map(message => ({ messageId: message.id, deliveries: message.deliveries })),
		});
		const snapshot = this.parseRecord(contents);
		return this.queue.queue(async () => {
			if (!this.records) {
				await this.loadRecords();
			}
			check(!this.archives!.some(archive => archive.room.id === snapshot.room.id), 'archived room is read-only');
			const previous = this.records!.get(snapshot.room.id);
			if (previous) {
				validateUpdate(previous, snapshot);
			}
			this.checkIdentities(snapshot.room, snapshot.room.members.map(member => member.sessionUri));
			const directory = await this.files.directory('rooms');
			await this.files.write(join(directory, `${snapshot.room.id}.json`), contents);
			this.records = new Map(this.records).set(snapshot.room.id, snapshot);
			this.indexIdentities(snapshot.room, snapshot.room.members.map(member => member.sessionUri));
			this.logService.trace('[AgentHostRoomsStorage] Saved inbox room', snapshot.room.id, snapshot.room.revision);
		});
	}

	isRepository(folderUri: string): Promise<boolean> {
		return this.worktrees.isRepository(folderUri);
	}

	resolveRepository(repositoryUri: string, revision?: string, initialize?: boolean): Promise<{ repositoryUri: string; baseRevision: string }> {
		return this.worktrees.resolveRepository(repositoryUri, revision, initialize);
	}

	worktreeUri(roomId: string, memberId: string): string {
		return this.worktrees.worktreeUri(roomId, memberId);
	}

	ensureWorktree(room: IAgentHostRoom, member: IRoomSessionParticipant, requireExisting?: boolean): Promise<void> {
		return this.worktrees.ensureWorktree(room, member, requireExisting);
	}

	publishPatch(room: IAgentHostRoom, member: IAgentHostRoomMember, title: string, validateContent?: RoomContentValidator): Promise<IAgentHostRoomArtifact> {
		return this.worktrees.publishPatch(room, member, title, validateContent);
	}

	readArtifact(room: IAgentHostRoom, artifact: IAgentHostRoomArtifact, validateContent?: RoomContentValidator): Promise<string> {
		return this.worktrees.readArtifact(room, artifact, validateContent, room.archived ? this.legacyFiles : this.files);
	}

	private async loadRecords(): Promise<void> {
		this.records = undefined;
		const records: IRoomRecord[] = [];
		for (const { id, contents } of await this.readJournals(this.files)) {
			const record = this.parseRecord(contents);
			check(record.room.id === id, 'room filename does not match its identity');
			records.push(record);
		}
		if (!this.archives) {
			const archives: IRoomArchive[] = [];
			for (const { id, contents } of await this.readJournals(this.legacyFiles)) {
				const archive = parseRoomArchive(contents, this.legacyFiles.root);
				check(archive.room.id === id, 'archive filename does not match its identity');
				archives.push(archive);
			}
			this.archives = Object.freeze(archives);
		}
		this.sessionOwners.clear();
		this.artifactOwners.clear();
		const ids = new Set<string>();
		for (const archive of this.archives) {
			unique(ids, archive.room.id, 'room.id');
			this.checkIdentities(archive.room, archive.sessionUris);
			this.indexIdentities(archive.room, archive.sessionUris);
		}
		for (const record of records) {
			unique(ids, record.room.id, 'room.id');
			const sessions = record.room.members.map(member => member.sessionUri);
			this.checkIdentities(record.room, sessions);
			this.indexIdentities(record.room, sessions);
		}
		this.records = new Map(records.map(record => [record.room.id, record]));
	}

	private async readJournals(files: RoomFiles): Promise<readonly { id: string; contents: string }[]> {
		if (!await files.hasDirectory('rooms')) {
			return [];
		}
		const journals: { id: string; contents: string }[] = [];
		for (const name of (await fs.readdir(files.path('rooms'))).sort()) {
			if (name.endsWith('.json')) {
				const id = identifier(name.slice(0, -5), 'room filename');
				journals.push({ id, contents: await files.read(files.path('rooms', name)) });
			}
		}
		return journals;
	}

	private checkIdentities(room: IAgentHostRoom, sessions: readonly string[]): void {
		const seen = new Set<string>();
		for (const session of sessions) {
			const key = extUri.getComparisonKey(URI.parse(session, true));
			unique(seen, key, 'sessionUri');
			const owner = this.sessionOwners.get(key);
			check(owner === undefined || owner === room.id, 'sessionUri is duplicated');
		}
		for (const artifact of room.artifacts) {
			const owner = this.artifactOwners.get(artifact.id);
			check(owner === undefined || owner === room.id, 'artifact.id is duplicated');
		}
	}

	private indexIdentities(room: IAgentHostRoom, sessions: readonly string[]): void {
		for (const session of sessions) {
			this.sessionOwners.set(extUri.getComparisonKey(URI.parse(session, true)), room.id);
		}
		for (const artifact of room.artifacts) {
			this.artifactOwners.set(artifact.id, room.id);
		}
	}

	private parseRecord(contents: string): IRoomRecord {
		const stored = object(JSON.parse(contents), 'stored record', ['version', 'room', 'executions', 'messages', 'receipts']);
		const messages = array(stored.messages, 'messages');
		const receipts = array(stored.receipts, 'receipts');
		check(receipts.length === messages.length, 'receipt message count');
		const record = {
			version: stored.version, room: stored.room, executions: stored.executions,
			messages: messages.map((value, index) => {
				const message = object(value, 'message');
				const receipt = object(receipts[index], 'receipt', ['messageId', 'deliveries']);
				check(!Object.hasOwn(message, 'deliveries') && message.id === receipt.messageId, 'receipt message identity');
				return { ...message, deliveries: receipt.deliveries };
			}),
		};
		this.validateRecord(record);
		return deepFreeze(record);
	}

	private validateRecord(value: unknown): asserts value is IRoomRecord {
		const record = object(value, 'record', ['version', 'room', 'messages', 'executions']);
		check(record.version === 2, 'unsupported room record version');
		this.validateRoom(record.room);
		const room = record.room;
		const members = new Map(room.members.map(member => [member.id, member]));
		const artifactIds = new Set(room.artifacts.map(artifact => artifact.id));
		const messages = array(record.messages, 'messages');
		check(messages.length === room.latestMessageSequence, 'latestMessageSequence does not match messages');
		const messageIds = new Set<string>();
		for (const [index, value] of messages.entries()) {
			const message = object(value, 'message', ['id', 'sequence', 'authorId', 'authorName', 'authorKind', 'kind', 'text', 'timestamp', 'mentions', 'replyTo', 'artifactId', 'artifactIds', 'deliveries']);
			const id = identifier(message.id, 'message.id');
			check(message.sequence === index + 1, 'message.sequence');
			const authorId = identifier(message.authorId, 'message.authorId');
			const authorName = text(message.authorName, 'message.authorName');
			enumValue(message.authorKind, ['human', 'agent', 'system'], 'message.authorKind');
			if (message.authorKind === 'agent') {
				check(members.get(authorId)?.name === authorName, 'message author differs from roster');
			} else {
				check(authorId === message.authorKind, 'message author identity');
			}
			enumValue(message.kind, ['message', 'work', 'finding', 'artifact', 'system'], 'message.kind');
			check(message.kind !== 'system' || message.authorKind === 'system', 'system message author');
			text(message.text, 'message.text', false, MAX_ROOM_MESSAGE_LENGTH);
			count(message.timestamp, 'message.timestamp');
			const mentions = references(message.mentions, new Set(members.keys()), 'message.mentions');
			if (message.replyTo !== undefined) {
				check(messageIds.has(identifier(message.replyTo, 'message.replyTo')), 'message.replyTo must reference an earlier message');
			}
			if (message.artifactId !== undefined) {
				check(artifactIds.has(identifier(message.artifactId, 'message.artifactId')), 'missing artifact reference');
			}
			if (message.artifactIds !== undefined) {
				references(message.artifactIds, artifactIds, 'message.artifactIds');
			}
			check(message.kind !== 'artifact' || message.artifactId !== undefined, 'artifact message has no artifact');
			if (message.kind === 'artifact') {
				check(message.authorKind === 'agent' && room.artifacts.find(artifact => artifact.id === message.artifactId)?.memberId === authorId, 'artifact publication author');
			}
			const deliveries = new Set<string>();
			for (const value of array(message.deliveries, 'message.deliveries')) {
				const delivery = object(value, 'delivery', ['memberId', 'state', 'turnId', 'error']);
				const recipient = identifier(delivery.memberId, 'delivery.memberId');
				check(mentions.has(recipient), 'delivery recipient is not addressed');
				unique(deliveries, recipient, 'delivery.memberId');
				enumValue(delivery.state, ['pending', 'reserved', 'submitted', 'failed', 'interrupted', 'cancelled'], 'delivery.state');
				optional(delivery.turnId, identifier, 'delivery.turnId');
				check(delivery.state !== 'submitted' && delivery.state !== 'reserved' || delivery.turnId !== undefined, 'reserved or submitted delivery has no turn');
				check(delivery.state !== 'pending' || delivery.turnId === undefined, 'pending delivery has a turn');
				optional(delivery.error, text, 'delivery.error');
			}
			check(deliveries.size === mentions.size, 'mentioned member has no delivery');
			unique(messageIds, id, 'message.id');
		}
		const executions = array(record.executions, 'executions');
		check(executions.length === members.size, 'execution member count');
		const seen = new Set<string>();
		for (const value of executions) {
			const execution = object(value, 'execution', ['memberId', 'initialized', 'turnId', 'runId']);
			const id = identifier(execution.memberId, 'execution.memberId');
			check(members.has(id), 'execution member is missing');
			unique(seen, id, 'execution.memberId');
			check(typeof execution.initialized === 'boolean', 'execution.initialized');
			optional(execution.turnId, identifier, 'execution.turnId');
			optional(execution.runId, identifier, 'execution.runId');
			check((execution.turnId === undefined) === (execution.runId === undefined), 'execution turn/run mismatch');
			check(execution.runId === undefined || execution.runId === room.run?.id, 'execution references a different run');
		}
	}

	private validateRoom(value: unknown): asserts value is IAgentHostRoom {
		const room = object(value, 'room', ['id', 'revision', 'title', 'goal', 'instructions', 'repositoryUri', 'baseRevision', 'createdAt', 'updatedAt', 'state', 'archived', 'pauseReason', 'members', 'artifacts', 'latestMessageSequence', 'run', 'error']);
		const roomId = identifier(room.id, 'room.id');
		count(room.revision, 'room.revision');
		text(room.title, 'room.title');
		text(room.goal, 'room.goal');
		text(room.instructions, 'room.instructions', true);
		localFile(room.repositoryUri, 'room.repositoryUri');
		const base = commit(room.baseRevision, 'room.baseRevision');
		check(count(room.updatedAt, 'room.updatedAt') >= count(room.createdAt, 'room.createdAt'), 'room.updatedAt precedes creation');
		enumValue(room.state, ['created', 'running', 'idle', 'paused', 'stopping', 'stopped', 'interrupted'], 'room.state');
		check(room.archived === undefined || room.archived === false, 'archived room is read-only');
		if (room.pauseReason !== undefined) {
			enumValue(room.pauseReason, ['user', 'budget', 'deadline'], 'room.pauseReason');
		}
		count(room.latestMessageSequence, 'room.latestMessageSequence');
		optional(room.error, text, 'room.error');
		const memberIds = new Set<string>();
		const sessions = new Set<string>();
		const members = array(room.members, 'room.members');
		check(members.length > 0, 'room member count');
		let activeMembers = 0;
		for (const value of members) {
			const member = object(value, 'member', ['id', 'name', 'sessionUri', 'chatUri', 'model', 'modelSelection', 'pendingModel', 'modelError', 'state', 'worktreeUri', 'activity', 'work', 'error', 'turns', 'removed', 'configuration']);
			const id = identifier(member.id, 'member.id');
			unique(memberIds, id, 'member.id');
			text(member.name, 'member.name');
			const session = URI.parse(text(member.sessionUri, 'member.sessionUri'), true);
			check(session.scheme === 'copilotcli' && !session.authority && !session.query && !session.fragment && session.path.startsWith('/'), 'member.sessionUri');
			identifier(session.path.slice(1), 'member.sessionId');
			unique(sessions, extUri.getComparisonKey(session), 'member.sessionUri');
			check(member.chatUri === undefined || member.chatUri === buildDefaultChatUri(String(member.sessionUri)), 'member.chatUri must be the preserved session default chat');
			if (member.worktreeUri !== undefined) {
				check(sameRoomFile(localFile(member.worktreeUri, 'member.worktreeUri').fsPath, this.files.path('worktrees', roomId, id)), 'member worktree identity');
			}
			optional(member.model, text, 'member.model');
			const selection = member.modelSelection === undefined ? undefined : parseRoomModelSelection(member.modelSelection);
			const pending = member.pendingModel === undefined || member.pendingModel === null ? member.pendingModel : parseRoomModelSelection(member.pendingModel);
			if (selection !== undefined || pending !== undefined) {
				check(member.model === (pending === null ? 'auto' : (pending ?? selection)?.id), 'member.model does not match its selected model');
			}
			optional(member.modelError, text, 'member.modelError');
			if (member.configuration !== undefined) {
				parseRoomConfiguration(member.configuration, true);
			}
			enumValue(member.state, ['pending', 'starting', 'working', 'idle', 'blocked', 'needsInput', 'stopping', 'stopped', 'failed', 'interrupted'], 'member.state');
			optional(member.activity, text, 'member.activity');
			optional(member.error, text, 'member.error');
			count(member.turns, 'member.turns');
			check(member.removed === undefined || typeof member.removed === 'boolean', 'member.removed');
			if (!member.removed) {
				activeMembers++;
			}
			if (member.work !== undefined) {
				const work = object(member.work, 'member.work', ['description', 'blocked', 'updatedAt']);
				text(work.description, 'work.description', true);
				check(typeof work.blocked === 'boolean', 'work.blocked');
				count(work.updatedAt, 'work.updatedAt');
			}
		}
		check(activeMembers <= MAX_ROOM_WORKERS, 'room active member count');
		const artifactIds = new Set<string>();
		for (const value of array(room.artifacts, 'room.artifacts')) {
			const artifact = object(value, 'artifact', ['id', 'memberId', 'title', 'createdAt', 'baseRevision', 'sourceRevision', 'uri']);
			const id = identifier(artifact.id, 'artifact.id');
			check(isUUID(id), 'artifact.id must be a UUID');
			unique(artifactIds, id, 'artifact.id');
			check(memberIds.has(identifier(artifact.memberId, 'artifact.memberId')), 'artifact member is missing');
			text(artifact.title, 'artifact.title');
			count(artifact.createdAt, 'artifact.createdAt');
			check(commit(artifact.baseRevision, 'artifact.baseRevision') === base, 'artifact base differs from room');
			commit(artifact.sourceRevision, 'artifact.sourceRevision');
			check(sameRoomFile(localFile(artifact.uri, 'artifact.uri').fsPath, this.files.path('artifacts', roomId, `${id}.patch`)), 'artifact file identity');
		}
		if (room.run !== undefined) {
			const run = object(room.run, 'room.run', ['id', 'startedAt', 'deadline', 'limits', 'admittedTurns']);
			identifier(run.id, 'run.id');
			const startedAt = count(run.startedAt, 'run.startedAt');
			const limits = object(run.limits, 'run.limits', ['maxTurns', 'timeoutMinutes']);
			const maxTurns = count(limits.maxTurns, 'limits.maxTurns');
			check(maxTurns > 0, 'limits.maxTurns must be positive');
			if (limits.timeoutMinutes !== undefined) {
				check(typeof limits.timeoutMinutes === 'number' && Number.isFinite(limits.timeoutMinutes) && limits.timeoutMinutes > 0, 'limits.timeoutMinutes');
			}
			if (run.deadline !== undefined) {
				check(count(run.deadline, 'run.deadline') >= startedAt, 'run.deadline precedes start');
			}
			check((run.deadline === undefined) === (limits.timeoutMinutes === undefined), 'run deadline does not match timeout setting');
			check(count(run.admittedTurns, 'run.admittedTurns') <= maxTurns, 'run.admittedTurns exceeds limit');
		}
	}
}

function validateUpdate(previous: IRoomRecord, next: IRoomRecord): void {
	check(next.room.revision >= previous.room.revision, 'room.revision regressed');
	check(sameRoomFile(localFile(next.room.repositoryUri, 'repositoryUri').fsPath, localFile(previous.room.repositoryUri, 'repositoryUri').fsPath)
		&& next.room.baseRevision === previous.room.baseRevision, 'room repository changed');
	const identities = (room: IAgentHostRoom) => room.members.map(member => [member.id, member.name, member.sessionUri, member.chatUri ?? buildDefaultChatUri(member.sessionUri), member.worktreeUri]);
	const preserved = identities(previous.room);
	check(next.room.members.length >= previous.room.members.length && equals(preserved, identities(next.room).slice(0, preserved.length)), 'preserved member identities changed');
	for (const [index, member] of previous.room.members.entries()) {
		check(next.room.members[index].turns >= member.turns && (!member.removed || next.room.members[index].removed), 'member lifecycle regressed');
	}
	for (const execution of previous.executions) {
		check(!execution.initialized || next.executions.find(value => value.memberId === execution.memberId)?.initialized, 'execution initialization regressed');
	}
	for (const artifact of previous.room.artifacts) {
		check(equals(next.room.artifacts.find(value => value.id === artifact.id), artifact), 'published artifact changed');
	}
	const attributed = ({ deliveries, ...message }: IAgentHostRoomMessage) => message;
	check(next.messages.length >= previous.messages.length && previous.messages.every((message, index) => equals(attributed(message), attributed(next.messages[index]))), 'recorded room messages changed');
	if (previous.room.run) {
		check(next.room.run?.id === previous.room.run.id, 'run identity changed');
		check(next.room.run.admittedTurns >= previous.room.run.admittedTurns && next.room.run.startedAt === previous.room.run.startedAt
			&& next.room.run.limits.maxTurns! >= previous.room.run.limits.maxTurns!, 'run budget regressed');
	}
}

function enumValue(value: unknown, values: readonly string[], field: string): void {
	check(typeof value === 'string' && values.includes(value), field);
}

function optional(value: unknown, validate: (value: unknown, field: string) => void, field: string): void {
	if (value !== undefined) {
		validate(value, field);
	}
}

function unique(values: Set<string>, value: string, field: string): void {
	check(!values.has(value), `${field} is duplicated`);
	values.add(value);
}

function references(value: unknown, targets: ReadonlySet<string>, field: string): ReadonlySet<string> {
	const seen = new Set<string>();
	for (const entry of array(value, field)) {
		const id = identifier(entry, field);
		check(targets.has(id), `${field} references a missing identity`);
		unique(seen, id, field);
	}
	return seen;
}
