/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { defaultAgentHostRoomConfiguration, IAgentHostRoomConfiguration } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { platformSessionSchema } from '../../../../../platform/agentHost/common/agentHostSchema.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { resetShownWarnings } from '../../../../../workbench/contrib/chat/common/chatPermissionWarnings.js';
import { ChatConfiguration } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { ICollaborationService } from '../../../../services/collaboration/common/collaboration.js';
import { CollaborationConfigurationPicker } from '../../browser/collaborationConfigurationPicker.js';
import { createCollaborationFixtureRoom } from './collaborationRoomFixtureData.js';

suite('CollaborationConfigurationPicker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	setup(() => resetShownWarnings());
	teardown(() => resetShownWarnings());

	function setupPicker(approveWarning = true) {
		const instantiation = store.add(new TestInstantiationService());
		const activeRoom = observableValue('room', createCollaborationFixtureRoom());
		let values = { ...defaultAgentHostRoomConfiguration };
		const writes: Partial<IAgentHostRoomConfiguration>[] = [];
		const errors: Error[] = [];
		let writeError: Error | undefined;
		const service = new class extends mock<ICollaborationService>() {
			override readonly activeRoom = activeRoom;
			override readonly activeRoomId = observableValue(this, activeRoom.get().id);
			override readonly availability = observableValue(this, 'available' as const);
			override readonly canConfigure = observableValue(this, true);
			override async getConfiguration() { return { schema: platformSessionSchema.toProtocol(), values }; }
			override async setConfiguration(patch: Partial<IAgentHostRoomConfiguration>) {
				if (writeError) {
					throw writeError;
				}
				writes.push(patch);
				values = { ...values, ...patch };
				activeRoom.set({ ...activeRoom.get(), members: activeRoom.get().members.map(member => ({ ...member, configuration: values })) }, undefined);
			}
		};
		let labels: string[] = [];
		let select: (label: string) => void = () => { throw new Error('Menu not opened'); };
		let hide = () => { };
		const widgetService = new class extends mock<IActionWidgetService>() {
			override show<T>(_id: string, _preview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>) {
				labels = items.map(item => item.label ?? 'separator');
				select = label => {
					const item = items.find(item => item.label === label);
					assert.ok(item?.item && !item.disabled);
					delegate.onSelect(item.item, false);
				};
				hide = () => delegate.onHide?.();
			}
			override hide() { hide(); }
		};
		instantiation.stub(ICollaborationService, service);
		instantiation.stub(IActionWidgetService, widgetService);
		instantiation.stub(IConfigurationService, new TestConfigurationService({ [ChatConfiguration.AssistedPermissionsEnabled]: true }));
		instantiation.stub(IDialogService, new TestDialogService(undefined, { result: approveWarning }));
		instantiation.stub(IStorageService, store.add(new InMemoryStorageService()));
		instantiation.stub(IPreferencesService, new class extends mock<IPreferencesService>() { });
		instantiation.stub(IAgentHostEnablementService, new class extends mock<IAgentHostEnablementService>() {
			override readonly managedSandboxEnforced = observableValue(this, false);
			override readonly managedSandboxAllowsBypass = observableValue(this, true);
		});
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const picker = store.add(instantiation.createInstance(CollaborationConfigurationPicker, container, error => errors.push(error instanceof Error ? error : new Error(String(error)))));
		const open = async () => {
			picker.element.querySelector<HTMLElement>('[aria-label^="Pick Mode,"]')!.click();
			await timeout(0);
		};
		return { picker, service, writes, errors, open, select: (label: string) => select(label), getLabels: () => labels, failWrites: (error: Error) => { writeError = error; } };
	}

	test('reuses the combined mode, permissions, and sandbox menu for all peers', async () => {
		const { picker, open, getLabels, select, writes } = setupPicker();
		await open();
		assert.deepStrictEqual(getLabels(), [
			'Agent mode', 'Interactive', 'Plan', 'Autopilot', 'separator', 'Permissions',
			'Manual permissions', 'Assisted permissions', 'Allow all', 'separator', 'Sandboxing for terminal', 'separator', 'Learn More About Permissions',
		]);
		select('Plan');
		await timeout(0);
		assert.deepStrictEqual({ writes, label: picker.element.querySelector('[aria-label^="Pick Mode,"]')?.getAttribute('aria-label') }, {
			writes: [{ mode: 'plan' }], label: 'Pick Mode, Plan',
		});
	});

	test('Allow all remains selected after acknowledged room updates', async () => {
		const { picker, open, select, writes, errors } = setupPicker();
		await open();
		select('Allow all');
		await timeout(0);
		await open();
		assert.deepStrictEqual({
			writes, errors, label: picker.element.querySelector('[aria-label^="Pick Permissions,"]')?.getAttribute('aria-label'),
		}, { writes: [{ autoApprove: 'autoApprove' }], errors: [], label: 'Pick Permissions, Allow all' });
	});

	test('declining the existing elevated-permissions warning does not alter any peer', async () => {
		const { open, select, writes } = setupPicker(false);
		await open();
		select('Allow all');
		await timeout(0);
		assert.deepStrictEqual(writes, []);
	});

	test('a rejected update surfaces its error and keeps the prior setting', async () => {
		const { picker, open, select, failWrites, writes, errors } = setupPicker();
		failWrites(new Error('Policy rejected the change'));
		await open();
		select('Allow all');
		await timeout(0);
		assert.deepStrictEqual({
			writes, errors: errors.map(error => error.message),
			label: picker.element.querySelector('[aria-label^="Pick Permissions,"]')?.getAttribute('aria-label'),
		}, { writes: [], errors: ['Policy rejected the change'], label: 'Pick Permissions, Manual permissions' });
	});
});
