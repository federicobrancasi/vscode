/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { ButtonWithDropdown } from '../../../../base/browser/ui/button/button.js';
import { toAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived, IObservable, observableFromEvent, observableFromPromise, observableValue } from '../../../../base/common/observable.js';
import { basename, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { isObject } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { parse as parseYaml, YamlParseError } from '../../../../base/common/yaml.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IChatWidget } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatResponseFileChangesService } from '../../../../workbench/contrib/chat/browser/chatResponseFileChangesService.js';
import { ResponseModelState } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IEditSessionEntryDiff } from '../../../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';

function getAppChangePaths(changes: readonly IEditSessionEntryDiff[], workingDirectory?: URI): string[] {
	return changes.filter(change => !change.identical && !change.isDeleted)
		.map(change => '/' + (workingDirectory && relativePath(workingDirectory, change.modifiedURI) || basename(change.modifiedURI)))
		.filter(path => !/\/(?:tests?|__tests__|__fixtures__|fixtures|docs|documentation)\/|\.(?:test|spec|stories)\.[^/]+$/i.test(path));
}

export function hasAppFileChanges(changes: readonly IEditSessionEntryDiff[], workingDirectory?: URI): boolean {
	return getAppChangePaths(changes, workingDirectory).some(path =>
		/\.(?:html?|xhtml|jsx|tsx|vue|svelte|astro|css|scss|sass|less|swift|a?xaml|qml|ui|storyboard|xib|fxml)$/i.test(path)
		|| /(?:\/App|view|screen|window|page|component|widget|viewcontroller)\.(?:[cm]?[jt]s|kt|java|cs|dart|mm?)$/i.test(path));
}

export class SessionTestAppButton extends Disposable {
	readonly element = $('.session-test-app');
	readonly visible: IObservable<boolean>;
	private readonly button: ButtonWithDropdown;

	constructor(
		widget: IChatWidget,
		interactive: IObservable<boolean>,
		@IChatResponseFileChangesService fileChangesService: IChatResponseFileChangesService,
		@IChatEntitlementService entitlementService: IChatEntitlementService,
		@INotificationService notificationService: INotificationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const model = observableFromEvent(this, widget.onDidChangeViewModel, () => widget.viewModel?.model);
		const response = model.map(model => model
			? observableFromEvent(this, model.onDidChange, () => model.getRequests().at(-1)?.response)
			: constObservable(undefined)).map((response, reader) => response.read(reader));
		const changes = response.map(response => response && (fileChangesService.getChangesForRequest(response.session.sessionResource, response.requestId)
			?? response.session.editingSession?.getDiffsForFilesInRequest(response.requestId)));
		const submitting = observableValue(this, false);
		const canTest = derived(this, reader => {
			const current = response.read(reader);
			return !!current && !current.isIncomplete.read(reader) && current.state === ResponseModelState.Complete
				&& !current.result?.errorDetails && !current.shouldBeRemovedOnSend && !current.shouldBeBlocked.read(reader)
				&& !current.isHiddenFromTranscript && interactive.read(reader) && !model.read(reader)?.isReadOnly.read(reader)
				&& !model.read(reader)?.requestInProgress.read(reader) && !submitting.read(reader)
				&& widget.input.currentModeObs.read(reader).kind === ChatModeKind.Agent && !entitlementService.sentimentObs.read(reader).hidden;
		});
		this.visible = derived(this, reader => {
			if (!canTest.read(reader)) {
				return constObservable(false);
			}
			const edits = changes.read(reader)?.read(reader) ?? [];
			const workingDirectory = response.read(reader)?.session.workingDirectory;
			return hasAppFileChanges(edits, workingDirectory) ? constObservable(true)
				: observableFromPromise(this.hasAppProjectChanges(edits, workingDirectory)).map(result => result.value ?? false);
		}).map((visible, reader) => visible.read(reader));
		const submit = async (useSubagent: boolean) => {
			if (this._store.isDisposed || !this.visible.get()) {
				return;
			}
			widget.focusInput();
			submitting.set(true, undefined);
			try {
				const prompt = [localize('testAppPrompt', "Test the UI of the app built or changed in this chat.\n\nFirst review the original requirements and the relevant implementation diffs, including added and deleted files. Identify the affected behavior and regression risks. Use the implementation changes in this chat as the scope, not unrelated workspace edits, and do not assume an unstaged git diff contains every change.\n\nIdentify the actual app target from the project's instructions and configuration. Launch it and interact with its actual UI. Use browser/Playwright tools for web targets, or available computer-use, native, simulator/emulator, and project-specific UI tools for native or desktop targets. A browser preview does not verify a native target.\n\nVerify the requested features, the affected user flows, and relevant edge cases. Check for visible failures and console/runtime errors where available. Reading the code or running unit tests alone does not count as UI verification.\n\nFix issues you find, then rerun the affected UI flows to confirm the fixes. Keep changes focused on issues uncovered by testing.")];
				if (useSubagent) {
					prompt.push(localize('testAppSubagentPrompt', "Delegate UI verification to a testing-capable subagent with fresh context where supported. Give it the original requirements, relevant implementation changes, and project instructions; ask it to verify behavior independently rather than rely on the implementation agent's conclusions. Use its reproduced findings to make focused fixes, then delegate verification of the affected flows again.\n\nIf using a suitable subagent is not possible, clearly tell the user \"SORRY NO SUBAGENTS I WILL DO IT\", then perform the same verification yourself."));
				}
				const result = await widget.acceptInput(prompt.join('\n\n'), { preserveInput: true, enableImplicitContext: false });
				if (!result) {
					notificationService.error(localize('testAppNotStarted', "The app test request could not be started."));
				}
			} catch (error) {
				notificationService.error(error);
			} finally {
				submitting.set(false, undefined);
			}
		};
		this.button = this._register(new ButtonWithDropdown(this.element, {
			...defaultButtonStyles, small: true, supportIcons: true,
			ariaLabel: localize('testApp', "Test App"),
			title: localize('testAppTooltip', "Review the changes, test the app UI, fix issues found, and retest"),
			contextMenuProvider: contextMenuService, addPrimaryActionToDropdown: false,
			actions: {
				getActions: () => [toAction({
					id: 'sessions.testAppWithSubagent', label: localize('testAppWithSubagent', "Test with Subagent"),
					enabled: this.visible.get(), run: () => submit(true),
				})]
			},
		}));
		this.button.label = localize('testAppWithIcon', "{0} Test App", '$(play)');
		// eslint-disable-next-line no-restricted-syntax -- The shared button owns the rendered label icon.
		this.button.primaryButton.element.querySelector('.codicon')?.setAttribute('aria-hidden', 'true');
		this.button.dropdownButton.setAriaLabel(localize('testAppActions', "App Testing Options"));
		this._register(this.button.onDidClick(() => submit(false)));
		this._register(autorun(reader => {
			const visible = this.visible.read(reader);
			if (!visible && this.button.hasFocus()) {
				widget.focusInput();
			}
			this.element.hidden = !visible;
		}));
	}

	private async hasAppProjectChanges(changes: readonly IEditSessionEntryDiff[], workingDirectory?: URI): Promise<boolean> {
		if (!workingDirectory) {
			return false;
		}
		const paths = getAppChangePaths(changes.filter(change => isEqualOrParent(change.modifiedURI, workingDirectory)), workingDirectory);
		for (const { file, source } of [{ file: 'package.json', source: /\.[cm]?[jt]s$/i }, { file: 'pubspec.yaml', source: /\.dart$/i }]) {
			if (!paths.some(path => source.test(path))) {
				continue;
			}
			try {
				const content = (await this.fileService.readFile(joinPath(workingDirectory, file))).value.toString();
				if (file === 'package.json') {
					const manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } = JSON.parse(content);
					if (!isObject(manifest)) {
						throw new Error('Expected a package.json object');
					}
					if ([manifest.dependencies, manifest.devDependencies].some(dependencies => isObject(dependencies)
						&& ['react', 'react-native', 'expo', 'next', 'vue', 'nuxt', 'svelte', 'astro', '@angular/core', 'electron'].some(name => typeof dependencies[name] === 'string'))) {
						return true;
					}
				} else {
					const errors: YamlParseError[] = [];
					let node = parseYaml(content, errors);
					if (errors.length) {
						throw new Error(errors.map(error => error.message).join(', '));
					}
					for (const key of ['dependencies', 'flutter', 'sdk']) {
						node = node?.type === 'map' ? node.properties.find(property => property.key.value === key)?.value : undefined;
					}
					if (node?.type === 'scalar' && node.value === 'flutter') {
						return true;
					}
				}
			} catch (error) {
				if (!(error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND)) {
					this.logService.warn('Test App: unable to read UI project configuration', error);
				}
			}
		}
		return false;
	}

	focus(): boolean {
		if (!this.visible.get()) {
			return false;
		}
		this.button.focus();
		return true;
	}
}
