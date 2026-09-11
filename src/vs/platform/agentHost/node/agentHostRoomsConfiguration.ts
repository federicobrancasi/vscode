/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IAgentHostRoomConfiguration } from '../common/agentHostRooms.js';
import { platformSessionSchema, schemaProperty } from '../common/agentHostSchema.js';
import { SessionConfigKey } from '../common/sessionConfigKeys.js';
import { ResolveSessionConfigResult, SessionConfigPropertySchema } from '../common/state/protocol/commands.js';

export const roomConfigurationKeys = [SessionConfigKey.Mode, SessionConfigKey.AutoApprove, SessionConfigKey.SandboxEnabled] as const;

export function parseRoomConfiguration(configuration: unknown, requireAll = false): Partial<IAgentHostRoomConfiguration> {
	if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
		|| (Object.getPrototypeOf(configuration) !== Object.prototype && Object.getPrototypeOf(configuration) !== null)) {
		throw new Error(localize('rooms.invalidConfiguration', "Invalid room configuration."));
	}
	let result: Partial<IAgentHostRoomConfiguration> = {};
	for (const [key, value] of Object.entries(configuration)) {
		if (key === SessionConfigKey.Mode && platformSessionSchema.validate(SessionConfigKey.Mode, value)) {
			result = { ...result, mode: value };
		} else if (key === SessionConfigKey.AutoApprove && platformSessionSchema.validate(SessionConfigKey.AutoApprove, value)) {
			result = { ...result, autoApprove: value };
		} else if (key === SessionConfigKey.SandboxEnabled && platformSessionSchema.validate(SessionConfigKey.SandboxEnabled, value)) {
			result = { ...result, sandboxEnabled: value };
		} else {
			throw new Error(localize('rooms.invalidConfigurationKey', "Invalid or immutable room configuration property: {0}.", key));
		}
	}
	if (requireAll && roomConfigurationKeys.some(key => !Object.hasOwn(configuration, key))) {
		throw new Error(localize('rooms.incompleteConfiguration', "Room configuration must contain mode, approvals, and sandbox selections."));
	}
	return result;
}

export function validateRoomConfigurationChange(configuration: Partial<IAgentHostRoomConfiguration>, resolved: ResolveSessionConfigResult): void {
	for (const key of roomConfigurationKeys) {
		if (!Object.hasOwn(configuration, key)) {
			continue;
		}
		const property = resolved.schema.properties[key];
		if (!property?.sessionMutable || property.readOnly || !schemaProperty(property).validate(configuration[key])) {
			throw new Error(localize('rooms.configurationRestricted', "The current provider or policy does not allow changing {0} to this value.", key));
		}
	}
}

export function intersectRoomConfigurations(configurations: readonly ResolveSessionConfigResult[]): ResolveSessionConfigResult {
	const properties: Record<string, SessionConfigPropertySchema> = {};
	const values: Record<string, unknown> = {};
	for (const key of roomConfigurationKeys) {
		const first = configurations[0]?.schema.properties[key];
		if (!first?.enum || configurations.some(configuration => !configuration.schema.properties[key]?.enum)) {
			continue;
		}
		const indices = first.enum.map((_, index) => index).filter(index =>
			configurations.every(configuration => configuration.schema.properties[key].enum!.includes(first.enum![index])));
		properties[key] = {
			...first,
			enum: indices.map(index => first.enum![index]),
			...(first.enumLabels ? { enumLabels: indices.map(index => first.enumLabels![index]) } : {}),
			...(first.enumDescriptions ? { enumDescriptions: indices.map(index => first.enumDescriptions![index]) } : {}),
			sessionMutable: configurations.every(configuration => configuration.schema.properties[key].sessionMutable === true),
			...(configurations.some(configuration => configuration.schema.properties[key].readOnly === true) ? { readOnly: true } : {}),
		};
		const value = configurations[0].values[key];
		if (value !== undefined && configurations.every(configuration => configuration.values[key] === value)) {
			values[key] = value;
		}
	}
	return { schema: { type: 'object', properties }, values };
}
