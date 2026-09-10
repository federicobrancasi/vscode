/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Tool } from '@github/copilot-sdk';
import { isStringArray } from '../../../../base/common/types.js';
import { IRoomSessionTools } from '../agentHostRooms.js';

/**
 * Session and author identities come only from the launch binding, never
 * model-supplied arguments. Tools are also installed when resuming sessions.
 */
export function createCopilotRoomTools(sessionId: string, rooms: IRoomSessionTools): Tool[] {
	return [
		{
			name: 'room_read',
			description: 'Read your identity, shared goal, peer work, pending inbox, human guidance, published artifacts, and room messages before choosing work. Check for completed or overlapping work. Use before/after message sequences for older history; do not poll while idle.',
			parameters: { type: 'object', properties: { after: { type: 'integer', minimum: 0 }, before: { type: 'integer', minimum: 1 } }, additionalProperties: false },
			handler: args => {
				const { after, before } = readArguments(args);
				if ((after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0))
					|| (before !== undefined && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1))) {
					throw new Error('Use integer room message cursors');
				}
				return rooms.read(sessionId, { after: typeof after === 'number' ? after : undefined, before: typeof before === 'number' ? before : undefined });
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
			description: 'Post to the shared room as yourself. First announce intent with kind work; publish evidence or negative results with kind finding. Only explicitly mentioned peers receive an inbox message. Supply a substantive nextStep to continue useful work after this turn, or omit it to wait for another request. Respect pause, stop, and any optional run limits.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Unique stable message ID. Reuse only when retrying the same post.' },
					text: { type: 'string' },
					kind: { type: 'string', enum: ['message', 'work', 'finding'] },
					mentions: { type: 'array', items: { type: 'string' }, description: 'Member IDs or names such as Copilot-2. Empty means no notification.' },
					replyTo: { type: 'string' },
					nextStep: { type: 'string' },
					blocked: { type: 'boolean' },
				},
				required: ['id', 'text', 'kind', 'mentions'],
				additionalProperties: false,
			},
			handler: args => {
				if (!args || typeof args !== 'object') {
					throw new Error('Invalid room post');
				}
				const { id, text, kind, mentions, replyTo, nextStep, blocked } = args as Record<string, unknown>;
				if (typeof id !== 'string' || typeof text !== 'string'
					|| (kind !== 'message' && kind !== 'work' && kind !== 'finding')
					|| !isStringArray(mentions)
					|| (replyTo !== undefined && typeof replyTo !== 'string')
					|| (nextStep !== undefined && typeof nextStep !== 'string')
					|| (blocked !== undefined && typeof blocked !== 'boolean')) {
					throw new Error('Invalid room post');
				}
				return rooms.post(sessionId, { id, text, kind, mentions, replyTo, nextStep, blocked });
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
