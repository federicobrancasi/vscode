/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHostRoomCoordinatorAssignmentSnapshot, IAgentHostRoomCoordinatorIssueSnapshot, IAgentHostRoomCoordinatorSnapshot, IAgentHostRoomCoordinatorUnownedWorkSnapshot, IAgentHostRoomMessage, AgentHostRoomVerificationState } from '../common/agentHostRooms.js';
import { IRoomRecord } from './agentHostRoomsTypes.js';

const MAX_ACTIVE_ASSIGNMENTS = 20;
const MAX_RECENT_ASSIGNMENTS = 50;
const MAX_RECENT_RESULTS = 50;
const MAX_PENDING_GUIDANCE = 20;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_TEXT = 1000;
const MAX_SNAPSHOT_TEXT = 2000;

function snapshotText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : value.slice(0, MAX_SNAPSHOT_TEXT);
}

function snapshotEvidence(value: string): string {
	return value.slice(0, MAX_EVIDENCE_TEXT);
}

function verificationState(messages: readonly IAgentHostRoomMessage[], resultId: string): AgentHostRoomVerificationState {
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

function assignmentSnapshots(record: IRoomRecord): readonly IAgentHostRoomCoordinatorAssignmentSnapshot[] {
	const assignments = record.messages.filter(message => message.assignment);
	const superseded = new Set(assignments.flatMap(message => message.assignment?.supersedes ? [message.assignment.supersedes] : []));
	return assignments.map(message => {
		const assignment = message.assignment!;
		const linkedResults = record.messages.filter(candidate => candidate.result?.assignmentId === message.id);
		const linkedVerifications = assignment.resultId
			? record.messages.filter(candidate => candidate.verification?.resultId === assignment.resultId && assignment.assigneeIds.includes(candidate.authorId))
			: [];
		const completedAssigneeIds = assignment.kind === 'work'
			? assignment.assigneeIds.filter(id => linkedResults.some(result => result.authorId === id))
			: assignment.assigneeIds.filter(id => linkedVerifications.some(verification => verification.authorId === id));
		const state = superseded.has(message.id)
			? 'superseded'
			: completedAssigneeIds.length === assignment.assigneeIds.length ? 'completed' : 'pending';
		return {
			id: message.id,
			sequence: message.sequence,
			kind: assignment.kind,
			description: snapshotText(assignment.description)!,
			assigneeIds: assignment.assigneeIds,
			expectedEvidence: assignment.expectedEvidence.slice(0, MAX_EVIDENCE_ITEMS).map(snapshotEvidence),
			resultId: assignment.resultId,
			supersedes: assignment.supersedes,
			state,
			completedAssigneeIds,
			evidenceIds: [message.id, ...linkedResults.map(result => result.id), ...linkedVerifications.map(verification => verification.id)],
		};
	});
}

export function projectAgentHostRoomCoordinatorSnapshot(record: IRoomRecord): IAgentHostRoomCoordinatorSnapshot {
	const coordinator = record.room.coordinator;
	if (!coordinator) {
		throw new Error('The collaboration room does not have a coordinator.');
	}
	const assignmentHistory = assignmentSnapshots(record);
	const activeAssignments = assignmentHistory.filter(assignment => assignment.state === 'pending').slice(-MAX_ACTIVE_ASSIGNMENTS);
	const retainedAssignmentIds = new Set([
		...activeAssignments.map(assignment => assignment.id),
		...assignmentHistory.slice(-MAX_RECENT_ASSIGNMENTS).map(assignment => assignment.id),
	]);
	const assignments = assignmentHistory.filter(assignment => retainedAssignmentIds.has(assignment.id));
	const resultHistory = record.messages.flatMap(message => {
		if (!message.result) {
			return [];
		}
		const verifications = record.messages.filter(candidate => candidate.verification?.resultId === message.id);
		return [{
			id: message.id,
			sequence: message.sequence,
			authorId: message.authorId,
			assignmentId: message.result.assignmentId,
			title: message.result.title,
			summary: snapshotText(message.result.summary)!,
			outcome: message.result.outcome,
			verificationState: verificationState(record.messages, message.id),
			verificationIds: verifications.map(verification => verification.id),
			evidence: message.result.evidence.slice(0, MAX_EVIDENCE_ITEMS).map(snapshotEvidence),
			evidenceIds: [message.id, ...message.result.artifactIds, ...verifications.map(verification => verification.id)],
		}];
	});
	const retainedResultIds = new Set([
		...resultHistory.slice(-MAX_RECENT_RESULTS).map(result => result.id),
		...assignments.flatMap(assignment => assignment.resultId ? [assignment.resultId] : []),
		...resultHistory.filter(result => result.assignmentId && retainedAssignmentIds.has(result.assignmentId)).map(result => result.id),
	]);
	const results = resultHistory.filter(result => retainedResultIds.has(result.id));
	const workers = record.room.members.map(member => {
		const workerAssignments = activeAssignments.filter(assignment => assignment.assigneeIds.includes(member.id));
		const pairedWith = [...new Set(workerAssignments.flatMap(assignment => assignment.assigneeIds).filter(id => id !== member.id))];
		return {
			id: member.id,
			name: member.name,
			state: member.state,
			removed: member.removed === true,
			turns: member.turns,
			work: member.work && { ...member.work, description: snapshotText(member.work.description)! },
			pairedWith,
			assignmentIds: workerAssignments.map(assignment => assignment.id),
			evidenceIds: [
				...workerAssignments.map(assignment => assignment.id),
				...record.messages.filter(message => message.authorId === member.id && (message.result || message.verification)).map(message => message.id),
			],
		};
	});
	const issues = record.room.members.flatMap<IAgentHostRoomCoordinatorIssueSnapshot>(member => {
		const kind = member.state === 'blocked' || member.work?.blocked
			? 'blocked'
			: member.state === 'failed' ? 'failed' : member.state === 'needsInput' ? 'needsInput' : undefined;
		if (!kind) {
			return [];
		}
		const evidenceIds = kind === 'blocked'
			? record.messages.filter(message => message.authorId === member.id
				&& (message.result?.outcome === 'blocked' || message.kind === 'work' && message.text === member.work?.description)).slice(-1).map(message => message.id)
			: [];
		return [{ memberId: member.id, kind, description: snapshotText(member.error ?? member.work?.description), evidenceIds }];
	});
	const pendingHumanGuidance = record.messages
		.filter(message => message.authorKind === 'human' && message.sequence > coordinator.cursor)
		.slice(-MAX_PENDING_GUIDANCE)
		.map(message => ({ id: message.id, sequence: message.sequence, text: snapshotText(message.text)!, evidenceIds: [message.id] }));
	const activelyAssignedWorkers = new Set(activeAssignments.filter(assignment => assignment.kind === 'work').flatMap(assignment => assignment.assigneeIds));
	const unownedWork: IAgentHostRoomCoordinatorUnownedWorkSnapshot[] = record.room.members.flatMap(member =>
		member.work && !member.removed && !activelyAssignedWorkers.has(member.id)
			? [{
				id: `worker-work:${member.id}`,
				description: snapshotText(member.work.description)!,
				memberId: member.id,
				evidenceIds: record.messages.filter(message => message.authorId === member.id
					&& (message.result?.summary === member.work?.description || message.kind === 'work' && message.text === member.work?.description)).slice(-1).map(message => message.id),
			}]
			: []);
	if (!activeAssignments.some(assignment => assignment.kind === 'work')) {
		unownedWork.unshift({ id: 'room-goal', description: record.room.goal, evidenceIds: [] });
	}
	return {
		room: {
			id: record.room.id,
			title: record.room.title,
			goal: record.room.goal,
			state: record.room.state,
			sequence: record.room.latestMessageSequence,
		},
		coordinator,
		workers,
		assignments,
		results,
		issues,
		pendingHumanGuidance,
		unownedWork,
		evidenceIds: [...new Set([
			...assignments.map(assignment => assignment.id),
			...results.flatMap(result => result.evidenceIds),
			...issues.flatMap(issue => issue.evidenceIds),
			...pendingHumanGuidance.map(guidance => guidance.id),
			...unownedWork.flatMap(work => work.evidenceIds),
			...record.room.artifacts.slice(-MAX_RECENT_RESULTS).map(artifact => artifact.id),
		])],
	};
}
