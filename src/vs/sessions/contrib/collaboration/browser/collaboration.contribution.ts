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
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { Menus } from '../../../browser/menus.js';
import { HasSelectedCollaborationRoomContext } from '../../../common/contextkeys.js';
import { ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationService } from '../../../services/collaboration/browser/collaborationService.js';
import { CollaborationAvailableContext, CollaborationEnabledSettingId, CollaborationRoomVisibleContext, CollaborationSupportedContext, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { CollaborationArtifactProvider } from './collaborationArtifactProvider.js';
import { collaborationRoomViewDescriptor } from './collaborationRoomView.js';

registerSingleton(ICollaborationService, CollaborationService, InstantiationType.Delayed);

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
		this._register(autorun(reader => supported.set(collaborationService.supported.read(reader))));
		this._register(autorun(reader => selected.set(!!collaborationService.activeRoomId.read(reader))));
		this._register({ dispose: () => { available.reset(); supported.reset(); visible.reset(); selected.reset(); } });
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
