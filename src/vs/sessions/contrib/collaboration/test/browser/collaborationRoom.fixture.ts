/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mock } from '../../../../../base/test/common/mock.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
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
import { CollaborationFixtureService, createCollaborationFixtureMessages, createCollaborationFixtureRoom } from './collaborationRoomFixtureData.js';
import '../../../../common/theme.js';

type RoomFixtureState = 'new' | 'home' | 'running' | 'paused' | 'offline' | 'steering';

function renderRoom(ctx: ComponentFixtureContext, state: RoomFixtureState): void {
	ctx.container.style.width = '1040px';
	ctx.container.style.height = state === 'new' ? '1000px' : '780px';
	ctx.container.style.display = 'flex';
	const service = new CollaborationFixtureService();
	const customViews = ctx.disposableStore.add(new CustomViewService(new NullLogService(), ctx.disposableStore.add(new InMemoryStorageService())));
	const views = ctx.disposableStore.add(new CollaborationRoomViewService(customViews));
	if (state === 'home') {
		const room = createCollaborationFixtureRoom();
		service.rooms.set([room, { ...room, id: 'review-room', title: 'Review the configuration changes', state: 'paused' }], undefined);
	} else if (state !== 'new') {
		const room = createCollaborationFixtureRoom();
		const history = createCollaborationFixtureMessages();
		if (state === 'steering') {
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
	const instantiation = createEditorServices(ctx.disposableStore, {
		colorTheme: ctx.theme,
		additionalServices: reg => {
			registerWorkbenchServices(reg);
			reg.define(IMenuService, MenuService);
			reg.defineInstance(ICollaborationService, service);
			reg.defineInstance(ICollaborationRoomViewService, views);
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
	ctx.disposableStore.add(customViews.registerCustomView(collaborationRoomViewDescriptor));
	customViews.showCustomView(collaborationRoomViewDescriptor.id);
	const node = ctx.disposableStore.add(instantiation.createInstance(CustomViewNode, collaborationRoomViewDescriptor));
	ctx.container.appendChild(node.element);
	node.layout(1040, state === 'new' ? 1000 : 780);
}

export default defineThemedFixtureGroup({ path: 'sessions/collaboration/' }, {
	NewRoom: defineComponentFixture({ render: ctx => renderRoom(ctx, 'new') }),
	Home: defineComponentFixture({ render: ctx => renderRoom(ctx, 'home') }),
	TenPeers: defineComponentFixture({ render: ctx => renderRoom(ctx, 'running') }),
	Paused: defineComponentFixture({ render: ctx => renderRoom(ctx, 'paused') }),
	Disconnected: defineComponentFixture({ render: ctx => renderRoom(ctx, 'offline') }),
	LiveGuidance: defineComponentFixture({ render: ctx => renderRoom(ctx, 'steering') }),
});
