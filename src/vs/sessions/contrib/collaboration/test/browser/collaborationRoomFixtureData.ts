/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, transaction } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { AgentHostRoomMemberState, defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomMessagePage } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { platformSessionSchema } from '../../../../../platform/agentHost/common/agentHostSchema.js';
import { ChatInputQuestionKind, ConfirmationOptionKind, ModelSelection, SessionModelInfo, ToolCallStatus } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { CollaborationAvailability, CollaborationRequestResponse, ICollaborationRequest, ICollaborationService, ICollaborationWorkspaceTrust } from '../../../../services/collaboration/common/collaboration.js';
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
			model: index % 2 === 0 ? 'gpt-5.5' : 'claude-sonnet-4.6',
			modelSelection: { id: index % 2 === 0 ? 'gpt-5.5' : 'claude-sonnet-4.6' },
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

export function createCollaborationFixtureRequests(): readonly ICollaborationRequest[] {
	return [{
		id: 'approve-tests', version: 1, roomId: 'room-fixture', memberId: 'member-5', memberName: 'Copilot-5',
		chatUri: 'copilotcli:/fixture-5/chat/default', turnId: 'turn-tests', state: 'ready',
		content: './scripts/test.sh --grep "Configuration cache"',
		payload: {
			kind: 'tool', toolCall: {
				toolCallId: 'run-tests', toolName: 'shell', displayName: 'Run in Terminal', status: ToolCallStatus.PendingConfirmation,
				invocationMessage: 'Run the focused configuration tests in this peer\'s worktree.',
				toolInput: './scripts/test.sh --grep "Configuration cache"',
				options: [
					{ id: 'once', label: 'Allow Once', kind: ConfirmationOptionKind.Approve },
					{ id: 'deny', label: 'Reject', kind: ConfirmationOptionKind.Deny },
				],
			}
		},
	}, {
		id: 'question-tests', version: 2, roomId: 'room-fixture', memberId: 'member-3', memberName: 'Copilot-3',
		chatUri: 'copilotcli:/fixture-3/chat/default', turnId: 'turn-question', state: 'ready',
		payload: {
			kind: 'input', request: {
				id: 'baseline', message: 'Which baseline should I compare?',
				questions: [{
					id: 'revision', kind: ChatInputQuestionKind.SingleSelect, message: 'Baseline revision', required: true,
					options: [{ id: 'pinned', label: 'Pinned room baseline' }, { id: 'release', label: 'Latest release' }],
				}],
			}
		},
	}];
}

export class CollaborationFixtureService extends mock<ICollaborationService>() {
	override readonly availability = observableValue<CollaborationAvailability>(this, 'available');
	override readonly supported = observableValue(this, true);
	override readonly availabilityError = observableValue<string | undefined>(this, undefined);
	override readonly rooms = observableValue<readonly IAgentHostRoom[]>(this, []);
	override readonly activeRoomId = observableValue<string | undefined>(this, undefined);
	override readonly activeRoom = observableValue<IAgentHostRoom | undefined>(this, undefined);
	override readonly messages = observableValue<IAgentHostRoomMessagePage>(this, { messages: [], hasEarlier: false, hasLater: false });
	override readonly models = observableValue<readonly SessionModelInfo[]>(this, [
		{ id: 'auto', name: 'Auto', provider: 'copilotcli' },
		{ id: 'gpt-5.5', name: 'GPT-5.5', provider: 'copilotcli' },
		{ id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'copilotcli' },
	]);
	override readonly loading = observableValue(this, false);
	override readonly loadingEarlier = observableValue(this, false);
	override readonly creating = observableValue(this, false);
	override readonly sending = observableValue(this, false);
	override readonly canSteer = observableValue(this, true);
	override readonly canConfigure = observableValue(this, true);
	override readonly canSetMemberModel = observableValue(this, true);
	override readonly error = observableValue<string | undefined>(this, undefined);
	override readonly workspaceTrust = observableValue<ICollaborationWorkspaceTrust>(this, { state: 'trusted' });
	override readonly requests = observableValue<readonly ICollaborationRequest[]>(this, []);
	override readonly requestError = observableValue<string | undefined>(this, undefined);
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
	override async loadMessages(): Promise<void> { }
	override async loadEarlierMessages(): Promise<void> { }

	override async setMemberModel(memberId: string, model: ModelSelection | undefined): Promise<void> {
		const room = this.activeRoom.get();
		if (!room) {
			throw new Error('No fixture room selected');
		}
		const selection = model ?? { id: 'auto' };
		this.activeRoom.set({
			...room, members: room.members.map(member => member.id !== memberId ? member : member.state === 'working' || member.state === 'pending'
				? { ...member, model: selection.id, pendingModel: selection, modelError: undefined }
				: { ...member, model: selection.id, modelSelection: selection, pendingModel: undefined, modelError: undefined }),
		}, undefined);
	}

	override async getConfiguration() {
		return { schema: platformSessionSchema.toProtocol(), values: { ...(this.activeRoom.get()?.members[0]?.configuration ?? defaultAgentHostRoomConfiguration) } };
	}

	override async setConfiguration(configuration: Partial<IAgentHostRoomConfiguration>): Promise<void> {
		const room = this.activeRoom.get();
		if (!room) {
			throw new Error('No fixture room selected');
		}
		this.activeRoom.set({
			...room,
			members: room.members.map(member => ({ ...member, configuration: { ...defaultAgentHostRoomConfiguration, ...member.configuration, ...configuration } })),
		}, undefined);
	}

	override async requestWorkspaceTrust(): Promise<void> {
		this.workspaceTrust.set({ ...this.workspaceTrust.get(), state: 'trusted' }, undefined);
	}

	override async respondToRequest(request: ICollaborationRequest, _response: CollaborationRequestResponse): Promise<void> {
		this.requests.set(this.requests.get().filter(candidate => candidate.id !== request.id || candidate.version !== request.version), undefined);
	}
}
