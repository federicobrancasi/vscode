/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AccessibleViewProviderId, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AccessibilityVerbositySettingId } from '../../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { ICollaborationRoomView, ICollaborationRoomViewService } from '../../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationAccessibilityHelp, CollaborationAccessibleView } from '../../browser/collaborationAccessibility.js';

suite('Collaboration accessibility', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let view: TestRoomView;
	let activeView: ISettableObservable<ICollaborationRoomView | undefined>;

	class TestRoomView extends Disposable implements ICollaborationRoomView {
		readonly element = $('div');
		layoutPanel(): void { }
		readonly input = $('textarea');
		content = 'Room: Startup performance\nCopilot-1: Measuring activation\nYou: Keep the public API unchanged';
		focusCount = 0;

		constructor() {
			super();
			this.element.appendChild(this.input);
			document.body.appendChild(this.element);
			this._register(toDisposable(() => this.element.remove()));
		}

		layout(): void { }

		focus(): void {
			this.focusCount++;
			this.input.focus();
		}

		getAccessibleContent(): string {
			return this.content;
		}

		captureFocus(): () => void {
			const element = getActiveElement();
			return () => {
				if (isHTMLElement(element) && element.isConnected) {
					element.focus();
				} else {
					this.focus();
				}
			};
		}
	}

	setup(() => {
		instantiation = store.add(new TestInstantiationService());
		view = store.add(new TestRoomView());
		activeView = observableValue<ICollaborationRoomView | undefined>('activeRoomView', view);
		instantiation.stub(ICollaborationRoomViewService, new class extends mock<ICollaborationRoomViewService>() {
			override readonly activeView = activeView;
		});
	});

	test('accessible view reads the real room content and restores the focused control', () => {
		view.input.focus();
		const provider = instantiation.invokeFunction(accessor => new CollaborationAccessibleView().getProvider(accessor));
		assert.ok(provider);
		store.add(provider);
		view.input.blur();
		provider.onClose();

		assert.deepStrictEqual({
			id: provider.id,
			type: provider.options.type,
			language: provider.options.language,
			verbosity: provider.verbositySettingKey,
			content: provider.provideContent(),
			focused: getActiveElement() === view.input,
		}, {
			id: AccessibleViewProviderId.CollaborationRoom,
			type: AccessibleViewType.View,
			language: 'plaintext',
			verbosity: AccessibilityVerbositySettingId.CollaborationRoom,
			content: view.content,
			focused: true,
		});
	});

	test('help documents peer messaging, run controls and workspace boundaries', () => {
		const provider = instantiation.invokeFunction(accessor => new CollaborationAccessibilityHelp().getProvider(accessor));
		assert.ok(provider);
		store.add(provider);
		const content = provider.provideContent();
		assert.deepStrictEqual({
			type: provider.options.type,
			verbosity: provider.verbositySettingKey,
			inbox: content.includes('Filtering and loading history never mark mail as handled'),
			noRenderInference: content.includes('never starts paid work'),
			explicitAudience: content.includes('Typing or completing an @name only inserts text'),
			defaultAudience: content.includes('composer sends to all peers') && content.includes('no audience selector'),
			hiddenMessages: content.includes('Hide for Me') && content.includes('does not delete room history') && content.includes('Show Hidden Messages'),
			budget: content.includes('required finite turn budget') && content.includes('Extend requires an explicit number'),
			summary: content.includes('choose an existing peer'),
			keyboard: content.includes('Shift+Enter'),
			pause: content.includes('Pause holds new admissions'),
			changes: content.includes('Publishing or reviewing a patch does not apply or merge'),
			primarySurface: content.includes('primary view separate from the session grid'),
			navigationKeybinding: content.includes('<keybinding:workbench.action.collaboration.close>'),
			reservedNotDelivered: content.includes('Reserved means turn budget and an immutable input batch') && content.includes('it is not delivered input'),
			submittedNotAccepted: content.includes('not provider acceptance or task completion'),
			countsNotDelivered: content.includes('message counts are not delivered-turn counts'),
			sidebarHome: content.includes('Agent Collab in the Sessions sidebar'),
			memberBusyInput: content.includes('native Queue and Steer are unavailable'),
			roomApprovals: content.includes('Room messages cannot bypass approvals'),
			trust: content.includes('exact local peer worktrees'),
			autopilot: content.includes('Autopilot is separate from Allow all'),
			configuration: content.includes('All peers Mode and Permissions controls'),
			archives: content.includes('Archived native chats are read-only too'),
			archiveAuthors: content.includes('Author names with a saved session link open that archived session'),
			historicalParticipants: content.includes('without adding them to the worker roster'),
		}, {
			type: AccessibleViewType.Help,
			verbosity: AccessibilityVerbositySettingId.CollaborationRoom,
			inbox: true,
			noRenderInference: true,
			explicitAudience: true,
			defaultAudience: true,
			hiddenMessages: true,
			budget: true,
			summary: true,
			keyboard: true,
			pause: true,
			changes: true,
			primarySurface: true,
			navigationKeybinding: true,
			reservedNotDelivered: true,
			submittedNotAccepted: true,
			countsNotDelivered: true,
			sidebarHome: true,
			memberBusyInput: true,
			roomApprovals: true,
			trust: true,
			autopilot: true,
			configuration: true,
			archives: true,
			archiveAuthors: true,
			historicalParticipants: true,
		});
	});

	test('closing falls back to the current room when the old control was removed', () => {
		view.input.focus();
		const provider = instantiation.invokeFunction(accessor => new CollaborationAccessibleView().getProvider(accessor));
		assert.ok(provider);
		store.add(provider);
		view.element.remove();
		provider.onClose();
		assert.strictEqual(view.focusCount, 1);
	});

	test('providers are unavailable without a room surface', () => {
		activeView.set(undefined, undefined);
		assert.deepStrictEqual(instantiation.invokeFunction(accessor => [
			new CollaborationAccessibilityHelp().getProvider(accessor),
			new CollaborationAccessibleView().getProvider(accessor),
		]), [undefined, undefined]);
	});
});
