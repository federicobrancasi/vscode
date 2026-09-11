/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IAgentModelInfo } from '../common/agent.js';
import { IAgentHostRoomMember } from '../common/agentHostRooms.js';
import { schemaProperty } from '../common/agentHostSchema.js';
import { ModelSelection, PolicyState } from '../common/state/sessionState.js';
import { JsonPrimitive } from '../common/state/protocol/state.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isPrimitive(value: unknown): value is JsonPrimitive {
	return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

export function parseRoomModelSelection(value: unknown): ModelSelection {
	if (!isPlainRecord(value) || Object.keys(value).some(key => key !== 'id' && key !== 'config')
		|| typeof value.id !== 'string' || !value.id.trim() || value.id.includes('\0')) {
		throw new Error(localize('rooms.invalidModel', "Invalid room model selection."));
	}
	if (value.config === undefined) {
		return { id: value.id };
	}
	if (!isPlainRecord(value.config)) {
		throw new Error(localize('rooms.invalidModelConfig', "Invalid room model configuration."));
	}
	const config: NonNullable<ModelSelection['config']> = {};
	for (const [key, setting] of Object.entries(value.config)) {
		if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) || !isPrimitive(setting)) {
			throw new Error(localize('rooms.invalidModelConfig', "Invalid room model configuration."));
		}
		config[key] = setting;
	}
	return { id: value.id, config };
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

export function getRoomMemberModel(member: IAgentHostRoomMember): ModelSelection | undefined {
	if (member.pendingModel !== undefined) {
		return member.pendingModel ?? { id: 'auto' };
	}
	return member.modelSelection ?? (member.model ? { id: member.model } : undefined);
}
