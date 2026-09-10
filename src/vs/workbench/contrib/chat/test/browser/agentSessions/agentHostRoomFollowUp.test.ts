/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAgentHostRoom, IAgentHostRoomPostOptions, IAgentHostRoomsService, OpenCollaborationRoomCommandId } from '../../../../../../platform/agentHost/common/agentHostRooms.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { forwardRoomFollowUp } from '../../../browser/agentSessions/agentHost/agentHostRoomFollowUp.js';
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { IChatAgentRequest } from '../../../common/participants/chatAgents.js';

suite('AgentHostRoomFollowUp', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const session = URI.parse('copilotcli:/peer-session');
	const authenticated = async () => { };

	function setup(state: IAgentHostRoom['state'] = 'stopped', deadline = 0, admittedTurns = 1) {
		const room: IAgentHostRoom = {
			id: 'room-a', revision: 1, title: 'Shared work', goal: 'Build a page', instructions: '',
			repositoryUri: 'file:///repo', baseRevision: 'a'.repeat(40),
			createdAt: 0, updatedAt: 0, state, latestMessageSequence: 0, artifacts: [],
			members: [{ id: 'member-a', name: 'Copilot-1', sessionUri: session.toString(), state: 'idle', turns: 1 }],
			run: { id: 'run-a', startedAt: 0, deadline, limits: { maxTurns: 3, timeoutMinutes: 1 }, admittedTurns },
		};
		const posts: { roomId: string; message: IAgentHostRoomPostOptions }[] = [];
		const rooms = new class extends mock<IAgentHostRoomsService>() {
			override async listRooms(): Promise<readonly IAgentHostRoom[]> { return [room]; }
			override async postMessage(roomId: string, message: IAgentHostRoomPostOptions) {
				posts.push({ roomId, message });
				return {
					...message, sequence: 1, authorId: 'human', authorName: 'You', authorKind: 'human' as const, kind: 'message' as const,
					timestamp: 0, deliveries: [{ memberId: 'member-a', state: 'pending' as const }],
				};
			}
		};
		const progress: IChatProgress[] = [];
		const request = upcastPartial<IChatAgentRequest>({
			requestId: 'request-a', message: 'The page does not work.', sessionResource: URI.parse('agent-host-copilotcli:/peer-session'),
			variables: { variables: [] },
		});
		return { room, rooms, posts, progress, request };
	}

	test('stopped-room follow-ups save to the targeted inbox and offer room navigation', async () => {
		const { rooms, posts, request, progress } = setup();
		disposables.add(CommandsRegistry.registerCommand(OpenCollaborationRoomCommandId, () => { }));
		const handled = await forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.None, authenticated);
		const text = progress.filter(part => part.kind === 'markdownContent').map(part => part.content.value).join('\n');
		const command = progress.find(part => part.kind === 'command');
		assert.deepStrictEqual({
			handled, posts,
			targeted: text.includes('Only the addressed peer'),
			command: command?.command,
		}, {
			handled: true,
			posts: [{ roomId: 'room-a', message: { id: 'followup-request-a', text: 'The page does not work.', mentions: ['member-a'] } }],
			targeted: true,
			command: { id: OpenCollaborationRoomCommandId, title: 'Back to Room', arguments: ['room-a'] },
		});
	});

	test('idle members with an authorized run use targeted delivery rather than a direct SDK turn', async () => {
		const { rooms, request, progress, posts } = setup('idle', Date.now() + 60000);
		await forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.None, authenticated);
		assert.deepStrictEqual({
			posts: posts.length,
			nextTurn: progress.some(part => part.kind === 'markdownContent' && part.content.value.includes('Only the addressed peer')),
		}, { posts: 1, nextTurn: true });
	});

	for (const [name, deadline, turns] of [['deadline expired', 0, 1], ['turn limit reached', Number.MAX_SAFE_INTEGER, 3]] as const) {
		test(`${name} still forwards the new human request through the room authority`, async () => {
			const { rooms, request, progress } = setup('idle', deadline, turns);
			await forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.None, authenticated);
			assert.ok(progress.some(part => part.kind === 'markdownContent' && part.content.value.includes('Only the addressed peer')));
		});
	}

	test('paused rooms explain that delivery waits for the pause to end', async () => {
		const { rooms, request, progress } = setup('paused');
		await forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.None, authenticated);
		assert.ok(progress.some(part => part.kind === 'markdownContent' && part.content.value.includes('room is paused or stopping')));
	});

	test('non-room sessions retain their ordinary send path', async () => {
		const { rooms, request, progress, posts } = setup();
		let authenticationRequested = false;
		const handled = await forwardRoomFollowUp(rooms, URI.parse('copilotcli:/ordinary-session'), request, parts => progress.push(...parts), CancellationToken.None, async () => { authenticationRequested = true; });
		assert.deepStrictEqual({ handled, authenticationRequested, posts, progress }, { handled: false, authenticationRequested: false, posts: [], progress: [] });
	});

	test('cancelled follow-ups are not posted', async () => {
		const { rooms, request, progress, posts } = setup();
		await assert.rejects(forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.Cancelled, authenticated), isCancellationError);
		assert.deepStrictEqual({ posts, progress }, { posts: [], progress: [] });
	});

	test('authentication failure cannot start a room follow-up', async () => {
		const { rooms, request, progress, posts } = setup();
		await assert.rejects(forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.None, async () => { throw new Error('Authentication required'); }), /Authentication required/);
		assert.deepStrictEqual({ posts, progress }, { posts: [], progress: [] });
	});

	test('cancellation during authentication cannot post a room follow-up', async () => {
		const { rooms, request, progress, posts } = setup();
		const cancellation = disposables.add(new CancellationTokenSource());
		await assert.rejects(forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), cancellation.token, async () => { cancellation.cancel(); }), isCancellationError);
		assert.deepStrictEqual({ posts, progress }, { posts: [], progress: [] });
	});

	test('unsupported attachments are not silently discarded', async () => {
		const { rooms, request, progress, posts } = setup();
		const attached = { ...request, variables: { variables: [{ kind: 'file' as const, id: 'file', name: 'file', value: URI.file('/repo/file') }] } };
		await assert.rejects(forwardRoomFollowUp(rooms, session, attached, parts => progress.push(...parts), CancellationToken.None, authenticated), /text only/);
		assert.deepStrictEqual({ posts, progress }, { posts: [], progress: [] });
	});

	test('a failed post surfaces the error without a success acknowledgement', async () => {
		const { rooms, request, progress } = setup();
		rooms.postMessage = async () => { throw new Error('Room storage unavailable'); };
		await assert.rejects(forwardRoomFollowUp(rooms, session, request, parts => progress.push(...parts), CancellationToken.None, authenticated), /storage unavailable/);
		assert.deepStrictEqual(progress, []);
	});
});
