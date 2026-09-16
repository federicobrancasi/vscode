/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { CopilotClient, CustomAgentConfig } from '@github/copilot-sdk';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { SEMANTIC_SEARCH_TOOL_NAME } from '../../common/semanticSearchConstants.js';
import { COPILOT_TEAM_SCOUT, COPILOT_TEAM_WORKER, createCopilotNativeTeam, readCopilotNativeTeamSupport, withCopilotTeamAgents } from '../../node/copilot/copilotNativeTeam.js';

suite('CopilotNativeTeam', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const team = { worker: { id: 'worker-model' }, scout: { id: 'scout-model' } };

	test('roles receive independent concrete models and origin-qualified tool scopes', () => {
		const config = createCopilotNativeTeam(team, new Set([SEMANTIC_SEARCH_TOOL_NAME, 'create_session', 'untrusted_read_tool']), ['custom_shell']);
		assert.deepStrictEqual({
			version: config.version,
			worker: { name: config.worker.agentName, model: config.worker.model, client: config.worker.tools.client, mcp: config.worker.tools.mcp },
			scout: { name: config.scout?.agentName, model: config.scout?.model, client: config.scout?.tools.client, mcp: config.scout?.tools.mcp },
			leadCanWrite: config.leadTools.builtIn.includes('edit') || config.leadTools.builtIn.includes('bash'),
			scoutCanWrite: config.scout?.tools.builtIn.includes('edit') || config.scout?.tools.builtIn.includes('bash'),
			workerCanWrite: config.worker.tools.builtIn.includes('edit') && config.worker.tools.builtIn.includes('bash'),
			workerCanDelegate: config.worker.tools.builtIn.includes('task'),
		}, {
			version: 1,
			worker: { name: COPILOT_TEAM_WORKER, model: 'worker-model', client: [SEMANTIC_SEARCH_TOOL_NAME, 'custom_shell'], mcp: [] },
			scout: { name: COPILOT_TEAM_SCOUT, model: 'scout-model', client: [SEMANTIC_SEARCH_TOOL_NAME], mcp: [] },
			leadCanWrite: false, scoutCanWrite: false, workerCanWrite: true, workerCanDelegate: false,
		});
	});

	test('two-role teams do not define or configure a Scout', () => {
		const two = { worker: team.worker };
		assert.deepStrictEqual({
			scout: createCopilotNativeTeam(two, new Set()).scout,
			agents: withCopilotTeamAgents([], two).map(agent => agent.name),
		}, { scout: undefined, agents: [COPILOT_TEAM_WORKER] });
	});

	test('independent reasoning options reach the custom-agent definitions', () => {
		assert.deepStrictEqual(withCopilotTeamAgents([], team, { worker: 'high', scout: 'low' }).map(agent => ({
			model: agent.model, effort: agent.reasoningEffort,
		})), [{ model: 'worker-model', effort: 'high' }, { model: 'scout-model', effort: 'low' }]);
	});

	test('independent reasoning options are pinned in the runtime contract', () => {
		const config = createCopilotNativeTeam(team, new Set(), [], { worker: 'high', scout: 'low' });
		assert.deepStrictEqual([config.worker.reasoningEffort, config.scout?.reasoningEffort], ['high', 'low']);
	});
	test('user customizations are preserved and reserved name collisions fail', () => {
		const user: CustomAgentConfig = { name: 'user-agent', prompt: 'User instructions', tools: ['view'], infer: false };
		const agents = withCopilotTeamAgents([user], team);
		assert.deepStrictEqual({ original: agents[0], names: agents.map(agent => agent.name) }, {
			original: user, names: ['user-agent', COPILOT_TEAM_WORKER, COPILOT_TEAM_SCOUT],
		});
		assert.throws(() => withCopilotTeamAgents([{ name: COPILOT_TEAM_WORKER, prompt: 'Collision' }], team), /reserved model-team name/);
	});

	test('support discovery does not create a session and handles older runtimes', async () => {
		const supported = upcastPartial<CopilotClient>({
			rpc: upcastPartial<CopilotClient['rpc']>({
				tools: upcastPartial<CopilotClient['rpc']['tools']>({ getTeamCapabilities: async () => ({ contractVersion: 1, supportsReasoningEffort: true }) }),
			}),
		});
		const modelOnly = upcastPartial<CopilotClient>({
			rpc: upcastPartial<CopilotClient['rpc']>({
				tools: upcastPartial<CopilotClient['rpc']['tools']>({ getTeamCapabilities: async () => ({ contractVersion: 1 }) }),
			}),
		});
		const missing = upcastPartial<CopilotClient>({
			rpc: upcastPartial<CopilotClient['rpc']>({
				tools: upcastPartial<CopilotClient['rpc']['tools']>({
					getTeamCapabilities: async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); },
				}),
			}),
		});
		assert.deepStrictEqual([
			await readCopilotNativeTeamSupport(supported, new NullLogService()),
			await readCopilotNativeTeamSupport(modelOnly, new NullLogService()),
			await readCopilotNativeTeamSupport(missing, new NullLogService()),
		], [1, 0, 0]);
	});

	test('discovery errors disable support and are logged', async () => {
		const errors: string[] = [];
		const log = new class extends NullLogService {
			override error(message: string): void { errors.push(message); }
		};
		const client = upcastPartial<CopilotClient>({
			rpc: upcastPartial<CopilotClient['rpc']>({
				tools: upcastPartial<CopilotClient['rpc']['tools']>({
					getTeamCapabilities: async () => { throw new Error('Connection lost'); },
				}),
			}),
		});
		assert.deepStrictEqual({ support: await readCopilotNativeTeamSupport(client, log), errors }, {
			support: 0, errors: ['[Copilot] Could not discover native model-team support'],
		});
	});
});
