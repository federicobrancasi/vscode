/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { IAction } from '../../../../../base/common/actions.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatAcceptInputOptions, IChatWidget, IChatWidgetViewModelChangeEvent } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatInputPart } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { IChatResponseFileChangesService } from '../../../../../workbench/contrib/chat/browser/chatResponseFileChangesService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatMode } from '../../../../../workbench/contrib/chat/common/chatModes.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { emptySessionEntryDiff, IEditSessionEntryDiff } from '../../../../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { ChatModel, IChatResponseModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IChatViewModel } from '../../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ChatAgentService, IChatAgentService } from '../../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { MockChatService } from '../../../../../workbench/contrib/chat/test/common/chatService/mockChatService.js';
import { IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { hasAppFileChanges, SessionTestAppButton } from '../../browser/sessionTestAppButton.js';

suite('SessionTestAppButton', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const diff = (path: string): IEditSessionEntryDiff => ({
		...emptySessionEntryDiff(URI.file(path), URI.file(path)), identical: false, added: 1,
	});

	function setup(workingDirectory = URI.file('/app')) {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IChatService, new MockChatService());
		instantiationService.stub(IChatAgentService, store.add(instantiationService.createInstance(ChatAgentService)));
		const model = store.add(instantiationService.createInstance(ChatModel, undefined, { initialLocation: ChatAgentLocation.Chat, canUseTools: true }));
		model.setWorkingDirectory(workingDirectory);
		const changes = observableValue<readonly IEditSessionEntryDiff[]>('changes', []);
		const interactive = observableValue('interactive', true);
		const mode = observableValue<IChatMode>('mode', upcastPartial<IChatMode>({ kind: ChatModeKind.Agent }));
		const sentiment = observableValue('sentiment', { hidden: false });
		const viewChanged = store.add(new Emitter<IChatWidgetViewModelChangeEvent>());
		const errors: unknown[] = [];
		const warnings: unknown[][] = [];
		const requests: { prompt: string | undefined; options: IChatAcceptInputOptions | undefined }[] = [];
		const files = new Map<string, string | Error>();
		const reads: URI[] = [];
		let readFile = async (uri: URI): Promise<string> => {
			const content = files.get(uri.path);
			if (content instanceof Error) {
				throw content;
			}
			if (content === undefined) {
				throw new FileOperationError('Not found', FileOperationResult.FILE_NOT_FOUND);
			}
			return content;
		};
		let menu: Parameters<IContextMenuService['showContextMenu']>[0] | undefined;
		const input = $('input');
		let viewModel: IChatViewModel | undefined = upcastPartial<IChatViewModel>({ model });
		let send = async (): Promise<IChatResponseModel | undefined> => model.lastRequest?.response;
		const widget = upcastPartial<IChatWidget>({
			onDidChangeViewModel: viewChanged.event,
			get viewModel() { return viewModel; },
			input: upcastPartial<ChatInputPart>({ currentModeObs: mode }),
			focusInput: () => input.focus(),
			acceptInput: async (prompt, options) => { requests.push({ prompt, options }); return send(); },
		});
		const button = store.add(new SessionTestAppButton(widget, interactive,
			upcastPartial<IChatResponseFileChangesService>({ getChangesForRequest: () => changes }),
			upcastPartial<IChatEntitlementService>({ sentimentObs: sentiment }),
			upcastPartial<INotificationService>({ error: error => { errors.push(error); return upcastPartial<INotificationHandle>({}); } }),
			upcastPartial<IContextMenuService>({ showContextMenu: delegate => { menu = delegate; } }),
			upcastPartial<IFileService>({
				readFile: async uri => {
					reads.push(uri);
					return upcastPartial<IFileContent>({ value: VSBuffer.fromString(await readFile(uri)) });
				}
			}),
			upcastPartial<ILogService>({ warn: (...args) => warnings.push(args) }),
		));
		const container = $('div', undefined, button.element, input);
		store.add(toDisposable(() => container.remove()));
		document.body.appendChild(container);
		const request = model.addRequest({ text: 'Implement the app', parts: [] }, { variables: [] }, 0);
		const primary = button.element.querySelector<HTMLElement>('.monaco-text-button')!;
		const dropdown = button.element.querySelector<HTMLElement>('.monaco-dropdown-button')!;
		const openMenu = (): readonly IAction[] => {
			dropdown.click();
			assert.ok(menu?.getActions);
			return menu.getActions();
		};
		return {
			model, request, changes, interactive, mode, sentiment, button, errors, requests, files, reads, warnings, input, primary, dropdown, openMenu,
			setSend: (value: typeof send) => send = value,
			setReadFile: (value: typeof readFile) => readFile = value,
			hideMenu: () => menu?.onHide?.(true),
			clearViewModel: () => {
				viewModel = undefined;
				viewChanged.fire({ previousSessionResource: model.sessionResource, currentSessionResource: undefined });
			},
		};
	}

	test('detects app UI changes without tool signals or a file-count threshold', () => {
		const paths = ['/app/index.html', '/app/App.tsx', '/app/App.vue', '/app/style.css', '/app/ContentView.swift', '/app/MainWindow.xaml', '/app/chatWidget.ts',
			'/app/script.py', '/app/lib.ts', '/app/docs/index.html', '/app/tests/App.tsx', '/app/App.spec.tsx'];
		assert.deepStrictEqual(paths.map(path => hasAppFileChanges([diff(path)], URI.file('/app'))), [
			true, true, true, true, true, true, true, false, false, false, false, false,
		]);
		assert.deepStrictEqual([
			hasAppFileChanges([{ ...diff('/app/index.html'), identical: true }]),
			hasAppFileChanges([{ ...diff('/app/index.html'), isDeleted: true }]),
			hasAppFileChanges([]),
		], [false, false, false]);
		assert.deepStrictEqual([
			hasAppFileChanges([diff('/home/test/styles.css')], URI.file('/home/test')),
			hasAppFileChanges([diff('/home/test/tests/App.tsx')], URI.file('/home/test')),
		], [true, false]);
	});

	test('tracks completion, async file changes, permissions, mode and the next request', () => {
		const { request, model, button, changes, interactive, mode, sentiment } = setup();
		const visible = () => !button.element.hidden;
		const states = [visible()];
		request.response!.complete();
		states.push(visible());
		changes.set([diff('/app/index.html')], undefined);
		states.push(visible());
		interactive.set(false, undefined);
		states.push(visible());
		interactive.set(true, undefined);
		mode.set(upcastPartial<IChatMode>({ kind: ChatModeKind.Ask }), undefined);
		states.push(visible());
		mode.set(upcastPartial<IChatMode>({ kind: ChatModeKind.Agent }), undefined);
		sentiment.set({ hidden: true }, undefined);
		states.push(visible());
		sentiment.set({ hidden: false }, undefined);
		states.push(visible());
		model.addRequest({ text: 'Next request', parts: [] }, { variables: [] }, 0);
		states.push(visible());
		assert.deepStrictEqual(states, [false, false, true, false, false, false, true, false]);
	});

	test('detects UI projects for ordinary source files without scanning the workspace', async () => {
		const cases = [
			{ path: 'main.ts', file: 'package.json', content: '{"dependencies":{"react-native":"0.81"}}', visible: true },
			{ path: 'main.js', file: 'package.json', content: '{"devDependencies":{"electron":"38"}}', visible: true },
			{ path: 'main.ts', file: 'package.json', content: '{"dependencies":{"express":"5"}}', visible: false },
			{ path: 'main.ts', file: 'package.json', content: '{"dependencies":{"react":false}}', visible: false },
			{ path: 'lib/main.dart', file: 'pubspec.yaml', content: 'dependencies:\n  flutter:\n    sdk: flutter\n', visible: true },
			{ path: 'lib/main.dart', file: 'pubspec.yaml', content: 'dependencies: {flutter: {sdk: "flutter"}}', visible: true },
			{ path: 'bin/main.dart', file: 'pubspec.yaml', content: 'dependencies:\n  args: ^2.0.0\n', visible: false },
			{ path: 'bin/main.dart', file: 'pubspec.yaml', content: 'description: |\n  flutter:\n    sdk: flutter\n', visible: false },
		];
		const actual = [];
		for (const entry of cases) {
			const { model, request, changes, button, files, reads, warnings } = setup(URI.parse('vscode-remote://host/app'));
			files.set(`/app/${entry.file}`, entry.content);
			changes.set([{ ...diff(`/app/${entry.path}`), modifiedURI: URI.parse(`vscode-remote://host/app/${entry.path}`) }], undefined);
			request.response!.complete();
			await timeout(0);
			actual.push({ path: entry.path, visible: button.visible.get(), reads: reads.map(uri => uri.toString()), warnings: warnings.length });
			model.dispose();
			button.dispose();
		}
		assert.deepStrictEqual(actual, cases.map(entry => ({
			path: entry.path, visible: entry.visible, reads: [`vscode-remote://host/app/${entry.file}`], warnings: 0,
		})));
	});

	test('skips configuration reads for UI fast paths, excluded files, outside files and busy chats', async () => {
		const { request, changes, button, files, reads } = setup();
		files.set('/app/package.json', '{"dependencies":{"react":"19"}}');
		changes.set([diff('/app/main.ts')], undefined);
		await timeout(0);
		const states = [button.visible.get()];
		changes.set([diff('/app/index.html')], undefined);
		request.response!.complete();
		states.push(button.visible.get());
		for (const path of ['/app/README.md', '/app/tests/main.ts', '/app/main.spec.ts', '/app/docs/main.ts', '/outside/main.ts', '/app/script.py']) {
			changes.set([diff(path)], undefined);
			await timeout(0);
			states.push(button.visible.get());
		}
		assert.deepStrictEqual({ states, reads }, { states: [false, true, false, false, false, false, false, false], reads: [] });
	});

	test('logs invalid or unreadable manifests but treats missing manifests as a negative hint', async () => {
		const { request, changes, button, files, warnings } = setup();
		request.response!.complete();
		const actual = [];
		for (const content of [undefined, '{', 'null', new Error('Permission denied')]) {
			files.clear();
			if (content !== undefined) {
				files.set('/app/package.json', content);
			}
			changes.set([diff('/app/main.ts')], undefined);
			await timeout(0);
			actual.push({ visible: button.visible.get(), warnings: warnings.length });
		}
		files.set('/app/pubspec.yaml', 'dependencies: [flutter');
		changes.set([diff('/app/main.dart')], undefined);
		await timeout(0);
		actual.push({ visible: button.visible.get(), warnings: warnings.length });
		assert.deepStrictEqual(actual, [
			{ visible: false, warnings: 0 }, { visible: false, warnings: 1 },
			{ visible: false, warnings: 2 }, { visible: false, warnings: 3 }, { visible: false, warnings: 4 },
		]);
	});

	test('does not apply a pending project hint after the changes, turn or chat changes', async () => {
		for (const scenario of ['changes', 'turn', 'chat', 'dispose']) {
			const { request, changes, button, setReadFile, model, clearViewModel } = setup();
			const pending = new DeferredPromise<string>();
			setReadFile(() => pending.p);
			changes.set([diff('/app/main.ts')], undefined);
			request.response!.complete();
			if (scenario === 'changes') {
				changes.set([diff('/app/script.py')], undefined);
			} else if (scenario === 'turn') {
				model.addRequest({ text: 'Next request', parts: [] }, { variables: [] }, 0);
			} else if (scenario === 'chat') {
				clearViewModel();
			} else {
				button.dispose();
			}
			await pending.complete('{"dependencies":{"react":"19"}}');
			await timeout(0);
			assert.strictEqual(button.element.hidden, true, scenario);
		}
	});

	test('offers a one-off subagent prompt and preserves the primary action', async () => {
		const { request, changes, requests, primary, dropdown, openMenu, hideMenu } = setup();
		changes.set([diff('/app/index.html')], undefined);
		request.response!.complete();
		primary.click();
		await timeout(0);
		const actions = openMenu();
		const menuState = {
			label: dropdown.getAttribute('aria-label'), expanded: dropdown.getAttribute('aria-expanded'),
			actions: actions.map(action => ({ label: action.label, enabled: action.enabled })),
		};
		hideMenu();
		await actions[0].run();
		primary.click();
		await timeout(0);
		assert.deepStrictEqual({
			menuState, expandedAfterHide: dropdown.getAttribute('aria-expanded'),
			delegation: requests.map(request => request.prompt?.includes('Delegate UI verification')),
			diffFirst: requests.every(request => request.prompt?.includes('First review the original requirements')),
			nativeTarget: requests.every(request => request.prompt?.includes('A browser preview does not verify a native target')),
			fallback: requests[1].prompt?.includes('SORRY NO SUBAGENTS I WILL DO IT'),
			preserved: requests.every(request => request.options?.preserveInput && request.options.enableImplicitContext === false),
			primaryLabel: primary.getAttribute('aria-label'),
		}, {
			menuState: { label: 'App Testing Options', expanded: 'true', actions: [{ label: 'Test with Subagent', enabled: true }] },
			expandedAfterHide: 'false', delegation: [false, true, false], diffFirst: true, nativeTarget: true,
			fallback: true, preserved: true, primaryLabel: 'Test App',
		});
	});

	test('rejects stale menu actions and restores focus when the dropdown disappears', async () => {
		const { request, changes, button, dropdown, input, requests, openMenu } = setup();
		changes.set([diff('/app/index.html')], undefined);
		request.response!.complete();
		const actions = openMenu();
		dropdown.focus();
		const focused = document.activeElement === dropdown;
		changes.set([], undefined);
		await actions[0].run();
		assert.deepStrictEqual({
			focused, restoredFocus: document.activeElement === input, hidden: button.element.hidden, requests,
		}, { focused: true, restoredFocus: true, hidden: true, requests: [] });
	});

	test('does not submit a menu action after disposal', async () => {
		const { request, changes, button, requests, openMenu } = setup();
		changes.set([diff('/app/index.html')], undefined);
		request.response!.complete();
		const actions = openMenu();
		button.dispose();
		await actions[0].run();
		assert.deepStrictEqual(requests, []);
	});

	test('submits once to the owning widget, preserves the draft and reports failures', async () => {
		const { request, button, changes, requests, errors, setSend } = setup();
		request.response!.complete();
		changes.set([diff('/app/index.html')], undefined);
		const pending = new DeferredPromise<IChatResponseModel | undefined>();
		setSend(() => pending.p);
		const control = button.element.querySelector<HTMLElement>('[role="button"]')!;
		control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
		control.click();
		await pending.complete(request.response);
		await timeout(0);
		assert.deepStrictEqual({
			count: requests.length,
			options: requests[0].options,
			fixAndRetest: requests[0].prompt?.includes('Fix issues you find, then rerun the affected UI flows'),
			blue: control.style.backgroundColor,
			playIcon: !!control.querySelector('.codicon-play[aria-hidden="true"]'),
			errors,
		}, {
			count: 1, options: { preserveInput: true, enableImplicitContext: false }, fixAndRetest: true,
			blue: 'var(--vscode-button-background)', playIcon: true, errors: [],
		});
		setSend(async () => { throw new Error('Cannot submit'); });
		control.click();
		await timeout(0);
		assert.deepStrictEqual({ errors: errors.map(String), canRetry: button.visible.get() }, { errors: ['Error: Cannot submit'], canRetry: true });
		setSend(async () => undefined);
		control.click();
		await timeout(0);
		assert.deepStrictEqual({ lastError: errors.at(-1), canRetry: button.visible.get() }, { lastError: 'The app test request could not be started.', canRetry: true });
	});

	test('does not offer a test for failed or cancelled responses', () => {
		const { request, changes, button } = setup();
		changes.set([diff('/app/index.html')], undefined);
		request.response!.setResult({ errorDetails: { message: 'Failed' } });
		request.response!.complete();
		assert.strictEqual(button.visible.get(), false);
		request.response!.cancel();
		assert.strictEqual(button.visible.get(), false);
	});
});
