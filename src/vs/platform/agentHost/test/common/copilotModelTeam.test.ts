/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAgentModelInfo } from '../../common/agent.js';
import { parseAgentHostModelSelection } from '../../common/agentHostModelSelection.js';
import { CopilotModelTeamAppliedConfigKey, CopilotModelTeamConfigKey, CopilotModelTeamRememberedConfigKey, CopilotModelTeamSupportConfigKey, copilotModelTeamRuntimeSchema, copilotModelTeamSchema, omitCopilotModelTeamConfig, parseCopilotModelTeam, validateCopilotModelTeam } from '../../common/copilotModelTeam.js';
import { PolicyState } from '../../common/state/sessionState.js';

suite('Copilot model teams', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const worker: IAgentModelInfo = { id: 'worker', name: 'Worker', provider: 'copilotcli', supportsVision: false };
	const scout: IAgentModelInfo = { id: 'scout', name: 'Scout', provider: 'copilotcli', supportsVision: false };

	test('Single has an explicit JSON-safe reset', () => {
		assert.deepStrictEqual([
			parseCopilotModelTeam(undefined),
			parseCopilotModelTeam(JSON.parse(JSON.stringify({}))),
			parseCopilotModelTeam({ worker: { id: 'worker' } }),
			parseCopilotModelTeam({ worker: { id: 'worker' }, scout: { id: 'scout' } }),
		], [
			undefined,
			undefined,
			{ worker: { id: 'worker' } },
			{ worker: { id: 'worker' }, scout: { id: 'scout' } },
		]);
	});

	test('malformed teams are not treated as Single', () => {
		for (const value of [null, false, [], '', new Date(), { scout: { id: 'scout' } }, { worker: undefined }, { worker: { id: '' } }, { worker: { id: 'worker' }, extra: true }]) {
			assert.throws(() => parseCopilotModelTeam(value));
		}
	});

	test('helpers require explicit model IDs', () => {
		for (const value of [{ worker: { id: 'auto' } }, { worker: { id: 'worker' }, scout: { id: 'auto' } }]) {
			assert.throws(() => parseCopilotModelTeam(value), /specific model/);
		}
	});

	test('model configuration preserves JSON primitives and rejects nested or unsafe values', () => {
		assert.deepStrictEqual(parseAgentHostModelSelection({ id: 'worker', config: { effort: 'high', context: 1000, enabled: true, optional: null } }), {
			id: 'worker', config: { effort: 'high', context: 1000, enabled: true, optional: null },
		});
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
			assert.throws(() => parseAgentHostModelSelection({ id: 'worker', config: { effort: value } }), /Invalid model configuration/);
		}
		assert.throws(() => parseAgentHostModelSelection({ id: 'worker', config: { constructor: 'invalid' } }), /Invalid model configuration/);
	});

	test('shared parser retains caller-specific validation messages', () => {
		const messages = { selection: 'Invalid room model selection.', configuration: 'Invalid room model configuration.' };
		assert.throws(() => parseAgentHostModelSelection({}, messages), /Invalid room model selection/);
		assert.throws(() => parseAgentHostModelSelection({ id: 'worker', config: [] }, messages), /Invalid room model configuration/);
	});

	test('unavailable or policy-disabled models fail without substitution', () => {
		assert.doesNotThrow(() => validateCopilotModelTeam({ worker: { id: 'worker' }, scout: { id: 'scout' } }, [worker, scout]));
		assert.throws(() => validateCopilotModelTeam({ worker: { id: 'missing' } }, [worker, scout]), /Worker model 'missing'.*replacement/);
		assert.throws(() => validateCopilotModelTeam({ worker: { id: 'worker' }, scout: { id: 'scout' } }, [worker, { ...scout, policyState: PolicyState.Disabled }]), /Scout model 'scout'.*replacement/);
		assert.throws(() => validateCopilotModelTeam({ worker: { id: 'worker' } }, [{ ...worker, provider: 'claude' }]), /unavailable/);
	});

	test('model-specific configuration must be supported and complete', () => {
		const configured: IAgentModelInfo = {
			...worker,
			configSchema: {
				type: 'object',
				properties: {
					thinkingLevel: { type: 'string', title: 'Effort', enum: ['low', 'high'] },
					contextSize: { type: 'number', title: 'Context', enum: [1000] },
				},
				required: ['thinkingLevel'],
			},
		};
		assert.doesNotThrow(() => validateCopilotModelTeam({ worker: { id: 'worker', config: { thinkingLevel: 'high' } } }, [configured]));
		assert.throws(() => validateCopilotModelTeam({ worker: { id: 'worker' } }, [configured]), /requires a value/);
		assert.throws(() => validateCopilotModelTeam({ worker: { id: 'worker', config: { thinkingLevel: 'invalid' } } }, [configured]), /does not support/);
		assert.throws(() => validateCopilotModelTeam({ worker: { id: 'worker', config: { thinkingLevel: 'high', contextSize: 1000 } } }, [configured]), /do not support the helper option/);
	});

	test('selection and saved preferences are mutable and runtime support defaults off', () => {
		assert.deepStrictEqual({
			selectionMutable: copilotModelTeamSchema.definition[CopilotModelTeamConfigKey].protocol.sessionMutable,
			rememberedMutable: copilotModelTeamSchema.definition[CopilotModelTeamRememberedConfigKey].protocol.sessionMutable,
			appliedReadOnly: copilotModelTeamSchema.definition[CopilotModelTeamAppliedConfigKey].protocol.readOnly,
			support: copilotModelTeamRuntimeSchema.definition[CopilotModelTeamSupportConfigKey].protocol,
		}, {
			selectionMutable: true,
			rememberedMutable: true,
			appliedReadOnly: true,
			support: { type: 'number', title: 'Native Model Team Contract Version', enum: [0, 1], default: 0, readOnly: true },
		});
	});

	test('team preferences and runtime state do not leak into automation templates', () => {
		const config = {
			mode: 'interactive',
			[CopilotModelTeamConfigKey]: { worker: { id: 'worker' } },
			[CopilotModelTeamRememberedConfigKey]: { worker: { id: 'worker', config: { thinkingLevel: 'high' } } },
			[CopilotModelTeamAppliedConfigKey]: {},
			[CopilotModelTeamSupportConfigKey]: 1,
		};
		assert.deepStrictEqual(omitCopilotModelTeamConfig(config), { mode: 'interactive' });
		assert.ok(Object.hasOwn(config, CopilotModelTeamConfigKey));
	});
});
