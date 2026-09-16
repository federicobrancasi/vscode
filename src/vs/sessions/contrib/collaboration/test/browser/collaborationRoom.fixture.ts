/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mock } from '../../../../../base/test/common/mock.js';
import { Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IActionWidgetService, ActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup, registerWorkbenchServices } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { CustomViewNode } from '../../../../browser/parts/customViewNode.js';
import { ISessionsPartService } from '../../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { CollaborationRoomViewService, ICollaborationRoomViewService } from '../../../../services/collaboration/browser/collaborationRoomView.js';
import { ICollaborationService } from '../../../../services/collaboration/common/collaboration.js';
import { CustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { collaborationRoomViewDescriptor } from '../../browser/collaborationRoomView.js';
import { CollaborationFixtureService, createCollaborationFixtureMessages, createCollaborationFixtureRequests, createCollaborationFixtureRoom } from './collaborationRoomFixtureData.js';
import { stubCollaborationTestServices } from './collaborationTestServices.js';
import '../../../../common/theme.js';

type RoomFixtureState = 'new' | 'home' | 'created' | 'running' | 'paused' | 'offline' | 'queued' | 'reserved' | 'budget-exhausted' | 'archive' | 'inbox' | 'hidden' | 'approvals' | 'approval-pending' | 'approval-failed' | 'untrusted' | 'one-peer' | 'three-peers' | 'settings' | 'narrow' | 'long-history' | 'mixed-setup' | 'pending-model' | 'model-error';

function renderRoom(ctx: ComponentFixtureContext, state: RoomFixtureState): void {
	const width = state === 'narrow' ? 640 : 1160;
	ctx.container.style.width = `${width}px`;
	ctx.container.style.height = state === 'new' ? '1000px' : '780px';
	ctx.container.style.display = 'flex';
	ctx.container.style.position = 'relative';
	const service = new CollaborationFixtureService();
	const storage = ctx.disposableStore.add(new InMemoryStorageService());
	const customViews = ctx.disposableStore.add(new CustomViewService(new NullLogService(), storage));
	const views = ctx.disposableStore.add(new CollaborationRoomViewService(customViews, storage, new NullLogService()));
	const memberNames = ['chaotic-cyborg', 'disciplined-neuron', 'caffeinated-compiler'];
	if (state === 'new' || state === 'home') {
		views.saveCreationDraft({
			title: '', goal: '', instructions: '', repositoryUri: undefined,
			baseRevision: '', workerCount: '3', model: '', memberNames,
		});
	} else if (state === 'mixed-setup') {
		views.saveCreationDraft({
			title: 'Review the implementation', goal: 'Find defects and share evidence in the room', instructions: '',
			repositoryUri: 'file:///workspace/project', baseRevision: 'main', workerCount: '3', model: '',
			memberNames,
			memberModels: [{ id: 'gpt-5.5' }, { id: 'claude-sonnet-4.6' }, { id: 'auto' }],
		});
	}
	if (state === 'home') {
		const room = createCollaborationFixtureRoom();
		service.rooms.set([room, { ...room, id: 'review-room', title: 'Review the configuration changes', state: 'paused' }], undefined);
	} else if (state !== 'new' && state !== 'mixed-setup') {
		const initial = createCollaborationFixtureRoom();
		const room = state === 'one-peer' || state === 'three-peers' || state === 'pending-model' || state === 'model-error'
			? { ...initial, members: initial.members.slice(0, state === 'one-peer' ? 1 : 3) } : initial;
		const history = createCollaborationFixtureMessages();
		if (state === 'pending-model' || state === 'model-error') {
			service.showRoom({
				...room, members: room.members.map((member, index) => index === 0 ? {
					...member, model: 'claude-sonnet-4.6', pendingModel: { id: 'claude-sonnet-4.6' },
					modelError: state === 'model-error' ? 'The selected model is temporarily unavailable. Choose another model or retry.' : undefined,
				} : member),
			}, history);
		} else if (state === 'long-history') {
			service.showRoom({ ...room, latestMessageSequence: 1000 }, {
				hasEarlier: true, hasLater: false,
				messages: Array.from({ length: 600 }, (_, index) => ({
					...history.messages[index % history.messages.length],
					id: `history-${index}`, sequence: index + 401, replyTo: undefined,
					text: index % 5 === 0
						? `${history.messages[index % history.messages.length].text}\n\n${'The measurement includes cold and warm launches. The saved worktree remains isolated and the public API is unchanged. '.repeat(8)}`
						: history.messages[index % history.messages.length].text,
				})),
			});
		} else if (state === 'reserved') {
			service.showRoom({
				...room, latestMessageSequence: 2, artifacts: [],
				run: { ...room.run!, deadline: undefined, limits: { maxTurns: 4 }, admittedTurns: 1 },
				members: [{ ...room.members[0], state: 'starting', turns: 1, activity: 'Preparing the reserved input batch' }],
			}, {
				hasEarlier: false, hasLater: false,
				messages: [1, 2].map(sequence => ({
					id: `reserved-${sequence}`, sequence, authorId: 'human', authorName: 'You', authorKind: 'human', kind: 'message',
					text: sequence === 1 ? 'Review the baseline before making changes.' : 'Include the measurement details in your reply.',
					timestamp: room.updatedAt + sequence, mentions: [room.members[0].id],
					deliveries: [{ memberId: room.members[0].id, state: 'reserved', turnId: 'reserved-batch' }],
				})),
			});
		} else if (state === 'queued') {
			service.showRoom({ ...room, latestMessageSequence: 7 }, {
				...history,
				messages: [...history.messages, {
					id: 'guidance', sequence: 7, authorId: 'human', authorName: 'You', authorKind: 'human', kind: 'message',
					text: '@Copilot-1 @Copilot-2 Pause the optimization ideas and fix the failing baseline first.',
					timestamp: room.updatedAt, mentions: ['member-1', 'member-2'],
					deliveries: [{ memberId: 'member-1', state: 'submitted', turnId: 'turn-1' }, { memberId: 'member-2', state: 'pending' }],
				}],
			});
		} else if (state === 'created') {
			service.showRoom({ ...room, state: 'created', run: undefined, latestMessageSequence: 0, members: room.members.map(member => ({ ...member, state: 'pending', turns: 0 })) }, { messages: [], hasEarlier: false, hasLater: false });
		} else if (state === 'budget-exhausted') {
			service.showRoom({ ...room, state: 'paused', pauseReason: 'budget', run: { ...room.run!, admittedTurns: room.run!.limits.maxTurns! } }, history);
		} else if (state === 'archive') {
			service.showRoom({
				...room, state: 'stopped', archived: true, latestMessageSequence: 7,
				members: room.members.map(member => ({ ...member, state: 'stopped' })),
				archivedSessions: [
					...room.members.map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
					{ id: 'historic-session', name: 'Historical participant', sessionUri: 'copilotcli:/historic', chatUri: 'opaque-chat:/historic/preserved', worktreeUri: 'file:///workspace/worktrees/historic' },
				],
			}, {
				...history,
				messages: [...history.messages, {
					id: 'historical-post', sequence: 7, authorId: 'historic-session', authorName: 'Historical participant', authorKind: 'agent', kind: 'message',
					text: 'Historical assignment and review metadata remain readable here. The preserved patch is available for inspection.',
					timestamp: room.updatedAt + 1, mentions: ['member-1'], replyTo: 'review-cache', artifactIds: ['patch-1'],
					deliveries: [{ memberId: 'member-1', state: 'interrupted', error: 'Historical status "completed" does not establish provider acceptance or task completion.' }],
				}],
			});
		} else {
			service.showRoom(state === 'paused' ? {
				...room,
				state: 'paused',
				members: room.members.map(member => ({ ...member, state: 'idle' })),
			} : room, history);
			if (state === 'inbox') {
				void service.selectInbox('member-2');
			} else if (state === 'hidden') {
				const message = history.messages.find(message => message.authorKind === 'human');
				if (!message) {
					throw new Error('The hidden-message fixture requires a human post');
				}
				views.hideMessage(room.id, message.id);
			}
		}
	}
	if (state === 'offline') {
		service.availability.set('unavailable', undefined);
		service.availabilityError.set('The local agent host disconnected. History is retained; reconnect before resuming.', undefined);
	}
	if (state === 'approvals' || state === 'approval-pending' || state === 'approval-failed') {
		const requests = createCollaborationFixtureRequests();
		service.requests.set(state === 'approvals' ? requests : [{
			...requests[0],
			state: state === 'approval-pending' ? 'submitting' : 'failed',
			error: state === 'approval-failed' ? 'The host did not acknowledge this response. Review the request and try again.' : undefined,
		}], undefined);
	}
	if (state === 'untrusted') {
		const room = service.activeRoom.get()!;
		service.workspaceTrust.set({
			state: 'untrusted', repositoryUri: room.repositoryUri,
			worktreeUris: room.members.flatMap(member => member.worktreeUri ? [member.worktreeUri] : []),
		}, undefined);
	}
	const instantiation = createEditorServices(ctx.disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: reg => {
			registerWorkbenchServices(reg);
			reg.define(IContextViewService, ContextViewService);
			reg.define(IActionWidgetService, ActionWidgetService);
			reg.defineInstance(ILayoutService, new class extends mock<ILayoutService>() {
				override readonly mainContainer = ctx.container;
				override readonly activeContainer = ctx.container;
				override readonly onDidLayoutContainer = Event.None;
				override getContainer() { return ctx.container; }
			}());
			reg.define(IMenuService, MenuService);
			reg.defineInstance(ICollaborationService, service);
			reg.defineInstance(ICollaborationRoomViewService, views);
			reg.defineInstance(IAgentHostEnablementService, new class extends mock<IAgentHostEnablementService>() {
				override readonly managedSandboxEnforced = constObservable(false);
				override readonly managedSandboxAllowsBypass = constObservable(true);
			});
			reg.define(IMarkdownRendererService, MarkdownRendererService);
			reg.defineInstance(IFileDialogService, new class extends mock<IFileDialogService>() { });
			reg.defineInstance(ISessionsService, new class extends mock<ISessionsService>() {
				override readonly activeSession = constObservable(undefined);
			});
			reg.defineInstance(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() { });
			reg.defineInstance(ISessionsPartService, new class extends mock<ISessionsPartService>() { });
			reg.defineInstance(IEditorService, new class extends mock<IEditorService>() { });
			reg.defineInstance(IViewsService, new class extends mock<IViewsService>() { });
			reg.defineInstance(IQuickInputService, new class extends mock<IQuickInputService>() { });
		},
	});
	stubCollaborationTestServices(instantiation, ctx.disposableStore);
	ctx.disposableStore.add(customViews.registerCustomView(collaborationRoomViewDescriptor));
	customViews.showCustomView(collaborationRoomViewDescriptor.id);
	const node = ctx.disposableStore.add(instantiation.createInstance(CustomViewNode, collaborationRoomViewDescriptor));
	ctx.container.appendChild(node.element);
	node.layout(width, state === 'new' ? 1000 : 780);
	if (state === 'settings') {
		// Settings live in the Agents window side panel, so show them at that width instead of the room.
		const panel = views.panelContent.get()!;
		node.element.remove();
		ctx.container.style.width = '340px';
		ctx.container.appendChild(panel);
		views.activeView.get()?.layoutPanel(340, 780);
	}
}

export default defineThemedFixtureGroup({ path: 'sessions/collaboration/' }, {
	NewRoom: defineComponentFixture({ render: ctx => renderRoom(ctx, 'new') }),
	Home: defineComponentFixture({ render: ctx => renderRoom(ctx, 'home') }),
	TenPeers: defineComponentFixture({ render: ctx => renderRoom(ctx, 'running'), additionalThemes: ['darkHighContrast', 'lightHighContrast'] }),
	OnePeer: defineComponentFixture({ render: ctx => renderRoom(ctx, 'one-peer') }),
	ThreePeers: defineComponentFixture({ render: ctx => renderRoom(ctx, 'three-peers') }),
	MixedModelsBeforeStart: defineComponentFixture({ render: ctx => renderRoom(ctx, 'mixed-setup') }),
	PendingModelChange: defineComponentFixture({ render: ctx => renderRoom(ctx, 'pending-model') }),
	ModelChangeError: defineComponentFixture({ render: ctx => renderRoom(ctx, 'model-error') }),
	NarrowConversation: defineComponentFixture({ render: ctx => renderRoom(ctx, 'narrow') }),
	SidePanelSettings: defineComponentFixture({ render: ctx => renderRoom(ctx, 'settings') }),
	LongConversation: defineComponentFixture({ render: ctx => renderRoom(ctx, 'long-history') }),
	Paused: defineComponentFixture({ render: ctx => renderRoom(ctx, 'paused') }),
	Disconnected: defineComponentFixture({ render: ctx => renderRoom(ctx, 'offline') }),
	QueuedMail: defineComponentFixture({ render: ctx => renderRoom(ctx, 'queued') }),
	ReservedInputBatch: defineComponentFixture({ render: ctx => renderRoom(ctx, 'reserved'), additionalThemes: ['darkHighContrast', 'lightHighContrast'] }),
	BeforeFirstStart: defineComponentFixture({ render: ctx => renderRoom(ctx, 'created') }),
	BudgetExhausted: defineComponentFixture({ render: ctx => renderRoom(ctx, 'budget-exhausted') }),
	ReadOnlyArchive: defineComponentFixture({ render: ctx => renderRoom(ctx, 'archive'), additionalThemes: ['darkHighContrast', 'lightHighContrast'] }),
	PeerInbox: defineComponentFixture({ render: ctx => renderRoom(ctx, 'inbox') }),
	HiddenHumanMessage: defineComponentFixture({ render: ctx => renderRoom(ctx, 'hidden'), additionalThemes: ['darkHighContrast', 'lightHighContrast'] }),
	RoomApprovals: defineComponentFixture({ render: ctx => renderRoom(ctx, 'approvals') }),
	ApprovalPending: defineComponentFixture({ render: ctx => renderRoom(ctx, 'approval-pending') }),
	ApprovalFailed: defineComponentFixture({ render: ctx => renderRoom(ctx, 'approval-failed') }),
	UntrustedWorkspace: defineComponentFixture({ render: ctx => renderRoom(ctx, 'untrusted') }),
});
