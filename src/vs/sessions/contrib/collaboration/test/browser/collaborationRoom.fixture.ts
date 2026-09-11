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
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
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

type RoomFixtureState = 'new' | 'home' | 'running' | 'paused' | 'offline' | 'steering' | 'approvals' | 'approval-pending' | 'approval-failed' | 'untrusted' | 'one-peer' | 'three-peers' | 'collapsed' | 'narrow' | 'narrow-drawer' | 'long-history' | 'mixed-setup' | 'pending-model' | 'model-error';

function renderRoom(ctx: ComponentFixtureContext, state: RoomFixtureState): void {
	const width = state === 'narrow' || state === 'narrow-drawer' ? 640 : 1160;
	ctx.container.style.width = `${width}px`;
	ctx.container.style.height = state === 'new' ? '1000px' : '780px';
	ctx.container.style.display = 'flex';
	ctx.container.style.position = 'relative';
	const service = new CollaborationFixtureService();
	const storage = ctx.disposableStore.add(new InMemoryStorageService());
	const customViews = ctx.disposableStore.add(new CustomViewService(new NullLogService(), storage));
	const views = ctx.disposableStore.add(new CollaborationRoomViewService(customViews, storage));
	if (state === 'collapsed') {
		views.savePanelState({ visible: false, width: 360 });
	}
	if (state === 'mixed-setup') {
		views.saveCreationDraft({
			title: 'Review the implementation', goal: 'Find defects and share evidence in the room', instructions: '',
			repositoryUri: 'file:///workspace/project', baseRevision: 'main', workerCount: '3', model: '',
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
		} else if (state === 'steering') {
			service.showRoom({ ...room, latestMessageSequence: 5 }, {
				...history,
				messages: [...history.messages, {
					id: 'guidance', sequence: 5, authorId: 'human', authorName: 'You', authorKind: 'human', kind: 'message', mode: 'steer',
					text: '@Copilot-1 @Copilot-2 Pause the optimization ideas and fix the failing baseline first.',
					timestamp: room.updatedAt, mentions: ['member-1', 'member-2'],
					deliveries: [{ memberId: 'member-1', state: 'delivered', turnId: 'turn-1' }, { memberId: 'member-2', state: 'steering', turnId: 'turn-2' }],
				}],
			});
		} else {
			service.showRoom(state === 'paused' ? {
				...room,
				state: 'paused',
				members: room.members.map(member => ({ ...member, state: 'idle' })),
			} : room, history);
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
		},
	});
	stubCollaborationTestServices(instantiation, ctx.disposableStore);
	ctx.disposableStore.add(customViews.registerCustomView(collaborationRoomViewDescriptor));
	customViews.showCustomView(collaborationRoomViewDescriptor.id);
	const node = ctx.disposableStore.add(instantiation.createInstance(CustomViewNode, collaborationRoomViewDescriptor));
	ctx.container.appendChild(node.element);
	node.layout(width, state === 'new' ? 1000 : 780);
	if (state === 'narrow-drawer') {
		ctx.container.querySelector<HTMLButtonElement>('.room-header button[aria-controls]')?.click();
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
	PanelCollapsed: defineComponentFixture({ render: ctx => renderRoom(ctx, 'collapsed') }),
	NarrowConversation: defineComponentFixture({ render: ctx => renderRoom(ctx, 'narrow') }),
	NarrowSettingsDrawer: defineComponentFixture({ render: ctx => renderRoom(ctx, 'narrow-drawer') }),
	LongConversation: defineComponentFixture({ render: ctx => renderRoom(ctx, 'long-history') }),
	Paused: defineComponentFixture({ render: ctx => renderRoom(ctx, 'paused') }),
	Disconnected: defineComponentFixture({ render: ctx => renderRoom(ctx, 'offline') }),
	LiveGuidance: defineComponentFixture({ render: ctx => renderRoom(ctx, 'steering') }),
	RoomApprovals: defineComponentFixture({ render: ctx => renderRoom(ctx, 'approvals') }),
	ApprovalPending: defineComponentFixture({ render: ctx => renderRoom(ctx, 'approval-pending') }),
	ApprovalFailed: defineComponentFixture({ render: ctx => renderRoom(ctx, 'approval-failed') }),
	UntrustedWorkspace: defineComponentFixture({ render: ctx => renderRoom(ctx, 'untrusted') }),
});
