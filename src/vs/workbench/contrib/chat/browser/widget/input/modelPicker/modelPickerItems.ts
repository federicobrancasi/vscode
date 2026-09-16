/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../../../../../base/common/collections.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { localize } from '../../../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetDropdownAction } from '../../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { ChatEntitlement, IChatEntitlementService, isProUser } from '../../../../../../services/chat/common/chatEntitlementService.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../../../common/constants.js';
import { IModelControlEntry, ILanguageModelChatMetadataAndIdentifier, IModelsControlManifest } from '../../../../common/languageModels.js';
import type { IModelPickerAdditionalActionGroup } from './modelPickerActionItem.js';
import { buildFlatModelItems, buildGroupedModelItems, buildUnavailableStateItems, RESTRICTED_MODE_TRUST_ACTION_ID, SETUP_REQUIRED_SIGN_IN_ACTION_ID } from './modelPickerItemSections.js';
import type { IBuildModelPickerItemsOptions } from './modelPickerItemTypes.js';

export type { IBuildModelPickerItemsOptions } from './modelPickerItemTypes.js';
export { ModelPickerSection } from './modelPickerItemSections.js';

const PICKER_COMMAND_ACTION_IDS: ReadonlySet<string> = new Set([RESTRICTED_MODE_TRUST_ACTION_ID, SETUP_REQUIRED_SIGN_IN_ACTION_ID]);

interface IModelPickerActionListItem extends IActionListItem<IActionWidgetDropdownAction> {
	readonly isAdditionalAction?: boolean;
}

export function getControlModelsForEntitlement(manifest: IModelsControlManifest, entitlement: ChatEntitlement): IStringDictionary<IModelControlEntry> {
	return isProUser(entitlement) && entitlement !== ChatEntitlement.EDU ? manifest.paid : manifest.free;
}

export function getModelPickerControlModels(
	manifest: IModelsControlManifest,
	entitlement: ChatEntitlement,
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
): IStringDictionary<IModelControlEntry> {
	if (entitlement !== ChatEntitlement.Unknown) {
		return getControlModelsForEntitlement(manifest, entitlement);
	}

	const availableModelIds = new Set(models
		.filter(model => !model.metadata.isBYOK && !model.metadata.byokModelIdentifier && !!model.metadata.targetChatSessionType)
		.map(model => model.metadata.id));
	const controlModels: IStringDictionary<IModelControlEntry> = {};
	for (const tier of [manifest.free, manifest.paid]) {
		for (const [id, entry] of Object.entries(tier)) {
			if (entry.featured && availableModelIds.has(id)) {
				controlModels[id] = { ...entry, exists: true };
			} else if (entry.demoted && !controlModels[id]) {
				// A demotion holds whoever is signed in, so it is not filtered away with
				// the curated list the way a recommendation is.
				controlModels[id] = { ...entry, exists: false };
			}
		}
	}
	return controlModels;
}

export function shouldShowManageModelsAction(chatEntitlementService: IChatEntitlementService): boolean {
	return chatEntitlementService.clientByokEnabled ||
		chatEntitlementService.hasByokModels ||
		chatEntitlementService.entitlement === ChatEntitlement.Free ||
		chatEntitlementService.entitlement === ChatEntitlement.EDU ||
		chatEntitlementService.entitlement === ChatEntitlement.Pro ||
		chatEntitlementService.entitlement === ChatEntitlement.ProPlus ||
		chatEntitlementService.entitlement === ChatEntitlement.Max ||
		chatEntitlementService.entitlement === ChatEntitlement.Business ||
		chatEntitlementService.entitlement === ChatEntitlement.Enterprise ||
		chatEntitlementService.isInternal;
}

export function createManageModelsAction(commandService: ICommandService): IActionWidgetDropdownAction {
	return {
		id: 'manageModels',
		enabled: true,
		checked: false,
		class: ThemeIcon.asClassName(Codicon.gear),
		tooltip: localize('chat.manageModels.tooltip', "Manage Language Models"),
		label: localize('chat.manageModels', "Manage Models..."),
		run: () => { commandService.executeCommand(MANAGE_CHAT_COMMAND_ID); },
	};
}

/** Builds the ordered model picker sections for the current presentation state. */
export function buildModelPickerItems(options: IBuildModelPickerItemsOptions): IActionListItem<IActionWidgetDropdownAction>[] {
	const unavailableItems = buildUnavailableStateItems(options);
	if (unavailableItems && (options.presentation.restrictedMode || options.presentation.setupRequired)) {
		return unavailableItems;
	}
	const items = unavailableItems ?? (options.presentation.useGroupedModelPicker
		? buildGroupedModelItems(options)
		: buildFlatModelItems(options));
	return prependModelPickerActionGroups(items, options.additionalActionGroups);
}

export function prependModelPickerActionGroups(
	items: IActionListItem<IActionWidgetDropdownAction>[],
	groups: readonly IModelPickerAdditionalActionGroup[] | undefined,
): IActionListItem<IActionWidgetDropdownAction>[] {
	const additionalItems: IModelPickerActionListItem[] = [];
	for (const group of groups ?? []) {
		if (!group.actions.length) {
			continue;
		}
		additionalItems.push({ kind: ActionListItemKind.Separator, label: group.label });
		for (const action of group.actions) {
			additionalItems.push({
				item: action,
				kind: ActionListItemKind.Action,
				isAdditionalAction: true,
				label: action.label,
				description: action.description,
				ariaDescription: action.ariaDescription,
				detail: action.detail,
				tooltip: action.tooltip,
				group: { title: '', icon: action.icon ?? (action.checked ? Codicon.check : Codicon.blank) },
				disabled: !action.enabled,
				hideIcon: action.checked === undefined && !action.icon,
				hover: action.hover,
				toolbarActions: action.toolbarActions,
				className: action.className,
				inlineToggle: action.inlineToggle,
				standaloneToggle: action.standaloneToggle,
				keybinding: action.keybinding,
			});
		}
	}
	if (!additionalItems.length) {
		return items;
	}
	if (items[0]?.kind === ActionListItemKind.Action) {
		additionalItems.push({ kind: ActionListItemKind.Separator });
	}
	return [...additionalItems, ...items];
}

export function getModelPickerAccessibilityProvider(isSearch = false) {
	return {
		getAriaLabel(element: IModelPickerActionListItem) {
			if (element.kind !== ActionListItemKind.Action) {
				return null;
			}
			const description = element.ariaDescription ?? (typeof element.description === 'string' ? element.description : element.description?.value);
			const selection = isSearch && element.item?.checked
				? element.isAdditionalAction ? localize('chat.modelPicker.selectedAction', "Selected") : localize('chat.modelPicker.currentModel', "Current model")
				: undefined;
			return [element.label, element.badge, description, selection].filter((part): part is string => !!part).join(', ');
		},
		isChecked(element: IModelPickerActionListItem) {
			if (isSearch || element.isSectionToggle) {
				return undefined;
			}
			if (element.isAdditionalAction) {
				return element.item?.checked;
			}
			if (element.kind === ActionListItemKind.Action && !(element.item?.id && PICKER_COMMAND_ACTION_IDS.has(element.item.id))) {
				return !!element.item?.checked;
			}
			return undefined;
		},
		getRole: (element: IModelPickerActionListItem) => {
			if (isSearch) {
				return element.kind === ActionListItemKind.Action ? 'option' : 'separator';
			}
			if (element.isSectionToggle) {
				return 'menuitem';
			}
			switch (element.kind) {
				case ActionListItemKind.Action:
					if (element.isAdditionalAction) {
						return element.item?.checked === undefined ? 'menuitem' : 'menuitemcheckbox';
					}
					return element.item?.id && PICKER_COMMAND_ACTION_IDS.has(element.item.id) ? 'menuitem' : 'menuitemradio';
				case ActionListItemKind.Separator:
				default:
					return 'separator';
			}
		},
		getWidgetRole: () => isSearch ? 'listbox' : 'menu',
	} as const;
}
