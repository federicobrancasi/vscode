/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessage, IAgentHostRoomMessagePage, MAX_ROOM_WORKERS } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { ChatInputRequestWithPlanReview } from '../../../../../platform/agentHost/common/agentHostPlanReview.js';
import { ChatInputQuestionKind, ChatInputResponseKind, ConfirmationOptionKind, ModelSelection, SessionModelInfo, ToolCallStatus } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfirmation, IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IPickOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { ITextDiffEditorPane } from '../../../../../workbench/common/editor.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IAgentHostSessionsProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsPartService } from '../../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ICollaborationRoomCreationDraft, ICollaborationRoomScrollState, ICollaborationRoomViewService } from '../../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationRequestResponse, ICollaborationRequest, ICollaborationService, ICollaborationWorkspaceTrust } from '../../../../services/collaboration/common/collaboration.js';
import { CollaborationAudience, CollaborationDraft } from '../../../../services/collaboration/common/collaborationMentions.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { IChat, ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { CollaborationRoomWidget } from '../../browser/collaborationRoomWidget.js';
import { stubCollaborationTestServices } from './collaborationTestServices.js';

suite('CollaborationRoomWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(state: IAgentHostRoom['state'] = 'running', messageCount = 0, newRoom = false, draft = new CollaborationDraft(), initialDraft?: ICollaborationRoomCreationDraft) {
		const room: IAgentHostRoom = {
			id: 'room', revision: 1, title: 'Peer room', goal: 'A shared goal', instructions: '',
			repositoryUri: 'file:///repo', baseRevision: 'base', createdAt: 0, updatedAt: 0, state,
			members: [1, 2].map(index => ({
				id: `member-${index}`, name: `Copilot-${index}`, sessionUri: `copilotcli:/member-${index}`,
				chatUri: `opaque-chat:/member-${index}/primary?version=2`,
				state: state === 'created' ? 'pending' as const : 'working' as const, turns: state === 'created' ? 0 : 1,
			})),
			artifacts: [], latestMessageSequence: messageCount,
			run: state === 'created' ? undefined : { id: 'run', startedAt: 0, limits: { maxTurns: 10 }, admittedTurns: 2 },
		};
		const messages: IAgentHostRoomMessage[] = Array.from({ length: messageCount }, (_, index): IAgentHostRoomMessage => ({
			id: `post-${index}`, sequence: index + 1, authorId: 'member-1', authorName: 'Copilot-1',
			authorKind: 'agent', kind: 'message', text: `Shared post ${index}`, timestamp: 0,
			mentions: [], deliveries: [],
		}));
		const starts: IAgentHostRoomLimits[] = [];
		const extensions: number[] = [];
		const summaries: string[] = [];
		const sentMessages: { text: string; audience: CollaborationAudience; replyTo: string | undefined }[] = [];
		const created = new DeferredPromise<IAgentHostRoomCreateOptions>();
		const opened = new DeferredPromise<{ session: ISession; chat: URI }>();
		const artifactFocused = new DeferredPromise<void>();
		const resolutions: { session: string; chat: string | undefined }[] = [];
		const selectedRooms: (string | undefined)[] = [];
		const peerChat = new class extends mock<IChat>() {
			override readonly resource = URI.parse('client-chat:/separate-resource');
		}();
		const peerSession = new class extends mock<ISession>() {
			override readonly resource = URI.parse('client-session:/opaque-resource');
		}();
		const provider = new class extends mock<IAgentHostSessionsProvider>() {
			override readonly id = LOCAL_AGENT_HOST_PROVIDER_ID;
			override async resolveSessionChat(session: URI, chat: URI | undefined) {
				resolutions.push({ session: session.toString(), chat: chat?.toString() });
				return { session: peerSession, chat: peerChat };
			}
		}();
		let sends = 0;
		let sessionFocuses = 0;
		const drafts = new Map<string, CollaborationDraft>([['room', draft]]);
		const facade = new class extends mock<ICollaborationService>() {
			override readonly availability = constObservable('available' as const);
			override readonly supported = constObservable(true);
			override readonly availabilityError = constObservable(undefined);
			override readonly rooms = observableValue<readonly IAgentHostRoom[]>(this, [room]);
			override readonly activeRoomId = observableValue<string | undefined>(this, newRoom ? undefined : room.id);
			override readonly activeRoom = observableValue<IAgentHostRoom | undefined>(this, newRoom ? undefined : room);
			override readonly inboxMemberId = observableValue<string | undefined>(this, undefined);
			override readonly messages = observableValue<IAgentHostRoomMessagePage>(this, { messages, hasEarlier: false, hasLater: false });
			override readonly models = observableValue<readonly SessionModelInfo[]>(this, [
				{ id: 'model-a', name: 'Model A', provider: 'copilotcli' },
				{ id: 'model-b', name: 'Model B', provider: 'copilotcli' },
			]);
			override readonly loading = constObservable(false);
			override readonly loadingEarlier = observableValue(this, false);
			override readonly creating = observableValue(this, false);
			override readonly sending = constObservable(false);
			override readonly canSend = observableValue(this, true);
			override readonly canConfigure = observableValue(this, false);
			override readonly canSetMemberModel = observableValue(this, true);
			override readonly error = constObservable(undefined);
			override readonly workspaceTrust = observableValue<ICollaborationWorkspaceTrust>(this, { state: 'trusted' });
			override readonly requests = observableValue<readonly ICollaborationRequest[]>(this, []);
			override readonly requestError = constObservable(undefined);
			override getDraft(roomId: string) {
				let draft = drafts.get(roomId);
				if (!draft) {
					draft = new CollaborationDraft();
					drafts.set(roomId, draft);
				}
				return draft;
			}
			private roomHistory: IAgentHostRoomMessagePage | undefined;
			override async selectRoom(roomId: string | undefined): Promise<void> {
				selectedRooms.push(roomId);
				transaction(tx => {
					this.activeRoomId.set(roomId, tx);
					this.activeRoom.set(this.rooms.get().find(candidate => candidate.id === roomId), tx);
					this.inboxMemberId.set(undefined, tx);
				});
			}
			override async selectInbox(memberId: string | undefined): Promise<void> {
				if (this.inboxMemberId.get() === undefined) {
					this.roomHistory = this.messages.get();
				}
				const page = this.roomHistory!;
				transaction(tx => {
					this.inboxMemberId.set(memberId, tx);
					this.messages.set({ ...page, messages: memberId ? page.messages.filter(message => message.mentions.includes(memberId)) : page.messages }, tx);
				});
			}
			override async loadMessages(): Promise<void> { }
			override async loadEarlierMessages(): Promise<void> { }
			override async sendMessage(): Promise<void> {
				const draft = this.getDraft(this.activeRoomId.get()!);
				sends++;
				sentMessages.push({ text: draft.text, audience: draft.audience, replyTo: draft.replyTo });
			}
			override async askForSummary(memberId: string): Promise<void> { summaries.push(memberId); }
			override async startRoom(limits: IAgentHostRoomLimits): Promise<void> { starts.push(limits); }
			override async extendRun(additionalTurns: number): Promise<void> { extensions.push(additionalTurns); }
			override async isRepository(): Promise<boolean> { return true; }
			override async createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom> {
				await created.complete(options);
				return room;
			}
		}();
		const viewService = new class extends mock<ICollaborationRoomViewService>() {
			override readonly visible = observableValue('roomVisible', true);
			override readonly activeView = constObservable(undefined);
			override readonly scrollState = observableValue<ICollaborationRoomScrollState | undefined>(this, undefined);
			override readonly creationDraft = observableValue<ICollaborationRoomCreationDraft | undefined>(this, initialDraft);
			override readonly hiddenMessages = observableValue<ReadonlyMap<string, ReadonlySet<string>>>(this, new Map());
			override readonly panelContent = observableValue<HTMLElement | undefined>(this, undefined);
			override saveScrollState(state: ICollaborationRoomScrollState): void { this.scrollState.set(state, undefined); }
			override saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void { this.creationDraft.set(draft, undefined); }
			override publishPanelContent(content: HTMLElement | undefined): IDisposable { this.panelContent.set(content, undefined); return Disposable.None; }
			override close(): void { this.visible.set(false, undefined); }
			override hideMessage(roomId: string, messageId: string): void {
				const hidden = new Map(this.hiddenMessages.get());
				hidden.set(roomId, new Set([...hidden.get(roomId) ?? [], messageId]));
				this.hiddenMessages.set(hidden, undefined);
			}
			override restoreHiddenMessages(roomId: string): void {
				const hidden = new Map(this.hiddenMessages.get());
				hidden.delete(roomId);
				this.hiddenMessages.set(hidden, undefined);
			}
		}();
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const lists = stubCollaborationTestServices(instantiation, disposables);
		const hovers = new Map<HTMLElement, string>();
		instantiation.stub(IHoverService, {
			...NullHoverService,
			setupDelayedHover: (target: HTMLElement, options: Parameters<IHoverService['setupDelayedHover']>[1]) => {
				const content = (typeof options === 'function' ? options() : options).content;
				if (typeof content === 'string') {
					hovers.set(target, content);
				}
				return toDisposable(() => hovers.delete(target));
			},
		});
		instantiation.stub(IActionWidgetService, new class extends mock<IActionWidgetService>() {
			override show(): void { }
			override hide(): void { }
		}());
		let contextMenu: Parameters<IContextMenuService['showContextMenu']>[0] | undefined;
		instantiation.stub(IContextMenuService, new class extends mock<IContextMenuService>() {
			override showContextMenu(delegate: Parameters<IContextMenuService['showContextMenu']>[0]): void { contextMenu = delegate; }
		}());
		instantiation.stub(ICollaborationService, facade);
		instantiation.stub(ICollaborationRoomViewService, viewService);
		instantiation.stub(IContextKeyService, disposables.add(new MockContextKeyService()));
		const configuration = new TestConfigurationService();
		disposables.add(configuration.onDidChangeConfigurationEmitter);
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(IKeybindingService, new class extends mock<IKeybindingService>() {
			override readonly onDidUpdateKeybindings = BaseEvent.None;
			override lookupKeybinding() { return undefined; }
		}());
		instantiation.stub(IMarkdownRendererService, new class extends mock<IMarkdownRendererService>() {
			override render(markdown: IMarkdownString) {
				const element = document.createElement('div');
				element.textContent = markdown.value;
				return { element, dispose() { } };
			}
		}());
		instantiation.stub(IFileDialogService, new class extends mock<IFileDialogService>() {
			override async showOpenDialog(): Promise<URI[]> { return [URI.file('/repo')]; }
		}());
		instantiation.stub(IOpenerService, new class extends mock<IOpenerService>() {
			override async open() { return true; }
		}());
		instantiation.stub(IQuickInputService, new class extends mock<IQuickInputService>() {
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: true }): Promise<T[] | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T> & { canPickMany: false }): Promise<T | undefined>;
			override pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: Omit<IPickOptions<T>, 'canPickMany'>): Promise<T | undefined>;
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[], options?: IPickOptions<T>): Promise<T | T[] | undefined> {
				const item = (await picks)[1];
				return item && item.type !== 'separator' ? options?.canPickMany ? [item] : item : undefined;
			}
		}());
		const providers = new Map<string, ISessionsProvider>([[provider.id, provider]]);
		instantiation.stub(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() {
			override getProvider<T extends ISessionsProvider>(id: string): T | undefined { return providers.get(id) as T | undefined; }
		}());
		instantiation.stub(ISessionsService, new class extends mock<ISessionsService>() {
			override readonly activeSession = constObservable(undefined);
			override async openChat(session: ISession, chat: URI): Promise<void> {
				await opened.complete({ session, chat });
			}
		}());
		instantiation.stub(ISessionsPartService, new class extends mock<ISessionsPartService>() {
			override focusSession(): void { sessionFocuses++; }
		}());
		const confirmations: string[] = [];
		instantiation.stub(IDialogService, new class extends mock<IDialogService>() {
			override async confirm(confirmation: IConfirmation) {
				confirmations.push(confirmation.message);
				return { confirmed: true };
			}
		}());
		instantiation.stub(IEditorService, new class extends mock<IEditorService>() {
			override async openEditor() {
				return new class extends mock<ITextDiffEditorPane>() {
					override focus(): void { void artifactFocused.complete(); }
				}();
			}
		}());
		const openedContainers: string[] = [];
		instantiation.stub(IViewsService, new class extends mock<IViewsService>() {
			override async openViewContainer(id: string) { openedContainers.push(id); return null; }
		}());
		const container = document.body.appendChild(document.createElement('div'));
		container.style.width = '1100px';
		container.style.height = '760px';
		disposables.add(toDisposable(() => container.remove()));
		const widget = disposables.add(instantiation.createInstance(CollaborationRoomWidget, container));
		widget.layout(1100, 760);
		// Stand in for the Agents window side panel, which adopts the settings the room publishes.
		const panel = viewService.panelContent.get()!;
		container.appendChild(panel);
		widget.layoutPanel(360, 760);
		const input = container.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')!;
		const type = (text: string) => {
			input.value = text;
			input.setSelectionRange(text.length, text.length);
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const key = (key: string, shiftKey = false) => {
			const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
			input.dispatchEvent(event);
			return event;
		};
		const setBudget = (value: string) => {
			const input = panel.querySelector<HTMLInputElement>('.room-budget-field input')!;
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const chooseMenuItem = async (selector: string, label: string) => {
			container.querySelector<HTMLElement>(selector)!.click();
			const menu = contextMenu!;
			assert.ok(menu.getActions);
			const action = menu.getActions().find(action => action.label === label);
			assert.ok(action);
			await action.run();
			menu.onHide?.(false);
		};
		const getMessageList = () => {
			const list = lists.widget;
			assert.ok(list instanceof WorkbenchList);
			return list;
		};
		const historyKey = (key: 'Home' | 'End') => {
			container.querySelector<HTMLElement>('.room-feed .monaco-list')!.focus();
			const list = getMessageList();
			if (key === 'Home') {
				list.focusFirst();
			} else {
				list.focusLast();
			}
			list.reveal(list.getFocus()[0], key === 'Home' ? 0 : 1);
		};
		return { widget, container, instantiation, confirmations, input, type, key, setBudget, chooseMenuItem, historyKey, getMessageList, hovers, draft, starts, extensions, summaries, created, opened, artifactFocused, provider, resolutions, selectedRooms, peerSession, peerChat, viewService, facade, sentMessages, openedContainers, panel, getSends: () => sends, getSessionFocuses: () => sessionFocuses };
	}

	test('peer navigation resolves opaque identities through the owning provider', async () => {
		const { container, opened, resolutions, peerSession, peerChat } = setup();
		container.querySelector<HTMLElement>('.room-member-heading .monaco-button')!.click();
		assert.deepStrictEqual(await opened.p, { session: peerSession, chat: peerChat.resource });
		assert.deepStrictEqual(resolutions, [{ session: 'copilotcli:/member-1', chat: URI.parse('opaque-chat:/member-1/primary?version=2').toString() }]);
	});

	test('peer navigation uses the latest host-supplied chat after provisioning', async () => {
		const { facade, container, opened, resolutions } = setup('created');
		const room = facade.activeRoom.get()!;
		const beforeStart = container.querySelector('.room-member-heading .monaco-button')?.getAttribute('aria-disabled');
		facade.activeRoom.set({ ...room, members: room.members.map(member => ({ ...member, turns: 1, state: 'idle', chatUri: 'opaque-chat:/provisioned/primary?version=3' })) }, undefined);
		container.querySelector<HTMLElement>('.room-member-heading .monaco-button')!.click();
		await opened.p;
		assert.deepStrictEqual({ beforeStart, resolutions }, {
			beforeStart: 'true', resolutions: [{ session: 'copilotcli:/member-1', chat: URI.parse('opaque-chat:/provisioned/primary?version=3').toString() }],
		});
	});

	test('rendering, resizing, incoming state, and inbox filtering create no sessions or turns', async () => {
		const { widget, facade, starts, getSends, resolutions, created } = setup('created', 1);
		widget.layout(800, 600);
		facade.activeRoom.set({ ...facade.activeRoom.get()!, revision: 2 }, undefined);
		await facade.selectInbox('member-1');
		await facade.selectInbox(undefined);
		assert.deepStrictEqual({
			starts, sends: getSends(), resolutions, created: created.isSettled,
		}, { starts: [], sends: 0, resolutions: [], created: false });
	});

	test('a late peer resolution cannot reopen a disposed room surface', async () => {
		const { container, opened, provider, widget, peerSession, peerChat } = setup();
		const pending = new DeferredPromise<{ session: ISession; chat: IChat }>();
		provider.resolveSessionChat = () => pending.p;
		container.querySelector<HTMLElement>('.room-member-heading .monaco-button')!.click();
		widget.dispose();
		await pending.complete({ session: peerSession, chat: peerChat });
		await timeout(0);
		assert.strictEqual(opened.isSettled, false);
	});

	test('artifact review reveals and focuses the editor while preserving Back to Room identity', async () => {
		const { container, facade, viewService, artifactFocused } = setup('running', 1);
		facade.activeRoom.set({
			...facade.activeRoom.get()!,
			artifacts: [{ id: 'patch', memberId: 'member-1', title: 'Review', createdAt: 0, baseRevision: 'base', sourceRevision: 'source', uri: 'file:///patch' }],
		}, undefined);
		const page = facade.messages.get();
		facade.messages.set({
			...page,
			messages: page.messages.map(message => ({ ...message, id: 'artifact-post', kind: 'artifact' as const, artifactId: 'patch' })),
		}, undefined);
		const review = [...container.querySelectorAll<HTMLElement>('.room-message [role="button"]')].find(button => button.textContent === 'Review Published Artifact')!;
		review.click();
		await artifactFocused.p;
		assert.strictEqual(viewService.visible.get(), false);
		assert.strictEqual(facade.activeRoomId.get(), 'room');
	});

	test('draft acknowledgements update a recreated room surface reactively', () => {
		const first = setup();
		first.type('Pending advice');
		const pending = first.draft.beginSend('saved-post');
		first.widget.dispose();
		const second = setup('running', 0, false, first.draft);
		assert.strictEqual(second.input.value, 'Pending advice');
		first.draft.acknowledge(pending.revision);
		assert.strictEqual(second.input.value, '');
		first.draft.update('A later edit', 'post-1');
		assert.strictEqual(second.input.value, 'A later edit');
	});

	test('room switches restore the original draft, audience, and scroll anchor without stealing composer focus', () => {
		const { facade, input, type, draft, historyKey, getMessageList, starts } = setup('running', 20);
		const first = facade.activeRoom.get()!;
		const firstPage = facade.messages.get();
		draft.update('Original note', undefined, { kind: 'member', memberId: 'member-1' });
		historyKey('Home');
		getMessageList().scrollTop = 37;
		const originalScroll = getMessageList().scrollTop;
		input.focus();
		transaction(tx => {
			facade.activeRoomId.set('second', tx);
			facade.activeRoom.set({ ...first, id: 'second' }, tx);
			facade.messages.set({ ...firstPage, messages: firstPage.messages.map(message => ({ ...message, id: `second-${message.id}` })) }, tx);
		});
		type('Second room draft');
		transaction(tx => {
			facade.activeRoomId.set(first.id, tx);
			facade.activeRoom.set(first, tx);
			facade.messages.set(firstPage, tx);
		});
		assert.deepStrictEqual({
			text: input.value, audience: draft.audience, secondDraft: facade.getDraft('second').text,
			scroll: getMessageList().scrollTop, focused: document.activeElement === input, starts,
		}, {
			text: 'Original note', audience: { kind: 'member', memberId: 'member-1' }, secondDraft: 'Second room draft',
			scroll: originalScroll, focused: true, starts: [],
		});
	});
	test('the home screen shows the creation card without transcript rows', () => {
		const { container, widget } = setup('created', 0, true);
		assert.deepStrictEqual({
			home: container.querySelector<HTMLElement>('.room-home')!.hidden,
			messages: container.querySelectorAll('.room-message').length,
			budgetHidden: container.querySelector<HTMLElement>('.room-budget-status')!.hidden,
			budgetText: container.querySelector('.room-budget-status')?.textContent,
			listsSavedRooms: widget.getAccessibleContent().includes('Saved room: Peer room.'),
		}, { home: false, messages: 0, budgetHidden: true, budgetText: '', listsSavedRooms: true });
	});

	test('a selected created room retains its budget status until returning to the home screen', async () => {
		const { container, facade } = setup('created', 0, true);
		const budget = container.querySelector<HTMLElement>('.room-budget-status')!;
		await facade.selectRoom('room');
		const selected = { hidden: budget.hidden, text: budget.textContent };
		await facade.selectRoom(undefined);
		assert.deepStrictEqual({
			selected, home: { hidden: budget.hidden, text: budget.textContent },
		}, {
			selected: { hidden: false, text: 'No run authorized. Choose a turn budget before Start.' },
			home: { hidden: true, text: '' },
		});
	});

	test('the empty folder field keeps usable width beside Browse at wide and narrow home sizes', () => {
		const { container, widget } = setup('created', 0, true);
		const row = container.querySelector<HTMLElement>('.room-home-row')!;
		const folder = row.querySelector<HTMLInputElement>('input')!;
		const browse = row.querySelector<HTMLElement>('.monaco-button')!;
		const sizes = [1100, 420].map(width => {
			container.style.width = `${width}px`;
			widget.layout(width, 760);
			const rowBounds = row.getBoundingClientRect();
			const fieldBounds = folder.getBoundingClientRect();
			const buttonBounds = browse.getBoundingClientRect();
			return {
				fieldGetsRemainingWidth: fieldBounds.width > rowBounds.width / 2,
				browseFitsLabel: buttonBounds.width < rowBounds.width / 2,
				noOverlap: fieldBounds.right <= buttonBounds.left,
			};
		});
		assert.deepStrictEqual({
			placeholder: folder.placeholder, value: folder.value, readOnly: folder.readOnly, sizes,
		}, {
			placeholder: 'Choose a folder', value: '', readOnly: true,
			sizes: [
				{ fieldGetsRemainingWidth: true, browseFitsLabel: true, noOverlap: true },
				{ fieldGetsRemainingWidth: true, browseFitsLabel: true, noOverlap: true },
			],
		});
	});

	test('returning to a new-room form does not require a saved scroll position', () => {
		const { container, facade } = setup();
		transaction(tx => {
			facade.activeRoomId.set(undefined, tx);
			facade.activeRoom.set(undefined, tx);
		});
		assert.strictEqual(container.querySelector<HTMLElement>('.room-home')!.hidden, false);
	});

	test('a creation still in progress disables a newly mounted form', () => {
		const { container, facade } = setup('created', 0, true);
		const create = container.querySelector<HTMLElement>('.room-home-actions .monaco-button')!;
		facade.creating.set(true, undefined);
		const disabled = create.getAttribute('aria-disabled');
		facade.creating.set(false, undefined);
		assert.deepStrictEqual([disabled, create.getAttribute('aria-disabled')], ['true', 'false']);
	});

	test('creation delegates goal, folder and peers to the host without a main-process Git lookup', async () => {
		const { container, created, starts } = setup('created', 0, true);
		const home = container.querySelector<HTMLElement>('.room-home')!;
		const textareas = home.querySelectorAll<HTMLTextAreaElement>('textarea');
		for (const [field, value] of [[textareas[0], 'Measure startup before changing code'], [textareas[1], 'Preserve public APIs']] as const) {
			field.value = value;
			field.dispatchEvent(new Event('input', { bubbles: true }));
		}
		const browse = [...home.querySelectorAll<HTMLElement>('.monaco-button')].find(button => button.textContent === 'Browse')!;
		const folderInput = home.querySelectorAll<HTMLInputElement>('input')[0];
		const selected = new DeferredPromise<void>();
		const observer = new MutationObserver(() => {
			if (folderInput.value === '/repo') {
				observer.disconnect();
				void selected.complete();
			}
		});
		disposables.add(toDisposable(() => observer.disconnect()));
		observer.observe(home, { attributes: true, subtree: true, attributeFilter: ['value'] });
		browse.click();
		await timeout(0);
		if (folderInput.value === '/repo') {
			observer.disconnect();
			void selected.complete();
		}
		await selected.p;
		const memberNames = [...home.querySelectorAll('.room-home-model-name')].map(element => element.textContent);
		[...home.querySelectorAll<HTMLElement>('.monaco-button')].find(button => button.textContent === 'Create Room')!.click();

		assert.deepStrictEqual({ options: await created.p, starts }, {
			options: {
				title: 'Measure startup before changing code', goal: 'Measure startup before changing code', instructions: 'Preserve public APIs',
				repositoryUri: 'file:///repo', workerCount: 3, initializeRepository: false,
				memberNames,
				memberModels: [undefined, undefined, undefined],
			},
			starts: [],
		});
	});

	test('arrow keys and Enter complete a named peer without sending', () => {
		const { input, type, key, draft, getSends } = setup();
		type('@Cop');
		assert.strictEqual(input.getAttribute('aria-expanded'), 'true');
		key('ArrowDown');
		key('Enter');
		assert.strictEqual(input.value, '@Copilot-2 ');
		assert.strictEqual(draft.text, '@Copilot-2 ');
		assert.strictEqual(input.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(getSends(), 0);
	});

	test('Shift+Enter remains a newline gesture and Escape dismisses suggestions', () => {
		const { input, type, key, getSends } = setup();
		type('Advice');
		assert.strictEqual(key('Enter', true).defaultPrevented, false);
		type('@Cop');
		assert.strictEqual(key('Escape').defaultPrevented, true);
		assert.strictEqual(input.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(getSends(), 0);
	});

	test('a moved cursor cannot accept a stale mention replacement', () => {
		const { input, type, key } = setup();
		type('Please @Cop');
		input.setSelectionRange(0, 0);
		key('Enter');
		assert.strictEqual(input.value, 'Please @Cop');
		assert.strictEqual(input.getAttribute('aria-expanded'), 'false');
	});

	test('Reply links to the original post while still addressing the whole room', () => {
		const { container, input, draft, viewService } = setup('running', 1);
		container.querySelector<HTMLElement>('.room-message [role="button"]')!.click();
		assert.strictEqual(draft.replyTo, 'post-0');
		assert.deepStrictEqual(draft.audience, { kind: 'all' });
		assert.strictEqual(input.value, '');
		assert.strictEqual(viewService.visible.get(), true);
	});

	test('Send uses the same ordinary inbox route for busy and idle peers', async () => {
		const { container, facade, type, sentMessages } = setup();
		type('Change direction');
		container.querySelector<HTMLElement>('.room-composer .room-send')!.click();
		await timeout(0);
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({ ...room, members: room.members.map(member => ({ ...member, state: 'idle' })) }, undefined);
		type('Another question');
		container.querySelector<HTMLElement>('.room-composer .room-send')!.click();
		assert.deepStrictEqual(sentMessages, [
			{ text: 'Change direction', audience: { kind: 'all' }, replyTo: undefined },
			{ text: 'Another question', audience: { kind: 'all' }, replyTo: undefined },
		]);
	});

	test('Control+Enter sends an ordinary message without inferring recipients from text', () => {
		const { input, type, sentMessages } = setup();
		type('@Copilot-1 Change direction');
		const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
		input.dispatchEvent(event);
		assert.deepStrictEqual({ prevented: event.defaultPrevented, sentMessages }, {
			prevented: true, sentMessages: [{ text: '@Copilot-1 Change direction', audience: { kind: 'all' }, replyTo: undefined }],
		});
	});

	test('the composer has no audience selector and clearly sends to all peers', () => {
		const { container, input } = setup();
		const send = container.querySelector<HTMLElement>('.room-send')!;
		assert.deepStrictEqual({
			selector: container.querySelector('.room-composer-audience'),
			label: send.textContent,
			placeholder: input.placeholder,
			accessible: input.getAttribute('aria-label')?.includes('all peers'),
		}, { selector: null, label: 'Send', placeholder: 'Message all peers', accessible: true });
	});

	for (const audience of [{ kind: 'note' }, { kind: 'member', memberId: 'member-1' }] as const) {
		test(`a restored ${audience.kind} draft cannot silently restrict room delivery`, async () => {
			const draft = new CollaborationDraft();
			draft.update('Focus on URI formatting', undefined, audience);
			const { container, sentMessages } = setup('stopped', 0, false, draft);
			container.querySelector<HTMLElement>('.room-send')!.click();
			await timeout(0);
			assert.deepStrictEqual(sentMessages, [{
				text: 'Focus on URI formatting', audience: { kind: 'all' }, replyTo: undefined,
			}]);
		});
	}

	test('hiding a human message preserves history and replies while removing it from both views', async () => {
		const { container, facade, widget, input, getSends, starts, viewService } = setup('running', 2);
		const original = facade.messages.get();
		const human: IAgentHostRoomMessage = {
			...original.messages[0], authorId: 'human', authorName: 'You', authorKind: 'human', text: 'My accidental room note',
		};
		const page = { ...original, messages: [human, { ...original.messages[1], replyTo: human.id }] };
		facade.messages.set(page, undefined);
		const message = container.querySelector<HTMLElement>(`[data-message-id="${human.id}"]`)!;
		const hide = [...message.querySelectorAll<HTMLElement>('.monaco-button')].find(button => button.textContent === 'Hide for Me')!;
		hide.focus();
		hide.click();
		await timeout(0);
		const hidden = {
			visible: [...container.querySelectorAll<HTMLElement>('.room-message')].map(message => message.dataset.messageId),
			accessible: widget.getAccessibleContent().includes(human.text),
			rawPage: facade.messages.get(),
			focused: document.activeElement === input,
			marker: viewService.hiddenMessages.get().get('room')?.has(human.id),
		};
		const restore = [...container.querySelectorAll<HTMLElement>('.room-history-controls .monaco-button')].find(button => button.textContent === 'Show Hidden Messages')!;
		restore.click();
		await timeout(0);
		assert.deepStrictEqual({
			hidden, restored: widget.getAccessibleContent().includes(human.text), rawPage: facade.messages.get(), starts, sends: getSends(),
		}, {
			hidden: { visible: ['post-1'], accessible: false, rawPage: page, focused: true, marker: true },
			restored: true, rawPage: page, starts: [], sends: 0,
		});
	});

	test('hiding the last visible post leaves restoration available without inventing new posts', async () => {
		const { container, facade, widget } = setup('running', 1);
		const page = facade.messages.get();
		const message: IAgentHostRoomMessage = { ...page.messages[0], authorId: 'human', authorName: 'You', authorKind: 'human', text: 'Hide only this note' };
		facade.messages.set({ ...page, messages: [message] }, undefined);
		[...container.querySelectorAll<HTMLElement>('.room-message .monaco-button')].find(button => button.textContent === 'Hide for Me')!.click();
		await timeout(0);
		const controls = container.querySelector<HTMLElement>('.room-history-controls')!;
		const restore = [...controls.querySelectorAll<HTMLElement>('.monaco-button')].find(button => button.textContent === 'Show Hidden Messages')!;
		assert.deepStrictEqual({
			count: container.querySelectorAll('.room-message').length,
			controlsHidden: controls.hidden, restoreHidden: restore.hidden,
			phantomPosts: controls.textContent?.includes('New Posts'),
			accessible: widget.getAccessibleContent().includes(message.text),
		}, { count: 0, controlsHidden: false, restoreHidden: false, phantomPosts: false, accessible: false });
	});

	test('room-start events can be hidden without cancelling their queued delivery', async () => {
		const { container, facade, widget, getSends, starts } = setup('stopped', 1);
		const page = facade.messages.get();
		const event: IAgentHostRoomMessage = {
			...page.messages[0], authorId: 'system', authorName: 'Room Start', authorKind: 'system', kind: 'system',
			text: 'Begin work on the shared goal.', mentions: ['member-1'], deliveries: [{ memberId: 'member-1', state: 'pending' }],
		};
		const original = { ...page, messages: [event] };
		facade.messages.set(original, undefined);
		[...container.querySelectorAll<HTMLElement>('.room-message .monaco-button')].find(button => button.textContent === 'Hide for Me')!.click();
		await timeout(0);
		assert.deepStrictEqual({
			rows: container.querySelectorAll('.room-message').length,
			accessible: widget.getAccessibleContent().includes(event.text),
			journal: facade.messages.get(), starts, sends: getSends(),
		}, { rows: 0, accessible: false, journal: original, starts: [], sends: 0 });
	});

	test('Ask for Summary uses an existing chosen peer without opening or creating a chat', async () => {
		const { container, summaries, starts, resolutions, created, type, draft } = setup();
		type('Keep my draft');
		[...container.querySelectorAll<HTMLElement>('.room-history-filter .monaco-button')].find(button => button.textContent === 'Ask for Summary')!.click();
		await timeout(0);
		assert.deepStrictEqual({
			summaries, starts, resolutions, created: created.isSettled, draft: draft.text,
		}, { summaries: ['member-2'], starts: [], resolutions: [], created: false, draft: 'Keep my draft' });
	});

	test('an unsupported inbox host disables all sending controls', () => {
		const { facade, container, type, getSends } = setup();
		type('Do not fall back to a raw turn');
		facade.canSend.set(false, undefined);
		const send = container.querySelector<HTMLElement>('.room-send')!;
		send.click();
		assert.deepStrictEqual({
			input: container.querySelector<HTMLTextAreaElement>('.room-composer textarea')!.disabled,
			send: send.getAttribute('aria-disabled'),
			audience: container.querySelector('.room-composer-audience'),
			sends: getSends(),
		}, { input: true, send: 'true', audience: null, sends: 0 });
	});

	test('sending while reading older posts resumes following the latest conversation', async () => {
		const { container, facade, viewService, type, input, historyKey } = setup('running', 20);
		historyKey('Home');
		assert.strictEqual(viewService.scrollState.get()?.followingLatest, false);
		const acknowledged = new DeferredPromise<void>();
		facade.sendMessage = () => acknowledged.p;
		type('Advice from older history');
		container.querySelector<HTMLElement>('.room-composer .room-send')!.click();
		await acknowledged.complete();
		await acknowledged.p;
		assert.deepStrictEqual({
			followingLatest: viewService.scrollState.get()?.followingLatest,
			lastPostVisible: container.querySelector('.room-feed')?.textContent?.includes('Shared post 19'),
			text: input.value,
		}, { followingLatest: true, lastPostVisible: true, text: 'Advice from older history' });
	});

	test('new peer work reports remain in the chat while the reader stays above the latest post', () => {
		const { container, facade, widget, historyKey, viewService } = setup('running', 20);
		const feed = container.querySelector<HTMLElement>('.room-feed')!;
		historyKey('Home');
		const anchor = viewService.scrollState.get();
		const page = facade.messages.get();
		facade.messages.set({
			...page, messages: [...page.messages, {
				id: 'new-work-report', sequence: 21, authorId: 'member-1', authorName: 'Copilot-1', authorKind: 'agent',
				kind: 'finding', text: 'Finished accessibility improvements and verified the tests.', timestamp: 0, mentions: [], deliveries: [],
			}],
		}, undefined);
		const latest = [...container.querySelectorAll<HTMLElement>('.room-history-controls .monaco-button')].find(button => button.textContent === 'Jump to Latest')!;
		assert.deepStrictEqual({
			reportLoaded: widget.getAccessibleContent().includes('Finished accessibility improvements'),
			firstPostVisible: feed.textContent?.includes('Shared post 0'),
			anchorUnchanged: viewService.scrollState.get() === anchor,
			jumpAvailable: !latest.hidden && latest.getAttribute('aria-disabled') !== 'true',
		}, { reportLoaded: true, firstPostVisible: true, anchorUnchanged: true, jumpAvailable: true });
	});

	test('findings and independent peer review retain text, reply links, and immutable patch navigation', () => {
		const { container, facade, widget } = setup();
		facade.activeRoom.set({
			...facade.activeRoom.get()!,
			artifacts: [{ id: 'patch-one', memberId: 'member-1', title: 'Parser patch', createdAt: 0, baseRevision: 'base', sourceRevision: 'source', uri: 'file:///patch' }],
		}, undefined);
		facade.messages.set({
			hasEarlier: false,
			hasLater: false,
			messages: [{
				id: 'finding-one', sequence: 1, authorId: 'member-1', authorName: 'Copilot-1', authorKind: 'agent',
				kind: 'finding', text: 'Parser result: focused parser tests passed.', timestamp: 0, mentions: ['member-2'],
				deliveries: [{ memberId: 'member-2', state: 'submitted' }], artifactIds: ['patch-one'],
			}, {
				id: 'review-one', sequence: 2, authorId: 'member-2', authorName: 'Copilot-2', authorKind: 'agent',
				kind: 'finding', text: 'Repeated the focused test.', timestamp: 1, mentions: ['member-1'], deliveries: [],
				replyTo: 'finding-one',
			}],
		}, undefined);
		const buttons = [...container.querySelectorAll<HTMLElement>('.room-message-actions [role="button"]')]
			.map(button => button.textContent)
			.filter(label => label !== 'Reply');
		const accessible = widget.getAccessibleContent();
		assert.deepStrictEqual({
			legacyCards: container.querySelectorAll('.room-result, .room-verification, .room-assignment').length,
			buttons,
			accessible: [
				accessible.includes('Parser result'),
				accessible.includes('focused parser tests passed.'),
				accessible.includes('Repeated the focused test.'),
			],
		}, {
			legacyCards: 0,
			buttons: ['Review Patch: Parser patch', 'Show Original'],
			accessible: [true, true, true],
		});
	});

	test('labels, ARIA, and tooltips distinguish queued, reserved, and native-submitted transport', () => {
		const { container, facade, widget, hovers } = setup();
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({
			...room,
			members: [...room.members, { ...room.members[0], id: 'member-3', name: 'Copilot-3', sessionUri: 'copilotcli:/member-3' }],
		}, undefined);
		facade.messages.set({
			hasEarlier: false,
			hasLater: false,
			messages: [{
				id: 'message-one', sequence: 1, authorId: 'human', authorName: 'You', authorKind: 'human',
				kind: 'message', text: 'Review the parser together.', timestamp: 0,
				mentions: ['member-1', 'member-2', 'member-3'], deliveries: [
					{ memberId: 'member-1', state: 'pending' },
					{ memberId: 'member-2', state: 'reserved', turnId: 'reserved-turn' },
					{ memberId: 'member-3', state: 'submitted' },
				],
			}],
		}, undefined);
		const metadata = container.querySelector<HTMLElement>('.room-message .detail')!;
		const tooltip = hovers.get(metadata);
		const aria = container.querySelector('.room-feed .monaco-list-row')?.getAttribute('aria-label');
		assert.deepStrictEqual({
			queued: metadata.textContent?.includes('Copilot-1: Queued'),
			reserved: metadata.textContent?.includes('Copilot-2: Reserved'),
			submitted: metadata.textContent?.includes('Copilot-3: Submitted to native host'),
			accessible: widget.getAccessibleContent().includes('To: Copilot-1, Copilot-2, Copilot-3'),
			ariaReserved: aria?.includes('immutable input batch are durably assigned'),
			ariaSubmission: aria?.includes('does not confirm provider acceptance or task completion'),
			tooltipReserved: tooltip?.includes('This is not delivered input'),
			tooltipSubmission: tooltip?.includes('Handed to the native host path'),
			descriptionMatchesTooltip: metadata.getAttribute('aria-description') === tooltip,
			completed: widget.getAccessibleContent().includes('Completed'),
			retryOffered: container.querySelector('.room-message-actions')?.textContent?.includes('Retry Delivery'),
		}, {
			queued: true, reserved: true, submitted: true, accessible: true, ariaReserved: true, ariaSubmission: true,
			tooltipReserved: true, tooltipSubmission: true, descriptionMatchesTooltip: true, completed: false, retryOffered: false,
		});
	});

	test('reserved inbox messages remain counted while their batch consumes only the host-admitted budget', async () => {
		const { facade, container, getMessageList, getSends, starts } = setup();
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({
			...room, run: { ...room.run!, admittedTurns: 1 },
			members: [{ ...room.members[0], state: 'starting', turns: 1 }],
		}, undefined);
		facade.messages.set({
			hasEarlier: false, hasLater: false,
			messages: [1, 2].map((sequence): IAgentHostRoomMessage => ({
				id: `reserved-${sequence}`, sequence, authorId: 'human', authorName: 'You', authorKind: 'human', kind: 'message',
				text: `Inbox message ${sequence}`, timestamp: sequence, mentions: ['member-1'],
				deliveries: [{ memberId: 'member-1', state: 'reserved', turnId: 'one-reserved-batch' }],
			})),
		}, undefined);
		await facade.selectInbox('member-1');
		assert.deepStrictEqual({
			inboxMessages: getMessageList().length,
			remaining: container.querySelector('.room-budget-status')?.textContent,
			receiptStates: facade.messages.get().messages.flatMap(message => message.deliveries.map(delivery => delivery.state)),
			retryOffered: [...container.querySelectorAll('.room-message-actions')].some(actions => actions.textContent?.includes('Retry Delivery')),
			starts, sends: getSends(),
		}, {
			inboxMessages: 2, remaining: '9 turns remaining of 10', receiptStates: ['reserved', 'reserved'], retryOffered: false, starts: [], sends: 0,
		});
	});

	test('legacy context-only human posts retain their original undelivered status', () => {
		const { container, facade, widget } = setup();
		facade.messages.set({
			hasEarlier: false, hasLater: false,
			messages: [{
				id: 'human-post', sequence: 1, authorId: 'human', authorKind: 'human', authorName: 'You',
				kind: 'message', text: 'Any updates?', timestamp: 0, mentions: [], deliveries: [],
			}],
		}, undefined);
		const explanation = 'Room note - no agents notified';
		assert.deepStrictEqual({
			visible: container.querySelector('.room-message .detail')?.textContent?.includes(explanation),
			accessible: widget.getAccessibleContent().includes(explanation),
		}, { visible: true, accessible: true });
	});

	test('Send requests resumption through the host without a separate Start call or budget extension', async () => {
		const { container, type, starts, extensions, sentMessages } = setup('stopped');
		type('Please review now');
		const send = container.querySelector<HTMLElement>('.room-composer .room-send')!;
		send.click();
		await timeout(0);
		assert.deepStrictEqual({
			enabled: send.getAttribute('aria-disabled') !== 'true',
			resumeExplained: container.querySelector('.room-delivery-hint')?.textContent?.includes('Send starts or resumes'),
			starts, extensions, sentMessages,
		}, { enabled: true, resumeExplained: true, starts: [], extensions: [], sentMessages: [{ text: 'Please review now', audience: { kind: 'all' }, replyTo: undefined }] });
	});

	test('Start requires an explicitly chosen finite turn budget', async () => {
		const { container, starts, setBudget } = setup('created');
		const start = container.querySelector<HTMLElement>('.room-start')!;
		for (const invalid of ['', '0', '-1', '1.5']) {
			setBudget(invalid);
			start.click();
		}
		const before = [...starts];
		setBudget('7');
		start.click();
		await timeout(0);
		assert.deepStrictEqual({
			before, starts, budgetField: !!container.querySelector('.room-budget-field input'),
		}, { before: [], starts: [{ maxTurns: 7 }], budgetField: true });
	});

	test('budget exhaustion exposes Extend and never lets Resume replenish turns', async () => {
		const { facade, container, starts, extensions, setBudget } = setup('paused');
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({ ...room, pauseReason: 'budget', run: { ...room.run!, admittedTurns: 10 } }, undefined);
		const resume = container.querySelector<HTMLElement>('.room-start')!;
		const extend = container.querySelector<HTMLElement>('.room-extend')!;
		const before = { resumeHidden: resume.hidden, extendDisabled: extend.getAttribute('aria-disabled') };
		setBudget('4');
		extend.click();
		await timeout(0);
		assert.deepStrictEqual({
			before, starts, extensions, remaining: container.querySelector('.room-budget-status')?.textContent,
		}, {
			before: { resumeHidden: true, extendDisabled: 'true' }, starts: [], extensions: [4], remaining: '0 turns remaining of 10',
		});
	});

	test('an idle room supports both Resume and Pause', () => {
		const { container, starts } = setup('idle');
		const resume = container.querySelector<HTMLElement>('.room-start')!;
		const pause = [...container.querySelectorAll<HTMLElement>('.room-run-controls-host .monaco-button')].find(button => button.textContent === 'Pause')!;
		assert.strictEqual(resume.textContent, 'Resume');
		assert.strictEqual(resume.getAttribute('aria-disabled'), 'false');
		assert.strictEqual(pause.getAttribute('aria-disabled'), 'false');
		resume.click();
		assert.deepStrictEqual(starts, [{}]);
	});

	test('history has bounded DOM without discarding loaded accessible messages', () => {
		const { container, widget } = setup('running', 500);
		assert.ok(container.querySelectorAll('.room-message').length < 40);
		assert.ok(widget.getAccessibleContent().includes('Shared post 0\n'));
		assert.ok(widget.getAccessibleContent().includes('Shared post 499'));
	});

	test('long message text wraps and reflows instead of inheriting the list row no-wrap style', () => {
		const { container, facade, widget } = setup('running', 1);
		const message = facade.messages.get().messages[0];
		facade.messages.set({
			messages: [{ ...message, text: 'This is a long paragraph that must remain readable in the conversation. '.repeat(30) }],
			hasEarlier: false, hasLater: false,
		}, undefined);
		const row = container.querySelector<HTMLElement>('.room-message')!;
		const content = row.querySelector<HTMLElement>('.chat-markdown-part > div')!;
		const range = document.createRange();
		range.selectNodeContents(content);
		const wrappedLines = range.getClientRects().length;
		container.style.width = '520px';
		widget.layout(520, 760);
		const narrowHeight = row.offsetHeight;
		container.style.width = '1100px';
		widget.layout(1100, 760);
		assert.ok(wrappedLines > 3, `Expected wrapped text, got ${wrappedLines} line boxes`);
		assert.ok(row.offsetHeight < narrowHeight, 'A wider conversation should reduce the wrapped message height');
	});

	test('prepending scrollback preserves the visible message and its pixel offset', () => {
		const { facade, historyKey, getMessageList, viewService } = setup('running', 20);
		const initial = facade.messages.get().messages.map(message => ({ ...message, id: `message-${message.sequence + 100}`, sequence: message.sequence + 100 }));
		facade.messages.set({ messages: initial, hasEarlier: true, hasLater: false }, undefined);
		historyKey('Home');
		const list = getMessageList();
		list.scrollTop = 20;
		const anchor = list.element(list.firstVisibleIndex);
		const offset = list.scrollTop - list.getElementTop(list.firstVisibleIndex);
		const earlier = Array.from({ length: 100 }, (_, index) => ({ ...initial[0], id: `message-${index + 1}`, sequence: index + 1 }));
		facade.messages.set({ messages: [...earlier, ...initial], hasEarlier: false, hasLater: false }, undefined);
		assert.deepStrictEqual({
			anchor: list.element(list.firstVisibleIndex),
			offset: list.scrollTop - list.getElementTop(list.firstVisibleIndex),
			followingLatest: viewService.scrollState.get()?.followingLatest,
		}, { anchor, offset, followingLatest: false });
	});

	test('scrolling near the beginning loads earlier history once while a page is pending', () => {
		const { facade, historyKey, getMessageList } = setup('running', 20);
		let loads = 0;
		facade.loadEarlierMessages = async () => {
			loads++;
			facade.loadingEarlier.set(true, undefined);
		};
		facade.messages.set({ ...facade.messages.get(), hasEarlier: true }, undefined);
		historyKey('Home');
		getMessageList().scrollTop = 20;
		assert.strictEqual(loads, 1);
	});

	test('the room has one conversation and publishes peer settings to the side panel', () => {
		const { container, panel } = setup('running', 1);
		const main = container.querySelector<HTMLElement>('.room-main')!;
		const mainTabs = [...main.querySelectorAll<HTMLElement>('.room-main-tabs .room-tab')];
		assert.deepStrictEqual({
			mainTabs: mainTabs.map(tab => tab.textContent),
			mainHasChat: !!main.querySelector('.room-feed'),
			mainHasComposer: !!main.querySelector('.room-composer'),
			mainHasRoster: !!main.querySelector('.room-roster'),
			panelInRoom: container.querySelector('.room-layout')!.contains(panel),
			panelHasRoster: !!panel.querySelector('.room-roster'),
			modelPickers: panel.querySelectorAll('.room-roster .room-model-picker').length,
			oldPaging: [...container.querySelectorAll('button')].some(button => ['Older Posts', 'Newer Posts'].includes(button.textContent ?? '')),
		}, {
			mainTabs: [],
			mainHasChat: true,
			mainHasComposer: true,
			mainHasRoster: false,
			panelInRoom: false,
			panelHasRoster: true,
			modelPickers: 2,
			oldPaging: false,
		});
	});

	test('inbox filters retain drafts and receipts without changing the composer audience', async () => {
		const { container, facade, input, type, draft, chooseMenuItem, getSends, starts } = setup('running', 3);
		const messages = facade.messages.get().messages.map((message, index) => ({
			...message, mentions: [`member-${index % 2 + 1}`], deliveries: [{ memberId: `member-${index % 2 + 1}`, state: 'pending' as const }],
		}));
		facade.messages.set({ messages, hasEarlier: false, hasLater: false }, undefined);
		type('Preserve this draft');
		await chooseMenuItem('.room-history-filter .monaco-button', 'Inbox: Copilot-2');
		const filtered = facade.messages.get().messages.map(message => message.id);
		const focusPreserved = document.activeElement === container.querySelector('.room-history-filter .monaco-button');
		await chooseMenuItem('.room-history-filter .monaco-button', 'All Messages');
		assert.deepStrictEqual({
			filtered, focusPreserved, restored: facade.messages.get().messages === messages,
			text: input.value, audience: draft.audience,
			receipts: messages.flatMap(message => message.deliveries.map(delivery => delivery.state)), sends: getSends(), starts,
		}, {
			filtered: ['post-1'], focusPreserved: true, restored: true, text: 'Preserve this draft',
			audience: { kind: 'all' }, receipts: ['pending', 'pending', 'pending'], sends: 0, starts: [],
		});
	});

	test('panel tab badges preserve keyboard focus on unrelated updates', () => {
		const { panel, facade } = setup();
		const agents = [...panel.querySelectorAll<HTMLElement>('.room-tab')].find(tab => tab.textContent === 'Agents')!;
		agents.click();
		agents.focus();
		facade.requests.set([approval()], undefined);
		const updated = [...panel.querySelectorAll<HTMLElement>('.room-tab')].find(tab => tab.textContent === 'Agents')!;
		assert.deepStrictEqual({
			focused: document.activeElement === updated, selected: updated.getAttribute('aria-selected'),
			approvals: [...panel.querySelectorAll<HTMLElement>('.room-tab')].find(tab => tab.textContent?.startsWith('Approvals'))?.textContent,
		}, { focused: true, selected: 'true', approvals: 'Approvals1' });
	});

	test('archives project plain text and disable writes while keeping native session and artifact inspection', async () => {
		const { container, facade, starts, extensions, opened, widget, getSends, type } = setup('stopped', 1);
		type('Keep my draft');
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({
			...room, archived: true,
			archivedSessions: room.members.map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
			artifacts: [{ id: 'patch', title: 'Preserved patch', memberId: 'member-1', baseRevision: 'base', sourceRevision: 'source', createdAt: 0, uri: 'file:///patch' }],
		}, undefined);
		facade.messages.set({
			messages: [{ ...facade.messages.get().messages[0], text: '<b>Historical result</b>', artifactIds: ['patch'] }],
			hasEarlier: false, hasLater: false,
		}, undefined);
		facade.requests.set([approval()], undefined);
		const send = container.querySelector<HTMLElement>('.room-send')!;
		const add = container.querySelector<HTMLElement>('.room-add-member')!;
		send.click();
		const snapshot = {
			archiveLabel: container.querySelector('.room-subtitle')?.textContent?.includes('Archive - read-only'),
			readOnly: container.querySelector<HTMLTextAreaElement>('.room-composer textarea')!.disabled,
			disabled: [send, add, container.querySelector<HTMLElement>('.room-start')!, container.querySelector<HTMLElement>('.room-extend')!].every(button => button.getAttribute('aria-disabled') === 'true'),
			plain: container.querySelector('.room-message-plain')?.textContent,
			noHtml: container.querySelector('.room-message-plain b') === null,
			patchLink: container.querySelector('.room-message-actions')?.textContent?.includes('Review Patch: Preserved patch'),
			approvals: container.querySelectorAll('.room-request').length,
			accessible: widget.getAccessibleContent().includes('<b>Historical result</b>'),
			starts, extensions, sends: getSends(),
		};
		container.querySelector<HTMLElement>('.room-member-heading .monaco-button')!.click();
		await opened.p;
		assert.deepStrictEqual(snapshot, {
			archiveLabel: true, readOnly: true, disabled: true, plain: '<b>Historical result</b>', noHtml: true, patchLink: true,
			approvals: 0, accessible: true, starts: [], extensions: [], sends: 0,
		});
	});

	test('historical nonworkers have inspect-only author and session links without joining the worker roster', async () => {
		const { container, facade, opened, starts, resolutions, created, getSends, widget } = setup('stopped');
		const room = facade.activeRoom.get()!;
		const historical = {
			id: 'historical-participant', name: 'Historical participant', sessionUri: 'copilotcli:/historical',
			chatUri: 'opaque-chat:/historical/old?version=1', worktreeUri: 'file:///saved/historical-worktree',
		};
		const archive = {
			...room, archived: true,
			archivedSessions: [
				...room.members.map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
				historical,
			],
		};
		facade.activeRoom.set(archive, undefined);
		const diagnostic = 'Historical status "completed" does not establish provider acceptance or task completion.';
		facade.messages.set({
			hasEarlier: false, hasLater: false,
			messages: [{
				id: 'historical-post', sequence: 1, authorId: historical.id, authorName: historical.name, authorKind: 'agent',
				kind: 'message', text: 'Historical assignment and result metadata are preserved as text.', timestamp: 0,
				mentions: ['member-1'], deliveries: [{ memberId: 'member-1', state: 'interrupted', error: diagnostic }],
			}, {
				id: 'historical-reply', sequence: 2, authorId: 'member-1', authorName: 'Copilot-1', authorKind: 'agent',
				kind: 'message', text: 'Historical review evidence.', timestamp: 1, replyTo: 'historical-post',
				mentions: [historical.id], deliveries: [{ memberId: historical.id, state: 'interrupted', error: diagnostic }],
			}],
		}, undefined);
		const authorSelector = '.room-message[data-message-id="historical-post"] .username .monaco-link';
		container.querySelector<HTMLElement>(authorSelector)!.focus();
		const updatedChat = 'opaque-chat:/historical/preserved?version=2';
		facade.activeRoom.set({
			...archive, revision: archive.revision + 1,
			archivedSessions: archive.archivedSessions.map(session => session.id === historical.id ? { ...session, chatUri: updatedChat } : session),
		}, undefined);
		const author = container.querySelector<HTMLElement>(authorSelector)!;
		const extra = container.querySelector<HTMLElement>('.room-archive-session')!;
		const before = {
			workers: container.querySelectorAll('.room-roster .room-member').length,
			historicalRows: container.querySelectorAll('.room-archive-session').length,
			historicalTurns: extra.querySelector('.room-member-state'),
			worktree: extra.textContent?.includes(historical.worktreeUri),
			focusedAuthor: document.activeElement === author,
			nativeCalls: resolutions.length, starts: starts.length, created: created.isSettled, sends: getSends(),
			diagnostic: widget.getAccessibleContent().includes(`Historical participant: Interrupted (${diagnostic})`),
			recipient: container.querySelector('.room-message[data-message-id="historical-reply"] .detail')?.textContent?.includes('To: Historical participant'),
		};
		author.click();
		await opened.p;
		assert.deepStrictEqual({ before, resolutions }, {
			before: {
				workers: 2, historicalRows: 1, historicalTurns: null, worktree: true, focusedAuthor: true,
				nativeCalls: 0, starts: 0, created: false, sends: 0, diagnostic: true, recipient: true,
			},
			resolutions: [{ session: historical.sessionUri, chat: URI.parse(updatedChat).toString() }],
		});
	});

	test('archived worker navigation uses archive session identities even when the worker has no turns', async () => {
		const { container, facade, opened, resolutions } = setup('stopped');
		const room = facade.activeRoom.get()!;
		const saved = {
			id: 'member-1', name: 'Preserved worker', sessionUri: 'copilotcli:/preserved-worker',
			chatUri: 'opaque-chat:/preserved-worker/primary?version=2', worktreeUri: 'file:///saved/worker',
		};
		facade.activeRoom.set({
			...room, archived: true,
			members: room.members.map(member => ({ ...member, state: 'stopped', turns: 0 })),
			archivedSessions: [
				saved,
				...room.members.filter(member => member.id !== saved.id).map(({ id, name, sessionUri, chatUri, worktreeUri }) => ({ id, name, sessionUri, chatUri, worktreeUri })),
			],
		}, undefined);
		const link = container.querySelector<HTMLElement>('.room-roster .room-member-heading .monaco-button')!;
		link.click();
		await opened.p;
		assert.deepStrictEqual({
			label: link.textContent, resolutions, duplicateRows: container.querySelectorAll('.room-archive-session').length,
		}, {
			label: 'Preserved worker', resolutions: [{ session: saved.sessionUri, chat: URI.parse(saved.chatUri).toString() }], duplicateRows: 0,
		});
	});

	test('missing archive references never synthesize native session links from workers', () => {
		const { facade, container, resolutions } = setup('stopped', 1);
		facade.activeRoom.set({ ...facade.activeRoom.get()!, archived: true, archivedSessions: [] }, undefined);
		const worker = container.querySelector<HTMLElement>('.room-member-heading .monaco-button')!;
		worker.click();
		assert.deepStrictEqual({
			disabled: worker.getAttribute('aria-disabled'),
			authorLinks: container.querySelectorAll('.room-message .username .monaco-link').length,
			resolutions,
		}, { disabled: 'true', authorLinks: 0, resolutions: [] });
	});

	test('the attention action opens the side panel and focuses the failed peer', async () => {
		const { container, panel, facade, openedContainers } = setup();
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({
			...room, members: room.members.map((member, index) => index === 0 ? { ...member, state: 'failed', error: 'Could not prepare the worktree' } : member),
		}, undefined);
		const attention = [...panel.querySelectorAll<HTMLElement>('.room-run-controls-host .monaco-button')].find(button => button.textContent === 'Needs Attention (1)')!;
		attention.click();
		await timeout(0);
		assert.deepStrictEqual({
			openedContainers,
			focusedAction: document.activeElement?.getAttribute('aria-label'),
			settingsButtonInRoom: !!container.querySelector('.room-header .monaco-button[aria-controls]'),
		}, {
			openedContainers: ['workbench.view.collaborationSettings'],
			focusedAction: 'Retry Copilot-1',
			settingsButtonInRoom: true,
		});
	});

	test('pending model failures remain visible and the attention action focuses the model without opening a peer', async () => {
		const { container, facade, opened } = setup();
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({
			...room, members: room.members.map((member, index) => index === 0 ? {
				...member, model: 'model-b', modelSelection: { id: 'model-a' }, pendingModel: { id: 'model-b' }, modelError: 'Model B is unavailable',
			} : member),
		}, undefined);
		await timeout(0);
		[...container.querySelectorAll<HTMLElement>('.room-run-controls-host .monaco-button')].find(button => button.textContent === 'Needs Attention (1)')!.click();
		await timeout(0);
		assert.deepStrictEqual({
			detail: container.querySelector('.room-roster .room-model-detail.error')?.textContent,
			focus: document.activeElement?.getAttribute('aria-label'),
			peerOpened: opened.isSettled,
		}, {
			detail: 'Model B is unavailable Applies on the next turn. Currently using Model A.',
			focus: 'Model for Copilot-1', peerOpened: false,
		});
	});

	test('model drafts stay with their named slots when the peer count changes', async () => {
		const draft: ICollaborationRoomCreationDraft = {
			title: 'Mixed models', goal: 'Review the design', instructions: '', repositoryUri: 'file:///repo',
			baseRevision: 'HEAD', workerCount: '3', model: '',
			memberNames: ['chaotic-cyborg', 'disciplined-neuron', 'caffeinated-compiler'],
			memberModels: [{ id: 'model-a' }, undefined, { id: 'model-b' }],
		};
		const { container, viewService, starts, created } = setup('created', 0, true, undefined, draft);
		const select = container.querySelector<HTMLSelectElement>('.room-home-count select')!;
		for (const value of ['1', '3']) {
			select.value = value;
			select.dispatchEvent(new Event('change', { bubbles: true }));
		}
		const visibleNames = [...container.querySelectorAll('.room-home-model-name')].map(element => element.textContent);
		[...container.querySelectorAll<HTMLElement>('.room-home .monaco-button')].find(button => button.textContent === 'Create Room')!.click();
		assert.deepStrictEqual({
			visibleNames,
			draftNames: viewService.creationDraft.get()?.memberNames,
			draftModels: viewService.creationDraft.get()?.memberModels,
			createdNames: (await created.p).memberNames,
			createdModels: (await created.p).memberModels,
			starts,
		}, {
			visibleNames: draft.memberNames, draftNames: draft.memberNames, draftModels: draft.memberModels,
			createdNames: draft.memberNames, createdModels: draft.memberModels, starts: [],
		});
	});

	test('new room drafts assign stable unique AI-themed names to peer slots', () => {
		const { container, viewService } = setup('created', 0, true);
		const select = container.querySelector<HTMLSelectElement>('.room-home-count select')!;
		const initial = [...container.querySelectorAll('.room-home-model-name')].map(element => element.textContent ?? '');
		for (const value of ['1', '3']) {
			select.value = value;
			select.dispatchEvent(new Event('change', { bubbles: true }));
		}
		const restored = [...container.querySelectorAll('.room-home-model-name')].map(element => element.textContent ?? '');
		assert.deepStrictEqual({
			count: initial.length,
			unique: new Set(initial).size,
			format: initial.every(name => /^[a-z]+-[a-z]+$/.test(name)),
			stable: restored,
			persisted: viewService.creationDraft.get()?.memberNames,
		}, { count: 3, unique: 3, format: true, stable: initial, persisted: initial });
	});

	test('reported work is not repeated in agent cards and authors have distinct stable accents', () => {
		const { container, facade } = setup('running', 2);
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({
			...room, members: room.members.map(member => ({ ...member, work: { description: 'Duplicate report', updatedAt: 0, blocked: false } })),
		}, undefined);
		const page = facade.messages.get();
		facade.messages.set({ ...page, messages: page.messages.map((message, index) => ({ ...message, authorId: `member-${index + 1}`, authorName: `Copilot-${index + 1}` })) }, undefined);
		const accents = [...container.querySelectorAll<HTMLElement>('.room-message .avatar')].map(avatar => avatar.style.background);
		assert.deepStrictEqual({
			repeatedReport: container.querySelector('.room-roster')?.textContent?.includes('Duplicate report'),
			distinctAuthors: new Set(accents).size,
		}, { repeatedReport: false, distinctAuthors: 2 });
	});

	test('Add Agent grows the roster, survives a stopped room, and withdraws at capacity', async () => {
		const { facade, panel } = setup('running', 1);
		const add = panel.querySelector<HTMLElement>('.room-add-member')!;
		const added: (ModelSelection | undefined)[] = [];
		facade.addMember = async model => { added.push(model); };
		const room = facade.activeRoom.get()!;

		add.click();
		await timeout(0);
		const whileRunning = { hidden: add.hidden, disabled: add.getAttribute('aria-disabled') === 'true' };

		facade.activeRoom.set({ ...room, members: Array.from({ length: MAX_ROOM_WORKERS }, (_, index) => ({ ...room.members[0], id: `m${index}`, name: `Copilot-${index + 1}` })) }, undefined);
		const atCapacity = { disabled: add.getAttribute('aria-disabled') === 'true', rosterSize: panel.querySelectorAll('.room-roster .room-member').length };

		// A stopped room can be resumed, so it can still gain a peer; a cancellation
		// in flight is the only state that withdraws the action.
		facade.activeRoom.set({ ...room, state: 'stopped' }, undefined);
		const whenStopped = { hidden: add.hidden, disabled: add.getAttribute('aria-disabled') === 'true' };
		facade.activeRoom.set({ ...room, state: 'stopping' }, undefined);

		assert.deepStrictEqual({
			calls: added.length,
			whileRunning,
			atCapacity,
			whenStopped,
			hiddenWhileStopping: add.hidden,
		}, {
			calls: 1,
			whileRunning: { hidden: false, disabled: false },
			atCapacity: { disabled: true, rosterSize: MAX_ROOM_WORKERS },
			whenStopped: { hidden: false, disabled: false },
			hiddenWhileStopping: true,
		});
	});

	test('removing a peer is confirmed, then drops it from the roster while its posts remain', async () => {
		const { facade, panel, container, confirmations } = setup('running', 1);
		const room = facade.activeRoom.get()!;
		const removed: string[] = [];
		facade.removeMember = async memberId => {
			removed.push(memberId);
			facade.activeRoom.set({ ...room, members: room.members.map(member => member.id === room.members[1].id ? { ...member, removed: true } : member) }, undefined);
		};
		const target = [...panel.querySelectorAll<HTMLElement>('.room-member')][1];
		target.querySelector<HTMLElement>('.room-member-actions .monaco-button:last-child')!.click();
		await timeout(0);

		assert.deepStrictEqual({
			confirmations,
			removed,
			roster: [...panel.querySelectorAll<HTMLElement>('.room-member')].map(m => (m.querySelector('.room-member-heading .monaco-button')?.textContent ?? '').trim()),
			postsRemain: !!container.querySelector('.room-message'),
			countsActiveOnly: container.querySelector('.room-subtitle')?.textContent?.includes('1 peers'),
		}, {
			confirmations: ['Remove Copilot-2 from this room?'],
			removed: [room.members[1].id],
			roster: ['Copilot-1'],
			postsRemain: true,
			countsActiveOnly: true,
		});
	});

	test('a peer offers Stop while it runs, and Resume once it has stopped', () => {
		const { facade, panel } = setup('running', 1);
		const room = facade.activeRoom.get()!;
		const labels = () => [...panel.querySelectorAll<HTMLElement>('.room-member')].map(member => [
			...member.querySelectorAll<HTMLElement>('.room-member-actions .monaco-button'),
		].filter(button => !button.hidden).map(button => (button.textContent ?? '').trim()));
		const withStates = (...states: string[]) => facade.activeRoom.set({
			...room, members: room.members.map((member, index) => ({ ...member, state: states[index] as typeof member.state })),
		}, undefined);

		withStates('working', 'stopped');
		const running = labels();
		withStates('failed', 'pending');
		const failedAndPending = labels();

		assert.deepStrictEqual({ running, failedAndPending }, {
			running: [['Stop', 'Remove'], ['Resume', 'Remove']],
			failedAndPending: [['Retry', 'Remove'], ['Stop', 'Remove']],
		});
	});

	test('the run tab offers only the actions the room state allows', () => {
		const { facade, panel } = setup('running', 1);
		const labels = () => [...panel.querySelectorAll<HTMLElement>('.room-run-controls-host .monaco-button')]
			.filter(button => !button.hidden).map(button => (button.textContent ?? '').trim());
		const room = facade.activeRoom.get()!;
		facade.activeRoom.set({ ...room, state: 'running' }, undefined);
		const whileRunning = labels();
		facade.activeRoom.set({ ...room, state: 'created', run: undefined }, undefined);
		assert.deepStrictEqual(
			{ whileRunning, beforeStarting: labels() },
			{ whileRunning: ['Extend', 'Pause', 'Stop All'], beforeStarting: ['Start'] });
	});

	test('the panel keeps four tabs however many agents the room has', () => {
		const { facade, panel } = setup('running', 1);
		const labels = () => [...panel.querySelectorAll<HTMLElement>('.room-tab')].map(tab => tab.textContent);
		const before = labels();
		facade.requests.set([approval()], undefined);
		const approvals = [...panel.querySelectorAll<HTMLElement>('.room-tab')].find(tab => tab.textContent?.startsWith('Approvals'))!;
		approvals.click();
		assert.deepStrictEqual({
			before,
			after: labels(),
			selected: approvals.getAttribute('aria-selected'),
			runControlsInRunTab: !!panel.querySelector('.room-tab-panel .room-run-controls-host'),
			agentsListed: [...panel.querySelectorAll<HTMLElement>('.room-member')].filter(member => !member.hidden).length,
			approvalsVisible: !panel.querySelector<HTMLElement>('.room-attention')!.hidden,
		}, {
			before: ['Run', 'Agents', 'Rules', 'Approvals'],
			after: ['Run', 'Agents', 'Rules', 'Approvals1'],
			selected: 'true', runControlsInRunTab: true, agentsListed: 2, approvalsVisible: true,
		});
	});

	test('arrow keys move between panel tabs without leaving the tablist', () => {
		const { panel } = setup('running', 1);
		const tabs = [...panel.querySelectorAll<HTMLElement>('.room-tab')];
		tabs[0].focus();
		panel.querySelector<HTMLElement>('.room-tabs')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		const afterRight = document.activeElement;
		panel.querySelector<HTMLElement>('.room-tabs')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		assert.deepStrictEqual({
			role: panel.querySelector('.room-tabs')!.getAttribute('role'),
			right: afterRight === tabs[1], end: document.activeElement === tabs[tabs.length - 1],
			roving: tabs[0].tabIndex,
		}, { role: 'tablist', right: true, end: true, roving: -1 });
	});

	function selectTab(container: HTMLElement, label: string): void {
		[...container.querySelectorAll<HTMLElement>('.room-tab')].find(tab => tab.textContent?.startsWith(label))!.click();
	}

	function approval(): ICollaborationRequest {
		return {
			id: 'approval', version: 1, roomId: 'room', memberId: 'member-1', memberName: 'Copilot-1',
			chatUri: 'chat:/member-1', turnId: 'turn', state: 'ready', content: 'npm test -- --grep Collaboration',
			payload: {
				kind: 'tool', toolCall: {
					toolCallId: 'shell-1', toolName: 'shell', displayName: 'Run in Terminal', invocationMessage: 'Run the collaboration tests',
					status: ToolCallStatus.PendingConfirmation, toolInput: 'npm test -- --grep Collaboration',
					options: [
						{ id: 'once', label: 'Allow Once', kind: ConfirmationOptionKind.Approve },
						{ id: 'deny', label: 'Reject', kind: ConfirmationOptionKind.Deny },
					],
				}
			},
		};
	}

	test('inline Allow is invoked once, stays pending, and exposes failures without leaving the room', async () => {
		const { container, facade, widget, opened } = setup();
		const request = approval();
		const pending = new DeferredPromise<void>();
		const responses: CollaborationRequestResponse[] = [];
		facade.respondToRequest = (_request, response) => { responses.push(response); return pending.p; };
		facade.requests.set([request], undefined);
		const card = container.querySelector<HTMLElement>('.room-request')!;
		const allow = card.querySelector<HTMLButtonElement>('button.primary')!;
		allow.click();
		allow.click();
		await timeout(0);
		assert.deepStrictEqual({
			responses, pending: allow.disabled, retained: card.isConnected, opened: opened.isSettled,
			content: widget.getAccessibleContent().includes('npm test -- --grep Collaboration'),
			label: allow.getAttribute('aria-label'),
		}, {
			responses: [{ kind: 'tool', approved: true, selectedOptionId: 'once' }],
			pending: true, retained: true, opened: false, content: true, label: 'Allow Once for Copilot-1',
		});
		await pending.error(new Error('The host rejected this approval'));
		await timeout(0);
		assert.deepStrictEqual({
			reenabled: !allow.disabled, retained: container.querySelector('.room-request') === card,
			error: card.querySelector('.room-request-status')?.textContent,
		}, { reenabled: true, retained: true, error: 'The host rejected this approval' });
	});

	test('inline question drafts and focus survive streaming and roster updates', async () => {
		const { container, facade } = setup();
		const request: ICollaborationRequest = {
			...approval(), id: 'question',
			payload: {
				kind: 'input', request: {
					id: 'name', message: 'Name the output file',
					questions: [{ id: 'filename', kind: ChatInputQuestionKind.Text, message: 'File name', required: true }],
				}
			},
		};
		facade.requests.set([request], undefined);
		selectTab(container, 'Approvals');
		const field = container.querySelector<HTMLInputElement>('.room-request input')!;
		field.value = 'report.txt';
		field.focus();
		facade.activeRoom.set({ ...facade.activeRoom.get()!, revision: 2, members: facade.activeRoom.get()!.members.map(member => ({ ...member, activity: 'Streaming output' })) }, undefined);
		facade.requests.set([{ ...request }], undefined);
		assert.deepStrictEqual({
			sameField: container.querySelector('.room-request input') === field,
			value: field.value, focused: document.activeElement === field,
		}, { sameField: true, value: 'report.txt', focused: true });
		const responses: CollaborationRequestResponse[] = [];
		facade.respondToRequest = async (_request, response) => { responses.push(response); };
		container.querySelector<HTMLButtonElement>('.room-request button.primary')!.click();
		await timeout(0);
		assert.deepStrictEqual(responses, [{
			kind: 'input', response: ChatInputResponseKind.Accept,
			answers: { filename: { state: 'submitted', value: { kind: 'text', value: 'report.txt' } } },
		}]);
	});

	test('approval drafts survive resizing the room and Escape returns to the conversation', async () => {
		const { container, facade, widget, panel } = setup();
		facade.requests.set([{
			...approval(), id: 'question',
			payload: { kind: 'input', request: { id: 'name', questions: [{ id: 'name', kind: ChatInputQuestionKind.Text, message: 'Name', required: true }] } },
		}], undefined);
		const field = container.querySelector<HTMLInputElement>('.room-request input')!;
		field.value = 'Keep my answer';
		[...panel.querySelectorAll<HTMLElement>('.room-run-controls-host .monaco-button')].find(button => button.textContent?.startsWith('Needs Attention'))!.click();
		await timeout(0);
		container.style.width = '640px';
		widget.layout(640, 760);
		widget.layoutPanel(280, 760);
		field.focus();
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.deepStrictEqual({
			sameField: container.querySelector('.room-request input') === field,
			value: field.value,
			focusedConversation: document.activeElement === container.querySelector('.room-main'),
		}, { sameField: true, value: 'Keep my answer', focusedConversation: true });
	});

	test('inline forms submit typed numeric, boolean, and selected answers', async () => {
		const { container, facade } = setup();
		facade.requests.set([{
			...approval(), id: 'form', content: undefined,
			payload: {
				kind: 'input', request: {
					id: 'settings',
					questions: [
						{ id: 'count', kind: ChatInputQuestionKind.Integer, message: 'Count', required: true, min: 1, max: 5 },
						{ id: 'ratio', kind: ChatInputQuestionKind.Number, message: 'Ratio', required: true, min: 0, max: 1 },
						{ id: 'enabled', kind: ChatInputQuestionKind.Boolean, message: 'Enabled', required: true },
						{ id: 'targets', kind: ChatInputQuestionKind.MultiSelect, message: 'Targets', required: true, min: 1, max: 2, options: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] },
					],
				}
			},
		}], undefined);
		container.querySelector<HTMLInputElement>('.room-request input[aria-label="Count"]')!.value = '2';
		container.querySelector<HTMLInputElement>('.room-request input[aria-label="Ratio"]')!.value = '0.5';
		container.querySelector<HTMLSelectElement>('.room-request select[aria-label="Enabled"]')!.value = 'false';
		const targets = container.querySelector<HTMLSelectElement>('.room-request select[aria-label="Targets"]')!;
		targets.options[1].selected = true;
		const responses: CollaborationRequestResponse[] = [];
		facade.respondToRequest = async (_request, response) => { responses.push(response); };
		container.querySelector<HTMLButtonElement>('.room-request button.primary')!.click();
		await timeout(0);
		assert.deepStrictEqual(responses, [{
			kind: 'input', response: ChatInputResponseKind.Accept,
			answers: {
				count: { state: 'submitted', value: { kind: 'number', value: 2 } },
				ratio: { state: 'submitted', value: { kind: 'number', value: 0.5 } },
				enabled: { state: 'submitted', value: { kind: 'boolean', value: false } },
				targets: { state: 'submitted', value: { kind: 'selected-many', value: ['second'] } },
			},
		}]);
	});

	test('stale approval completion does not alter the next room or its request', async () => {
		const { container, facade } = setup();
		const pending = new DeferredPromise<void>();
		facade.respondToRequest = () => pending.p;
		facade.requests.set([approval()], undefined);
		const oldCard = container.querySelector<HTMLElement>('.room-request')!;
		oldCard.querySelector<HTMLButtonElement>('button.primary')!.click();
		await timeout(0);
		transaction(tx => {
			facade.activeRoomId.set('next-room', tx);
			facade.requests.set([{ ...approval(), id: 'next-approval', roomId: 'next-room', version: 2 }], tx);
		});
		await pending.error(new Error('Previous room response failed'));
		await timeout(0);
		assert.deepStrictEqual({
			oldRemoved: !oldCard.isConnected,
			notice: container.querySelector('.room-request-status')?.textContent,
			canAnswer: !container.querySelector<HTMLButtonElement>('.room-request button.primary')!.disabled,
		}, { oldRemoved: true, notice: '', canAnswer: true });
	});

	test('plan review uses the server actions and answer identifier in the room', async () => {
		const { container, facade } = setup();
		const plan: ChatInputRequestWithPlanReview = {
			id: 'plan',
			planReview: {
				title: 'Review the plan', content: '1. Fix the form\n2. Add coverage', canProvideFeedback: true, answerQuestionId: 'plan-choice',
				actions: [{ id: 'implement', label: 'Implement the Plan' }, { id: 'revise', label: 'Revise the Plan' }],
			},
		};
		facade.requests.set([{ ...approval(), id: 'plan', payload: { kind: 'input', request: plan } }], undefined);
		const feedback = container.querySelector<HTMLTextAreaElement>('.room-request textarea')!;
		feedback.value = 'Keep the existing keyboard shortcuts';
		const responses: CollaborationRequestResponse[] = [];
		facade.respondToRequest = async (_request, response) => { responses.push(response); };
		container.querySelector<HTMLButtonElement>('.room-request button.primary')!.click();
		await timeout(0);
		assert.deepStrictEqual(responses, [{
			kind: 'input', response: ChatInputResponseKind.Accept,
			answers: { 'plan-choice': { state: 'submitted', value: { kind: 'selected', value: 'implement', freeformValues: ['Keep the existing keyboard shortcuts'] } } },
		}]);
	});

	test('the room shows one workspace trust action and lists the exact directories', async () => {
		const { container, facade, opened } = setup();
		let trustRequests = 0;
		facade.requestWorkspaceTrust = async () => { trustRequests++; };
		facade.workspaceTrust.set({
			state: 'untrusted', repositoryUri: 'file:///source/project',
			worktreeUris: ['file:///rooms/room/member-1', 'file:///rooms/room/member-2'],
		}, undefined);
		const buttons = container.querySelectorAll<HTMLElement>('.room-trust .monaco-button');
		buttons[0].click();
		await timeout(0);
		assert.deepStrictEqual({
			buttons: buttons.length, trustRequests, peerOpened: opened.isSettled,
			directories: container.querySelector('.room-trust pre')?.textContent,
		}, {
			buttons: 1, trustRequests: 1, peerOpened: false,
			directories: 'file:///source/project\nfile:///rooms/room/member-1\nfile:///rooms/room/member-2',
		});
	});
});
