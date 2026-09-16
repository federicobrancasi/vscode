/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepFreeze } from '../../../base/common/objects.js';
import { join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { AgentHostRoomDeliveryState, AgentHostRoomMessageKind, IAgentHostRoomArchiveSession, IAgentHostRoomArtifact, IAgentHostRoomDelivery, IAgentHostRoomMember, IAgentHostRoomMessage } from '../common/agentHostRooms.js';
import { buildDefaultChatUri } from '../common/state/sessionState.js';
import { checkRoomData as check, roomArray as array, roomCommit as commit, roomCount as count, roomId as identifier, roomLocalFile as localFile, roomObject as object, roomText as text, sameRoomFile } from './agentHostRoomStorageUtils.js';
import { parseRoomConfiguration } from './agentHostRoomsConfiguration.js';
import { parseRoomModelSelection } from './agentHostRoomsModels.js';
import { IRoomArchive } from './agentHostRoomsTypes.js';

/** Projects old experiments without migrating their bytes or restoring their execution state. */
export function parseRoomArchive(contents: string, root: string): IRoomArchive {
	const record = object(JSON.parse(contents), 'archive');
	check(record.version === 1, 'unsupported archive version');
	const source = object(record.room, 'archive.room');
	const id = identifier(source.id, 'archive.room.id');
	const sessions: IAgentHostRoomArchiveSession[] = [];
	const members: IAgentHostRoomMember[] = array(source.members, 'archive.members').map(value => {
		const member = object(value, 'archive.member');
		const identity = sessionIdentity(member, root, id);
		sessions.push(identity);
		const work = member.work === undefined ? undefined : object(member.work, 'archive.work');
		check(member.removed === undefined || typeof member.removed === 'boolean', 'archive.member.removed');
		check(!work || typeof work.blocked === 'boolean', 'archive.work.blocked');
		return {
			...identity,
			model: optionalText(member.model),
			modelSelection: member.modelSelection === undefined ? undefined : parseRoomModelSelection(member.modelSelection),
			pendingModel: member.pendingModel === undefined || member.pendingModel === null ? member.pendingModel : parseRoomModelSelection(member.pendingModel),
			modelError: optionalText(member.modelError),
			state: 'stopped',
			activity: optionalText(member.activity),
			work: work ? {
				description: [text(work.description, 'archive.work.description', true), optionalText(work.nextStep)].filter(value => value !== undefined).join('\n'),
				blocked: work.blocked === true,
				updatedAt: count(work.updatedAt, 'archive.work.updatedAt'),
			} : undefined,
			error: optionalText(member.error),
			turns: count(member.turns, 'archive.member.turns'),
			removed: member.removed === true,
			configuration: member.configuration === undefined ? undefined : parseRoomConfiguration(member.configuration, true),
		};
	});
	if (source.coordinator !== undefined) {
		sessions.push(sessionIdentity(object(source.coordinator, 'archive.coordinator'), root, id));
	}
	check(new Set(sessions.map(session => session.id)).size === sessions.length, 'archive participant identity is duplicated');
	const authors = new Map(sessions.map(session => [session.id, session.name]));
	const memberIds = new Set(members.map(member => member.id));
	const baseRevision = commit(source.baseRevision, 'archive.baseRevision');
	const artifacts: IAgentHostRoomArtifact[] = array(source.artifacts, 'archive.artifacts').map(value => {
		const artifact = object(value, 'archive.artifact');
		const artifactId = identifier(artifact.id, 'archive.artifact.id');
		const memberId = identifier(artifact.memberId, 'archive.artifact.memberId');
		check(authors.has(memberId), 'archive artifact author is missing');
		const uri = text(artifact.uri, 'archive.artifact.uri');
		check(sameRoomFile(localFile(uri, 'archive.artifact.uri').fsPath, join(root, 'artifacts', id, `${artifactId}.patch`)), 'archive artifact identity');
		check(commit(artifact.baseRevision, 'archive.artifact.baseRevision') === baseRevision, 'archive artifact base revision');
		return {
			id: artifactId, memberId, uri, baseRevision,
			title: text(artifact.title, 'archive.artifact.title'),
			createdAt: count(artifact.createdAt, 'archive.artifact.createdAt'),
			sourceRevision: commit(artifact.sourceRevision, 'archive.artifact.sourceRevision'),
		};
	});
	const artifactIds = new Set(artifacts.map(artifact => artifact.id));
	check(artifactIds.size === artifacts.length, 'archive artifact identity is duplicated');
	const seen = new Set<string>();
	const messages: IAgentHostRoomMessage[] = array(record.messages, 'archive.messages').map((value, index) => {
		const message = object(value, 'archive.message');
		const messageId = identifier(message.id, 'archive.message.id');
		check(!seen.has(messageId) && message.sequence === index + 1, 'archive message order or identity');
		const authorKind = choice(message.authorKind, ['human', 'agent', 'system'], 'archive.authorKind');
		const authorId = identifier(message.authorId, 'archive.authorId');
		const authorName = text(message.authorName, 'archive.authorName');
		check(authorKind === 'agent' ? authors.get(authorId) === authorName : authorId === authorKind, 'archive author identity');
		const legacyKind = choice(message.kind, ['message', 'work', 'finding', 'artifact', 'system', 'result', 'verification', 'coordination'], 'archive.message.kind');
		const kind: AgentHostRoomMessageKind = legacyKind === 'result' || legacyKind === 'verification' || legacyKind === 'coordination' ? 'message' : legacyKind;
		let body = text(message.text, 'archive.message.text', true);
		for (const field of ['assignment', 'result', 'verification']) {
			if (message[field] !== undefined) {
				body += `\n\n${localize('rooms.archiveDetails', "Archived {0} record:", field)}\n${JSON.stringify(object(message[field], `archive.${field}`), null, '\t')}`;
			}
		}
		const result = message.result === undefined ? undefined : object(message.result, 'archive.result');
		const verification = message.verification === undefined ? undefined : object(message.verification, 'archive.verification');
		const replyTo = optionalText(message.replyTo ?? verification?.resultId ?? result?.assignmentId);
		check(replyTo === undefined || seen.has(replyTo), 'archive reply references a missing earlier message');
		const mentions = ids(message.mentions, memberIds, 'archive.mentions');
		const artifactId = optionalText(message.artifactId);
		check(artifactId === undefined || artifactIds.has(artifactId), 'archive artifact reference is missing');
		const linkedArtifacts = result?.artifactIds === undefined ? undefined : ids(result.artifactIds, artifactIds, 'archive.result.artifactIds');
		const deliveries = array(message.deliveries, 'archive.deliveries').map(value => archiveDelivery(value, memberIds));
		check(new Set(deliveries.map(delivery => delivery.memberId)).size === deliveries.length, 'archive delivery is duplicated');
		seen.add(messageId);
		return {
			id: messageId, sequence: index + 1, authorId, authorName, authorKind, kind, text: body,
			timestamp: count(message.timestamp, 'archive.timestamp'), mentions, replyTo, artifactId,
			artifactIds: linkedArtifacts, deliveries,
		};
	});
	check(messages.length === count(source.latestMessageSequence, 'archive.latestMessageSequence'), 'archive message count');
	const run = source.run === undefined ? undefined : object(source.run, 'archive.run');
	const limits = run === undefined ? undefined : object(run.limits, 'archive.run.limits');
	return deepFreeze({
		room: {
			id, revision: count(source.revision, 'archive.revision'),
			title: text(source.title, 'archive.title'), goal: text(source.goal, 'archive.goal'),
			instructions: text(source.instructions, 'archive.instructions', true),
			repositoryUri: localFile(source.repositoryUri, 'archive.repositoryUri').toString(),
			baseRevision, createdAt: count(source.createdAt, 'archive.createdAt'), updatedAt: count(source.updatedAt, 'archive.updatedAt'),
			state: 'stopped', archived: true, archivedSessions: sessions, members, artifacts,
			latestMessageSequence: messages.length, error: optionalText(source.error),
			run: run && limits ? {
				id: identifier(run.id, 'archive.run.id'), startedAt: count(run.startedAt, 'archive.run.startedAt'),
				deadline: run.deadline === undefined ? undefined : count(run.deadline, 'archive.run.deadline'),
				limits: {
					maxTurns: limits.maxTurns === undefined ? undefined : count(limits.maxTurns, 'archive.run.maxTurns'),
					timeoutMinutes: limits.timeoutMinutes === undefined ? undefined : positiveNumber(limits.timeoutMinutes, 'archive.run.timeoutMinutes'),
				},
				admittedTurns: count(run.admittedTurns, 'archive.run.admittedTurns'),
			} : undefined,
		},
		messages,
		sessionUris: sessions.map(session => session.sessionUri),
	});
}

function sessionIdentity(source: Record<string, unknown>, root: string, roomId: string): IAgentHostRoomArchiveSession {
	const id = identifier(source.id, 'archive.participant.id');
	const sessionUri = text(source.sessionUri, 'archive.participant.sessionUri');
	const session = URI.parse(sessionUri, true);
	check(session.scheme === 'copilotcli' && !session.authority && !session.query && !session.fragment && session.path.startsWith('/'), 'archive session identity');
	identifier(session.path.slice(1), 'archive.session.id');
	const chatUri = optionalText(source.chatUri);
	check(chatUri === undefined || chatUri === buildDefaultChatUri(sessionUri), 'archive session default chat');
	const worktreeUri = optionalText(source.worktreeUri);
	check(worktreeUri === undefined || sameRoomFile(localFile(worktreeUri, 'archive.worktreeUri').fsPath, join(root, 'worktrees', roomId, id)), 'archive worktree identity');
	return { id, name: text(source.name, 'archive.participant.name'), sessionUri, chatUri, worktreeUri };
}

function archiveDelivery(value: unknown, members: ReadonlySet<string>): IAgentHostRoomDelivery {
	const source = object(value, 'archive.delivery');
	const memberId = identifier(source.memberId, 'archive.delivery.memberId');
	check(members.has(memberId), 'archive delivery recipient is missing');
	const legacy = choice(source.state, ['pending', 'submitted', 'failed', 'interrupted', 'cancelled', 'completed', 'delivered', 'steering'], 'archive.delivery.state');
	const state: AgentHostRoomDeliveryState = legacy === 'completed' || legacy === 'delivered' || legacy === 'steering' ? 'interrupted' : legacy;
	return {
		memberId, state, turnId: optionalText(source.turnId),
		error: legacy === state ? optionalText(source.error) : localize('rooms.archiveDelivery', "Legacy status: {0}. Model delivery is not reconciled for archives.", legacy),
	};
}

function optionalText(value: unknown): string | undefined {
	return value === undefined ? undefined : text(value, 'archive.text', true);
}

function ids(value: unknown, known: ReadonlySet<string>, field: string): string[] {
	const values = array(value, field).map(value => identifier(value, field));
	check(new Set(values).size === values.length && values.every(id => known.has(id)), field);
	return values;
}

function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
	const selected = values.find(candidate => candidate === value);
	check(selected !== undefined, field);
	return selected;
}

function positiveNumber(value: unknown, field: string): number {
	check(typeof value === 'number' && Number.isFinite(value) && value > 0, field);
	return value;
}
