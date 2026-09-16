/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import { CopilotModelTeamConfigKey, CopilotModelTeamSupportConfigKey } from '../../../../common/copilotModelTeam.js';
import { ResolveSessionConfigResult, SubscribeResult } from '../../../../common/state/protocol/commands.js';
import { ActionType } from '../../../../common/state/sessionActions.js';
import { ROOT_STATE_URI, RootState } from '../../../../common/state/sessionState.js';
import { fetchSessionWithChat, getActionEnvelope, isActionNotification } from '../../serverIntegrationTestHelpers.js';
import { createRealSession } from '../harness/agentHostE2ETestHarness.js';
import { IAgentHostE2ETestContext, providerHostOnlyTest } from './e2eTestContext.js';

export function defineNativeModelTeamTests(context: IAgentHostE2ETestContext): void {
	if (context.config.provider !== 'copilotcli') {
		return;
	}

	providerHostOnlyTest(context, 'native model teams: capability, configuration and reset use no inference', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'ahp-native-team-'));
		context.tempDirs.push(workspace);
		const sessionUri = await createRealSession(context.client, context.config, 'native-team-config', context.createdSessions, URI.file(workspace));
		const root = await context.client.call<SubscribeResult>('subscribe', { channel: ROOT_STATE_URI });
		const state = root.snapshot?.state as RootState | undefined;
		assert.strictEqual(state?.config?.values[CopilotModelTeamSupportConfigKey], 1, 'The installed runtime must enforce native team contract v1');
		const model = state.agents.find(agent => agent.provider === 'copilotcli')?.models.find(model => model.id !== 'auto');
		assert.ok(model, 'The Copilot catalog must contain a concrete helper model');
		const team = { worker: { id: model.id } };
		const resolved = await context.client.call<ResolveSessionConfigResult>('resolveSessionConfig', {
			provider: 'copilotcli', workingDirectory: URI.file(workspace).toString(),
			config: { [CopilotModelTeamConfigKey]: team },
		});
		assert.deepStrictEqual(resolved.values[CopilotModelTeamConfigKey], team);

		for (const [index, value] of [team, {}].entries()) {
			context.client.clearReceived();
			context.client.dispatch({
				channel: sessionUri, clientSeq: index + 1,
				action: { type: ActionType.SessionConfigChanged, config: { [CopilotModelTeamConfigKey]: value } },
			});
			await context.client.waitForNotification(notification => isActionNotification(notification, ActionType.SessionConfigChanged)
				&& getActionEnvelope(notification).channel === sessionUri);
			const current = await fetchSessionWithChat(context.client, sessionUri);
			assert.deepStrictEqual(current.config?.values[CopilotModelTeamConfigKey], value);
		}
		await assert.rejects(context.client.call('resolveSessionConfig', {
			provider: 'copilotcli', workingDirectory: URI.file(workspace).toString(),
			config: { [CopilotModelTeamConfigKey]: { worker: { id: 'unavailable-native-team-model' } } },
		}), /unavailable|disabled by policy/);
		assert.deepStrictEqual(context.observedModelRequestBodies, []);
	});
}
