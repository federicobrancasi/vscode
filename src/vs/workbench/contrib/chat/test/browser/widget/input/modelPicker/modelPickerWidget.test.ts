/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as dom from '../../../../../../../../base/browser/dom.js';
import { IManagedHoverContentOrFactory } from '../../../../../../../../base/browser/ui/hover/hover.js';
import { Switch } from '../../../../../../../../base/browser/ui/toggle/switch.js';
import { mainWindow } from '../../../../../../../../base/browser/window.js';
import { toAction } from '../../../../../../../../base/common/actions.js';
import { DeferredPromise, timeout } from '../../../../../../../../base/common/async.js';
import { IStringDictionary } from '../../../../../../../../base/common/collections.js';
import { Emitter, Event as CommonEvent } from '../../../../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../../base/common/lifecycle.js';
import { constObservable, observableValue, transaction } from '../../../../../../../../base/common/observable.js';
import { extUri } from '../../../../../../../../base/common/resources.js';
import { upcastPartial } from '../../../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../../base/test/common/utils.js';
import { IAccessibilityService } from '../../../../../../../../platform/accessibility/common/accessibility.js';
import { TestAccessibilityService } from '../../../../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../../../../platform/actionWidget/browser/actionWidget.js';
import { ICommandService } from '../../../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../../../../platform/contextkey/common/contextkey.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../../../../platform/contextview/browser/contextView.js';
import { ContextViewService } from '../../../../../../../../platform/contextview/browser/contextViewService.js';
import { IDefaultAccountService } from '../../../../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IHoverService } from '../../../../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../../../../../../platform/keybinding/common/keybinding.js';
import { MockKeybindingService } from '../../../../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILayoutService } from '../../../../../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../../../../../platform/opener/common/opener.js';
import { NullOpenerService } from '../../../../../../../../platform/opener/test/common/nullOpenerService.js';
import { IProductService } from '../../../../../../../../platform/product/common/productService.js';
import { InMemoryStorageService, IStorageService } from '../../../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../../../platform/telemetry/common/telemetry.js';
import { IUpdateService, StateType } from '../../../../../../../../platform/update/common/update.js';
import { IUriIdentityService } from '../../../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../../../../../platform/workspace/common/workspaceTrust.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../../../../services/chat/common/chatEntitlementService.js';
import { TestChatEntitlementService, TestWorkspaceTrustManagementService } from '../../../../../../../test/common/workbenchTestServices.js';
import { IModelPickerAdditionalContentContext, IModelPickerDelegate, IModelPickerSelectionPresentation, ModelPickerActionItem } from '../../../../../browser/widget/input/modelPicker/modelPickerActionItem.js';
import { IModelConfigurationAccess, MODEL_CONFIG_GROUP_EFFORT } from '../../../../../browser/widget/input/modelPicker/modelPickerModelConfig.js';
import { ModelPickerWidget, TABBED_MODEL_PICKER_SETTING_ID } from '../../../../../browser/widget/input/modelPicker/modelPickerWidget.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelProviderDescriptor, ILanguageModelsService } from '../../../../../common/languageModels.js';
import { NullLanguageModelsService } from '../../../../common/languageModels.js';

function createModel(id: string, name: string, vendor = 'copilot'): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: `${vendor}/${id}`,
		metadata: upcastPartial<ILanguageModelChatMetadata>({
			id, name, vendor, family: id, version: '1.0',
			maxInputTokens: 128000, maxOutputTokens: 4096, isDefaultForLocation: {},
			configurationSchema: {
				properties: {
					reasoningEffort: { type: 'string', title: 'Thinking Effort', group: 'navigation', enum: ['medium', 'high'], enumItemLabels: ['Medium', 'High'], default: 'medium' },
				},
			},
		}),
	};
}

const MODEL = createModel('example', 'Example Model');
const LOCAL_MODEL = createModel('local', 'Local Model', 'local');
const AUTO_MODEL = createModel('auto', 'Auto');
const ALTERNATE_SELECTION: IModelPickerSelectionPresentation = {
	label: 'Saved +2',
	ariaLabel: 'Saved choice with three participants',
	tooltip: 'Saved choice: Example Model and two other participants',
};

async function waitForLayout(element: HTMLElement): Promise<void> {
	const targetWindow = dom.getWindow(element);
	await new Promise<void>(resolve => targetWindow.requestAnimationFrame(() => targetWindow.requestAnimationFrame(() => resolve())));
	await timeout(0);
}

suite('ModelPickerWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createPicker(tabbed: boolean, options: {
		additionalActions?: boolean;
		selectionPresentation?: IModelPickerSelectionPresentation;
		selectedModel?: ILanguageModelChatMetadataAndIdentifier;
		restrictedMode?: boolean;
		setupRequired?: boolean;
		compact?: boolean;
		workspaceTrustInitialized?: Promise<void>;
		additionalContent?: IModelPickerDelegate['getAdditionalContent'];
		realPopup?: boolean;
	} = {}) {
		const instantiationService = store.add(new TestInstantiationService());
		const container = dom.append(mainWindow.document.body, dom.$('.monaco-workbench.monaco-reduce-motion'));
		container.style.position = 'fixed';
		container.style.bottom = '0';
		container.style.width = '640px';
		container.style.height = options.realPopup ? '600px' : '';
		const layoutContainer = options.realPopup ? container : mainWindow.document.body;
		const onDidLayoutContainer = store.add(new Emitter<{ readonly container: HTMLElement; readonly dimension: dom.IDimension }>());
		instantiationService.stub(ILayoutService, {
			getContainer: () => layoutContainer,
			mainContainer: layoutContainer,
			activeContainer: layoutContainer,
			onDidChangeActiveContainer: CommonEvent.None,
			onDidAddContainer: CommonEvent.None,
			onDidLayoutMainContainer: CommonEvent.None,
			onDidLayoutActiveContainer: CommonEvent.None,
			onDidLayoutContainer: onDidLayoutContainer.event,
		});
		const activeRender = store.add(new MutableDisposable());
		let activeDelegate: IContextViewDelegate | undefined;
		const hide = (): void => {
			if (options.realPopup) {
				contextViewService.hideContextView();
				return;
			}
			const delegate = activeDelegate;
			activeDelegate = undefined;
			delegate?.onHide?.();
			activeRender.clear();
			dom.clearNode(popup);
		};
		store.add(toDisposable(hide));
		const contextViewService: IContextViewService = options.realPopup ? store.add(instantiationService.createInstance(ContextViewService)) : upcastPartial<IContextViewService>({
			showContextView: delegate => {
				hide();
				activeDelegate = delegate;
				activeRender.value = delegate.render(popup);
				delegate.focus?.();
				return { close: hide };
			},
			hideContextView: hide,
			getContextViewElement: (): HTMLElement => popup,
			layout: () => { },
		});
		instantiationService.stub(IContextViewService, contextViewService);
		const popup: HTMLElement = options.realPopup ? contextViewService.getContextViewElement() : dom.append(mainWindow.document.body, dom.$('.monaco-reduce-motion'));
		store.add(toDisposable(() => { container.remove(); popup.remove(); }));
		const isVisible = () => options.realPopup ? popup.style.display !== 'none' : !!activeDelegate;
		const configurationService = new TestConfigurationService({ [TABBED_MODEL_PICKER_SETTING_ID]: tabbed });
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(IContextKeyService, store.add(new ContextKeyService(configurationService)));
		instantiationService.stub(IKeybindingService, new MockKeybindingService());
		instantiationService.stub(IAccessibilityService, new class extends TestAccessibilityService {
			override isMotionReduced(): boolean { return true; }
		}());
		const hovers = new Map<HTMLElement, { content: IManagedHoverContentOrFactory }>();
		instantiationService.stub(IHoverService, {
			...NullHoverService,
			setupManagedHover: (_delegate, target, content) => {
				const entry = { content };
				hovers.set(target, entry);
				return {
					show: () => { },
					hide: () => { },
					update: content => { entry.content = content; },
					dispose: () => {
						if (hovers.get(target) === entry) {
							hovers.delete(target);
						}
					},
				};
			},
		});
		instantiationService.set(IOpenerService, NullOpenerService);
		instantiationService.stub(ICommandService, { executeCommand: async () => undefined });
		const telemetryEvents: string[] = [];
		instantiationService.stub(ITelemetryService, { publicLog2: name => { telemetryEvents.push(name); } });
		instantiationService.stub(IProductService, { version: '1.100.0' });
		instantiationService.stub(IUpdateService, { state: { type: StateType.Uninitialized } });
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IDefaultAccountService, { resolveGitHubUrl: () => 'https://github.com/settings/copilot' });
		instantiationService.stub(IWorkspaceTrustRequestService, {});
		const trustService = store.add(new class extends TestWorkspaceTrustManagementService {
			override get workspaceTrustInitialized(): Promise<void> {
				return options.workspaceTrustInitialized ?? super.workspaceTrustInitialized;
			}
		}(!options.restrictedMode));
		instantiationService.stub(IWorkspaceTrustManagementService, trustService);
		const entitlement = new TestChatEntitlementService();
		entitlement.entitlement = options.setupRequired ? ChatEntitlement.Available : ChatEntitlement.Pro;
		instantiationService.stub(IChatEntitlementService, entitlement);
		instantiationService.stub(IStorageService, store.add(new InMemoryStorageService()));
		const models = options.setupRequired ? [] : [AUTO_MODEL, MODEL, LOCAL_MODEL];
		const modelHistoryCalls: string[] = [];
		instantiationService.stub(ILanguageModelsService, new class extends NullLanguageModelsService {
			override getLanguageModelIds() { return models.map(model => model.identifier); }
			override getRecentlyUsedModelIds() { return [MODEL.identifier]; }
			override addToRecentlyUsedList() { modelHistoryCalls.push('recent'); }
			override pinModel(id: string) { modelHistoryCalls.push(`pin:${id}`); }
			override unpinModel(id: string) { modelHistoryCalls.push(`unpin:${id}`); }
			override getVendors(): ILanguageModelProviderDescriptor[] {
				return [
					upcastPartial<ILanguageModelProviderDescriptor>({ vendor: 'copilot', displayName: 'GitHub Copilot', isDefault: true }),
					upcastPartial<ILanguageModelProviderDescriptor>({ vendor: 'local', displayName: 'Local', isDefault: false }),
				];
			}
		}());
		const configurations = new Map<string, IStringDictionary<unknown>>();
		const configurationAccess: IModelConfigurationAccess = {
			getModelConfiguration: id => configurations.get(id),
			setModelConfiguration: async (id, values) => { configurations.set(id, { ...configurations.get(id), ...values }); },
			getModelConfigurationActions: () => [],
		};
		const actionWidgetService = store.add(instantiationService.createInstance(ActionWidgetService));
		instantiationService.stub(IActionWidgetService, actionWidgetService);
		const currentModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>('currentModel', options.selectedModel ?? MODEL);
		const selectionPresentation = observableValue<IModelPickerSelectionPresentation | undefined>('selectionPresentation', options.selectionPresentation);
		const selections: string[] = [];
		const actionCalls: { id: string; visible: boolean }[] = [];
		let groupReads = 0;
		const delegate: IModelPickerDelegate = {
			currentModel,
			selectionPresentation,
			setModel: model => {
				selections.push(model.identifier);
				transaction(tx => {
					currentModel.set(model, tx);
					selectionPresentation.set(undefined, tx);
				});
			},
			getModels: () => models,
			getPresentationOptions: () => ({
				useGroupedModelPicker: true, showManageModelsAction: false, showUnavailableFeatured: false,
				showFeatured: true, showAutoModel: true, showModelIcon: true,
			}),
			modelConfiguration: configurationAccess,
			getAdditionalContent: options.additionalContent,
			getAdditionalActionGroups: options.additionalActions ? () => {
				groupReads++;
				return [
					{ label: 'Empty', actions: [] },
					{
						label: 'Saved choices',
						actions: [
							toAction({
								id: 'savedChoice', label: 'Saved Choice', checked: !!selectionPresentation.get(),
								run: () => {
									actionCalls.push({ id: 'savedChoice', visible: isVisible() });
									selectionPresentation.set(ALTERNATE_SELECTION, undefined);
								},
							}),
							toAction({
								id: 'disabledChoice', label: 'Unavailable Choice', checked: false, enabled: false,
								run: () => { actionCalls.push({ id: 'disabledChoice', visible: isVisible() }); },
							}),
						],
					},
					{
						label: 'Commands',
						actions: [toAction({
							id: 'editChoices', label: 'Edit Choices',
							run: () => { actionCalls.push({ id: 'editChoices', visible: isVisible() }); },
						})],
					},
				];
			} : undefined,
		};
		const picker = store.add(instantiationService.createInstance(ModelPickerActionItem,
			toAction({ id: 'pickModel', label: 'Models', run: () => { } }), delegate, { compact: constObservable(options.compact ?? false) }));
		picker.render(container);
		if (options.realPopup) {
			const anchor = container.querySelector<HTMLElement>('.model-picker-split');
			assert.ok(anchor);
			anchor.style.position = 'absolute';
			anchor.style.bottom = '0';
		}
		if (!options.workspaceTrustInitialized) {
			await trustService.workspaceTrustInitialized;
		}

		const nameButton = () => {
			const button = container.querySelector<HTMLElement>('.model-picker-name');
			assert.ok(button);
			return button;
		};
		const rows = () => [...popup.querySelectorAll<HTMLElement>('.monaco-list-row.action')];
		const row = (label: string) => {
			const result = rows().find(row => row.textContent?.includes(label));
			assert.ok(result, `Missing action row: ${label}`);
			return result;
		};
		const createStandalonePicker = async (overrides: Partial<IModelPickerDelegate> = {}) => {
			const standaloneDelegate: IModelPickerDelegate = {
				...delegate,
				selectionPresentation: undefined,
				getAdditionalActionGroups: undefined,
				getAdditionalContent: undefined,
				...overrides,
			};
			const standalone = store.add(instantiationService.createInstance(ModelPickerWidget, standaloneDelegate));
			store.add(standalone.onDidChangeSelection(model => standaloneDelegate.setModel(model)));
			await trustService.workspaceTrustInitialized;
			return standalone;
		};
		const openModelConfiguration = () => {
			const list = popup.querySelector<HTMLElement>('.monaco-list');
			assert.ok(list);
			if (!tabbed) {
				actionWidgetService.focusItemById(MODEL.identifier);
			}
			list.focus();
			list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', keyCode: 39 }));
			if (!tabbed) {
				const button = popup.querySelector<HTMLElement>('.chat-model-hover-configurable .monaco-button');
				assert.ok(button);
				button.click();
			}
		};
		const configurationOption = (label: string) => {
			if (!tabbed) {
				return row(label);
			}
			const option = [...popup.querySelectorAll<HTMLElement>('.chat-model-card [role="radio"]')].find(option => option.textContent === label);
			assert.ok(option);
			return option;
		};
		return {
			picker, container, popup, currentModel, selectionPresentation, selections, actionCalls, telemetryEvents,
			modelHistoryCalls, configurations, actionWidgetService, hovers, hide, nameButton, rows, row, createStandalonePicker, openModelConfiguration, configurationOption,
			layoutWorkbench: () => onDidLayoutContainer.fire({ container: layoutContainer, dimension: dom.getClientArea(layoutContainer) }),
			get visible() { return isVisible(); },
			get groupReads() { return groupReads; },
			show: () => {
				nameButton().focus();
				picker.show();
			},
			presentation: () => {
				const button = nameButton();
				const content = hovers.get(button)?.content;
				return {
					label: button.querySelector('.chat-input-picker-label')?.textContent,
					ariaLabel: button.ariaLabel,
					tooltip: typeof content === 'function' ? content() : content,
				};
			},
		};
	}

	for (const tabbed of [false, true]) {
		suite(tabbed ? 'tabbed picker' : 'classic picker', () => {
			test('header-only content preserves the normal model UI and width', async () => {
				const ordinary = await createPicker(tabbed, { realPopup: true });
				ordinary.show();
				const ordinaryWidth = ordinary.popup.querySelector<HTMLElement>('.action-widget')?.style.width;
				ordinary.hide();
				const result = await createPicker(tabbed, {
					realPopup: true,
					additionalContent: () => ({
						renderHeader: container => {
							dom.append(container, dom.$('button', { type: 'button' }, 'Team'));
							return Disposable.None;
						},
					}),
				});
				result.show();
				await waitForLayout(result.popup);
				const widget = result.popup.querySelector<HTMLElement>('.action-widget');
				assert.deepStrictEqual({
					visible: result.visible,
					headerFirst: widget?.firstElementChild?.classList.contains('action-list-custom-header'),
					width: widget?.style.width,
					hasModel: result.rows().some(row => row.textContent?.includes('Example Model')),
					hasSearch: !!result.popup.querySelector(tabbed ? '[data-id="search"]' : 'input'),
					customFooter: !!result.popup.querySelector('.action-list-custom-footer'),
				}, {
					visible: true, headerFirst: true, width: ordinaryWidth,
					hasModel: true, hasSearch: true, customFooter: false,
				});
			});

			test('replacement content has no model list, search, Auto footer or unavailable state', async () => {
				let contentContext: IModelPickerAdditionalContentContext | undefined;
				const result = await createPicker(tabbed, {
					realPopup: true,
					additionalContent: () => ({
						replaceModelList: true,
						renderHeader: (container, context) => {
							contentContext = context;
							dom.append(container, dom.$('button', { type: 'button' }, 'Team'));
							return Disposable.None;
						},
						render: container => {
							dom.append(container, dom.$('button', { type: 'button' }, 'Lead model'));
							dom.append(container, dom.$('button', { type: 'button' }, 'Worker model'));
							return Disposable.None;
						},
					}),
				});
				result.show();
				const anchor = result.container.querySelector('.model-picker-split');
				const state = {
					header: result.popup.querySelector('.action-list-custom-header')?.textContent,
					body: result.popup.querySelector('.chat-model-picker-custom-body')?.textContent,
					normalControls: result.popup.querySelectorAll('.monaco-list, input, .tabbed-action-list-footer, .chat-model-picker-tabbar').length,
					unavailable: result.popup.textContent?.includes('unavailable'),
					stableAnchor: contentContext?.anchor === anchor,
					focused: dom.getActiveElement()?.textContent,
				};
				result.hide();
				assert.deepStrictEqual({ ...state, anchorConnectedAfterHide: contentContext?.anchor.isConnected }, {
					header: 'Team', body: 'Lead modelWorker model', normalControls: 0, unavailable: false,
					stableAnchor: true, focused: 'Team', anchorConnectedAfterHide: true,
				});
			});

			test('custom content reopens from the delegate without closing the selection flow', async () => {
				const result = await createPicker(tabbed, { realPopup: true });
				let enabled = false;
				let closes = 0;
				const anchors: HTMLElement[] = [];
				const picker = await result.createStandalonePicker({
					getAdditionalContent: () => ({
						replaceModelList: enabled,
						renderHeader: (container, context) => {
							anchors.push(context.anchor);
							const button = dom.append(container, dom.$('button', { type: 'button' }, 'Team'));
							return dom.addDisposableListener(button, 'click', () => {
								enabled = !enabled;
								context.hide();
								context.reopen();
							});
						},
						render: enabled ? container => {
							dom.append(container, dom.$('button', { type: 'button' }, 'Worker model'));
							return Disposable.None;
						} : undefined,
					}),
				});
				store.add(picker.onDidClose(() => closes++));
				const anchor = result.nameButton();
				anchor.focus();
				picker.show(anchor);
				const states = [];
				for (let i = 0; i < 2; i++) {
					result.popup.querySelector<HTMLElement>('.action-list-custom-header button')?.click();
					await waitForLayout(result.popup);
					states.push({
						enabled, visible: result.visible, closes,
						hasList: !!result.popup.querySelector('.monaco-list'),
						hasBody: !!result.popup.querySelector('.chat-model-picker-custom-body'),
					});
				}
				assert.deepStrictEqual({ states, stableAnchors: anchors.every(candidate => candidate === anchor) }, {
					states: [
						{ enabled: true, visible: true, closes: 0, hasList: false, hasBody: true },
						{ enabled: false, visible: true, closes: 0, hasList: true, hasBody: false },
					],
					stableAnchors: true,
				});
			});

			test('custom header Switch leaves Enter and Space to native button activation', async () => {
				const result = await createPicker(tabbed, { realPopup: true });
				let changes = 0;
				let closes = 0;
				const picker = await result.createStandalonePicker({
					getAdditionalContent: () => ({
						renderHeader: container => {
							const contentStore = new DisposableStore();
							const toggle = contentStore.add(new Switch({ ariaLabel: 'Team', checked: false }));
							contentStore.add(toggle.onChange(() => changes++));
							container.appendChild(toggle.domNode);
							return contentStore;
						},
					}),
				});
				store.add(picker.onDidClose(() => closes++));
				picker.show(result.nameButton());
				const toggle = result.popup.querySelector<HTMLElement>('.action-list-custom-header [role="switch"]');
				assert.ok(toggle);
				toggle.focus();
				const prevented = [];
				for (const [key, keyCode] of [['Enter', 13], [' ', 32]] as const) {
					const event = new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true });
					toggle.dispatchEvent(event);
					prevented.push(event.defaultPrevented);
				}
				await timeout(0);
				assert.deepStrictEqual({
					prevented, visible: result.visible, focused: dom.getActiveElement() === toggle,
					changes, closes, selections: result.selections,
				}, { prevented: [false, false], visible: true, focused: true, changes: 0, closes: 0, selections: [] });
			});

			for (const contentLocation of ['header', 'footer', 'replacement'] as const) {
				test(`${contentLocation} resize preserves focus and does not close the popup`, async () => {
					const result = await createPicker(tabbed, { realPopup: true });
					const button = dom.$('button', { type: 'button' }, 'Team');
					const render = (container: HTMLElement) => {
						container.appendChild(button);
						return Disposable.None;
					};
					const picker = await result.createStandalonePicker({
						getAdditionalContent: () => ({
							renderHeader: contentLocation === 'header' ? render : undefined,
							render: contentLocation !== 'header' ? render : undefined,
							replaceModelList: contentLocation === 'replacement',
						}),
					});
					let closes = 0;
					store.add(picker.onDidClose(() => closes++));
					result.nameButton().focus();
					picker.show(result.nameButton());
					await waitForLayout(result.popup);
					button.focus();
					button.style.height = '80px';
					await waitForLayout(result.popup);
					assert.deepStrictEqual({ visible: result.visible, focused: dom.getActiveElement() === button, closes }, {
						visible: true, focused: true, closes: 0,
					});
				});
			}

			for (const anchorAtTop of [false, true]) {
				test(`replacement body scrolls within the viewport with a pinned header (anchor at top: ${anchorAtTop})`, async () => {
					const result = await createPicker(tabbed, { realPopup: true });
					const targetWindow = dom.getWindow(result.container);
					const anchor = dom.append(result.container, dom.$('button', { type: 'button' }, 'Models'));
					anchor.style.position = 'fixed';
					anchor.style.left = '24px';
					anchor.style[anchorAtTop ? 'top' : 'bottom'] = '12px';
					const header = dom.$('button', { type: 'button' }, 'Team');
					const first = dom.$('button', { type: 'button' }, 'Lead model');
					const last = dom.$('button', { type: 'button' }, 'Worker model');
					const roles = dom.$('div');
					roles.style.display = 'flex';
					roles.style.flexDirection = 'column';
					roles.style.justifyContent = 'space-between';
					roles.style.height = `${targetWindow.innerHeight * 3}px`;
					roles.append(first, last);
					const picker = await result.createStandalonePicker({
						getAdditionalContent: () => ({
							replaceModelList: true,
							renderHeader: container => {
								container.appendChild(header);
								return Disposable.None;
							},
							render: container => {
								container.appendChild(roles);
								return Disposable.None;
							},
						}),
					});
					let closes = 0;
					store.add(picker.onDidClose(() => closes++));
					anchor.focus();
					picker.show(anchor);
					await waitForLayout(result.popup);
					const viewport = result.popup.querySelector<HTMLElement>('.chat-model-picker-custom-body-viewport');
					const widget = result.popup.querySelector<HTMLElement>('.chat-model-picker-custom-content');
					const slider = result.popup.querySelector<HTMLElement>('.scrollbar.vertical .slider');
					assert.ok(viewport && widget && slider);
					const initialBounds = widget.getBoundingClientRect();
					const initialAnchorBounds = anchor.getBoundingClientRect();
					const initialHeaderTop = header.getBoundingClientRect().top;
					const initialSliderHeight = slider.getBoundingClientRect().height;
					viewport.scrollTop = 100;
					await waitForLayout(result.popup);
					const scrolled = viewport.scrollTop > 0;
					const headerPinned = header.getBoundingClientRect().top === initialHeaderTop;
					header.focus();
					roles.style.height = `${targetWindow.innerHeight * 4}px`;
					widget.style.width = '200px';
					await waitForLayout(result.popup);
					const bodyGrowthObserved = viewport.scrollHeight >= targetWindow.innerHeight * 4;
					const initialViewportHeight = viewport.clientHeight;
					anchor.style.top = `${Math.floor(targetWindow.innerHeight / 2)}px`;
					anchor.style.bottom = '';
					targetWindow.dispatchEvent(new Event('resize'));
					await waitForLayout(result.popup);
					const resizedBounds = widget.getBoundingClientRect();
					const resizedViewportHeight = viewport.clientHeight;
					const resizeShrunkBody = resizedViewportHeight < initialViewportHeight;
					anchor.style.top = '12px';
					result.layoutWorkbench();
					await waitForLayout(result.popup);
					const layoutBounds = widget.getBoundingClientRect();
					last.focus();
					await waitForLayout(result.popup);
					const viewportBounds = viewport.getBoundingClientRect();
					const lastBounds = last.getBoundingClientRect();
					assert.deepStrictEqual({
						visible: result.visible, closes, scrolled, headerPinned, bodyGrowthObserved,
						scrollbarUpdated: initialSliderHeight > 0 && slider.getBoundingClientRect().height < initialSliderHeight,
						bounded: initialBounds.top >= 0 && initialBounds.bottom <= targetWindow.innerHeight && resizedBounds.top >= 0 && resizedBounds.bottom <= targetWindow.innerHeight && layoutBounds.top >= 0 && layoutBounds.bottom <= targetWindow.innerHeight,
						resizeShrunkBody,
						workbenchExpandedBody: viewport.clientHeight > resizedViewportHeight,
						besideAnchor: anchorAtTop ? initialBounds.top >= initialAnchorBounds.bottom : initialBounds.bottom <= initialAnchorBounds.top,
						bodyBounded: viewport.clientHeight > 0 && viewport.clientHeight < viewport.scrollHeight,
						lastControlVisible: lastBounds.top >= viewportBounds.top && lastBounds.bottom <= viewportBounds.bottom + 1,
						focused: dom.getActiveElement() === last,
					}, {
						visible: true, closes: 0, scrolled: true, headerPinned: true, bodyGrowthObserved: true, scrollbarUpdated: true,
						bounded: true, resizeShrunkBody: true, workbenchExpandedBody: true, besideAnchor: true, bodyBounded: true, lastControlVisible: true, focused: true,
					});
				});
			}

			test('standalone selection closes once after applying the model and restores anchor focus', async () => {
				const result = await createPicker(tabbed, { realPopup: true, selectedModel: AUTO_MODEL });
				const picker = await result.createStandalonePicker();
				const anchor = result.nameButton();
				const closedStates: { model: string | undefined; visible: boolean; focused: boolean }[] = [];
				store.add(picker.onDidClose(() => closedStates.push({
					model: result.currentModel.get()?.identifier, visible: result.visible, focused: dom.getActiveElement() === anchor,
				})));
				anchor.focus();
				picker.show(anchor);
				result.row('Example Model').click();
				await timeout(0);
				picker.hide();
				assert.deepStrictEqual({ rendered: !!picker.domNode, selections: result.selections, closedStates }, {
					rendered: false, selections: [MODEL.identifier],
					closedStates: [{ model: MODEL.identifier, visible: false, focused: true }],
				});
			});

			test('standalone cancellation can reopen the parent without a stale instance closing it', async () => {
				const result = await createPicker(tabbed, { realPopup: true });
				const picker = await result.createStandalonePicker();
				let closes = 0;
				store.add(picker.onDidClose(() => {
					closes++;
					result.picker.show(result.nameButton());
				}));
				result.nameButton().focus();
				picker.show(result.nameButton());
				const focused = dom.getActiveElement();
				assert.ok(dom.isHTMLElement(focused));
				focused.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 27 }));
				await waitForLayout(result.popup);
				picker.hide();
				picker.dispose();
				assert.deepStrictEqual({ closes, visible: result.visible, selections: result.selections }, {
					closes: 1, visible: true, selections: [],
				});
			});

			for (const replacement of [false, true]) {
				test(`hiding or disposing a replaced instance does not close another picker (replacement: ${replacement})`, async () => {
					const result = await createPicker(tabbed, { realPopup: true });
					const first = await result.createStandalonePicker({
						getAdditionalContent: replacement ? () => ({
							replaceModelList: true,
							render: container => {
								dom.append(container, dom.$('button', { type: 'button' }, 'Worker model'));
								return Disposable.None;
							},
						}) : undefined,
					});
					const second = await result.createStandalonePicker();
					let secondCloses = 0;
					store.add(second.onDidClose(() => secondCloses++));
					first.show(result.nameButton());
					second.show(result.nameButton());
					await timeout(0);
					first.hide();
					first.dispose();
					assert.deepStrictEqual({ visible: result.visible, secondCloses }, { visible: true, secondCloses: 0 });
				});
			}

			test('standalone configuration stays in the selection flow until dismissed', async () => {
				const result = await createPicker(tabbed, { realPopup: true });
				const picker = await result.createStandalonePicker();
				const anchor = result.nameButton();
				let closes = 0;
				let focusRestored = false;
				store.add(picker.onDidClose(() => {
					closes++;
					focusRestored = dom.getActiveElement() === anchor;
					result.picker.show(anchor);
				}));
				anchor.focus();
				picker.show(anchor);
				result.openModelConfiguration();
				await timeout(0);
				const configuredPopup = {
					visible: result.visible, closes,
					focused: dom.isAncestorOfActiveElement(result.popup),
					aboveAnchor: result.popup.getBoundingClientRect().bottom <= anchor.getBoundingClientRect().top + 1,
				};
				result.configurationOption('High').click();
				await timeout(0);
				const afterConfiguration = {
					configuration: result.configurations.get(MODEL.identifier), visible: result.visible, closes,
					focused: dom.isAncestorOfActiveElement(result.popup),
				};
				picker.hide();
				await waitForLayout(result.popup);
				picker.hide();
				picker.dispose();
				assert.deepStrictEqual({ configuredPopup, afterConfiguration, closes, focusRestored, parentVisible: result.visible }, {
					configuredPopup: { visible: true, closes: 0, focused: true, aboveAnchor: true },
					afterConfiguration: { configuration: { reasoningEffort: 'high' }, visible: true, closes: 0, focused: true },
					closes: 1, focusRestored: true, parentVisible: true,
				});
			});

			for (const fromModelPicker of [false, true]) {
				test(`public configuration picker keeps standalone flow ownership (from model list: ${fromModelPicker})`, async () => {
					const result = await createPicker(tabbed, { realPopup: true });
					const picker = await result.createStandalonePicker();
					const anchor = result.nameButton();
					let closes = 0;
					let focusRestored = false;
					store.add(picker.onDidClose(() => {
						closes++;
						focusRestored = dom.getActiveElement() === anchor;
						result.picker.show(anchor);
					}));
					anchor.focus();
					if (fromModelPicker) {
						picker.show(anchor);
						picker.showConfiguration(undefined, MODEL_CONFIG_GROUP_EFFORT);
					} else {
						picker.showConfiguration(anchor, MODEL_CONFIG_GROUP_EFFORT);
					}
					await timeout(0);
					const opened = {
						closes, visible: result.visible,
						focused: dom.isAncestorOfActiveElement(result.popup),
						focusedGroup: result.popup.querySelector('.monaco-list-row.focused')?.textContent?.includes('Medium'),
						aboveAnchor: result.popup.getBoundingClientRect().bottom <= anchor.getBoundingClientRect().top + 1,
					};
					result.row('High').click();
					await timeout(0);
					const configured = { closes, visible: result.visible, configuration: result.configurations.get(MODEL.identifier) };
					picker.hide();
					await waitForLayout(result.popup);
					picker.hide();
					picker.dispose();
					assert.deepStrictEqual({
						opened, configured, closes, focusRestored, selections: result.selections,
						rendered: !!picker.domNode, parentVisible: result.visible,
					}, {
						opened: { closes: 0, visible: true, focused: true, focusedGroup: true, aboveAnchor: true },
						configured: { closes: 0, visible: true, configuration: { reasoningEffort: 'high' } },
						closes: 1, focusRestored: true, selections: [], rendered: false, parentVisible: true,
					});
				});
			}

			test('public configuration cannot open an unavailable widget or close another instance', async () => {
				const result = await createPicker(tabbed, { realPopup: true });
				const disabled = await result.createStandalonePicker();
				const disposed = await result.createStandalonePicker();
				const unanchored = await result.createStandalonePicker();
				disabled.setEnabled(false);
				disposed.dispose();
				result.show();
				disabled.showConfiguration(result.nameButton(), MODEL_CONFIG_GROUP_EFFORT);
				disposed.showConfiguration(result.nameButton(), MODEL_CONFIG_GROUP_EFFORT);
				unanchored.showConfiguration();
				assert.deepStrictEqual({
					visible: result.visible,
					hasModelList: result.rows().some(row => row.textContent?.includes('Example Model')),
					hasConfiguration: result.rows().some(row => row.querySelector('.title')?.textContent === 'High'),
				}, { visible: true, hasModelList: true, hasConfiguration: false });
			});

			test('standalone roles keep independent configuration for the same model', async () => {
				const result = await createPicker(tabbed, { realPopup: true });
				const first = await result.createStandalonePicker();
				const secondValues: IStringDictionary<unknown> = { reasoningEffort: 'high' };
				const second = await result.createStandalonePicker({
					modelConfiguration: {
						getModelConfiguration: () => secondValues,
						setModelConfiguration: async (_id, values) => { Object.assign(secondValues, values); },
						getModelConfigurationActions: () => [],
					},
				});
				for (const [picker, effort] of [[first, 'High'], [second, 'Medium']] as const) {
					result.nameButton().focus();
					picker.show(result.nameButton());
					result.openModelConfiguration();
					result.configurationOption(effort).click();
					await timeout(0);
					picker.hide();
					await timeout(0);
				}
				assert.deepStrictEqual({ first: result.configurations.get(MODEL.identifier), second: secondValues }, {
					first: { reasoningEffort: 'high' }, second: { reasoningEffort: 'medium' },
				});
			});

			test('renders interactive additional content and disposes it with the popup', async () => {
				let renders = 0;
				let disposals = 0;
				let clicks = 0;
				const result = await createPicker(tabbed, {
					additionalContent: () => ({
						render: container => {
							renders++;
							const button = dom.append(container, dom.$('button', undefined, 'Worker model'));
							button.className = 'test-model-team-card';
							const listener = dom.addDisposableListener(button, 'click', () => clicks++);
							return toDisposable(() => { listener.dispose(); button.remove(); disposals++; });
						},
					}),
				});
				result.show();
				result.popup.querySelector<HTMLElement>('.test-model-team-card')?.click();
				result.hide();
				result.show();
				assert.deepStrictEqual({
					renders, disposals, clicks, cards: result.popup.querySelectorAll('.test-model-team-card').length,
					selections: result.selections, history: result.modelHistoryCalls,
				}, { renders: 2, disposals: 1, clicks: 1, cards: 1, selections: [], history: [] });
			});

			test('compact presentation retains both agent identities', async () => {
				const result = await createPicker(tabbed, {
					compact: true,
					selectionPresentation: {
						...ALTERNATE_SELECTION,
						segments: [{ label: 'Lead Model', icon: { id: 'agent' } }, { label: 'Worker Model', icon: { id: 'agent' } }],
					},
				});
				assert.deepStrictEqual({
					segments: [...result.nameButton().querySelectorAll('.model-picker-selection-segment')].map(element => element.textContent),
					multiple: result.container.querySelector('.model-picker-split')?.classList.contains('multiple-models'),
					ariaLabel: result.nameButton().ariaLabel,
				}, { segments: ['Lead Model', 'Worker Model'], multiple: true, ariaLabel: ALTERNATE_SELECTION.ariaLabel });
			});

			test('absent groups preserve the ordinary model selection', async () => {
				const result = await createPicker(tabbed);
				result.show();
				assert.deepStrictEqual({
					label: result.presentation().label,
					modelChecked: !!result.row('Example Model').querySelector('.codicon-check'),
					hasAdditionalGroups: result.popup.textContent?.includes('Saved choices'),
					model: result.currentModel.get(),
				}, { label: 'Example Model', modelChecked: true, hasAdditionalGroups: false, model: MODEL });
			});

			test('renders checked and disabled actions and runs an extra action only after closing', async () => {
				const result = await createPicker(tabbed, { additionalActions: true, selectionPresentation: ALTERNATE_SELECTION });
				result.show();
				const checked = !!result.row('Saved Choice').querySelector('.codicon-check');
				const disabled = result.row('Unavailable Choice').classList.contains('option-disabled');
				const modelChecked = !!result.row('Example Model').querySelector('.codicon-check');
				result.row('Unavailable Choice').click();
				const stillVisible = result.visible;
				result.row('Saved Choice').click();

				assert.deepStrictEqual({
					checked, disabled, modelChecked, stillVisible,
					visible: result.visible, focused: dom.getActiveElement() === result.nameButton(),
					actionCalls: result.actionCalls, selections: result.selections, telemetry: result.telemetryEvents,
					history: result.modelHistoryCalls, model: result.currentModel.get(),
				}, {
					checked: true, disabled: true, modelChecked: false, stillVisible: true,
					visible: false, focused: true, actionCalls: [{ id: 'savedChoice', visible: false }],
					selections: [], telemetry: [], history: [], model: MODEL,
				});
			});

			test('multi-segment chips use balanced spacing and hide only the global configuration chip', async () => {
				const result = await createPicker(tabbed, {
					compact: true,
					selectionPresentation: {
						...ALTERNATE_SELECTION,
						segments: [{ label: 'Lead Model', icon: { id: 'agent' } }, { label: 'Worker Model', icon: { id: 'agent' } }],
					},
				});
				const workbench = dom.append(mainWindow.document.body, dom.$('.monaco-workbench.interactive-session'));
				store.add(toDisposable(() => workbench.remove()));
				const toolbars = dom.append(workbench, dom.$('.chat-input-toolbars'));
				const toolbar = dom.append(toolbars, dom.$('.chat-input-toolbar'));
				toolbar.appendChild(result.container);
				result.container.style.setProperty('--vscode-spacing-size60', '6px');
				const separator = result.nameButton().querySelector<HTMLElement>('.model-picker-selection-separator');
				const segment = result.nameButton().querySelector<HTMLElement>('.model-picker-selection-segment');
				const label = segment?.querySelector<HTMLElement>('.chat-input-picker-label');
				const configuration = result.container.querySelector<HTMLElement>('.model-picker-config');
				assert.ok(separator && segment && label && configuration);
				const style = dom.getWindow(separator).getComputedStyle(separator);
				const labelStyle = dom.getWindow(label).getComputedStyle(label);
				const segmented = {
					configurationVisible: configuration.style.display !== 'none',
					padding: [style.paddingInlineStart, style.paddingInlineEnd],
					iconLabelGap: dom.getWindow(segment).getComputedStyle(segment).gap,
					labelMargin: [labelStyle.marginInlineStart, labelStyle.marginInlineEnd],
					ellipsis: labelStyle.textOverflow,
					decorative: [...result.nameButton().querySelectorAll('.model-picker-selection-separator, .model-picker-selection-segment .codicon')].map(element => element.getAttribute('aria-hidden')),
				};
				result.selectionPresentation.set(undefined, undefined);
				assert.deepStrictEqual({ segmented, singleConfigurationVisible: configuration.style.display !== 'none' }, {
					segmented: {
						configurationVisible: false, padding: ['6px', '6px'], iconLabelGap: '6px',
						labelMargin: ['0px', '0px'], ellipsis: 'ellipsis', decorative: ['true', 'true', 'true'],
					},
					singleConfigurationVisible: !tabbed,
				});
			});

			test('a plain additional command also closes without selecting a model', async () => {
				const result = await createPicker(tabbed, { additionalActions: true });
				result.show();
				result.row('Edit Choices').click();
				assert.deepStrictEqual({
					visible: result.visible, actions: result.actionCalls, selections: result.selections, telemetry: result.telemetryEvents,
				}, { visible: false, actions: [{ id: 'editChoices', visible: false }], selections: [], telemetry: [] });
			});

			test('keyboard selection of a filtered additional action restores focus', async () => {
				const result = await createPicker(tabbed, { additionalActions: true });
				result.show();
				if (tabbed) {
					const searchButton = result.popup.querySelector<HTMLElement>('[data-id="search"]');
					assert.ok(searchButton);
					searchButton.click();
				}
				const input = result.popup.querySelector<HTMLInputElement>('input');
				assert.ok(input);
				input.value = 'Saved Choice';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await timeout(0);
				input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
				assert.deepStrictEqual({
					visible: result.visible, focused: dom.getActiveElement() === result.nameButton(),
					actions: result.actionCalls, selections: result.selections,
				}, { visible: false, focused: true, actions: [{ id: 'savedChoice', visible: false }], selections: [] });
			});

			test('reactively restores labels, ARIA, tooltip and checkmarks without changing the underlying model', async () => {
				const result = await createPicker(tabbed, { additionalActions: true });
				const ordinary = result.presentation();
				result.show();
				const focused = dom.getActiveElement();
				const states = [];
				for (const presentation of [ALTERNATE_SELECTION, { ...ALTERNATE_SELECTION, label: 'Changed +2', ariaLabel: 'Changed selection', tooltip: 'Changed selection details' }, undefined]) {
					result.selectionPresentation.set(presentation, undefined);
					states.push({
						presentation: result.presentation(),
						modelChecked: !!result.row('Example Model').querySelector('.codicon-check'),
						actionChecked: !!result.row('Saved Choice').querySelector('.codicon-check'),
						focused: dom.getActiveElement() === focused,
						model: result.currentModel.get(),
					});
				}
				assert.deepStrictEqual(states, [
					{ presentation: ALTERNATE_SELECTION, modelChecked: false, actionChecked: true, focused: true, model: MODEL },
					{ presentation: { label: 'Changed +2', ariaLabel: 'Changed selection', tooltip: 'Changed selection details' }, modelChecked: false, actionChecked: true, focused: true, model: MODEL },
					{ presentation: ordinary, modelChecked: true, actionChecked: false, focused: true, model: MODEL },
				]);
			});

			test('selecting the real underlying model clears the alternate presentation', async () => {
				const result = await createPicker(tabbed, { additionalActions: true, selectionPresentation: ALTERNATE_SELECTION });
				result.show();
				result.row('Example Model').click();
				assert.deepStrictEqual({
					label: result.presentation().label, selections: result.selections, model: result.currentModel.get(),
					presentation: result.selectionPresentation.get(), telemetry: result.telemetryEvents,
				}, {
					label: 'Example Model', selections: [MODEL.identifier], model: MODEL,
					presentation: undefined, telemetry: ['chat.modelChange'],
				});
			});

			test('the alternate label stays visible in compact mode', async () => {
				const result = await createPicker(tabbed, { compact: true, selectionPresentation: ALTERNATE_SELECTION });
				assert.deepStrictEqual(result.presentation(), ALTERNATE_SELECTION);
			});

			test('keeps configuration attached to the real model', async () => {
				const result = await createPicker(tabbed, { selectionPresentation: ALTERNATE_SELECTION });
				if (tabbed) {
					result.show();
					const row = result.row('Example Model');
					row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
					row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementY: 1 }));
					await timeout(50);
					const high = [...result.popup.querySelectorAll<HTMLElement>('[role="radio"]')].find(option => option.textContent === 'High');
					assert.ok(high);
					high.click();
				} else {
					const button = result.container.querySelector<HTMLElement>('.model-picker-config');
					assert.ok(button && button.style.display !== 'none');
					button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
					result.row('High').click();
				}
				await timeout(0);
				assert.deepStrictEqual({
					configuration: result.configurations.get(MODEL.identifier), presentation: result.presentation(),
					model: result.currentModel.get(), selections: result.selections, telemetry: result.telemetryEvents,
				}, {
					configuration: { reasoningEffort: 'high' }, presentation: ALTERNATE_SELECTION,
					model: MODEL, selections: [], telemetry: ['chat.thinkingEffortChange'],
				});
			});

			test('does not retain popup observers or old controls across show, hide and render', async () => {
				const result = await createPicker(tabbed, { additionalActions: true });
				const states = [];
				for (let i = 0; i < 3; i++) {
					result.show();
					result.hide();
					const groupReads = result.groupReads;
					const oldButton = result.nameButton();
					result.picker.render(result.container);
					oldButton.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
					result.selectionPresentation.set(i % 2 ? undefined : ALTERNATE_SELECTION, undefined);
					states.push({
						refreshedHiddenPicker: result.groupReads !== groupReads, visible: result.visible,
						oldButtonConnected: oldButton.isConnected, hovers: result.hovers.size,
					});
				}
				assert.deepStrictEqual(states, Array.from({ length: 3 }, () => ({
					refreshedHiddenPicker: false, visible: false, oldButtonConnected: false, hovers: 1,
				})));
			});

			for (const unavailable of ['restrictedMode', 'setupRequired'] as const) {
				test(`does not expose additional actions or presentation through ${unavailable}`, async () => {
					const result = await createPicker(tabbed, { [unavailable]: true, additionalActions: true, selectionPresentation: ALTERNATE_SELECTION });
					result.show();
					assert.deepStrictEqual({
						label: result.presentation().label, hasAdditionalActions: result.popup.textContent?.includes('Saved'),
						groupReads: result.groupReads, hasAlternateTooltip: result.presentation().tooltip === ALTERNATE_SELECTION.tooltip,
					}, { label: 'Models', hasAdditionalActions: false, groupReads: 0, hasAlternateTooltip: false });
				});
			}

			test('does not open additional actions when the control is disabled', async () => {
				const result = await createPicker(tabbed, { additionalActions: true });
				result.picker.setEnabled(false);
				result.picker.render(result.container);
				result.show();
				assert.deepStrictEqual({ visible: result.visible, groupReads: result.groupReads }, { visible: false, groupReads: 0 });
			});

			test('does not expose additional actions before workspace trust is initialized', async () => {
				const initialized = new DeferredPromise<void>();
				const result = await createPicker(tabbed, { additionalActions: true, workspaceTrustInitialized: initialized.p });
				result.show();
				const state = { groupReads: result.groupReads, hasAdditionalActions: result.popup.textContent?.includes('Saved Choice') };
				result.hide();
				await initialized.complete();
				assert.deepStrictEqual(state, { groupReads: 0, hasAdditionalActions: false });
			});
		});
	}

	test('an asynchronous configuration save cannot update another instance popup', async () => {
		const result = await createPicker(false, { realPopup: true });
		const save = new DeferredPromise<void>();
		const picker = await result.createStandalonePicker({
			modelConfiguration: {
				getModelConfiguration: () => undefined,
				setModelConfiguration: () => save.p,
				getModelConfigurationActions: () => [],
			},
		});
		result.nameButton().focus();
		picker.show(result.nameButton());
		result.openModelConfiguration();
		result.configurationOption('High').click();
		picker.hide();
		result.picker.show(result.nameButton());
		await save.complete();
		await timeout(0);
		picker.dispose();
		assert.deepStrictEqual({
			visible: result.visible,
			hasModels: result.rows().some(row => row.textContent?.includes('Example Model')),
			hasConfiguration: result.rows().some(row => row.textContent === 'High'),
			focused: dom.isAncestorOfActiveElement(result.popup),
		}, { visible: true, hasModels: true, hasConfiguration: false, focused: true });
	});

	test('tabbed groups remain available across provider tabs and occur only once in search', async () => {
		const result = await createPicker(true, { additionalActions: true, selectionPresentation: ALTERNATE_SELECTION });
		result.show();
		const localTab = [...result.popup.querySelectorAll<HTMLElement>('.chat-model-picker-tabbar .monaco-button')].find(tab => tab.ariaLabel === 'Local');
		assert.ok(localTab);
		localTab.click();
		const localModelVisible = !!result.row('Local Model');
		const actionVisible = !!result.row('Saved Choice');
		const searchButton = result.popup.querySelector<HTMLElement>('[data-id="search"]');
		assert.ok(searchButton);
		searchButton.click();
		const matchesBeforeFiltering = result.rows().filter(row => row.textContent?.includes('Saved Choice')).length;
		const input = result.popup.querySelector<HTMLInputElement>('input');
		assert.ok(input);
		input.value = 'Saved Choice';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await timeout(0);

		assert.deepStrictEqual({
			localModelVisible, actionVisible, matchesBeforeFiltering,
			actionLabel: result.row('Saved Choice').getAttribute('aria-label'),
			modelVisibleInFilteredList: result.rows().some(row => row.textContent?.includes('Example Model')),
		}, {
			localModelVisible: true, actionVisible: true, matchesBeforeFiltering: 1,
			actionLabel: 'Saved Choice, Selected', modelVisibleInFilteredList: false,
		});
	});

	test('an alternate presentation also suppresses and restores the tabbed Auto switch', async () => {
		const result = await createPicker(true, { selectedModel: AUTO_MODEL, selectionPresentation: ALTERNATE_SELECTION });
		result.show();
		const toggle = result.popup.querySelector<HTMLElement>('[role="switch"]');
		assert.ok(toggle);
		const before = toggle.getAttribute('aria-checked');
		result.selectionPresentation.set(undefined, undefined);
		assert.deepStrictEqual({ before, after: toggle.getAttribute('aria-checked'), model: result.currentModel.get() }, {
			before: 'false', after: 'true', model: AUTO_MODEL,
		});
	});
});
