/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { resolveModelIdentifier } from '../../../../../workbench/contrib/chat/common/modelSelection.js';
import { registerChatFixtureServices } from '../../../../../workbench/test/browser/componentFixtures/chat/chatFixtureUtils.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionModelTeam, ISessionModelTeamState, ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { ISessionModelTeamContext, SessionModelTeamPicker } from '../../browser/sessionModelTeamPicker.js';

const models: ILanguageModelChatMetadataAndIdentifier[] = ['Lead model', 'Worker model with a long name', 'Scout model'].map((name, index) => ({
	identifier: `fixture-model-${index}`,
	metadata: {
		id: `fixture-model-${index}`, name, vendor: 'fixture', family: 'fixture', version: '1',
		extension: new ExtensionIdentifier('fixture.model-teams'),
		maxInputTokens: 128000, maxOutputTokens: 16000, isDefaultForLocation: {},
		configurationSchema: {
			properties: {
				thinkingLevel: {
					type: 'string', group: 'navigation', enum: ['low', 'medium', 'high'],
					enumItemLabels: ['Low', 'Medium', 'High'], default: 'medium',
				},
			},
		},
	},
}));

interface IRolePanelFixtureOptions {
	readonly roleCount: 2 | 3;
	readonly width?: number;
	readonly persistent?: boolean;
	readonly paused?: boolean;
}

function renderRolePanel({ container, disposableStore, theme }: ComponentFixtureContext, options: IRolePanelFixtureOptions): void {
	const { roleCount, width = roleCount === 3 ? 520 : 360 } = options;
	container.style.width = `${width}px`;
	container.style.backgroundColor = 'var(--vscode-editorWidget-background)';
	const context = observableValue<ISessionModelTeamContext>('context', {
		sessionId: 'fixture-session', providerId: 'fixture', chatResource: URI.parse('chat:/model-team-fixture'), modelId: models[0].identifier,
	});
	const changes = disposableStore.add(new Emitter<void>());
	let state: ISessionModelTeamState = {
		supported: true, pending: false, leadModelConfiguration: { thinkingLevel: 'high' },
		selection: {
			workerModelId: models[1].identifier, workerModelConfiguration: { thinkingLevel: 'medium' },
			...(roleCount === 3 ? { scoutModelId: models[2].identifier, scoutModelConfiguration: { thinkingLevel: 'low' } } : {}),
		},
		...(options.persistent ? {
			members: [
				{ role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: !options.paused },
				...(roleCount === 3 ? [{ role: 'scout' as const, chatResource: URI.parse('chat:/persistent-scout'), status: options.paused ? SessionStatus.Completed : SessionStatus.NeedsInput, enabled: !options.paused }] : []),
			],
		} : {}),
	};
	if (options.paused) {
		state = { ...state, selection: undefined, rememberedSelection: state.selection };
	}
	const session = new class extends mock<ISession>() {
		override readonly sessionId = 'fixture-session';
	}();
	const provider = new class extends mock<ISessionsProvider>() {
		override readonly id = 'fixture';
		override readonly onDidChangeModels = Event.None;
		override readonly onDidChangeModelTeam = changes.event;
		override getModelsSnapshot() { return { models, modelTarget: undefined, desiredModelResolution: resolveModelIdentifier(models, context.get().modelId, true) }; }
		override getModelTeam() { return state; }
		override getSessions() { return [session]; }
		override async setModelTeam(_sessionId: string, _chatResource: URI, modelId: string, selection: ISessionModelTeam | undefined, configuration?: Readonly<Record<string, unknown>>): Promise<void> {
			state = {
				...state, selection, leadModelConfiguration: configuration ?? state.leadModelConfiguration,
				rememberedSelection: selection ? undefined : state.selection ?? state.rememberedSelection,
			};
			context.set({ ...context.get(), modelId }, undefined);
			changes.fire();
		}
	};
	const registeredProvider: ISessionsProvider = provider;
	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: theme,
		additionalServices: registration => {
			registerChatFixtureServices(registration);
			registration.defineInstance(ISessionsService, new class extends mock<ISessionsService>() {
				override async openChat(): Promise<void> { }
			}());
			registration.defineInstance(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() {
				override readonly onDidChangeProviders = Event.None;
				override getProvider<T extends ISessionsProvider>(): T { return registeredProvider as T; }
			}());
		},
	});
	const picker = disposableStore.add(instantiationService.createInstance(SessionModelTeamPicker, context, undefined));
	const mounted = disposableStore.add(new MutableDisposable<DisposableStore>());
	const popup = {
		anchor: container,
		hide: () => mounted.clear(),
		reopen: () => {
			const content = picker.getAdditionalContent();
			if (!content) {
				throw new Error('The model-team fixture requires picker content.');
			}
			const renderStore = new DisposableStore();
			mounted.value = renderStore;
			if (content.renderHeader) {
				renderStore.add(content.renderHeader(container, popup));
			}
			if (content.render) {
				renderStore.add(content.render(container, popup));
			}
		},
	};
	popup.reopen();
}

const additionalThemes = ['darkHighContrast', 'lightHighContrast'] as const;

export default defineThemedFixtureGroup({ path: 'sessions/chat/modelTeam/' }, {
	TwoRolePanel: defineComponentFixture({
		labels: { kind: 'screenshot' }, additionalThemes,
		expectedVisualDescriptions: ['An enabled Team switch sits above two equal role cards. Each card has its own model and reasoning button; no Apply/Cancel form is visible.'],
		render: context => renderRolePanel(context, { roleCount: 2 }),
	}),
	ThreeRolePanel: defineComponentFixture({
		labels: { kind: 'screenshot' }, additionalThemes,
		expectedVisualDescriptions: ['Three role cards show Lead, Worker, and Scout with separate High, Medium, and Low reasoning choices, plus a Remove Scout action.'],
		render: context => renderRolePanel(context, { roleCount: 3 }),
	}),
	NarrowThreeRolePanel: defineComponentFixture({
		labels: { kind: 'screenshot' }, additionalThemes,
		expectedVisualDescriptions: ['In a narrow container, the three role cards reflow vertically without clipping their controls. Long model names have ellipses.'],
		render: context => renderRolePanel(context, { roleCount: 3, width: 240 }),
	}),
	PersistentTwoRolePanel: defineComponentFixture({
		labels: { kind: 'screenshot' }, additionalThemes,
		expectedVisualDescriptions: ['The Worker card has a Waiting for Lead status and an Open Chat action beneath its model and reasoning controls. The existing Lead controls remain unchanged.'],
		render: context => renderRolePanel(context, { roleCount: 2, persistent: true }),
	}),
	PersistentNarrowThreeRolePanel: defineComponentFixture({
		labels: { kind: 'screenshot' }, additionalThemes,
		expectedVisualDescriptions: ['Three cards reflow vertically. Worker is Waiting for Lead, Scout needs approval or input, and their chat actions fit within the narrow cards.'],
		render: context => renderRolePanel(context, { roleCount: 3, width: 240, persistent: true }),
	}),
	PersistentPausedHistory: defineComponentFixture({
		labels: { kind: 'screenshot' }, additionalThemes,
		expectedVisualDescriptions: ['The Team switch is off and no model-team cards are visible. Quiet paused-history rows provide actions to open the saved Worker and Scout conversations.'],
		render: context => renderRolePanel(context, { roleCount: 3, width: 360, persistent: true, paused: true }),
	}),
});
