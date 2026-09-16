/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Tool } from '@github/copilot-sdk';
import { isStringArray } from '../../../../base/common/types.js';
import { MAX_ROOM_MESSAGE_LENGTH, MAX_ROOM_WORKERS } from '../../common/agentHostRooms.js';
import { IRoomSessionTools } from '../agentHostRooms.js';

/** Create and resume use the same host-bound identities and tool contracts. */
export function createCopilotRoomTools(sessionId: string, rooms: IRoomSessionTools): Tool[] {
	return [
		{
			name: 'room_read',
			description: 'Read room state and a bounded page of shared messages or one member inbox. Use after for newer messages or before for older history. Reading never changes receipts or starts a turn. Reserved means assigned to a host turn; submitted means native host input was submitted, not provider acceptance or task completion. Do not poll while idle.',
			parameters: {
				type: 'object',
				properties: {
					after: { type: 'integer', minimum: 0 }, before: { type: 'integer', minimum: 1 },
					limit: { type: 'integer', minimum: 1, maximum: 200 }, memberId: { type: 'string' },
				},
				additionalProperties: false,
			},
			handler: args => {
				const { after, before, limit, memberId } = readArguments(args, ['after', 'before', 'limit', 'memberId']);
				if ((after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0))
					|| (before !== undefined && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1))
					|| (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200))
					|| (memberId !== undefined && typeof memberId !== 'string')) {
					throw new Error('Use integer room message cursors and a limit from 1 to 200');
				}
				return rooms.read(sessionId, { after, before, limit, memberId });
			},
		},
		{
			name: 'room_post',
			description: 'Persist a useful peer request, reply, finding, or work update in the shared room. Supply explicit recipient member IDs; names and text mentions do not select recipients. Empty mentions creates a passive note and wakes nobody. Addressed messages attach to an eligible recipient\'s next native input within the human-approved budget; busy recipients queue them without steering. Reuse an ID only to retry the identical post. Avoid acknowledgement-only chatter.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Stable message ID. Reuse only for an identical retry.' },
					text: { type: 'string', maxLength: MAX_ROOM_MESSAGE_LENGTH },
					mentions: { type: 'array', items: { type: 'string' }, maxItems: MAX_ROOM_WORKERS, uniqueItems: true, description: 'Exact member IDs. Empty makes a passive room note.' },
					kind: { type: 'string', enum: ['message', 'work', 'finding'] },
					replyTo: { type: 'string' },
					artifactIds: { type: 'array', items: { type: 'string' }, maxItems: 20, uniqueItems: true },
					blocked: { type: 'boolean' },
				},
				required: ['id', 'text', 'mentions'],
				additionalProperties: false,
			},
			handler: args => {
				const { id, text, mentions, kind, replyTo, artifactIds, blocked } = readArguments(args, ['id', 'text', 'mentions', 'kind', 'replyTo', 'artifactIds', 'blocked']);
				if (typeof id !== 'string' || typeof text !== 'string' || !isStringArray(mentions)
					|| (kind !== undefined && kind !== 'message' && kind !== 'work' && kind !== 'finding')
					|| (replyTo !== undefined && typeof replyTo !== 'string')
					|| (artifactIds !== undefined && !isStringArray(artifactIds))
					|| (blocked !== undefined && typeof blocked !== 'boolean')) {
					throw new Error('Invalid room post');
				}
				return rooms.post(sessionId, { id, text, mentions, kind, replyTo, artifactIds, blocked });
			},
		},
		{
			name: 'room_share_patch',
			description: 'Publish an immutable Git binary patch from your own worktree relative to the room base, including new and deleted files. Publishing does not apply, merge, commit, or wake peers. Send its artifact ID with room_post when requesting review.',
			parameters: { type: 'object', properties: { title: { type: 'string', maxLength: 200 } }, required: ['title'], additionalProperties: false },
			handler: args => {
				const { title } = readArguments(args, ['title']);
				if (typeof title !== 'string') {
					throw new Error('A patch title is required');
				}
				return rooms.sharePatch(sessionId, title);
			},
		},
		{
			name: 'room_read_artifact',
			description: 'Inspect a published patch before adopting it. Return attributed metadata, a read-only patch path, and paginated text subject to normal content exclusions. Apply a patch only in your own worktree using normal approved Git tools; never modify another peer\'s files.',
			parameters: {
				type: 'object', properties: { artifactId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
				required: ['artifactId'], additionalProperties: false,
			},
			handler: args => {
				const { artifactId, offset } = readArguments(args, ['artifactId', 'offset']);
				if (typeof artifactId !== 'string' || (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0))) {
					throw new Error('Provide a published artifact ID and an optional nonnegative offset');
				}
				return rooms.readArtifact(sessionId, artifactId, offset);
			},
		},
	];
}

function readArguments(args: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) {
		throw new Error('Invalid room tool arguments');
	}
	return args as Record<string, unknown>;
}
