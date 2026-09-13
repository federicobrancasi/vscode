/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './collaborationAccessibility.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { OpenCollaborationRoomCommandId } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { Menus } from '../../../browser/menus.js';
import { HasSelectedCollaborationRoomContext } from '../../../common/contextkeys.js';
import { ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationAvailableContext, CollaborationEnabledSettingId, CollaborationRoomVisibleContext, CollaborationSupportedContext, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { CollaborationArtifactProvider } from './collaborationArtifactProvider.js';
import { collaborationRoomViewDescriptor } from './collaborationRoomView.js';
import { COLLABORATION_SETTINGS_CONTAINER_ID, COLLABORATION_SETTINGS_VIEW_ID, CollaborationSettingsViewPane, CollaborationSettingsViewPaneContainer } from './collaborationSettingsView.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'chat',
	properties: {
		[CollaborationEnabledSettingId]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental'],
			description: localize('room.enabledSetting', "Enable experimental local Copilot collaboration rooms in the Agents window. Rooms use independent peer sessions and Git worktrees. Run limits are optional; normal tool approvals still apply."),
		}
	}
});

const roomEnabled = ContextKeyExpr.and(
	ChatContextKeys.enabled,
	ContextKeyExpr.equals(`config.${CollaborationEnabledSettingId}`, true),
);

class CollaborationContribution extends Disposable {
	static readonly ID = 'sessions.collaboration';

	constructor(
		@ICollaborationService collaborationService: ICollaborationService,
		@ICollaborationRoomViewService roomViewService: ICollaborationRoomViewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(instantiationService.createInstance(CollaborationArtifactProvider));
		this._register(customViewService.registerCustomView(collaborationRoomViewDescriptor, { restore: false }));
		const available = CollaborationAvailableContext.bindTo(contextKeyService);
		const supported = CollaborationSupportedContext.bindTo(contextKeyService);
		const visible = CollaborationRoomVisibleContext.bindTo(contextKeyService);
		const selected = HasSelectedCollaborationRoomContext.bindTo(contextKeyService);
		this._register(autorun(reader => {
			const availability = collaborationService.availability.read(reader);
			available.set(availability === 'available');
			if (availability === 'disabled') {
				roomViewService.close();
			}
		}));
		this._register(autorun(reader => visible.set(roomViewService.visible.read(reader))));
		this._register(instantiationService.createInstance(CollaborationSidePanelSwitcher));
		this._register(autorun(reader => supported.set(collaborationService.supported.read(reader))));
		this._register(autorun(reader => selected.set(!!collaborationService.activeRoomId.read(reader))));
		this._register({ dispose: () => { available.reset(); supported.reset(); visible.reset(); selected.reset(); } });
	}
}

const collaborationSettingsIcon = registerIcon('collaboration-settings-icon', Codicon.settingsGear, localize('collaborationSettingsIcon', "View icon for the collaboration room settings."));

const collaborationSettingsContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: COLLABORATION_SETTINGS_CONTAINER_ID,
	title: localize2('room.settingsContainer', "Room Settings"),
	icon: collaborationSettingsIcon,
	order: 30,
	ctorDescriptor: new SyncDescriptor(CollaborationSettingsViewPaneContainer),
	storageId: COLLABORATION_SETTINGS_CONTAINER_ID,
	hideIfEmpty: true,
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: COLLABORATION_SETTINGS_VIEW_ID,
	name: localize2('room.settingsContainer', "Room Settings"),
	ctorDescriptor: new SyncDescriptor(CollaborationSettingsViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	containerIcon: collaborationSettingsIcon,
	when: CollaborationRoomVisibleContext,
}], collaborationSettingsContainer);

/**
 * Keeps the Agents window side panel in step with the room: room settings while a
 * collaboration room is open, and whatever the user had before (Changes, Files) once
 * it closes.
 */
class CollaborationSidePanelSwitcher extends Disposable {
	private restoreTo: string | undefined;

	constructor(
		@ICollaborationRoomViewService roomViewService: ICollaborationRoomViewService,
		@IViewsService private readonly viewsService: IViewsService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
	) {
		super();
		this._register(autorun(reader => {
			if (roomViewService.visible.read(reader)) {
				this.enterRoom();
			} else {
				this.leaveRoom();
			}
		}));
	}

	private enterRoom(): void {
		const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId();
		if (active === COLLABORATION_SETTINGS_CONTAINER_ID) {
			return;
		}
		this.restoreTo = active;
		this.viewsService.openViewContainer(COLLABORATION_SETTINGS_CONTAINER_ID, false);
	}

	private leaveRoom(): void {
		const restoreTo = this.restoreTo;
		this.restoreTo = undefined;
		if (!restoreTo || this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId() !== COLLABORATION_SETTINGS_CONTAINER_ID) {
			return;
		}
		this.viewsService.openViewContainer(restoreTo, false);
	}
}

registerWorkbenchContribution2(CollaborationContribution.ID, CollaborationContribution, WorkbenchPhase.AfterRestored);

registerAction2(class OpenCollaborationRoomAction extends Action2 {
	constructor() {
		super({
			id: OpenCollaborationRoomCommandId,
			title: localize2('room.open', "Open Collaboration Room"),
			category: localize2('room.category', "Agents"),
			icon: Codicon.commentDiscussion,
			f1: true,
			precondition: roomEnabled,
			menu: [{
				id: Menus.SidebarSessionsHeader,
				group: 'navigation',
				order: 3,
				when: roomEnabled,
			}],
		});
	}

	override async run(accessor: ServicesAccessor, roomId?: string): Promise<void> {
		const service = accessor.get(ICollaborationService);
		const viewService = accessor.get(ICollaborationRoomViewService);
		if (service.availability.get() !== 'disabled') {
			viewService.open();
			if (typeof roomId === 'string' && roomId && roomId !== service.activeRoomId.get()) {
				await service.selectRoom(roomId);
			}
		}
	}
});

registerAction2(class BackToCollaborationRoomAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.collaboration.back',
			title: localize2('room.back', "Back to Room"),
			category: localize2('room.category', "Agents"),
			icon: Codicon.commentDiscussion,
			f1: true,
			precondition: ContextKeyExpr.and(roomEnabled, HasSelectedCollaborationRoomContext),
			menu: [{
				id: Menus.TitleBarRightLayout,
				group: 'navigation',
				order: 0,
				when: ContextKeyExpr.and(roomEnabled, HasSelectedCollaborationRoomContext, CollaborationRoomVisibleContext.negate()),
			}],
		});
	}

	override run(accessor: ServicesAccessor): void {
		const service = accessor.get(ICollaborationService);
		if (service.availability.get() !== 'disabled' && service.activeRoomId.get()) {
			accessor.get(ICollaborationRoomViewService).open();
		}
	}
});

registerAction2(class FocusCollaborationComposerAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.collaboration.focus',
			title: localize2('room.focus', "Focus Collaboration Composer"),
			category: localize2('room.category', "Agents"),
			f1: true,
			precondition: ContextKeyExpr.and(roomEnabled, CollaborationRoomVisibleContext),
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ICollaborationRoomViewService).activeView.get()?.focus();
	}
});

registerAction2(class CloseCollaborationRoomAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.collaboration.close',
			title: localize2('room.close', "Back to Sessions"),
			category: localize2('room.category', "Agents"),
			icon: Codicon.arrowLeft,
			f1: true,
			precondition: CollaborationRoomVisibleContext,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyW,
				weight: KeybindingWeight.WorkbenchContrib + 3,
				when: CollaborationRoomVisibleContext,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const viewService = accessor.get(ICollaborationRoomViewService);
		if (viewService.visible.get()) {
			// Closing the room returns to the sessions grid as it was; it must not
			// pull focus into whichever session happened to be active last.
			viewService.close();
		}
	}
});
