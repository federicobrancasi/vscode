/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { AnchorPosition } from '../../../../base/common/layout.js';
import { autorun, observableSignalFromEvent, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { createAgentHostSandboxToggle, getAgentHostSandboxToggleState } from '../../../../platform/agentHost/browser/agentHostSandboxToggle.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoom, IAgentHostRoomConfiguration } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IAgentHostEnablementService } from '../../../../platform/agentHost/common/agentHostEnablementService.js';
import { platformSessionSchema } from '../../../../platform/agentHost/common/agentHostSchema.js';
import { getAgentHostCopilotSandboxSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { AgentHostCustomTerminalToolEnabledSettingId } from '../../../../platform/agentHost/common/copilotCliConfig.js';
import { SessionConfigKey } from '../../../../platform/agentHost/common/sessionConfigKeys.js';
import { ResolveSessionConfigResult } from '../../../../platform/agentHost/common/state/protocol/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { AgentSandboxEnabledSettingValue, isAgentSandboxEnabledValue } from '../../../../platform/sandbox/common/settings.js';
import { AGENT_HOST_PERMISSIONS_SETTINGS_QUERY, createModePickerModeItems, createModePickerPermissionsItems, getModePermissionsPickerAccessibilityProvider, getModePermissionsPickerOptions, getModePickerAriaLabel, IModePickerTrigger, renderModePickerTrigger } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostModePickerPresentation.js';
import { isAssistedPermissionsEnabled, isAutoApprovePolicyRestricted } from '../../../../workbench/contrib/chat/common/agentHostConfigPolicy.js';
import { maybeConfirmElevatedPermissionLevel } from '../../../../workbench/contrib/chat/common/chatPermissionWarnings.js';
import { ChatConfiguration, ChatPermissionLevel } from '../../../../workbench/contrib/chat/common/constants.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { ICollaborationService } from '../../../services/collaboration/common/collaboration.js';

function label(property: 'mode' | 'autoApprove', value: string | undefined): string {
	if (value === undefined) {
		return localize('room.configurationMixed', "Mixed");
	}
	const schema = platformSessionSchema.definition[property].protocol;
	return schema.enumLabels?.[schema.enum?.indexOf(value) ?? -1] ?? value;
}

function permissionLevel(value: string | undefined): ChatPermissionLevel {
	return value === 'autoApprove' ? ChatPermissionLevel.AutoApprove : value === 'assisted' ? ChatPermissionLevel.Assisted : ChatPermissionLevel.Default;
}

/** The shared mode/permissions presentation, backed by durable room-wide settings. */
export class CollaborationConfigurationPicker extends Disposable {
	readonly element: HTMLElement;
	private readonly trigger: HTMLElement;
	private readonly rendered = this._register(new MutableDisposable<IModePickerTrigger>());
	private readonly busy = observableValue(this, false);
	private menuOpen = false;

	constructor(
		parent: HTMLElement,
		private readonly onError: (error: unknown) => void,
		@ICollaborationService private readonly collaboration: ICollaborationService,
		@IActionWidgetService private readonly actionWidget: IActionWidgetService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialog: IDialogService,
		@IStorageService private readonly storage: IStorageService,
		@IPreferencesService private readonly preferences: IPreferencesService,
		@IAgentHostEnablementService private readonly enablement: IAgentHostEnablementService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		super();
		this.element = append(parent, $('.room-configuration'));
		append(this.element, $('span.room-hint', undefined, localize('room.configurationAllPeers', "All peers")));
		this.trigger = append(this.element, $('div.action-label'));
		const configurationChanged = observableSignalFromEvent(this, configuration.onDidChangeConfiguration);
		this._register(autorun(reader => {
			configurationChanged.read(reader);
			const room = collaboration.activeRoom.read(reader);
			if (collaboration.canConfigure.read(reader)) {
				enablement.managedSandboxEnforced.read(reader);
				enablement.managedSandboxAllowsBypass.read(reader);
			}
			this.update(room, !room?.archived && collaboration.canConfigure.read(reader) && collaboration.availability.read(reader) === 'available' && !this.busy.read(reader));
		}));
	}

	private update(room: IAgentHostRoom | undefined, enabled: boolean): void {
		this.element.hidden = !room || room.archived === true || !this.collaboration.canConfigure.read(undefined);
		this.trigger.ariaDisabled = String(!enabled);
		if (this.element.hidden || !room) {
			if (this.menuOpen) {
				this.actionWidget.hide();
			}
			return;
		}
		const values = room.members.map(member => member.configuration ?? defaultAgentHostRoomConfiguration);
		const mode = values.every(value => value.mode === values[0]?.mode) ? values[0]?.mode : undefined;
		const approvals = isAutoApprovePolicyRestricted(this.configuration) ? 'default'
			: values.every(value => value.autoApprove === values[0]?.autoApprove) ? values[0]?.autoApprove : undefined;
		const permissions = { label: label('autoApprove', approvals), level: permissionLevel(approvals), sandboxed: values.length > 0 && values.every(value => getAgentHostSandboxToggleState(this.sandboxState(value.sandboxEnabled))?.checked) };
		this.trigger.ariaLabel = getModePickerAriaLabel(label('mode', mode), permissions);
		this.rendered.value = renderModePickerTrigger(this.trigger, {
			label: label('mode', mode), icon: mode === 'autopilot' ? Codicon.rocket : mode === 'plan' ? Codicon.checklist : Codicon.comment,
			labelClassName: 'room-mode-label',
		}, permissions, (anchor, openPermissions) => {
			void this.show(anchor, openPermissions).catch(this.onError);
		}, this.rendered.value);
	}

	private async apply(roomId: string, patch: Partial<IAgentHostRoomConfiguration>): Promise<void> {
		if (this.busy.get()) {
			return;
		}
		this.busy.set(true, undefined);
		try {
			if (patch.autoApprove && !await maybeConfirmElevatedPermissionLevel(permissionLevel(patch.autoApprove), this.dialog, this.storage, {
				defaultSettingKey: ChatConfiguration.DefaultConfiguration, levelLabel: localize('room.permissionScope', "{0} for All Peers", label('autoApprove', patch.autoApprove)),
			})) {
				return;
			}
			if (this._store.isDisposed || this.collaboration.activeRoomId.get() !== roomId) {
				throw new CancellationError();
			}
			await this.collaboration.setConfiguration(patch);
		} finally {
			this.busy.set(false, undefined);
		}
	}

	private async show(anchor: HTMLElement, openPermissions: boolean): Promise<void> {
		if (this.busy.get() || this.trigger.ariaDisabled === 'true') {
			return;
		}
		const roomId = this.collaboration.activeRoomId.get();
		if (!roomId) {
			return;
		}
		const resolved = await this.collaboration.getConfiguration();
		if (this._store.isDisposed || this.collaboration.activeRoomId.get() !== roomId) {
			return;
		}
		const action = (property: 'mode' | 'autoApprove', value: string): IAction => toAction({
			id: `room.${property}.${value}`, label: label(property, value), checked: resolved.values[property] === value,
			run: async () => {
				if (property === 'mode' && platformSessionSchema.validate(SessionConfigKey.Mode, value)) {
					await this.apply(roomId, { mode: value });
				} else if (property === 'autoApprove' && platformSessionSchema.validate(SessionConfigKey.AutoApprove, value)) {
					await this.apply(roomId, { autoApprove: value });
				} else {
					throw new Error(localize('room.configurationInvalid', "The selected room configuration is no longer available."));
				}
			},
		});
		const enumItems = (property: 'mode' | 'autoApprove'): IActionListItem<IAction>[] => {
			const schema = resolved.schema.properties[property];
			return (schema?.enum ?? []).flatMap((value, index) => {
				if (typeof value !== 'string' || !platformSessionSchema.validate(property === 'mode' ? SessionConfigKey.Mode : SessionConfigKey.AutoApprove, value)
					|| property === 'autoApprove' && value === 'assisted' && !isAssistedPermissionsEnabled(this.configuration)) {
					return [];
				}
				const item = action(property, value);
				return [{
					kind: ActionListItemKind.Action, item, label: schema.enumLabels?.[index] ?? item.label,
					detail: schema.enumDescriptions?.[index], disabled: schema.readOnly === true || property === 'autoApprove' && value !== 'default' && isAutoApprovePolicyRestricted(this.configuration),
					group: {
						title: '', icon: property === 'mode' ? value === 'autopilot' ? Codicon.rocket : value === 'plan' ? Codicon.checklist : Codicon.comment
							: value === 'autoApprove' ? Codicon.warning : value === 'assisted' ? Codicon.sparkle : Codicon.key
					},
				}];
			});
		};
		const approvals = typeof resolved.values.autoApprove === 'string' ? resolved.values.autoApprove : undefined;
		const permissions = { label: label('autoApprove', approvals), level: permissionLevel(approvals), sandboxed: getAgentHostSandboxToggleState(this.sandboxState(resolved.values.sandboxEnabled))?.checked === true };
		const items: IActionListItem<IAction>[] = [
			...createModePickerModeItems(enumItems('mode'), true),
			{ kind: ActionListItemKind.Separator },
			...createModePickerPermissionsItems<IAction>(permissions, enumItems('autoApprove'), async () => { await this.preferences.openSettings({ query: AGENT_HOST_PERMISSIONS_SETTINGS_QUERY }); }),
			...this.sandboxItems(roomId, resolved),
			{ kind: ActionListItemKind.Separator },
			{
				kind: ActionListItemKind.Action, label: localize('room.configurePermissions', "Learn More About Permissions"), item: toAction({
					id: 'room.permissions.learn', label: localize('room.configurePermissions', "Learn More About Permissions"),
					run: async () => { await this.opener.open(URI.parse('https://aka.ms/vscode/docs/permissions')); },
				})
			},
		];
		this.menuOpen = true;
		anchor.ariaExpanded = 'true';
		this.actionWidget.show('collaboration.configuration', false, items, {
			onSelect: item => {
				this.actionWidget.hide();
				void this.runAction(item);
			},
			onHide: () => {
				this.menuOpen = false;
				anchor.ariaExpanded = 'false';
				if (anchor.isConnected) {
					anchor.focus();
				}
			},
		}, anchor, undefined, undefined, { getAriaLabel: item => item.label ?? '', ...getModePermissionsPickerAccessibilityProvider<IAction>(true) }, {
			...getModePermissionsPickerOptions(openPermissions), anchorPosition: AnchorPosition.BELOW,
		});
	}

	private async runAction(action: IAction): Promise<void> {
		try {
			await action.run();
		} catch (error) {
			this.onError(error);
		}
	}

	private sandboxItems(roomId: string, resolved: ResolveSessionConfigResult): IActionListItem<IAction>[] {
		const schema = resolved.schema.properties.sandboxEnabled;
		if (!schema) {
			return [];
		}
		const toggle = createAgentHostSandboxToggle(() => this.sandboxState(resolved.values.sandboxEnabled), enabled => {
			this.actionWidget.hide();
			void this.apply(roomId, { sandboxEnabled: enabled ? 'on' : 'off' }).catch(this.onError);
		});
		return toggle ? [
			{ kind: ActionListItemKind.Separator },
			{ kind: ActionListItemKind.Action, label: toggle.label, group: { title: '', icon: Codicon.shield }, standaloneToggle: { ...toggle, disabled: toggle.disabled || schema.readOnly === true } },
		] : [];
	}

	private sandboxState(value: unknown) {
		return {
			provider: 'copilotcli',
			sessionEnabled: value === 'on' ? true : value === 'off' ? false : undefined,
			globalEnabled: isAgentSandboxEnabledValue(this.configuration.getValue<AgentSandboxEnabledSettingValue>(
				getAgentHostCopilotSandboxSettingId(this.configuration.getValue<boolean>(AgentHostCustomTerminalToolEnabledSettingId) === true))),
			managedEnabled: this.enablement.managedSandboxEnforced.get(),
			allowsBypass: this.enablement.managedSandboxAllowsBypass.get(),
		};
	}

	override dispose(): void {
		if (this.menuOpen) {
			this.actionWidget.hide();
		}
		super.dispose();
		this.element.remove();
	}
}
