/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ModelSelection, SessionModelInfo } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { IAgentHostRoomMember } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { CollaborationModelCatalog, CollaborationModelPicker, getCollaborationMemberModelState } from '../../browser/collaborationModelPicker.js';
import { stubCollaborationTestServices } from './collaborationTestServices.js';

suite('CollaborationModelPicker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const menus = new class extends mock<IActionWidgetService>() {
			readonly choices = new Map<string, () => void>();
			private close: (() => void) | undefined;
			override show<T>(_user: string, _preview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>): void {
				this.hide();
				for (const item of items) {
					const action = item.item;
					if (action !== undefined && !item.disabled) {
						this.choices.set(item.label ?? '', () => delegate.onSelect(action));
					}
				}
				this.close = () => delegate.onHide();
			}
			override hide(): void {
				this.close?.();
				this.close = undefined;
				this.choices.clear();
			}
		}();
		store.add(toDisposable(() => menus.hide()));
		const instantiation = workbenchInstantiationService(undefined, store);
		stubCollaborationTestServices(instantiation, store);
		instantiation.stub(IActionWidgetService, menus);
		const models = observableValue<readonly SessionModelInfo[]>('models', [
			{ id: 'model-a', name: 'Model A', provider: 'copilotcli' },
			{ id: 'model-b', name: 'Model B', provider: 'copilotcli' },
		]);
		const catalog = store.add(instantiation.createInstance(CollaborationModelCatalog, models, error => { throw error; }));
		const container = document.body.appendChild(document.createElement('div'));
		store.add(toDisposable(() => container.remove()));
		const create = (name: string, select: (model: ModelSelection) => void | Promise<void>) => store.add(instantiation.createInstance(CollaborationModelPicker, container, name, catalog, select));
		const choose = (picker: CollaborationModelPicker, label: string) => {
			picker.element.querySelector<HTMLElement>('.model-picker-name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
			const action = menus.choices.get(label);
			assert.ok(action, `Expected ${label} in ${[...menus.choices.keys()].join(', ')}`);
			action();
		};
		return { create, choose, models };
	}

	test('independent popup delegates persist the addressed model without changing another picker', async () => {
		const { create, choose } = setup();
		const saved: { peer: string; model: ModelSelection }[] = [];
		const first = create('Copilot 1', model => {
			saved.push({ peer: 'first', model });
		});
		const second = create('Copilot 2', model => { saved.push({ peer: 'second', model }); });
		first.state.set({ selection: { id: 'model-a' }, enabled: true }, undefined);
		second.state.set({ selection: { id: 'model-a' }, enabled: true }, undefined);
		await timeout(0);
		choose(first, 'Model B');
		await timeout(0);
		assert.deepStrictEqual({
			saved, first: first.state.get().selection,
			firstLabel: first.element.querySelector('.model-picker-name')?.textContent?.trim(),
			second: second.state.get().selection,
		}, {
			saved: [{ peer: 'first', model: { id: 'model-b' } }], first: { id: 'model-b' },
			firstLabel: 'Model B', second: { id: 'model-a' },
		});
	});

	test('an unacknowledged model stays pending and a rejected choice restores the authoritative label', async () => {
		const { create, choose } = setup();
		const pending = new DeferredPromise<void>();
		const picker = create('Copilot 1', () => pending.p);
		picker.state.set({ selection: { id: 'model-a' }, enabled: true }, undefined);
		await timeout(0);
		choose(picker, 'Model B');
		assert.strictEqual(picker.element.querySelector('.room-model-detail')?.textContent, 'Saving model...');
		await pending.error(new Error('Policy no longer allows Model B'));
		await timeout(0);
		assert.deepStrictEqual({
			label: picker.element.querySelector('.model-picker-name')?.textContent?.trim(),
			selection: picker.state.get().selection,
			error: picker.element.querySelector('.room-model-detail.error')?.textContent,
		}, { label: 'Model A', selection: { id: 'model-a' }, error: 'Policy no longer allows Model B' });
	});

	test('an unavailable saved model is shown explicitly without falling back to a different model', async () => {
		const { create, models } = setup();
		const selections: ModelSelection[] = [];
		const picker = create('Copilot 1', model => { selections.push(model); });
		picker.state.set({ selection: { id: 'model-b' }, enabled: true }, undefined);
		models.set([{ id: 'model-a', name: 'Model A', provider: 'copilotcli' }], undefined);
		await timeout(0);
		assert.deepStrictEqual({
			selection: picker.state.get().selection,
			label: picker.element.querySelector('.model-picker-name')?.textContent?.trim(),
			detail: picker.element.querySelector('.room-model-detail')?.textContent,
			selections,
		}, { selection: { id: 'model-b' }, label: 'model-b (Unavailable)', detail: 'model-b is unavailable. Choose another model.', selections: [] });
	});

	test('an unspecified provider default is not labelled as a confirmed Auto selection', async () => {
		const { create } = setup();
		const picker = create('Copilot 1', () => { });
		await timeout(0);
		assert.deepStrictEqual({
			selection: picker.state.get().selection,
			label: picker.element.querySelector('.model-picker-name')?.textContent?.trim(),
		}, { selection: undefined, label: 'Provider Default' });
	});

	test('pending selections preserve configuration and distinguish the acknowledged model from the desired model', () => {
		const member: IAgentHostRoomMember = {
			id: 'peer', name: 'Copilot 1', sessionUri: 'copilotcli:/peer', state: 'working', turns: 1,
			model: 'model-b', modelSelection: { id: 'model-a' }, pendingModel: { id: 'model-b', config: { effort: 'high' } },
		};
		const models: SessionModelInfo[] = [{ id: 'model-a', name: 'Model A', provider: 'copilotcli' }];
		assert.deepStrictEqual(getCollaborationMemberModelState(member, models, true), {
			selection: { id: 'model-b', config: { effort: 'high' } }, enabled: true,
			detail: 'Applies on the next turn. Currently using Model A.', error: undefined,
		});
	});

	test('a peer that has already run reports its change as pending, not its model as unconfirmed', () => {
		const member: IAgentHostRoomMember = {
			id: 'peer', name: 'Copilot 1', sessionUri: 'copilotcli:/peer', state: 'working', turns: 3,
			model: 'grok', pendingModel: { id: 'grok' },
		};
		assert.deepStrictEqual(
			getCollaborationMemberModelState(member, [], true),
			{ selection: { id: 'grok' }, enabled: true, detail: 'Applies on this peer\'s next turn.', error: undefined });
	});

	test('pending Auto and unconfirmed legacy selections are never shown as provider-acknowledged models', () => {
		const member: IAgentHostRoomMember = {
			id: 'peer', name: 'Copilot 1', sessionUri: 'copilotcli:/peer', state: 'pending', turns: 0, model: 'legacy',
		};
		assert.deepStrictEqual([
			getCollaborationMemberModelState({ ...member, pendingModel: null, modelError: 'Auto is unavailable' }, [], true),
			getCollaborationMemberModelState(member, [], true),
		], [
			{ selection: { id: 'auto' }, enabled: true, detail: 'Applies when this peer starts.', error: 'Auto is unavailable' },
			{ selection: { id: 'legacy' }, enabled: true, detail: 'Applies when this peer starts.', error: undefined },
		]);
	});
});
