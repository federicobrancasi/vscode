/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IAgentModelInfo } from '../common/agent.js';
import { parseAgentHostModelSelection } from '../common/agentHostModelSelection.js';
import { schemaProperty } from '../common/agentHostSchema.js';
import { ModelSelection, PolicyState } from '../common/state/sessionState.js';
import { IRoomSessionParticipant } from './agentHostRoomsTypes.js';

export function parseRoomModelSelection(value: unknown): ModelSelection {
	return parseAgentHostModelSelection(value, {
		selection: localize('rooms.invalidModel', "Invalid room model selection."),
		configuration: localize('rooms.invalidModelConfig', "Invalid room model configuration."),
	});
}

export function validateRoomModelSelection(selection: ModelSelection, models: readonly IAgentModelInfo[]): void {
	parseRoomModelSelection(selection);
	const model = models.find(model => model.provider === 'copilotcli' && model.id === selection.id);
	if (!model || model.policyState === PolicyState.Disabled) {
		throw new Error(localize('rooms.modelUnavailable', "The requested model '{0}' is unavailable or disabled by policy.", selection.id));
	}
	for (const [key, value] of Object.entries(selection.config ?? {})) {
		const property = model.configSchema?.properties[key];
		if (!property || property.readOnly || !schemaProperty(property).validate(value)) {
			throw new Error(localize('rooms.modelConfigUnavailable', "The requested model '{0}' does not support this value for '{1}'.", selection.id, key));
		}
	}
	for (const key of model.configSchema?.required ?? []) {
		if (!Object.hasOwn(selection.config ?? {}, key)) {
			throw new Error(localize('rooms.modelConfigRequired', "The requested model '{0}' requires a value for '{1}'.", selection.id, key));
		}
	}
}

export function getRoomMemberModel(member: IRoomSessionParticipant): ModelSelection | undefined {
	if (member.pendingModel !== undefined) {
		return member.pendingModel ?? { id: 'auto' };
	}
	return member.modelSelection ?? (member.model ? { id: member.model } : undefined);
}
