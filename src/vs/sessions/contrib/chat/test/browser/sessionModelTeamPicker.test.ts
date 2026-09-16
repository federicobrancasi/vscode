/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IModelPickerDelegate } from '../../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { resolveModelIdentifier } from '../../../../../workbench/contrib/chat/common/modelSelection.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionModelTeam, ISessionModelTeamState, ISessionsProvider, SessionModelTeamRole } from '../../../../services/sessions/common/sessionsProvider.js';
import { normalizeModelPickerOptions } from '../../browser/sessionModelPickerState.js';
import { getModelTeamModels, getModelTeamPresentation, ISessionModelTeamContext, SessionModelTeamPicker } from '../../browser/sessionModelTeamPicker.js';

function model(id: string): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: id,
		metadata: {
			id, name: id, vendor: 'test', version: '', family: id,
			extension: new ExtensionIdentifier('test.models'),
			maxInputTokens: 1, maxOutputTokens: 1, isDefaultForLocation: {},
			configurationSchema: {
				type: 'object',
				properties: {
					thinkingLevel: { type: 'string', enum: ['low', 'medium', 'high'], enumItemLabels: ['Low', 'Medium', 'High'], default: 'medium', group: 'navigation' },
					contextSize: { type: 'number', enum: [1000, 2000], default: 1000, group: 'tokens' },
				},
			},
		},
	};
}

const lead = model('lead');
const worker = model('worker');
const scout = model('scout');
const auto = model('auto');
const models = [lead, worker, scout, auto];
const chatResource = URI.parse('chat:/one');

class TeamRolePicker extends Disposable {
	private readonly _selected = this._register(new Emitter<ILanguageModelChatMetadataAndIdentifier>());
	readonly onDidChangeSelection = this._selected.event;
	private readonly _closed = this._register(new Emitter<void>());
	readonly onDidClose = this._closed.event;
	anchor: HTMLElement | undefined;
	group: string | undefined;

	constructor(readonly delegate: IModelPickerDelegate, private readonly opened: Emitter<TeamRolePicker>) {
		super();
	}

	setSelectedModel(_model: ILanguageModelChatMetadataAndIdentifier | undefined): void { }

	show(anchor?: HTMLElement): void {
		this.anchor = anchor;
		this.opened.fire(this);
	}

	showConfiguration(anchor?: HTMLElement, group?: string): void {
		this.group = group;
		this.show(anchor);
	}

	choose(modelId: string, close = true): void {
		const selected = this.delegate.getModels().find(model => model.identifier === modelId);
		assert.ok(selected);
		this._selected.fire(selected);
		if (close) {
			this.close();
		}
	}

	close(): void {
		this._closed.fire();
	}
}

suite('SessionModelTeamPicker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function fixture() {
		const changes = store.add(new Emitter<void>());
		const shown = store.add(new Emitter<void>());
		const selected = store.add(new Emitter<void>());
		const opened = store.add(new Emitter<TeamRolePicker>());
		const context = observableValue<ISessionModelTeamContext | undefined>('context', { sessionId: 'test:session', providerId: 'test', chatResource, modelId: 'lead' });
		let state: ISessionModelTeamState = { supported: true, pending: false };
		let barrier: DeferredPromise<void> | undefined;
		let failSave = false;
		let failOpen = false;
		let confirmReset = true;
		let onConfirm: (() => void) | undefined;
		const writes: { sessionId: string; resource: URI; leadModelId: string; team: ISessionModelTeam | undefined; leadConfiguration?: Readonly<Record<string, unknown>> }[] = [];
		const globalWrites: string[] = [];
		const selections: string[] = [];
		const errors: Parameters<INotificationService['error']>[0][] = [];
		const openedChats: { sessionId: string; resource: URI }[] = [];
		const resets: { role: SessionModelTeamRole; expected: URI; resource: URI }[] = [];
		const confirmations: IConfirmation[] = [];
		const session = new class extends mock<ISession>() {
			override readonly sessionId = 'test:session';
		}();
		const provider = new class extends mock<ISessionsProvider>() {
			override readonly id = 'test';
			override readonly onDidChangeModels = Event.None;
			override readonly onDidChangeModelTeam = changes.event;
			override getSessions() { return [session]; }
			override getModelsSnapshot(_sessionId: string, desiredModelId?: string) {
				return { models, modelTarget: 'test', desiredModelResolution: resolveModelIdentifier(models, desiredModelId, true) };
			}
			override getModelTeam(_sessionId: string, resource: URI) { return isEqual(resource, chatResource) ? state : undefined; }
			override async setModelTeam(sessionId: string, resource: URI, leadModelId: string, team: ISessionModelTeam | undefined, leadConfiguration?: Readonly<Record<string, unknown>>) {
				writes.push({ sessionId, resource, leadModelId, team, leadConfiguration });
				await barrier?.p;
				if (failSave) {
					throw new Error('Unable to save team');
				}
				state = {
					...state,
					supported: true,
					pending: true,
					selection: team,
					rememberedSelection: team ? undefined : state.selection ?? state.rememberedSelection,
					leadModelConfiguration: leadConfiguration ?? state.leadModelConfiguration,
					...(state.members ? { members: state.members.map(member => ({ ...member, enabled: !!team && (member.role === 'worker' || !!team.scoutModelId) })) } : {}),
				};
				const current = context.get();
				if (current && isEqual(current.chatResource, resource)) {
					context.set({ ...current, modelId: leadModelId }, undefined);
				}
				changes.fire();
			}
			override async resetModelTeamMember(_sessionId: string, resource: URI, role: SessionModelTeamRole, expected: URI): Promise<void> {
				if (!isEqual(state.members?.find(member => member.role === role)?.chatResource, expected)) {
					throw new Error('Teammate changed before reset');
				}
				resets.push({ role, expected, resource });
			}
		};
		const registeredProvider: ISessionsProvider = provider;
		const providers = new class extends mock<ISessionsProvidersService>() {
			override readonly onDidChangeProviders = Event.None;
			override getProvider<T extends ISessionsProvider>(id: string): T | undefined { return id === registeredProvider.id ? registeredProvider as T : undefined; }
		};
		const languageModels = new class extends mock<ILanguageModelsService>() {
			override readonly onDidChangeLanguageModels = Event.None;
			override getModelConfiguration() { return undefined; }
			override async setModelConfiguration(modelId: string) { globalWrites.push(modelId); }
		};
		const notifications = new class extends mock<INotificationService>() {
			override error(error: Parameters<INotificationService['error']>[0]) { errors.push(error); }
		};
		const sessionsService = new class extends mock<ISessionsService>() {
			override async openChat(session: ISession, resource: URI): Promise<void> {
				openedChats.push({ sessionId: session.sessionId, resource });
			}
		}();
		const dialogService = new class extends mock<IDialogService>() {
			override async confirm(confirmation: IConfirmation) {
				confirmations.push(confirmation);
				onConfirm?.();
				return { confirmed: confirmReset };
			}
		}();
		const picker = store.add(new SessionModelTeamPicker(context, delegate => {
			if (failOpen) {
				failOpen = false;
				throw new Error('Unable to open model picker');
			}
			return new TeamRolePicker(delegate, opened);
		}, providers, new class extends mock<IInstantiationService>() { }(), languageModels, notifications, new NullLogService(), NullHoverService, sessionsService, dialogService));
		const parent = mainWindow.document.body.appendChild($('.monaco-workbench'));
		store.add(toDisposable(() => parent.remove()));
		const mounted = store.add(new MutableDisposable());
		const popup = {
			anchor: parent,
			hide: () => mounted.clear(),
			reopen: () => {
				const content = picker.getAdditionalContent();
				assert.ok(content);
				const renderStore = new DisposableStore();
				if (content.renderHeader) {
					renderStore.add(content.renderHeader(parent, popup));
				}
				if (content.render) {
					renderStore.add(content.render(parent, popup));
				}
				mounted.value = renderStore;
				shown.fire();
			},
		};
		const click = (label: string) => {
			const button = [...parent.querySelectorAll<HTMLElement>('.monaco-button')].find(button => button.getAttribute('aria-label')?.startsWith(label) || button.textContent?.trim() === label.trim());
			assert.ok(button, `Missing button ${label}`);
			button.click();
		};
		const choose = async (role: string, modelId: string | undefined, configure = false) => {
			const opening = Event.toPromise(opened.event);
			click(configure ? `${role} reasoning:` : `Choose model for ${role}:`);
			const rolePicker = await opening;
			const ready = Event.toPromise(shown.event);
			if (modelId) {
				rolePicker.choose(modelId);
			} else {
				rolePicker.close();
			}
			await ready;
			return rolePicker;
		};
		const toggle = () => {
			const toggle = parent.querySelector<HTMLButtonElement>('.monaco-switch');
			assert.ok(toggle);
			toggle.click();
		};
		const currentModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>('model', lead);
		const delegate: IModelPickerDelegate = picker.decorate({
			currentModel,
			setModel: model => { selections.push(model.identifier); selected.fire(); },
			getModels: () => models,
			getPresentationOptions: () => ({ ...normalizeModelPickerOptions(undefined), showModelIcon: true }),
		});
		return {
			picker, parent, context, currentModel, writes, errors, delegate, selections, selected, popup, click, choose, toggle, opened, shown, globalWrites, openedChats, resets, confirmations,
			getState: () => state,
			setState: (value: ISessionModelTeamState) => { state = value; changes.fire(); },
			setBarrier: (value: DeferredPromise<void>) => { barrier = value; },
			failSave: () => { failSave = true; },
			failOpen: () => { failOpen = true; },
			setResetConfirmation: (confirmed: boolean, handler?: () => void) => { confirmReset = confirmed; onConfirm = handler; },
		};
	}

	test('only the lead can select Auto and unsupported models are excluded', () => {
		const hidden = { ...model('hidden'), metadata: { ...model('hidden').metadata, isUserSelectable: false } };
		const byok = { ...model('byok'), metadata: { ...model('byok').metadata, isBYOK: true } };
		const catalog = [...models, hidden, byok];
		assert.deepStrictEqual(['lead', 'worker', 'scout'].map(role => getModelTeamModels(catalog, role === 'lead' ? 'lead' : role === 'worker' ? 'worker' : 'scout').map(model => model.identifier)), [
			['lead', 'worker', 'scout', 'auto'], ['lead', 'worker', 'scout'], ['lead', 'worker', 'scout'],
		]);
	});

	test('models requiring unsupported helper configuration remain Lead-only choices', () => {
		const requiresContext = model('requires-context');
		const configured = {
			...requiresContext,
			metadata: { ...requiresContext.metadata, configurationSchema: { ...requiresContext.metadata.configurationSchema, required: ['contextSize'] } },
		};
		assert.deepStrictEqual({
			lead: getModelTeamModels([configured], 'lead').map(model => model.identifier),
			worker: getModelTeamModels([configured], 'worker'),
		}, { lead: ['requires-context'], worker: [] });
	});

	test('compact presentation names both agents and announces pending changes', () => {
		const presentation = getModelTeamPresentation({ supported: true, pending: true, selection: { workerModelId: 'missing' } }, models, 'lead');
		assert.deepStrictEqual({
			label: presentation?.label,
			aria: presentation?.ariaLabel,
			segments: presentation?.segments?.map(segment => segment.label),
		}, {
			label: 'lead + missing (Unavailable)',
			aria: 'Model team. Lead: lead (Reasoning: Medium). Worker: missing (Unavailable). Applies on the next request.',
			segments: ['lead', 'missing (Unavailable)'],
		});
	});

	test('Single shows only the Team switch without committing a selection', () => {
		const test = fixture();
		test.popup.reopen();
		assert.deepStrictEqual({
			checked: test.parent.querySelector('.monaco-switch')?.getAttribute('aria-checked'),
			roles: test.parent.querySelectorAll('.model-team-card').length,
			replacesList: test.picker.getAdditionalContent()?.replaceModelList,
			writes: test.writes,
		}, { checked: 'false', roles: 0, replacesList: false, writes: [] });
	});

	test('cancelling first-time setup preserves Single', async () => {
		const test = fixture();
		test.popup.reopen();
		const opening = Event.toPromise(test.opened.event);
		test.toggle();
		const rolePicker = await opening;
		const ready = Event.toPromise(test.shown.event);
		rolePicker.close();
		await ready;
		assert.deepStrictEqual({ writes: test.writes, errors: test.errors, presentation: test.picker.selectionPresentation.get() }, { writes: [], errors: [], presentation: undefined });
	});

	test('first-time enabling saves the exact chat without Apply or Cancel', async () => {
		const test = fixture();
		test.popup.reopen();
		const opening = Event.toPromise(test.opened.event);
		test.toggle();
		const rolePicker = await opening;
		const ready = Event.toPromise(test.shown.event);
		rolePicker.choose('worker');
		await ready;
		assert.deepStrictEqual({
			selection: test.getState().selection,
			targets: test.writes.map(write => [write.sessionId, write.resource, write.leadModelId]),
			roles: test.parent.querySelectorAll('.model-team-card').length,
			replacesList: test.picker.getAdditionalContent()?.replaceModelList,
			formButtons: [...test.parent.querySelectorAll('.monaco-button')].filter(button => button.textContent === 'Apply Team' || button.textContent === 'Cancel').length,
			errors: test.errors,
		}, {
			selection: { workerModelId: 'worker', workerModelConfiguration: {} },
			targets: [['test:session', chatResource, 'lead']],
			roles: 2, replacesList: true, formButtons: 0, errors: [],
		});
	});

	test('adding and removing Scout save immediately', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		test.popup.reopen();
		const opening = Event.toPromise(test.opened.event);
		test.click('Add Scout');
		const rolePicker = await opening;
		let ready = Event.toPromise(test.shown.event);
		rolePicker.choose('scout');
		await ready;
		const before = test.parent.querySelectorAll('.model-team-card').length;
		ready = Event.toPromise(test.shown.event);
		test.click('Remove Scout');
		await ready;
		assert.deepStrictEqual({
			before,
			after: test.parent.querySelectorAll('.model-team-card').length,
			selections: test.writes.map(write => write.team?.scoutModelId),
		}, { before: 3, after: 2, selections: ['scout', undefined] });
	});

	test('turning Team off and on remembers helper models and reasoning', async () => {
		const test = fixture();
		const selection = { workerModelId: 'worker', workerModelConfiguration: { thinkingLevel: 'high' }, scoutModelId: 'scout', scoutModelConfiguration: { thinkingLevel: 'low' } };
		test.setState({ supported: true, pending: false, selection, leadModelConfiguration: { thinkingLevel: 'medium' } });
		test.popup.reopen();
		let ready = Event.toPromise(test.shown.event);
		test.toggle();
		await ready;
		const off = { selection: test.getState().selection, remembered: test.getState().rememberedSelection, label: test.picker.selectionPresentation.get() };
		ready = Event.toPromise(test.shown.event);
		test.toggle();
		await ready;
		assert.deepStrictEqual({
			off,
			on: test.getState().selection,
			lead: test.getState().leadModelConfiguration,
			globalWrites: test.globalWrites,
		}, { off: { selection: undefined, remembered: selection, label: undefined }, on: selection, lead: { thinkingLevel: 'medium' }, globalWrites: [] });
	});

	test('role selection uses a standalone picker and restores focus on cancellation', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		test.popup.reopen();
		const rolePicker = await test.choose('Worker', undefined);
		assert.deepStrictEqual({
			anchor: rolePicker.anchor === test.parent,
			current: rolePicker.delegate.currentModel.get()?.identifier,
			focused: mainWindow.document.activeElement?.getAttribute('aria-label'),
			writes: test.writes,
		}, { anchor: true, current: 'worker', focused: 'Choose model for Worker: worker', writes: [] });
	});

	test('the same model has independent reasoning in every role', async () => {
		const test = fixture();
		test.setState({
			supported: true, pending: false, leadModelConfiguration: { thinkingLevel: 'high' },
			selection: { workerModelId: 'lead', workerModelConfiguration: { thinkingLevel: 'medium' }, scoutModelId: 'lead', scoutModelConfiguration: { thinkingLevel: 'high' } },
		});
		test.popup.reopen();
		const opening = Event.toPromise(test.opened.event);
		test.click('Worker reasoning:');
		const rolePicker = await opening;
		const ready = Event.toPromise(test.shown.event);
		await rolePicker.delegate.modelConfiguration?.setModelConfiguration('lead', { thinkingLevel: 'low' });
		rolePicker.close();
		await ready;
		assert.deepStrictEqual({
			group: rolePicker.group,
			lead: test.getState().leadModelConfiguration?.thinkingLevel,
			worker: test.getState().selection?.workerModelConfiguration?.thinkingLevel,
			scout: test.getState().selection?.scoutModelConfiguration?.thinkingLevel,
			focused: mainWindow.document.activeElement?.getAttribute('aria-label'),
			globalWrites: test.globalWrites,
		}, { group: 'navigation', lead: 'high', worker: 'low', scout: 'high', focused: 'Worker reasoning: Low', globalWrites: [] });
	});

	test('Lead reasoning is scoped to the team chat, not global defaults', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker', workerModelConfiguration: { thinkingLevel: 'low' } } });
		await test.delegate.modelConfiguration?.setModelConfiguration('lead', { thinkingLevel: 'high' });
		assert.deepStrictEqual({
			lead: test.getState().leadModelConfiguration,
			worker: test.getState().selection?.workerModelConfiguration,
			globalWrites: test.globalWrites,
		}, { lead: { thinkingLevel: 'high' }, worker: { thinkingLevel: 'low' }, globalWrites: [] });
	});

	test('a chat that has not used a team preserves its original configuration access', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, leadModelConfiguration: { thinkingLevel: 'low' } });
		const before = test.delegate.modelConfiguration?.getModelConfiguration('lead');
		await test.delegate.modelConfiguration?.setModelConfiguration('lead', { thinkingLevel: 'high' });
		assert.deepStrictEqual({ before, globalWrites: test.globalWrites, teamWrites: test.writes }, {
			before: undefined, globalWrites: ['lead'], teamWrites: [],
		});
	});

	test('opening a persistent teammate targets its existing chat without assigning work', async () => {
		const test = fixture();
		const member = { role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: true };
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' }, members: [member] });
		test.popup.reopen();
		const status = test.parent.querySelector('.model-team-member-status')?.textContent;
		test.click('Open Worker Chat');
		await timeout(0);
		assert.deepStrictEqual({ status, opened: test.openedChats, writes: test.writes }, {
			status: 'Waiting for Lead', opened: [{ sessionId: 'test:session', resource: member.chatResource }], writes: [],
		});
	});

	test('member progress updates preserve the focused role controls', () => {
		const test = fixture();
		const member = { role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: true };
		const state = { supported: true, pending: false, selection: { workerModelId: 'worker' }, members: [member] };
		test.setState(state);
		test.popup.reopen();
		const button = test.parent.querySelector<HTMLElement>('[data-role="worker"][data-control="model"]');
		assert.ok(button);
		button.focus();
		test.setState({ ...state, members: [{ ...member, status: SessionStatus.InProgress }] });
		assert.deepStrictEqual({
			sameButton: test.parent.querySelector('[data-role="worker"][data-control="model"]') === button,
			focused: mainWindow.document.activeElement === button,
			status: test.parent.querySelector('.model-team-member-status')?.textContent,
			resetDisabled: test.parent.querySelector('[aria-label="Reset Worker"]')?.getAttribute('aria-disabled'),
		}, { sameButton: true, focused: true, status: 'Working', resetDisabled: 'true' });
	});

	test('paused teammate history stays accessible with Team off', async () => {
		const test = fixture();
		const member = { role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: false };
		test.setState({ supported: true, pending: false, rememberedSelection: { workerModelId: 'worker' }, members: [member] });
		test.popup.reopen();
		const status = test.parent.querySelector('.model-team-member-status')?.textContent;
		test.click('Open Worker Chat');
		await timeout(0);
		assert.deepStrictEqual({ status, opened: test.openedChats, writes: test.writes }, {
			status: 'Paused', opened: [{ sessionId: 'test:session', resource: member.chatResource }], writes: [],
		});
	});

	test('saved histories remain inspectable when runtime support is temporarily unavailable', async () => {
		const test = fixture();
		const member = { role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: false };
		test.setState({ supported: false, pending: false, members: [member] });
		test.popup.reopen();
		const resetDisabled = test.parent.querySelector('[aria-label="Reset Worker"]')?.getAttribute('aria-disabled');
		test.click('Open Worker Chat');
		await timeout(0);
		assert.deepStrictEqual({ resetDisabled, opened: test.openedChats, writes: test.writes }, {
			resetDisabled: 'true', opened: [{ sessionId: 'test:session', resource: member.chatResource }], writes: [],
		});
	});

	test('reset requires confirmation and binds the exact teammate generation', async () => {
		const test = fixture();
		const member = { role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: true };
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' }, members: [member] });
		test.popup.reopen();
		test.setResetConfirmation(false);
		let ready = Event.toPromise(test.shown.event);
		test.click('Reset Worker');
		await ready;
		const cancelled = test.resets.length;
		test.setResetConfirmation(true);
		ready = Event.toPromise(test.shown.event);
		test.click('Reset Worker');
		await ready;
		assert.deepStrictEqual({
			cancelled,
			resets: test.resets,
			confirmations: test.confirmations.map(confirmation => confirmation.message),
		}, { cancelled: 0, resets: [{ role: 'worker', expected: member.chatResource, resource: chatResource }], confirmations: ['Reset Worker?', 'Reset Worker?'] });
	});

	test('a reset confirmation cannot affect a different chat or replacement teammate', async () => {
		const test = fixture();
		const member = { role: 'worker' as const, chatResource: URI.parse('chat:/persistent-worker'), status: SessionStatus.Completed, enabled: true };
		const state = { supported: true, pending: false, selection: { workerModelId: 'worker' }, members: [member] };
		test.setState(state);
		test.popup.reopen();
		test.setResetConfirmation(true, () => test.setState({ ...state, members: [{ ...member, chatResource: URI.parse('chat:/replacement') }] }));
		const ready = Event.toPromise(test.shown.event);
		test.click('Reset Worker');
		await ready;
		const replacementErrors = test.errors.map(error => error instanceof Error ? error.message : error);
		test.setResetConfirmation(true, () => test.context.set(undefined, undefined));
		test.click('Reset Worker');
		await timeout(0);
		assert.deepStrictEqual({ resets: test.resets, replacementErrors }, { resets: [], replacementErrors: ['Teammate changed before reset'] });
	});

	test('helper pickers omit unsupported context controls and reset settings when changing models', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker', workerModelConfiguration: { thinkingLevel: 'high' } } });
		test.popup.reopen();
		const rolePicker = await test.choose('Worker', 'scout');
		assert.deepStrictEqual({
			options: Object.keys(rolePicker.delegate.getModels()[0].metadata.configurationSchema?.properties ?? {}),
			selection: test.getState().selection,
			globalWrites: test.globalWrites,
		}, { options: ['thinkingLevel'], selection: { workerModelId: 'scout', workerModelConfiguration: {} }, globalWrites: [] });
	});

	test('failed saving reports the error and retains the accepted team', async () => {
		const test = fixture();
		const selection = { workerModelId: 'worker' };
		test.setState({ supported: true, pending: false, selection });
		test.failSave();
		test.popup.reopen();
		await test.choose('Worker', 'scout');
		assert.deepStrictEqual({
			selection: test.getState().selection,
			errors: test.errors.map(error => error instanceof Error ? error.message : error),
		}, { selection, errors: ['Unable to save team'] });
	});

	test('a failed picker construction does not block the next attempt', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		test.popup.reopen();
		test.failOpen();
		const ready = Event.toPromise(test.shown.event);
		test.click('Choose model for Worker:');
		await ready;
		await test.choose('Worker', 'scout');
		assert.deepStrictEqual({
			worker: test.getState().selection?.workerModelId,
			errors: test.errors.map(error => error instanceof Error ? error.message : error),
		}, { worker: 'scout', errors: ['Unable to open model picker'] });
	});

	test('model and reasoning changes from one picker flow save in order', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker', scoutModelId: 'scout' } });
		test.popup.reopen();
		const opening = Event.toPromise(test.opened.event);
		test.click('Choose model for Worker:');
		const rolePicker = await opening;
		rolePicker.choose('lead', false);
		await rolePicker.delegate.modelConfiguration?.setModelConfiguration('lead', { thinkingLevel: 'low' });
		const ready = Event.toPromise(test.shown.event);
		rolePicker.close();
		await ready;
		assert.deepStrictEqual({
			selection: test.getState().selection,
			writes: test.writes.map(write => write.team?.workerModelConfiguration),
			globalWrites: test.globalWrites,
		}, {
			selection: { workerModelId: 'lead', workerModelConfiguration: { thinkingLevel: 'low' }, scoutModelId: 'scout' },
			writes: [{}, { thinkingLevel: 'low' }],
			globalWrites: [],
		});
	});

	test('an obsolete remembered reasoning value requires a fresh explicit model choice', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, rememberedSelection: { workerModelId: 'worker', workerModelConfiguration: { thinkingLevel: 'obsolete' } } });
		test.popup.reopen();
		const opening = Event.toPromise(test.opened.event);
		test.toggle();
		const rolePicker = await opening;
		const before = test.writes.length;
		const ready = Event.toPromise(test.shown.event);
		rolePicker.choose('worker');
		await ready;
		assert.deepStrictEqual({ before, selection: test.getState().selection, errors: test.errors }, {
			before: 0, selection: { workerModelId: 'worker', workerModelConfiguration: {} }, errors: [],
		});
	});

	test('restored and committed chat delegates retain the team presentation and cards', () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		test.popup.reopen();
		assert.deepStrictEqual({
			label: test.delegate.selectionPresentation?.get()?.label,
			roles: test.parent.querySelectorAll('.model-team-card').length,
			worker: test.parent.querySelectorAll('.model-team-model')[1].getAttribute('aria-label'),
		}, { label: 'lead + worker', roles: 2, worker: 'Choose model for Worker: worker' });
	});

	test('the canonical input model supplies the Lead while a committed session hydrates', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' }, leadModelConfiguration: { thinkingLevel: 'low' } });
		test.context.set({ sessionId: 'test:session', providerId: 'test', chatResource, modelId: undefined }, undefined);
		const label = test.picker.selectionPresentation.get()?.label;
		test.popup.reopen();
		await test.choose('Worker', 'scout');
		assert.deepStrictEqual({
			label,
			lead: test.writes[0]?.leadModelId,
			worker: test.getState().selection?.workerModelId,
			errors: test.errors,
		}, { label: 'lead + worker', lead: 'lead', worker: 'scout', errors: [] });
	});

	test('an open Lead card follows late canonical model hydration', () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		test.context.set({ sessionId: 'test:session', providerId: 'test', chatResource, modelId: undefined }, undefined);
		test.currentModel.set(undefined, undefined);
		test.popup.reopen();
		test.currentModel.set(lead, undefined);
		assert.deepStrictEqual({
			model: test.parent.querySelector('.model-team-model')?.getAttribute('aria-label'),
			reasoning: test.parent.querySelector('.model-team-reasoning')?.getAttribute('aria-label'),
			writes: test.writes,
		}, { model: 'Choose model for Lead: lead', reasoning: 'Lead reasoning: Medium', writes: [] });
	});

	test('choosing a normal model leaves the team before updating the chat input', async () => {
		const test = fixture();
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		const done = Event.toPromise(test.selected.event);
		test.delegate.setModel(scout);
		await done;
		assert.deepStrictEqual({ teams: test.writes.map(write => write.team), selections: test.selections }, { teams: [undefined], selections: ['scout'] });
	});

	test('a delayed model selection cannot change a different chat input', async () => {
		const test = fixture();
		const barrier = new DeferredPromise<void>();
		test.setBarrier(barrier);
		test.setState({ supported: true, pending: false, selection: { workerModelId: 'worker' } });
		test.delegate.setModel(scout);
		await timeout(0);
		test.context.set(undefined, undefined);
		barrier.complete();
		await timeout(0);
		assert.deepStrictEqual({ resources: test.writes.map(write => write.resource), selections: test.selections }, { resources: [chatResource], selections: [] });
	});

	test('configuration hydration disables the picker content without inventing a team', () => {
		const test = fixture();
		test.setState({ supported: true, loading: true, pending: false });
		assert.deepStrictEqual({ enabled: test.picker.canSelectModel.get(), content: test.picker.getAdditionalContent(), label: test.picker.selectionPresentation.get()?.label }, {
			enabled: false, content: undefined, label: 'Models',
		});
	});
});
