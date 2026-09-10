/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessage, IAgentHostRoomMessagePage } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ITextDiffEditorPane } from '../../../../../workbench/common/editor.js';
import { IAgentHostSessionsProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsPartService } from '../../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ICollaborationRoomCreationDraft, ICollaborationRoomScrollState, ICollaborationRoomViewService } from '../../../../services/collaboration/browser/collaborationRoomView.js';
import { COLLABORATION_MESSAGE_PAGE_SIZE, ICollaborationService } from '../../../../services/collaboration/common/collaboration.js';
import { CollaborationDraft } from '../../../../services/collaboration/common/collaborationMentions.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { IChat, ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { CollaborationRoomWidget } from '../../browser/collaborationRoomWidget.js';

suite('CollaborationRoomWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(state: IAgentHostRoom['state'] = 'running', messageCount = 0, newRoom = false, draft = new CollaborationDraft()) {
		const room: IAgentHostRoom = {
			id: 'room', revision: 1, title: 'Peer room', goal: 'A shared goal', instructions: '',
			repositoryUri: 'file:///repo', baseRevision: 'base', createdAt: 0, updatedAt: 0, state,
			members: [1, 2].map(index => ({
				id: `member-${index}`, name: `Copilot-${index}`, sessionUri: `copilotcli:/member-${index}`,
				chatUri: `opaque-chat:/member-${index}/primary?version=2`,
				state: 'working' as const, turns: 1,
			})),
			artifacts: [], latestMessageSequence: messageCount,
		};
		const messages: IAgentHostRoomMessage[] = Array.from({ length: messageCount }, (_, index): IAgentHostRoomMessage => ({
			id: `post-${index}`, sequence: index + 1, authorId: 'member-1', authorName: 'Copilot-1',
			authorKind: 'agent', kind: 'message', text: `Shared post ${index}`, timestamp: 0,
			mentions: [], deliveries: [],
		}));
		const starts: IAgentHostRoomLimits[] = [];
		const sendModes: string[] = [];
		const followChanges: boolean[] = [];
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
		const facade = new class extends mock<ICollaborationService>() {
			override readonly availability = constObservable('available' as const);
			override readonly supported = constObservable(true);
			override readonly availabilityError = constObservable(undefined);
			override readonly rooms = observableValue<readonly IAgentHostRoom[]>(this, [room]);
			override readonly activeRoomId = observableValue<string | undefined>(this, newRoom ? undefined : room.id);
			override readonly activeRoom = observableValue<IAgentHostRoom | undefined>(this, newRoom ? undefined : room);
			override readonly messages = observableValue<IAgentHostRoomMessagePage>(this, { messages, hasEarlier: false, hasLater: false });
			override readonly models = constObservable([]);
			override readonly loading = constObservable(false);
			override readonly creating = observableValue(this, false);
			override readonly sending = constObservable(false);
			override readonly canSteer = observableValue(this, true);
			override readonly error = constObservable(undefined);
			override getDraft() { return draft; }
			override async selectRoom(roomId: string | undefined): Promise<void> {
				selectedRooms.push(roomId);
				transaction(tx => {
					this.activeRoomId.set(roomId, tx);
					this.activeRoom.set(this.rooms.get().find(candidate => candidate.id === roomId), tx);
				});
			}
			override setFollowingLatest(following: boolean): void { followChanges.push(following); }
			override async sendMessage(mode = 'message'): Promise<void> { sends++; sendModes.push(mode); }
			override async startRoom(limits: IAgentHostRoomLimits): Promise<void> { starts.push(limits); }
			override async createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom> {
				await created.complete(options);
				return room;
			}
		}();
		const viewService = new class extends mock<ICollaborationRoomViewService>() {
			override readonly visible = observableValue('roomVisible', true);
			override readonly activeView = constObservable(undefined);
			override readonly scrollState = observableValue<ICollaborationRoomScrollState | undefined>(this, undefined);
			override readonly creationDraft = observableValue<ICollaborationRoomCreationDraft | undefined>(this, undefined);
			override saveScrollState(state: ICollaborationRoomScrollState): void { this.scrollState.set(state, undefined); }
			override saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void { this.creationDraft.set(draft, undefined); }
			override close(): void { this.visible.set(false, undefined); }
		}();
		const instantiation = disposables.add(new TestInstantiationService());
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
		instantiation.stub(IEditorService, new class extends mock<IEditorService>() {
			override async openEditor() {
				return new class extends mock<ITextDiffEditorPane>() {
					override focus(): void { void artifactFocused.complete(); }
				}();
			}
		}());
		const container = document.body.appendChild(document.createElement('div'));
		disposables.add(toDisposable(() => container.remove()));
		const widget = disposables.add(instantiation.createInstance(CollaborationRoomWidget, container));
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
		return { widget, container, input, type, key, draft, starts, created, opened, artifactFocused, provider, resolutions, selectedRooms, peerSession, peerChat, viewService, facade, followChanges, sendModes, getSends: () => sends, getSessionFocuses: () => sessionFocuses };
	}

	test('Agent Collab home exposes saved rooms and creation without transcript rows', () => {
		const { container, widget, facade, selectedRooms } = setup('created', 0, true);
		const saved = container.querySelector<HTMLButtonElement>('.room-saved-room button')!;
		assert.strictEqual(saved.textContent, 'Peer room');
		assert.strictEqual(container.querySelector<HTMLFormElement>('.room-start-form')!.hidden, false);
		assert.strictEqual(container.querySelectorAll('.room-message').length, 0);
		assert.ok(widget.getAccessibleContent().includes('Saved room: Peer room.'));
		saved.click();
		assert.deepStrictEqual(selectedRooms, ['room']);
		assert.strictEqual(facade.activeRoomId.get(), 'room');
	});

	test('saved room status updates retain the focused room button', () => {
		const { container, facade } = setup('created', 0, true);
		const saved = container.querySelector<HTMLButtonElement>('.room-saved-room button')!;
		saved.focus();
		facade.rooms.set(facade.rooms.get().map(room => ({ ...room, state: 'paused' as const })), undefined);
		assert.strictEqual(container.querySelector('.room-saved-room button'), saved);
		assert.strictEqual(document.activeElement, saved);
		assert.strictEqual(saved.getAttribute('aria-label'), 'Open Peer room, Paused');
	});

	test('peer navigation resolves opaque identities through the owning provider', async () => {
		const { container, opened, resolutions, peerSession, peerChat } = setup();
		container.querySelector<HTMLButtonElement>('.room-member > button')!.click();
		assert.deepStrictEqual(await opened.p, { session: peerSession, chat: peerChat.resource });
		assert.deepStrictEqual(resolutions, [{ session: 'copilotcli:/member-1', chat: URI.parse('opaque-chat:/member-1/primary?version=2').toString() }]);
	});

	test('a late peer resolution cannot reopen a disposed room surface', async () => {
		const { container, opened, provider, widget, peerSession, peerChat } = setup();
		const pending = new DeferredPromise<{ session: ISession; chat: IChat }>();
		provider.resolveSessionChat = () => pending.p;
		container.querySelector<HTMLButtonElement>('.room-member > button')!.click();
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
		const review = [...container.querySelectorAll<HTMLButtonElement>('.room-message button')].find(button => button.textContent === 'Review Published Artifact')!;
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

	test('returning to a new-room form does not require a saved scroll position', () => {
		const { container, facade } = setup();
		transaction(tx => {
			facade.activeRoomId.set(undefined, tx);
			facade.activeRoom.set(undefined, tx);
		});
		assert.strictEqual(container.querySelector<HTMLElement>('.room-start-container')!.hidden, false);
	});

	test('a creation still in progress disables a newly mounted form', () => {
		const { container, facade } = setup('created', 0, true);
		facade.creating.set(true, undefined);
		assert.strictEqual(container.querySelector<HTMLButtonElement>('.room-start-form button.primary')!.disabled, true);
		facade.creating.set(false, undefined);
		assert.strictEqual(container.querySelector<HTMLButtonElement>('.room-start-form button.primary')!.disabled, false);
	});

	test('creation delegates the selected base to the host without a main-process Git lookup', async () => {
		const { container, created, starts } = setup('created', 0, true);
		const form = container.querySelector<HTMLFormElement>('.room-start-form')!;
		const inputs = form.querySelectorAll<HTMLInputElement>('input');
		const textareas = form.querySelectorAll<HTMLTextAreaElement>('textarea');
		inputs[0].value = 'Startup investigation';
		textareas[0].value = 'Measure startup before changing code';
		textareas[1].value = 'Preserve public APIs';
		const choose = [...form.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Choose Repository')!;
		const selected = new DeferredPromise<void>();
		const observer = new MutationObserver(() => {
			if (!choose.disabled && inputs[1].value === '/repo') {
				observer.disconnect();
				void selected.complete();
			}
		});
		disposables.add(toDisposable(() => observer.disconnect()));
		observer.observe(form, { attributes: true, subtree: true, attributeFilter: ['disabled'] });
		choose.click();
		await selected.p;
		inputs[2].value = 'HEAD';
		inputs[3].value = '2';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		assert.deepStrictEqual({ options: await created.p, starts }, {
			options: {
				title: 'Startup investigation', goal: 'Measure startup before changing code', instructions: 'Preserve public APIs',
				repositoryUri: 'file:///repo', baseRevision: 'HEAD', workerCount: 2, model: undefined,
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

	test('Reply targets the original post and names its peer without changing surfaces', () => {
		const { container, input, draft, viewService } = setup('running', 1);
		container.querySelector<HTMLButtonElement>('.room-message button')!.click();
		assert.strictEqual(draft.replyTo, 'post-0');
		assert.strictEqual(input.value, '@Copilot-1 ');
		assert.strictEqual(viewService.visible.get(), true);
	});

	test('the steering button sends an explicit steering request without changing normal Send', () => {
		const { container, type, sendModes } = setup();
		type('Change direction');
		const buttons = [...container.querySelectorAll<HTMLButtonElement>('.room-composer button')];
		buttons.find(button => button.textContent === 'Steer Agents')!.click();
		assert.deepStrictEqual(sendModes, ['steer']);
	});

	test('Control+Enter steers from the composer and normal Enter still posts a message', () => {
		const { input, type, sendModes } = setup();
		type('@Copilot-1 Change direction');
		const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
		input.dispatchEvent(event);
		assert.deepStrictEqual({ prevented: event.defaultPrevented, sendModes }, { prevented: true, sendModes: ['steer'] });
	});

	test('steering controls are hidden when the connected host lacks support', () => {
		const { container, facade } = setup();
		facade.canSteer.set(false, undefined);
		const button = [...container.querySelectorAll<HTMLButtonElement>('.room-composer button')].find(button => button.textContent === 'Steer Agents')!;
		assert.deepStrictEqual({ hidden: button.hidden, disabled: button.disabled }, { hidden: true, disabled: true });
	});

	test('sending while reading older posts resumes following the latest conversation', async () => {
		const { container, facade, followChanges, type, input } = setup('running', 20);
		const feed = container.querySelector<HTMLElement>('.room-feed')!;
		feed.style.flex = 'none';
		feed.style.height = '100px';
		feed.style.overflowY = 'auto';
		feed.scrollTop = 0;
		feed.dispatchEvent(new Event('scroll'));
		assert.strictEqual(followChanges.at(-1), false);
		const acknowledged = new DeferredPromise<void>();
		facade.sendMessage = () => acknowledged.p;
		type('Advice from older history');
		container.querySelector<HTMLButtonElement>('.room-composer button.primary')!.click();
		await acknowledged.complete();
		await acknowledged.p;
		assert.deepStrictEqual({
			followingLatest: followChanges.at(-1),
			atBottom: Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop) <= 1,
			text: input.value,
		}, { followingLatest: true, atBottom: true, text: 'Advice from older history' });
	});

	test('plain human posts explain that no agents were notified in the feed and accessible view', () => {
		const { container, facade, widget } = setup();
		facade.messages.set({
			hasEarlier: false, hasLater: false,
			messages: [{
				id: 'human-post', sequence: 1, authorId: 'human', authorKind: 'human', authorName: 'You',
				kind: 'message', text: 'Any updates?', timestamp: 0, mentions: [], deliveries: [],
			}],
		}, undefined);
		const explanation = 'Shared with room; no agents notified';
		assert.deepStrictEqual({
			visible: container.querySelector('.room-message-meta')?.textContent?.includes(explanation),
			accessible: widget.getAccessibleContent().includes(explanation),
		}, { visible: true, accessible: true });
	});

	test('Start does not require a turn cap or deadline', () => {
		const { container, starts } = setup('created');
		container.querySelector<HTMLButtonElement>('form.room-history-controls button')!.click();
		assert.deepStrictEqual(starts, [{}]);
	});

	test('Start passes the explicitly entered run limits', () => {
		const { container, starts } = setup('created');
		const limits = container.querySelectorAll<HTMLInputElement>('form.room-history-controls input');
		limits[0].value = '12';
		limits[1].value = '5';
		container.querySelector<HTMLButtonElement>('form.room-history-controls button')!.click();
		assert.deepStrictEqual(starts, [{ maxTurns: 12, timeoutMinutes: 5 }]);
	});

	test('turn caps and deadlines can be chosen independently', () => {
		const first = setup('created');
		first.container.querySelectorAll<HTMLInputElement>('form.room-history-controls input')[0].value = '12';
		first.container.querySelector<HTMLButtonElement>('form.room-history-controls button')!.click();
		const second = setup('created');
		second.container.querySelectorAll<HTMLInputElement>('form.room-history-controls input')[1].value = '5';
		second.container.querySelector<HTMLButtonElement>('form.room-history-controls button')!.click();
		assert.deepStrictEqual([first.starts, second.starts], [[{ maxTurns: 12 }], [{ timeoutMinutes: 5 }]]);
	});

	test('an idle room supports both an explicit bounded Resume and Pause', () => {
		const { container, starts } = setup('idle');
		const resume = container.querySelector<HTMLButtonElement>('form.room-history-controls button')!;
		const pause = [...container.querySelectorAll<HTMLButtonElement>('.room-header button')].find(button => button.textContent === 'Pause')!;
		assert.strictEqual(resume.textContent, 'Resume');
		assert.strictEqual(resume.disabled, false);
		assert.strictEqual(pause.disabled, false);
		const limits = container.querySelectorAll<HTMLInputElement>('form.room-history-controls input');
		limits[0].value = '6';
		limits[1].value = '3';
		resume.click();
		assert.deepStrictEqual(starts, [{ maxTurns: 6, timeoutMinutes: 3 }]);
	});

	test('rendered and accessible history remain bounded', () => {
		const { container, widget } = setup('running', COLLABORATION_MESSAGE_PAGE_SIZE + 10);
		assert.strictEqual(container.querySelectorAll('.room-message').length, COLLABORATION_MESSAGE_PAGE_SIZE);
		assert.ok(!widget.getAccessibleContent().includes('Shared post 0\n'));
		assert.ok(widget.getAccessibleContent().includes('Shared post 109'));
	});

	test('returning to sessions hides the room without changing the session model', () => {
		const { container, viewService, getSessionFocuses } = setup();
		const back = [...container.querySelectorAll<HTMLButtonElement>('.room-header button')].find(button => button.textContent === 'Back to Sessions')!;
		back.click();
		assert.strictEqual(viewService.visible.get(), false);
		assert.strictEqual(getSessionFocuses(), 1);
	});
});
