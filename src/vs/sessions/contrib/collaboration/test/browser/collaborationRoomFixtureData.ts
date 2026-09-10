/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, transaction } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { AgentHostRoomMemberState, IAgentHostRoom, IAgentHostRoomMessagePage } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { SessionModelInfo } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { CollaborationAvailability, ICollaborationService } from '../../../../services/collaboration/common/collaboration.js';
import { CollaborationDraft } from '../../../../services/collaboration/common/collaborationMentions.js';

const timestamp = Date.UTC(2026, 8, 9, 12, 0);

export function createCollaborationFixtureRoom(): IAgentHostRoom {
	const states: AgentHostRoomMemberState[] = ['working', 'working', 'blocked', 'working', 'needsInput', 'idle', 'working', 'working', 'failed', 'working'];
	const avenues = [
		'Measuring extension activation',
		'Checking repeated configuration reads',
		'Waiting for baseline measurements',
		'Comparing startup traces',
		'Running the performance tests',
		'Published an unsuccessful experiment',
		'Reviewing the cache change',
		'Investigating service initialization',
		'Worktree setup failed',
		'Validating the proposed patch',
	];
	return {
		id: 'room-fixture',
		revision: 4,
		title: 'Improve startup performance',
		goal: 'Reduce startup time without changing public APIs.',
		instructions: 'Announce work and share evidence. Keep changes isolated.',
		repositoryUri: 'file:///workspace/project',
		baseRevision: '0123456789abcdef0123456789abcdef01234567',
		createdAt: timestamp,
		updatedAt: timestamp + 60000,
		state: 'running',
		latestMessageSequence: 4,
		run: {
			id: 'run-fixture',
			startedAt: timestamp,
			deadline: timestamp + 30 * 60000,
			limits: { maxTurns: 100, timeoutMinutes: 30 },
			admittedTurns: 14,
		},
		members: states.map((state, index) => ({
			id: `member-${index + 1}`,
			name: `Copilot-${index + 1}`,
			sessionUri: `copilotcli:/fixture-${index + 1}`,
			worktreeUri: `file:///workspace/worktrees/member-${index + 1}`,
			state,
			activity: avenues[index],
			work: { description: avenues[index], blocked: state === 'blocked', updatedAt: timestamp },
			error: state === 'failed' ? 'Could not create the worktree. Your original folder was not changed.' : undefined,
			turns: index === 8 ? 0 : 2,
		})),
		artifacts: [{
			id: 'patch-1',
			memberId: 'member-2',
			title: 'Configuration cache experiment',
			createdAt: timestamp + 40000,
			baseRevision: '0123456789abcdef0123456789abcdef01234567',
			sourceRevision: 'abcdef0123456789abcdef0123456789abcdef01',
			uri: 'file:///workspace/shared/patch-1.patch',
		}],
	};
}

export function createCollaborationFixtureMessages(): IAgentHostRoomMessagePage {
	return {
		hasEarlier: true,
		hasLater: false,
		messages: [{
			id: 'message-1', sequence: 1, authorId: 'member-1', authorName: 'Copilot-1', authorKind: 'agent', kind: 'work',
			text: 'I am measuring extension activation. I will share the baseline here before changing code.',
			timestamp, mentions: [], deliveries: [],
		}, {
			id: 'message-2', sequence: 2, authorId: 'member-2', authorName: 'Copilot-2', authorKind: 'agent', kind: 'message',
			text: '@Copilot-1 I found repeated configuration reads. Can you check their impact on the baseline?',
			timestamp: timestamp + 10000, mentions: ['member-1'], replyTo: 'message-1',
			deliveries: [{ memberId: 'member-1', state: 'completed', turnId: 'turn-2' }],
		}, {
			id: 'message-3', sequence: 3, authorId: 'human', authorName: 'You', authorKind: 'human', kind: 'message',
			text: '@Copilot-2 Keep the public configuration API unchanged.',
			timestamp: timestamp + 20000, mentions: ['member-2'], replyTo: 'message-2',
			deliveries: [{ memberId: 'member-2', state: 'pending' }],
		}, {
			id: 'message-4', sequence: 4, authorId: 'member-2', authorName: 'Copilot-2', authorKind: 'agent', kind: 'artifact',
			text: 'The cache experiment is ready for review. Publishing this patch has not changed your working branch.',
			timestamp: timestamp + 40000, mentions: [], artifactId: 'patch-1', deliveries: [],
		}],
	};
}

export class CollaborationFixtureService extends mock<ICollaborationService>() {
	override readonly availability = observableValue<CollaborationAvailability>(this, 'available');
	override readonly supported = observableValue(this, true);
	override readonly availabilityError = observableValue<string | undefined>(this, undefined);
	override readonly rooms = observableValue<readonly IAgentHostRoom[]>(this, []);
	override readonly activeRoomId = observableValue<string | undefined>(this, undefined);
	override readonly activeRoom = observableValue<IAgentHostRoom | undefined>(this, undefined);
	override readonly messages = observableValue<IAgentHostRoomMessagePage>(this, { messages: [], hasEarlier: false, hasLater: false });
	override readonly models = observableValue<readonly SessionModelInfo[]>(this, []);
	override readonly loading = observableValue(this, false);
	override readonly creating = observableValue(this, false);
	override readonly sending = observableValue(this, false);
	override readonly canSteer = observableValue(this, true);
	override readonly error = observableValue<string | undefined>(this, undefined);
	private readonly drafts = new Map<string, CollaborationDraft>();

	showRoom(room: IAgentHostRoom, messages: IAgentHostRoomMessagePage): void {
		transaction(tx => {
			this.rooms.set([room], tx);
			this.activeRoomId.set(room.id, tx);
			this.activeRoom.set(room, tx);
			this.messages.set(messages, tx);
		});
	}

	override getDraft(roomId: string): CollaborationDraft {
		let draft = this.drafts.get(roomId);
		if (!draft) {
			draft = new CollaborationDraft();
			this.drafts.set(roomId, draft);
		}
		return draft;
	}

	override async refresh(): Promise<void> { }
	override setFollowingLatest(): void { }
}
