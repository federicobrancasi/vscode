/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Tool } from '@github/copilot-sdk';
import { isStringArray } from '../../../../base/common/types.js';
import { IRoomCoordinatorTools, IRoomSessionTools } from '../agentHostRooms.js';

export function createCopilotRoomCoordinatorTools(sessionId: string, rooms: IRoomCoordinatorTools): Tool[] {
	return [
		{
			name: 'room_coordinator_snapshot',
			description: 'Read deterministic typed room facts: workers, explicit assignments and pairings, results and verification, blockers and failures, pending human guidance, unowned work, room sequence, and immutable evidence IDs. Status text never creates a pairing.',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			handler: args => {
				if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
					throw new Error('The coordinator snapshot tool takes no arguments');
				}
				return rooms.coordinatorSnapshot(sessionId);
			},
		},
		{
			name: 'room_assign',
			description: 'Create one immutable structured work or verification assignment for one or more room members. Use supersedes to redirect existing work, resultId for verification requests, expectedEvidence for completion criteria, and note only when a visible coordination message is useful.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Unique stable assignment ID. Reuse only when retrying the identical assignment.' },
					assignees: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, uniqueItems: true },
					kind: { type: 'string', enum: ['work', 'verification'] },
					description: { type: 'string', maxLength: 8000 },
					expectedEvidence: { type: 'array', items: { type: 'string', maxLength: 2000 }, minItems: 1, maxItems: 20 },
					resultId: { type: 'string' },
					supersedes: { type: 'string' },
					note: { type: 'string', maxLength: 32000 },
				},
				required: ['id', 'assignees', 'kind', 'description', 'expectedEvidence'],
				additionalProperties: false,
			},
			handler: args => {
				const { id, assignees, kind, description, expectedEvidence, resultId, supersedes, note } = readArguments(args);
				if (typeof id !== 'string' || !isStringArray(assignees)
					|| (kind !== 'work' && kind !== 'verification')
					|| typeof description !== 'string' || !isStringArray(expectedEvidence)
					|| (resultId !== undefined && typeof resultId !== 'string')
					|| (supersedes !== undefined && typeof supersedes !== 'string')
					|| (note !== undefined && typeof note !== 'string')) {
					throw new Error('Invalid room assignment');
				}
				return rooms.assign(sessionId, { id, assignees, kind, description, expectedEvidence, resultId, supersedes, note });
			},
		},
		{
			name: 'room_post',
			description: 'Post a visible informational note to Activity as the coordinator. Use this only to explain coordination state that should be shared with workers; use room_assign for work, redirection, pairing, or verification. The note does not notify or wake workers.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Unique stable message ID. Reuse only when retrying the identical note.' },
					text: { type: 'string', maxLength: 32000 },
				},
				required: ['id', 'text'],
				additionalProperties: false,
			},
			handler: args => {
				const { id, text } = readArguments(args);
				if (typeof id !== 'string' || typeof text !== 'string') {
					throw new Error('Invalid room coordination note');
				}
				return rooms.postCoordinationNote(sessionId, id, text);
			},
		},
	];
}

/**
 * Session and author identities come only from the launch binding, never
 * model-supplied arguments. Tools are also installed when resuming sessions.
 */
export function createCopilotRoomTools(sessionId: string, rooms: IRoomSessionTools): Tool[] {
	return [
		{
			name: 'room_read',
			description: 'Read your identity, shared goal, peer work, pending inbox, human guidance, published artifacts, structured results, verifications, and ordered room messages. Use limit for the latest messages, after with the last sequence you saw for newer messages, or before for older history. Do not poll while idle.',
			parameters: { type: 'object', properties: { after: { type: 'integer', minimum: 0 }, before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
			handler: args => {
				const { after, before, limit } = readArguments(args);
				if ((after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0))
					|| (before !== undefined && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1))
					|| (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200))) {
					throw new Error('Use integer room message cursors and a limit from 1 to 200');
				}
				return rooms.read(sessionId, {
					after: typeof after === 'number' ? after : undefined,
					before: typeof before === 'number' ? before : undefined,
					limit: typeof limit === 'number' ? limit : undefined,
				});
			},
		},
		{
			name: 'room_read_artifact',
			description: 'Inspect another peer\'s published patch before building on it. Returns attributed metadata, a read-only canonical patch path, and paginated text. Check and explicitly apply the patch only in your own worktree with normal approved Git tools; never edit the original repository or another peer\'s files.',
			parameters: { type: 'object', properties: { artifactId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['artifactId'], additionalProperties: false },
			handler: args => {
				const { artifactId, offset } = readArguments(args);
				if (typeof artifactId !== 'string' || (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0))) {
					throw new Error('Provide a published artifact ID and an optional nonnegative offset');
				}
				return rooms.readArtifact(sessionId, artifactId, typeof offset === 'number' ? offset : undefined);
			},
		},
		{
			name: 'room_post',
			description: 'Post a focused question, informal finding, work update, or useful peer reply to the shared room as yourself. Use room_publish_result for meaningful completed outcomes. Avoid routine progress updates. Only explicitly mentioned peers receive an inbox message; peer suggestions are optional. Use blocked only for a genuine condition that prevents further work.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Unique stable message ID. Reuse only when retrying the same post.' },
					text: { type: 'string' },
					kind: { type: 'string', enum: ['message', 'work', 'finding'] },
					mentions: { type: 'array', items: { type: 'string' }, description: 'Member IDs or names such as Copilot-2. Empty means no notification.' },
					replyTo: { type: 'string' },
					blocked: { type: 'boolean' },
				},
				required: ['id', 'text', 'kind', 'mentions'],
				additionalProperties: false,
			},
			handler: args => {
				if (!args || typeof args !== 'object') {
					throw new Error('Invalid room post');
				}
				const { id, text, kind, mentions, replyTo, blocked } = args as Record<string, unknown>;
				if (typeof id !== 'string' || typeof text !== 'string'
					|| (kind !== 'message' && kind !== 'work' && kind !== 'finding')
					|| !isStringArray(mentions)
					|| (replyTo !== undefined && typeof replyTo !== 'string')
					|| (blocked !== undefined && typeof blocked !== 'boolean')) {
					throw new Error('Invalid room post');
				}
				return rooms.post(sessionId, { id, text, kind, mentions, replyTo, blocked });
			},
		},
		{
			name: 'room_yield',
			description: 'Choose whether the room should admit another turn for you after this one. Use continue only when you have a concrete next step that can proceed immediately. Use wait when you depend on another result, input, or approval, or have no actionable work; a later assignment or human message will wake you. Call exactly once before ending every turn. Never continue merely to poll room_read.',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['continue', 'wait'] },
					reason: { type: 'string', maxLength: 2000, description: 'Concrete next step for continue, or the dependency/reason for wait.' },
				},
				required: ['action', 'reason'],
				additionalProperties: false,
			},
			handler: args => {
				const { action, reason } = readArguments(args);
				if ((action !== 'continue' && action !== 'wait') || typeof reason !== 'string') {
					throw new Error('Invalid room yield decision');
				}
				return rooms.yieldTurn(sessionId, action, reason);
			},
		},
		{
			name: 'room_publish_result',
			description: 'Publish an immutable structured result after meaningful implementation or investigation. Include reproducible evidence and reference only patches you already published with room_share_patch. The result starts pending independent verification and does not notify or wake peers.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Unique stable result ID. Reuse only when retrying the same publication.' },
					title: { type: 'string', maxLength: 200 },
					summary: { type: 'string', maxLength: 8000 },
					outcome: { type: 'string', enum: ['success', 'negative', 'inconclusive', 'blocked'] },
					evidence: { type: 'array', items: { type: 'string', maxLength: 2000 }, minItems: 1, maxItems: 20 },
					artifactIds: { type: 'array', items: { type: 'string' }, maxItems: 20, uniqueItems: true },
					assignmentId: { type: 'string', description: 'Coordinator work assignment satisfied by this result.' },
				},
				required: ['id', 'title', 'summary', 'outcome', 'evidence', 'artifactIds'],
				additionalProperties: false,
			},
			handler: args => {
				const { id, title, summary, outcome, evidence, artifactIds, assignmentId } = readArguments(args);
				if (typeof id !== 'string' || typeof title !== 'string' || typeof summary !== 'string'
					|| (outcome !== 'success' && outcome !== 'negative' && outcome !== 'inconclusive' && outcome !== 'blocked')
					|| !isStringArray(evidence) || !isStringArray(artifactIds)
					|| (assignmentId !== undefined && typeof assignmentId !== 'string')) {
					throw new Error('Invalid structured room result');
				}
				return rooms.publishResult(sessionId, { id, title, summary, outcome, evidence, artifactIds, assignmentId });
			},
		},
		{
			name: 'room_verify_result',
			description: 'Independently verify or reject another agent\'s structured result after reading it and checking the claimed evidence. You cannot verify your own result. Reviews are permanent attributed room records; a later human verdict is authoritative.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Unique stable review ID. Reuse only when retrying the same review.' },
					resultId: { type: 'string' },
					verdict: { type: 'string', enum: ['verified', 'rejected'] },
					evidence: { type: 'array', items: { type: 'string', maxLength: 2000 }, minItems: 1, maxItems: 20 },
				},
				required: ['id', 'resultId', 'verdict', 'evidence'],
				additionalProperties: false,
			},
			handler: args => {
				const { id, resultId, verdict, evidence } = readArguments(args);
				if (typeof id !== 'string' || typeof resultId !== 'string'
					|| (verdict !== 'verified' && verdict !== 'rejected') || !isStringArray(evidence)) {
					throw new Error('Invalid room result verification');
				}
				return rooms.reviewResult(sessionId, { id, resultId, verdict, evidence });
			},
		},
		{
			name: 'room_share_patch',
			description: 'Publish an immutable Git binary patch of your worktree relative to the room base, including new and deleted files. Publishing never applies, merges, or commits changes.',
			parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
			handler: args => {
				const title = args && typeof args === 'object' ? (args as { title?: unknown }).title : undefined;
				if (typeof title !== 'string') {
					throw new Error('A patch title is required');
				}
				return rooms.sharePatch(sessionId, title);
			},
		},
	];
}

function readArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		throw new Error('Expected room tool arguments');
	}
	return args as Record<string, unknown>;
}
