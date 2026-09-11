/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { autorun, observableValue, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostRoom } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionEnvelope, ActionType, ChatAction } from '../../../../../platform/agentHost/common/state/protocol/actions.js';
import { ChatInputAnswer, ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, ChatState, ConfirmationOptionKind, MessageKind, ResponsePart, ResponsePartKind, SessionStatus, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { chatReducer } from '../../../../../platform/agentHost/common/state/sessionReducers.js';
import { ContentEncoding, ResourceReadResult } from '../../../../../platform/agentHost/common/state/sessionProtocol.js';
import { buildDefaultChatUri, StateComponents } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { CollaborationRoomRequests } from '../../browser/collaborationRoomRequests.js';

suite('CollaborationRoomRequests', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const explicitChatUri = URI.from({ scheme: 'opaque-chat', path: '/room/member/primary', query: 'version=2' }).toString();

	function toolPart(options = true): ResponsePart {
		return {
			kind: ResponsePartKind.ToolCall,
			toolCall: {
				toolCallId: 'tool-1', toolName: 'shell', displayName: 'Run in Terminal',
				status: ToolCallStatus.PendingConfirmation, invocationMessage: 'Run the tests',
				toolInput: 'npm test', _meta: { autoApproveRuleResolvable: false },
				...(options ? {
					options: [
						{ id: 'once', label: 'Allow Once', kind: ConfirmationOptionKind.Approve },
						{ id: 'deny', label: 'Reject', kind: ConfirmationOptionKind.Deny },
					]
				} : {}),
			},
		};
	}

	function setup(parts: ResponsePart[] = [toolPart()], authorize = async () => { }, readResource?: IAgentHostService['resourceRead']) {
		const room = observableValue<IAgentHostRoom | undefined>('room', {
			id: 'room', revision: 1, title: 'Peers', goal: 'Goal', instructions: '',
			repositoryUri: 'file:///repo', baseRevision: 'base', createdAt: 0, updatedAt: 0, state: 'running',
			members: [{ id: 'member-1', name: 'Copilot-1', sessionUri: 'copilotcli:/member', chatUri: explicitChatUri, state: 'needsInput', turns: 1 }],
			artifacts: [], latestMessageSequence: 0,
		});
		const generation = observableValue('generation', 0);
		const changed = store.add(new Emitter<ChatState>());
		const applied = store.add(new Emitter<ActionEnvelope>());
		const exited = store.add(new Emitter<number>());
		let verified: ChatState = {
			resource: explicitChatUri, title: 'Peer', status: SessionStatus.InputNeeded, modifiedAt: '', turns: [],
			activeTurn: { id: 'turn-1', startedAt: '', message: { text: 'Work', origin: { kind: MessageKind.User } }, responseParts: parts, usage: undefined },
		};
		let optimistic: ChatState | undefined;
		const subscription = new class extends mock<IAgentSubscription<ChatState>>() {
			override get value() { return optimistic ?? verified; }
			override get verifiedValue() { return verified; }
			override readonly onDidChange = changed.event;
			override readonly onWillApplyAction = Event.None;
			override readonly onDidApplyAction = applied.event;
		}();
		const acquisitions: { kind: StateComponents; uri: string; owner: string }[] = [];
		let releases = 0;
		const sent: { channel: string; action: Parameters<IAgentHostService['dispatch']>[1] }[] = [];
		const host = new class extends mock<IAgentHostService>() {
			override readonly clientId = 'room-client';
			override readonly onAgentHostExit = exited.event;
			override readonly getSubscription = ((kind: StateComponents, uri: URI, owner: string) => {
				acquisitions.push({ kind, uri: uri.toString(), owner });
				return { object: subscription, dispose: () => { releases++; } };
			}) as IAgentHostService['getSubscription'];
			override dispatch(channel: string, action: Parameters<IAgentHostService['dispatch']>[1]) {
				sent.push({ channel, action });
			}
			override async resourceRead(uri: URI) {
				if (!readResource) {
					throw new Error('Unexpected content read');
				}
				return readResource(uri);
			}
		}();
		const controller = store.add(new CollaborationRoomRequests(host, room, generation, authorize, 10));
		const setState = (state: ChatState) => {
			verified = state;
			optimistic = undefined;
			changed.fire(state);
		};
		const receive = (action: ChatAction, options?: { clientId?: string; rejectionReason?: string; channel?: string; apply?: boolean }) => {
			if (!options?.rejectionReason && options?.apply !== false) {
				setState(chatReducer(verified, action));
			}
			applied.fire({
				channel: options?.channel ?? explicitChatUri, action, serverSeq: 1,
				origin: { clientId: options?.clientId ?? host.clientId, clientSeq: 1 },
				rejectionReason: options?.rejectionReason,
			});
		};
		return {
			controller, host, room, generation, sent, acquisitions, exited, receive, setState,
			getState: () => verified, getReleases: () => releases,
			setOptimistic: (state: ChatState) => { optimistic = state; changed.fire(state); },
		};
	}

	test('uses the exact host chat, submits once, and waits for the correlated server receipt', async () => {
		const { controller, acquisitions, sent, receive, getState, setOptimistic } = setup();
		const request = controller.requests.get()[0];
		const response = { kind: 'tool' as const, approved: true, selectedOptionId: 'once' };
		const pending = controller.respond(request, response);
		assert.strictEqual(controller.respond(request, response), pending);
		await Promise.resolve();
		const action = sent[0].action as ChatAction;
		setOptimistic(chatReducer(getState(), action));
		receive(action, { clientId: 'another-client', apply: false });
		receive(action, { channel: 'other-chat:/chat', apply: false });
		assert.deepStrictEqual({
			acquisitions,
			sent,
			requests: controller.requests.get().map(item => ({ state: item.state, content: item.content })),
		}, {
			acquisitions: [{ kind: StateComponents.Chat, uri: explicitChatUri, owner: 'CollaborationService.roomApprovals' }],
			sent: [{
				channel: explicitChatUri, action: {
					type: ActionType.ChatToolCallConfirmed, turnId: 'turn-1', toolCallId: 'tool-1', approved: true,
					confirmed: ToolCallConfirmationReason.UserAction, selectedOptionId: 'once',
				}
			}],
			requests: [{ state: 'submitting', content: 'npm test' }],
		});
		receive(action);
		await pending;
		assert.deepStrictEqual(controller.requests.get(), []);
	});

	test('server rejection is visible and reenables the same one-time request for retry', async () => {
		const { controller, sent, receive } = setup();
		const request = controller.requests.get()[0];
		const pending = controller.respond(request, { kind: 'tool', approved: true, selectedOptionId: 'once' });
		const rejected = assert.rejects(pending, /Approval journal is closed/);
		await Promise.resolve();
		receive(sent[0].action as ChatAction, { rejectionReason: 'Approval journal is closed' });
		await rejected;
		assert.deepStrictEqual(controller.requests.get().map(item => ({ version: item.version, state: item.state, error: item.error })), [
			{ version: request.version, state: 'failed', error: 'Approval journal is closed' },
		]);
		const retry = controller.respond(controller.requests.get()[0], { kind: 'tool', approved: false, selectedOptionId: 'deny' });
		await Promise.resolve();
		receive(sent[1].action as ChatAction);
		await retry;
		assert.strictEqual(sent.length, 2);
	});

	test('a success-shaped echo without a verified state change is not treated as approval', async () => {
		const { controller, sent, receive } = setup([toolPart(false)]);
		const pending = controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true });
		const rejected = assert.rejects(pending, /request is still pending/);
		await Promise.resolve();
		receive(sent[0].action as ChatAction, { apply: false });
		await rejected;
		assert.strictEqual(controller.requests.get()[0].state, 'failed');
	});

	test('does not invent an allow-all option for a managed one-time request', async () => {
		const { controller, sent } = setup();
		const request = controller.requests.get()[0];
		await assert.rejects(controller.respond(request, { kind: 'tool', approved: true }), /current options/);
		await assert.rejects(controller.respond(request, { kind: 'tool', approved: true, selectedOptionId: 'allow-all' }), /current options/);
		await assert.rejects(controller.respond(request, { kind: 'tool', approved: true, selectedOptionId: 'deny' }), /current options/);
		assert.deepStrictEqual(sent, []);
	});

	test('rejected trust sends no approval action', async () => {
		const { controller, sent } = setup([toolPart(false)], async () => { throw new Error('Workspace trust was not granted'); });
		await assert.rejects(controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true }), /trust was not granted/);
		assert.deepStrictEqual({ sent, states: controller.requests.get().map(item => item.state) }, { sent: [], states: ['failed'] });
	});

	test('result approvals and input completions use their existing protocol actions', async () => {
		const { controller, sent, receive } = setup([{
			kind: ResponsePartKind.ToolCall,
			toolCall: {
				toolCallId: 'result', toolName: 'read', displayName: 'Read', status: ToolCallStatus.PendingResultConfirmation,
				invocationMessage: 'Read output', confirmed: ToolCallConfirmationReason.UserAction, success: true,
				pastTenseMessage: 'Read the output', content: [{ type: ToolResultContentType.Text, text: 'Actual result to review' }],
			},
		}, {
			kind: ResponsePartKind.InputRequest,
			request: { id: 'question', message: 'Which file?', questions: [{ id: 'file', kind: ChatInputQuestionKind.Text, message: 'File name', required: true }] },
		}]);
		const resultRequest = controller.requests.get()[0];
		assert.strictEqual(resultRequest.content, 'Actual result to review');
		const result = controller.respond(resultRequest, { kind: 'tool', approved: false });
		receive(sent[0].action as ChatAction);
		await result;
		const answers: Record<string, ChatInputAnswer> = { file: { state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Text, value: 'README.md' } } };
		const input = controller.respond(controller.requests.get()[0], { kind: 'input', response: ChatInputResponseKind.Accept, answers });
		await Promise.resolve();
		receive(sent[1].action as ChatAction);
		await input;
		assert.deepStrictEqual(sent.map(item => item.action), [
			{ type: ActionType.ChatToolCallResultConfirmed, turnId: 'turn-1', toolCallId: 'result', approved: false },
			{ type: ActionType.ChatInputCompleted, requestId: 'question', response: ChatInputResponseKind.Accept, answers },
		]);
	});

	test('streaming text does not republish or replace existing requests', () => {
		const { controller, getState, setState } = setup();
		let updates = 0;
		store.add(autorun(reader => { controller.requests.read(reader); updates++; }));
		const request = controller.requests.get()[0];
		for (let i = 0; i < 10; i++) {
			setState({ ...getState(), activeTurn: { ...getState().activeTurn!, responseParts: [toolPart(), { kind: ResponsePartKind.Markdown, id: 'text', content: String(i) }] } });
		}
		assert.deepStrictEqual({ updates, same: controller.requests.get()[0] === request }, { updates: 1, same: true });
	});

	test('ending a turn while authorization is pending prevents stale dispatch', async () => {
		const authorized = new DeferredPromise<void>();
		const { controller, sent, getState, setState } = setup([toolPart(false)], () => authorized.p);
		const pending = controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true });
		const rejected = assert.rejects(pending, /no longer current/);
		setState({ ...getState(), activeTurn: undefined });
		await authorized.complete();
		await rejected;
		assert.deepStrictEqual(sent, []);
	});

	test('connection exit rejects an in-flight response instead of reporting success', async () => {
		const { controller, exited, sent } = setup([toolPart(false)]);
		const pending = controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true });
		const rejected = assert.rejects(pending, /disconnected before confirming/);
		await Promise.resolve();
		exited.fire(1);
		await rejected;
		assert.deepStrictEqual({ sent: sent.length, state: controller.requests.get()[0].state }, { sent: 1, state: 'failed' });
	});

	test('missing receipts time out and reenable a still-pending request', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { controller } = setup([toolPart(false)]);
		await assert.rejects(controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true }), /did not acknowledge/);
		assert.strictEqual(controller.requests.get()[0].state, 'failed');
	}));

	test('changing the selected room releases subscriptions and invalidates pending responses', async () => {
		const { controller, room, sent, getReleases } = setup([toolPart(false)]);
		const pending = controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true });
		const rejected = assert.rejects(pending, /no longer current/);
		room.set(undefined, undefined);
		await rejected;
		assert.deepStrictEqual({ sent, releases: getReleases(), requests: controller.requests.get() }, { sent: [], releases: 1, requests: [] });
	});

	test('an authentication generation change invalidates an old card even in the same room', async () => {
		const { controller, generation, sent } = setup([toolPart(false)]);
		const old = controller.requests.get()[0];
		generation.set(1, undefined);
		await assert.rejects(controller.respond(old, { kind: 'tool', approved: true }), /no longer current/);
		assert.deepStrictEqual({ sent, newVersion: controller.requests.get()[0].version > old.version }, { sent: [], newVersion: true });
	});

	test('referenced input is loaded once and cannot be approved while unread', async () => {
		const content = new DeferredPromise<ResourceReadResult>();
		let reads = 0;
		const part = toolPart(false);
		assert.strictEqual(part.kind, ResponsePartKind.ToolCall);
		if (part.kind !== ResponsePartKind.ToolCall || part.toolCall.status !== ToolCallStatus.PendingConfirmation) {
			throw new Error('Expected confirmation');
		}
		part.toolCall.toolInput = { uri: 'content:/input', nonce: 'first' };
		const { controller, sent } = setup([part], async () => { }, async () => { reads++; return content.p; });
		await assert.rejects(controller.respond(controller.requests.get()[0], { kind: 'tool', approved: true }), /complete tool input/);
		await content.complete({ data: 'npm test -- --grep Room', encoding: ContentEncoding.Utf8 });
		await waitForState(controller.requests, requests => !requests[0].contentLoading);
		assert.deepStrictEqual({ reads, sent, content: controller.requests.get()[0].content }, { reads: 1, sent: [], content: 'npm test -- --grep Room' });
	});

	test('old hosts use the main default-chat helper and never subscribe to more than ten peers', () => {
		const { room, acquisitions } = setup();
		room.set({
			...room.get()!, members: Array.from({ length: 11 }, (_value, index) => ({
				id: `peer-${index}`, name: `Copilot-${index}`, sessionUri: `copilotcli:/peer-${index}`, state: 'needsInput' as const, turns: 1,
			})),
		}, undefined);
		assert.deepStrictEqual(acquisitions.slice(1).map(item => item.uri), Array.from({ length: 10 }, (_value, index) => buildDefaultChatUri(`copilotcli:/peer-${index}`)));
	});
});
