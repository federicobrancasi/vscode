/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, constObservable } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { AbstractCustomView } from '../../../customView/browser/customView.js';
import { CustomViewService } from '../../../customView/browser/customViewService.js';
import { COLLABORATION_CUSTOM_VIEW_ID, CollaborationRoomViewService } from '../../browser/collaborationRoomView.js';

class TestRoomCustomView extends AbstractCustomView {
	readonly title = constObservable('Collaboration room');
	render(): void { }
	layout(): void { }
}

suite('CollaborationRoomView', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const customViews = disposables.add(new CustomViewService(new NullLogService(), disposables.add(new InMemoryStorageService())));
		const service = disposables.add(new CollaborationRoomViewService(customViews));
		return { customViews, service };
	}

	test('does not open before the desktop custom view is registered', () => {
		const { service } = setup();
		service.open();
		assert.strictEqual(service.visible.get(), false);
		assert.strictEqual(service.activeView.get(), undefined);
	});

	test('visibility and view lifetime follow the current custom view grid', () => {
		const { customViews, service } = setup();
		disposables.add(customViews.registerCustomView({ id: COLLABORATION_CUSTOM_VIEW_ID, ctor: new SyncDescriptor(TestRoomCustomView) }));
		let creations = 0;
		let focuses = 0;
		let disposals = 0;
		disposables.add(autorun(reader => {
			if (customViews.activeCustomView.read(reader)?.id !== COLLABORATION_CUSTOM_VIEW_ID) {
				return;
			}
			creations++;
			reader.store.add(service.registerView({
				layoutPanel: () => { },
				focus: () => { focuses++; },
				captureFocus: () => () => { focuses++; },
				getAccessibleContent: () => 'Current room',
				dispose: () => { },
			}));
			reader.store.add(toDisposable(() => { disposals++; }));
		}));
		assert.strictEqual(creations, 0);
		service.open();
		const firstView = service.activeView.get();
		assert.ok(firstView);
		assert.strictEqual(service.visible.get(), true);
		service.close();
		assert.strictEqual(service.activeView.get(), undefined);
		assert.strictEqual(disposals, 1);
		service.open();
		assert.strictEqual(creations, 2);
		assert.strictEqual(focuses, 2);
		assert.notStrictEqual(service.activeView.get(), firstView);
		customViews.hideCustomView();
		assert.strictEqual(disposals, 2);
		assert.strictEqual(service.visible.get(), false);
		assert.strictEqual(service.activeView.get(), undefined);
	});

	test('closing a room does not dismiss a different primary surface', () => {
		const { customViews, service } = setup();
		disposables.add(customViews.registerCustomView({ id: 'another-view', ctor: new SyncDescriptor(TestRoomCustomView) }));
		customViews.showCustomView('another-view');
		service.close();
		assert.strictEqual(customViews.activeCustomView.get()?.id, 'another-view');
	});

	test('scroll state survives view disposal without retaining the old widget', () => {
		const { service } = setup();
		const state = { roomId: 'room', scrollTop: 240, followingLatest: false };
		service.saveScrollState(state);
		const registration = service.registerView({
			layoutPanel() { },
			focus() { },
			captureFocus: () => () => { },
			getAccessibleContent: () => '',
			dispose() { },
		});
		registration.dispose();
		assert.strictEqual(service.activeView.get(), undefined);
		assert.deepStrictEqual(service.scrollState.get(), state);
	});

	test('unfinished creation fields survive primary-surface navigation', () => {
		const { service } = setup();
		const draft = {
			title: 'Investigate startup', goal: 'Measure before editing', instructions: 'Preserve APIs',
			repositoryUri: 'file:///repo', baseRevision: 'origin/main', workerCount: '3', model: 'host-model',
			memberModels: [{ id: 'model-a' }, undefined, { id: 'model-b' }],
		};
		service.saveCreationDraft(draft);
		service.close();
		assert.deepStrictEqual(service.creationDraft.get(), draft);
		service.saveCreationDraft(undefined);
		assert.strictEqual(service.creationDraft.get(), undefined);
	});

	test('publishing settings content hands it to the side panel and takes it back on dispose', () => {
		const { service } = setup();
		const content = document.createElement('div');
		const published = service.publishPanelContent(content);
		assert.strictEqual(service.panelContent.get(), content);
		published.dispose();
		assert.strictEqual(service.panelContent.get(), undefined);
	});
});
