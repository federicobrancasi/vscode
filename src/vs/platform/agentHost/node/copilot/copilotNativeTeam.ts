/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CopilotClient, CustomAgentConfig, NativeTeamConfig, NativeTeamToolScope } from '@github/copilot-sdk';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { ICopilotModelTeam } from '../../common/copilotModelTeam.js';
import { SEMANTIC_SEARCH_TOOL_NAME } from '../../common/semanticSearchConstants.js';

export const COPILOT_TEAM_WORKER = 'vscode-team-worker';
export const COPILOT_TEAM_SCOUT = 'vscode-team-scout';

const readTools = ['view', 'grep', 'rg', 'glob', 'web_fetch', 'web_search', 'read_memories', 'ask_user'];
const workerTools = [...readTools, 'create', 'edit', 'apply_patch', 'bash', 'read_bash', 'write_bash', 'stop_bash', 'powershell', 'read_powershell', 'write_powershell', 'stop_powershell'];

interface ICopilotTeamReasoning {
	readonly worker?: CustomAgentConfig['reasoningEffort'];
	readonly scout?: CustomAgentConfig['reasoningEffort'];
}

export const COPILOT_NATIVE_TEAM_INSTRUCTIONS = [
	'The user selected a native model team for this chat. You are the Lead: plan, inspect evidence, review results, and give the final answer.',
	'Only the Worker may edit files or execute commands. Delegate implementation and verification to vscode-team-worker using task. When a Scout is configured, delegate independent read-only research to vscode-team-scout.',
	'Keep each assignment bounded and self-contained. At most one Worker and one Scout may run at a time. Leave task model and reasoning overrides unset: the runtime enforces the user-selected models and reasoning.',
	'Wait for the helpers you started before declaring the request complete. Report failed or blocked work honestly. A user-stopped helper must not be restarted without the user asking.',
	'Use no other agents, factories, session-creation tools, or nested delegation. Team selection does not authorize extra permissions, commits, pushes, or changes to another session.',
].join('\n');

export function createCopilotNativeTeam(team: ICopilotModelTeam, clientToolNames: ReadonlySet<string>, shellToolNames: readonly string[] = [], effort: ICopilotTeamReasoning = {}): NativeTeamConfig {
	const readScope: NativeTeamToolScope = {
		builtIn: [...readTools],
		client: clientToolNames.has(SEMANTIC_SEARCH_TOOL_NAME) ? [SEMANTIC_SEARCH_TOOL_NAME] : [],
		mcp: [],
	};
	return {
		version: 1,
		leadTools: { ...readScope, builtIn: [...readTools, 'task', 'read_agent', 'write_agent', 'list_agents'] },
		worker: {
			agentName: COPILOT_TEAM_WORKER,
			model: team.worker.id,
			...(effort.worker ? { reasoningEffort: effort.worker } : {}),
			tools: { ...readScope, builtIn: [...workerTools], client: [...readScope.client, ...shellToolNames] },
		},
		...(team.scout ? {
			scout: { agentName: COPILOT_TEAM_SCOUT, model: team.scout.id, ...(effort.scout ? { reasoningEffort: effort.scout } : {}), tools: readScope },
		} : {}),
	};
}

export function withCopilotTeamAgents(agents: readonly CustomAgentConfig[], team: ICopilotModelTeam, effort: ICopilotTeamReasoning = {}): CustomAgentConfig[] {
	if (agents.some(agent => agent.name === COPILOT_TEAM_WORKER || agent.name === COPILOT_TEAM_SCOUT)) {
		throw new Error(localize('copilot.teamAgentConflict', "A custom agent uses a reserved model-team name. Rename that agent before enabling the team."));
	}
	return [
		...agents,
		{
			name: COPILOT_TEAM_WORKER,
			displayName: localize('copilot.teamWorker', "Worker"),
			description: 'Implements and verifies the Lead\'s bounded assignment using the selected Worker model.',
			prompt: 'Implement only the assigned work in the current workspace. You are the team\'s sole editor. Respect existing user edits, permissions, and project instructions. Run the narrow checks that verify your changes. Do not delegate. Report the files changed, checks run, results, and remaining blockers to the Lead.',
			model: team.worker.id,
			...(effort.worker ? { reasoningEffort: effort.worker } : {}),
			tools: null,
			infer: true,
		},
		...(team.scout ? [{
			name: COPILOT_TEAM_SCOUT,
			displayName: localize('copilot.teamScout', "Scout"),
			description: 'Reads code and gathers evidence for the Lead without changing files or running commands.',
			prompt: 'Investigate only the assigned question. Read permitted code and documentation, and return concise findings with source references and uncertainties. Do not edit files, run commands, delegate, or repeat work assigned to the Worker.',
			model: team.scout.id,
			...(effort.scout ? { reasoningEffort: effort.scout } : {}),
			tools: null,
			infer: true,
		}] : []),
	];
}

export async function readCopilotNativeTeamSupport(client: Pick<CopilotClient, 'rpc'>, logService: ILogService): Promise<0 | 1> {
	try {
		const result = await client.rpc.tools.getTeamCapabilities();
		return result.contractVersion === 1 && result.supportsReasoningEffort === true ? 1 : 0;
	} catch (error) {
		if (typeof error === 'object' && error !== null && Object.getOwnPropertyDescriptor(error, 'code')?.value === -32601) {
			logService.trace('[Copilot] The runtime does not advertise native model teams');
		} else {
			logService.error('[Copilot] Could not discover native model-team support', error);
		}
		return 0;
	}
}
