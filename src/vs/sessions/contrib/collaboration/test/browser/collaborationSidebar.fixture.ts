/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constObservable } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { ChatAutomationsEnabledContext } from '../../../../../workbench/contrib/chat/common/automations/automationsEnabled.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { CollaborationEnabledSettingId, CollaborationSupportedContext } from '../../../../services/collaboration/common/collaboration.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { SessionsGrouping, SessionsList, SessionsSorting, SESSIONS_LIST_SHOW_EMPTY_DEFAULT_GROUPS_SETTING } from '../../../sessions/browser/views/sessionsList.js';
import { createListHarness } from '../../../sessions/test/browser/sessionsListTestUtils.js';
import { collaborationRoomViewDescriptor } from '../../browser/collaborationRoomView.js';
import '../../../../common/theme.js';

function renderSidebar(ctx: ComponentFixtureContext, active: boolean): void {
	ctx.container.style.width = '300px';
	ctx.container.style.height = '320px';
	ctx.container.style.background = 'var(--vscode-sideBar-background)';
	const themedServices = createEditorServices(ctx.disposableStore, { colorTheme: ctx.theme });
	const harness = createListHarness(ctx.disposableStore, [], instantiationService => {
		instantiationService.stub(IThemeService, themedServices.get(IThemeService));
		const configuration = instantiationService.get(IConfigurationService) as TestConfigurationService;
		void configuration.setUserConfiguration(CollaborationEnabledSettingId, true);
		void configuration.setUserConfiguration(SESSIONS_LIST_SHOW_EMPTY_DEFAULT_GROUPS_SETTING, true);
		const context = ctx.disposableStore.add(new ContextKeyService(configuration));
		instantiationService.stub(IContextKeyService, context);
		ChatContextKeys.enabled.bindTo(context).set(true);
		ChatAutomationsEnabledContext.bindTo(context).set(true);
		CollaborationSupportedContext.bindTo(context).set(true);
		instantiationService.stub(IAutomationService, new class extends mock<IAutomationService>() {
			override readonly automations = constObservable([]);
			override readonly runs = constObservable([]);
			override readonly catalogueState = constObservable('ready' as const);
		});
		instantiationService.stub(ICustomViewService, new class extends mock<ICustomViewService>() {
			override readonly activeCustomView = constObservable(active ? collaborationRoomViewDescriptor : undefined);
		});
	});
	const list = ctx.disposableStore.add(harness.instantiationService.createInstance(SessionsList, ctx.container, {
		grouping: () => SessionsGrouping.Date,
		sorting: () => SessionsSorting.Created,
		onSessionOpen: () => { },
	}));
	list.layout(300, 320);
}

export default defineThemedFixtureGroup({ path: 'sessions/collaboration/sidebar/' }, {
	Available: defineComponentFixture({ render: ctx => renderSidebar(ctx, false) }),
	Active: defineComponentFixture({ render: ctx => renderSidebar(ctx, true) }),
});
