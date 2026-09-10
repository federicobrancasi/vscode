/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/collaborationRoom.css';
import { $, addDisposableListener, EventType, getActiveElement, isAncestor, isHTMLElement, trackFocus } from '../../../../base/browser/dom.js';
import { IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AgentHostRoomMessageMode, IAgentHostRoom, IAgentHostRoomMember, IAgentHostRoomMessage } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { isAgentHostProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ICollaborationRoomView, ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { COLLABORATION_MESSAGE_PAGE_SIZE, CollaborationRoomFocusedContext, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { getCollaborationMentionQuery, ICollaborationMentionQuery } from '../../../services/collaboration/common/collaborationMentions.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { deliveryStateLabel, memberStateLabel, messageKindLabel, roomStateLabel } from './collaborationRoomLabels.js';
import { CollaborationArtifactProvider } from './collaborationArtifactProvider.js';

interface IMemberElements {
	readonly element: HTMLElement;
	readonly open: HTMLButtonElement;
	readonly state: HTMLElement;
	readonly activity: HTMLElement;
	readonly work: HTMLElement;
	readonly error: HTMLElement;
	readonly stop: HTMLButtonElement;
	readonly retry: HTMLButtonElement;
}

interface IMessageElements {
	readonly element: HTMLElement;
	readonly metadata: HTMLElement;
	readonly body: HTMLElement;
	readonly rendered: MutableDisposable<IRenderedMarkdown>;
	readonly disposables: DisposableStore;
	readonly retry: HTMLButtonElement | undefined;
	text: string | undefined;
	message: IAgentHostRoomMessage | undefined;
}

interface ISavedRoomElements {
	readonly element: HTMLElement;
	readonly open: HTMLButtonElement;
	readonly state: HTMLElement;
	readonly disposables: DisposableStore;
}

export class CollaborationRoomWidget extends Disposable implements ICollaborationRoomView {
	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly subtitle: HTMLElement;
	private readonly goalDetails: HTMLDetailsElement;
	private readonly goalContent: HTMLElement;
	private readonly roomPicker: HTMLSelectElement;
	private readonly notice: HTMLElement;
	private readonly retryLoad: HTMLButtonElement;
	private readonly roster: HTMLElement;
	private readonly feed: HTMLElement;
	private readonly historyControls: HTMLElement;
	private readonly earlier: HTMLButtonElement;
	private readonly later: HTMLButtonElement;
	private readonly latest: HTMLButtonElement;
	private readonly composer: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly send: HTMLButtonElement;
	private readonly steer: HTMLButtonElement;
	private readonly replyLabel: HTMLElement;
	private readonly cancelReply: HTMLButtonElement;
	private readonly suggestions: HTMLElement;
	private readonly startContainer: HTMLElement;
	private readonly savedRoomsSection: HTMLElement;
	private readonly savedRoomsList: HTMLElement;
	private readonly startForm: HTMLFormElement;
	private readonly titleInput: HTMLInputElement;
	private readonly goalInput: HTMLTextAreaElement;
	private readonly instructionsInput: HTMLTextAreaElement;
	private readonly repositoryInput: HTMLInputElement;
	private readonly baseInput: HTMLInputElement;
	private readonly countInput: HTMLInputElement;
	private readonly modelInput: HTMLSelectElement;
	private readonly createButton: HTMLButtonElement;
	private readonly runForm: HTMLFormElement;
	private readonly turnsInput: HTMLInputElement;
	private readonly deadlineInput: HTMLInputElement;
	private readonly startButton: HTMLButtonElement;
	private readonly pauseButton: HTMLButtonElement;
	private readonly stopButton: HTMLButtonElement;
	private readonly busy = observableValue(this, false);
	private readonly localError = observableValue<string | undefined>(this, undefined);
	private readonly memberElements = new Map<string, IMemberElements>();
	private readonly memberDisposables = this._register(new DisposableStore());
	private readonly savedRoomElements = new Map<string, ISavedRoomElements>();
	private readonly savedRoomDisposables = this._register(new DisposableStore());
	private readonly messageElements = new Map<string, IMessageElements>();
	private readonly messageDisposables = this._register(new DisposableStore());
	private readonly suggestionDisposables = this._register(new DisposableStore());
	private readonly suggestionId = `collaboration-mentions-${generateUuid()}`;
	private suggestionMembers: readonly IAgentHostRoomMember[] = [];
	private suggestionIndex = 0;
	private mentionQuery: ICollaborationMentionQuery | undefined;
	private repository: URI | undefined;
	private followingLatest = true;
	private pendingScrollTop: number | undefined;
	private initialSelection = true;
	private previousRoomId: string | undefined;
	private lastAnnouncedSequence = 0;
	private previousNeedsInput: number | undefined;
	private roomCatalog = '';
	private readonly navigationCancellation = new CancellationTokenSource();

	constructor(
		parent: HTMLElement,
		@ICollaborationService private readonly collaborationService: ICollaborationService,
		@ICollaborationRoomViewService private readonly roomViewService: ICollaborationRoomViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._register(toDisposable(() => this.navigationCancellation.dispose(true)));
		this.element = parent.appendChild($('.collaboration-room'));
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('room.region', "Collaboration room"));
		const focused = CollaborationRoomFocusedContext.bindTo(contextKeyService);
		const focusTracker = this._register(trackFocus(this.element));
		this._register(focusTracker.onDidFocus(() => focused.set(true)));
		this._register(focusTracker.onDidBlur(() => focused.set(false)));
		this._register({ dispose: () => focused.reset() });

		this.header = this.element.appendChild($('.room-header'));
		const headingContainer = this.header.appendChild($('.room-heading'));
		this.heading = headingContainer.appendChild($('h2'));
		this.subtitle = headingContainer.appendChild($('.room-subtitle'));
		this.roomPicker = this.header.appendChild($('select')) as HTMLSelectElement;
		this.roomPicker.setAttribute('aria-label', localize('room.choose', "Choose collaboration room"));
		this._register(addDisposableListener(this.roomPicker, EventType.CHANGE, () => {
			void this.perform(() => this.collaborationService.selectRoom(this.roomPicker.value || undefined));
		}));
		this.button(this.header, localize('room.new', "New Room"), async () => {
			await this.collaborationService.selectRoom(undefined);
			this.titleInput.focus();
		});
		this.button(this.header, localize('room.back', "Back to Sessions"), () => {
			this.roomViewService.close();
			this.sessionsPartService.focusSession(this.sessionsService.activeSession.get());
		}, this._store, false);
		this.pauseButton = this.button(this.header, localize('room.pause', "Pause"), () => this.collaborationService.pauseRoom());
		this.stopButton = this.button(this.header, localize('room.stop', "Stop All"), () => this.collaborationService.stopRoom());
		this.goalDetails = this.element.appendChild($('details.room-notice')) as HTMLDetailsElement;
		this.goalDetails.appendChild($('summary')).textContent = localize('room.goalAndRules', "Shared goal, rules, and baseline");
		this.goalContent = this.goalDetails.appendChild($('p'));

		this.notice = this.element.appendChild($('.room-notice'));
		this.notice.setAttribute('role', 'status');
		this.retryLoad = this.button(this.element, localize('room.reload', "Retry Loading"), async () => {
			if (this.collaborationService.availability.get() === 'available') {
				await this.collaborationService.selectRoom(this.collaborationService.activeRoomId.get());
			} else {
				await this.collaborationService.refresh();
			}
		});
		this.roster = this.element.appendChild($('.room-roster'));
		this.roster.setAttribute('role', 'list');
		this.roster.setAttribute('aria-label', localize('room.participants', "Copilot peers and current activity"));

		this.startContainer = this.element.appendChild($('.room-start-container'));
		this.savedRoomsSection = this.startContainer.appendChild($('section.room-saved-rooms'));
		this.savedRoomsSection.appendChild($('h3')).textContent = localize('room.savedRooms', "Saved rooms");
		this.savedRoomsList = this.savedRoomsSection.appendChild($('ul.room-saved-room-list'));
		this.savedRoomsList.setAttribute('aria-label', localize('room.savedRoomsLabel', "Saved collaboration rooms"));
		this.startForm = this.startContainer.appendChild($('form.room-start-form')) as HTMLFormElement;
		this.startForm.appendChild($('h3')).textContent = localize('room.createHeading', "Create a room");
		const introduction = this.startForm.appendChild($('p'));
		introduction.textContent = localize('room.introduction', "One shared conversation, equal Copilot peers, and a separate Git worktree for each peer. Creating a room does not start a paid run. Start the team when ready, or @mention a peer to request work. Run limits are optional.");
		this.titleInput = this.textField(this.startForm, localize('room.title', "Room title"));
		this.titleInput.required = true;
		this.goalInput = this.textArea(this.startForm, localize('room.goal', "Shared goal"));
		this.goalInput.required = true;
		this.instructionsInput = this.textArea(this.startForm, localize('room.rules', "Shared rules (optional)"));
		this.repositoryInput = this.textField(this.startForm, localize('room.repository', "Local Git repository"));
		this.repositoryInput.readOnly = true;
		this.repositoryInput.required = true;
		this.button(this.startForm, localize('room.browse', "Choose Repository"), () => this.chooseRepository());
		this.baseInput = this.textField(this.startForm, localize('room.base', "Base branch, tag, or commit"));
		this.baseInput.value = 'HEAD';
		this.baseInput.required = true;
		const baselineHint = this.startForm.appendChild($('p.room-hint'));
		baselineHint.textContent = localize('room.baselineHint', "The selected committed revision is pinned before creation. Uncommitted workspace changes are not included, committed, or discarded. Published patches are never applied automatically.");
		this.countInput = this.numberField(this.startForm, localize('room.count', "Number of Copilot peers (1-10)"), 10);
		this.countInput.value = '3';
		const modelLabel = this.startForm.appendChild($('label'));
		modelLabel.append(localize('room.model', "Model"));
		this.modelInput = modelLabel.appendChild($('select')) as HTMLSelectElement;
		this.createButton = this.button(this.startForm, localize('room.create', "Create Room"), () => this.createRoom());
		this.createButton.classList.add('primary');
		this._register(addDisposableListener(this.startForm, EventType.INPUT, () => this.saveCreationDraft()));
		this._register(addDisposableListener(this.startForm, EventType.CHANGE, () => this.saveCreationDraft()));
		this._register(addDisposableListener(this.startForm, EventType.SUBMIT, event => {
			event.preventDefault();
			void this.perform(() => this.createRoom());
		}));

		this.runForm = this.element.appendChild($('form.room-history-controls')) as HTMLFormElement;
		const limits = this.runForm.appendChild($('details.room-run-limits'));
		limits.appendChild($('summary')).textContent = localize('room.optionalLimits', "Optional run limits");
		this.turnsInput = this.numberField(limits, localize('room.turns', "Maximum total turns for this run"), 10000);
		this.deadlineInput = this.numberField(limits, localize('room.deadline', "Run deadline (minutes)"), 1440);
		this.turnsInput.required = false;
		this.deadlineInput.required = false;
		this.turnsInput.placeholder = localize('room.noLimit', "No limit");
		this.deadlineInput.placeholder = localize('room.noDeadline', "No deadline");
		this.startButton = this.button(this.runForm, localize('room.start', "Start"), () => this.startRun());
		this.startButton.classList.add('primary');
		this._register(addDisposableListener(this.runForm, EventType.SUBMIT, event => {
			event.preventDefault();
			void this.perform(() => this.startRun());
		}));
		const limitsHint = this.runForm.appendChild($('span.room-hint'));
		limitsHint.textContent = localize('room.limitsHint', "Start runs the team. A human @mention requests only the addressed peer. Pause holds messages; Stop cancels current work. Limits are optional.");

		this.historyControls = this.element.appendChild($('.room-history-controls'));
		this.earlier = this.button(this.historyControls, localize('room.earlier', "Older Posts"), async () => {
			const first = this.collaborationService.messages.get().messages[0];
			if (first) {
				this.followingLatest = false;
				await this.collaborationService.loadMessages({ before: first.sequence });
				this.feed.scrollTop = 0;
				this.feed.focus();
			}
		});
		this.later = this.button(this.historyControls, localize('room.later', "Newer Posts"), async () => {
			const last = this.collaborationService.messages.get().messages.at(-1);
			if (last) {
				await this.collaborationService.loadMessages({ after: last.sequence });
				this.feed.scrollTop = 0;
				this.feed.focus();
			}
		});
		this.latest = this.button(this.historyControls, localize('room.latest', "Latest Posts"), async () => {
			this.followingLatest = true;
			await this.collaborationService.loadMessages();
			this.feed.scrollTop = this.feed.scrollHeight;
		});
		this.feed = this.element.appendChild($('.room-feed'));
		this.feed.tabIndex = 0;
		this.feed.setAttribute('role', 'list');
		this.feed.setAttribute('aria-label', localize('room.feed', "Shared conversation"));
		this._register(addDisposableListener(this.feed, EventType.SCROLL, () => {
			if (this.pendingScrollTop !== undefined) {
				return;
			}
			this.followingLatest = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 48;
			this.collaborationService.setFollowingLatest(this.followingLatest);
			this.saveScrollPosition();
		}));

		this.composer = this.element.appendChild($('.room-composer'));
		this.replyLabel = this.composer.appendChild($('.room-hint'));
		this.cancelReply = this.button(this.composer, localize('room.cancelReply', "Cancel Reply"), () => {
			this.updateDraft(undefined);
			this.updateReply();
			this.input.focus();
		});
		this.input = this.composer.appendChild($('textarea')) as HTMLTextAreaElement;
		this.input.placeholder = localize('room.placeholder', "Message the room or @mention a peer");
		this.input.setAttribute('role', 'combobox');
		this.input.setAttribute('aria-multiline', 'true');
		this.input.setAttribute('aria-autocomplete', 'list');
		this.input.setAttribute('aria-haspopup', 'listbox');
		this.input.setAttribute('aria-expanded', 'false');
		this.input.setAttribute('aria-controls', this.suggestionId);
		this.suggestions = this.composer.appendChild($('ul.room-mentions'));
		this.suggestions.id = this.suggestionId;
		this.suggestions.setAttribute('role', 'listbox');
		this.suggestions.setAttribute('aria-label', localize('room.mentions', "Mention a Copilot peer"));
		this.suggestions.hidden = true;
		const composerActions = this.composer.appendChild($('.room-composer-actions'));
		composerActions.appendChild($('span.room-hint')).textContent = localize('room.composerHint', "Send posts to the room. Steer Agents sends live guidance to @mentioned peers, or everyone when none are mentioned.");
		this.send = this.button(composerActions, localize('room.send', "Send"), () => this.sendMessage());
		this.send.classList.add('primary');
		this.steer = this.button(composerActions, localize('room.steer', "Steer Agents"), () => this.sendMessage('steer'), this._store, false);
		this.steer.setAttribute('aria-description', localize('room.steerDescription', "Send guidance to mentioned agents or all agents. Busy peers receive it during their current turn. Control or Command plus Enter also steers."));
		this._register(addDisposableListener(this.input, EventType.INPUT, () => {
			this.updateDraft(this.currentDraft?.replyTo);
			this.updateMentions();
		}));
		this._register(addDisposableListener(this.input, EventType.CLICK, () => this.updateMentions()));
		this._register(addDisposableListener(this.input, EventType.KEY_DOWN, event => this.onComposerKeyDown(event)));
		this._register(addDisposableListener(this.input, EventType.KEY_UP, event => {
			if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
				|| (!this.suggestionMembers.length && ['ArrowUp', 'ArrowDown'].includes(event.key))) {
				this.updateMentions();
			}
		}));
		this._register(addDisposableListener(this.input, EventType.BLUR, () => this.hideMentions()));
		const updateInputLabel = () => {
			const keybinding = this.keybindingService.lookupKeybinding('editor.action.accessibilityHelp')?.getAriaLabel();
			const hint = this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.CollaborationRoom) && keybinding
				? localize('room.accessibilityHint', " Press {0} for collaboration accessibility help.", keybinding) : '';
			this.input.setAttribute('aria-label', localize('room.inputLabel', "Message the collaboration room.{0}", hint));
			for (const element of [this.element, this.titleInput]) {
				if (hint) {
					element.setAttribute('aria-description', hint.trim());
				} else {
					element.removeAttribute('aria-description');
				}
			}
		};
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AccessibilityVerbositySettingId.CollaborationRoom)) {
				updateInputLabel();
			}
		}));
		this._register(this.keybindingService.onDidUpdateKeybindings(updateInputLabel));
		updateInputLabel();
		this.observeState();
	}

	private observeState(): void {
		this._register(autorun(reader => {
			const draft = this.roomViewService.creationDraft.read(reader);
			for (const [field, value] of [
				[this.titleInput, draft?.title ?? ''],
				[this.goalInput, draft?.goal ?? ''],
				[this.instructionsInput, draft?.instructions ?? ''],
				[this.baseInput, draft?.baseRevision ?? 'HEAD'],
				[this.countInput, draft?.workerCount ?? '3'],
			] as const) {
				if (field.value !== value) {
					field.value = value;
				}
			}
			this.repository = draft?.repositoryUri ? URI.parse(draft.repositoryUri) : undefined;
			this.repositoryInput.value = this.repository?.fsPath ?? '';
		}));
		this._register(autorun(reader => {
			const rooms = this.collaborationService.rooms.read(reader);
			const selected = this.collaborationService.activeRoomId.read(reader);
			const catalog = JSON.stringify(rooms.map(room => [room.id, room.title]));
			if (catalog !== this.roomCatalog) {
				this.roomCatalog = catalog;
				this.roomPicker.replaceChildren();
				this.roomPicker.add(new Option(localize('room.newChoice', "New collaboration room"), ''));
				for (const room of rooms) {
					this.roomPicker.add(new Option(room.title, room.id));
				}
			}
			this.roomPicker.value = selected ?? '';
			this.renderSavedRooms(rooms, this.busy.read(reader) || this.collaborationService.availability.read(reader) !== 'available');
		}));
		this._register(autorun(reader => {
			const models = this.collaborationService.models.read(reader);
			const selected = this.roomViewService.creationDraft.read(reader)?.model ?? '';
			this.modelInput.replaceChildren();
			this.modelInput.add(new Option(localize('room.defaultModel', "Copilot Default (Selected by the Host)"), ''));
			for (const model of models) {
				this.modelInput.add(new Option(model.name, model.id));
			}
			if (selected) {
				if (!models.some(model => model.id === selected)) {
					const unavailable = new Option(localize('room.modelGone', "{0} (no longer available)", selected), selected);
					unavailable.disabled = true;
					this.modelInput.add(unavailable);
				}
				this.modelInput.value = selected;
			}
		}));
		this._register(autorun(reader => {
			const id = this.collaborationService.activeRoomId.read(reader);
			const scrollState = this.initialSelection ? this.roomViewService.scrollState.read(undefined) : undefined;
			this.initialSelection = false;
			if (id !== this.previousRoomId) {
				this.previousRoomId = id;
				this.memberDisposables.clear();
				this.memberElements.clear();
				this.roster.replaceChildren();
				this.clearMessages();
				this.turnsInput.value = '';
				this.deadlineInput.value = '';
				this.followingLatest = scrollState && scrollState.roomId === id ? scrollState.followingLatest : true;
				this.pendingScrollTop = scrollState && scrollState.roomId === id && !scrollState.followingLatest ? scrollState.scrollTop : undefined;
				this.lastAnnouncedSequence = 0;
				this.previousNeedsInput = undefined;
				this.localError.set(undefined, undefined);
				this.hideMentions();
				this.updateReply();
			}
		}));
		this._register(autorun(reader => {
			const id = this.collaborationService.activeRoomId.read(reader);
			const draft = id ? this.collaborationService.getDraft(id).state.read(reader) : undefined;
			if (this.input.value !== (draft?.text ?? '')) {
				this.input.value = draft?.text ?? '';
			}
			this.updateReply();
		}));
		this._register(autorun(reader => {
			const room = this.collaborationService.activeRoom.read(reader);
			const roomId = this.collaborationService.activeRoomId.read(reader);
			const available = this.collaborationService.availability.read(reader) === 'available';
			const busy = this.busy.read(reader);
			const creationBusy = busy || this.collaborationService.creating.read(reader);
			this.heading.textContent = room?.title ?? localize('room.heading', "Create or open a room");
			this.subtitle.textContent = room ? localize('room.summary', "{0} | {1} peers | Base {2}{3}", roomStateLabel(room.state), room.members.length, room.baseRevision.slice(0, 8),
				room.run ? localize('room.runSummary', " | {0} turns{1}{2}", room.run.admittedTurns,
					room.run.limits.maxTurns === undefined ? '' : localize('room.turnLimit', " / {0} maximum", room.run.limits.maxTurns),
					room.run.deadline === undefined ? '' : localize('room.runDeadline', " | Deadline {0}", new Date(room.run.deadline).toLocaleTimeString())) : '') : '';
			this.subtitle.title = room ? localize('room.repositorySummary', "{0}\nGoal: {1}", room.repositoryUri, room.goal) : '';
			this.goalDetails.hidden = !room;
			this.goalContent.textContent = room ? localize('room.goalDetails', "Goal: {0}\nRules: {1}\nRepository: {2}\nPinned base: {3}", room.goal, room.instructions, room.repositoryUri, room.baseRevision) : '';
			this.startContainer.hidden = !!roomId;
			this.runForm.hidden = !room || room.state === 'running' || room.state === 'stopping';
			this.roster.hidden = !room;
			this.historyControls.hidden = !room;
			this.feed.hidden = !roomId;
			this.composer.hidden = !room;
			this.createButton.disabled = creationBusy || !available;
			for (const field of this.startForm.elements) {
				if (isHTMLElement(field) && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(field.tagName)) {
					field.toggleAttribute('disabled', creationBusy || !available);
				}
			}
			this.roomPicker.disabled = busy;
			this.startButton.textContent = room?.state === 'created' ? localize('room.start', "Start") : localize('room.resume', "Resume");
			const canStart = !!room && ['created', 'idle', 'paused', 'stopped', 'interrupted'].includes(room.state);
			this.startButton.disabled = busy || !available || !canStart;
			this.turnsInput.disabled = busy || !canStart;
			this.deadlineInput.disabled = busy || !canStart;
			this.pauseButton.hidden = !room;
			this.stopButton.hidden = !room;
			this.pauseButton.disabled = busy || !available || !room || !['running', 'idle'].includes(room.state);
			this.stopButton.disabled = busy || !available || !room || ['created', 'stopped', 'stopping'].includes(room.state);
			this.send.disabled = !available || this.collaborationService.sending.read(reader);
			this.steer.disabled = this.send.disabled || !this.collaborationService.canSteer.read(reader);
			this.steer.hidden = !this.collaborationService.canSteer.read(reader);
			this.input.disabled = !available;
			this.send.textContent = this.collaborationService.sending.read(reader) ? localize('room.sending', "Sending...") : localize('room.send', "Send");
			if (room) {
				this.renderRoster(room, busy || !available);
			}
		}));
		this._register(autorun(reader => {
			const page = this.collaborationService.messages.read(reader);
			const room = this.collaborationService.activeRoom.read(reader);
			this.earlier.disabled = !page.hasEarlier || this.collaborationService.loading.read(reader);
			this.later.disabled = !page.hasLater || this.collaborationService.loading.read(reader);
			this.latest.hidden = !page.hasLater && (room?.latestMessageSequence ?? 0) <= (page.messages.at(-1)?.sequence ?? 0);
			this.renderMessages(page.messages.slice(-COLLABORATION_MESSAGE_PAGE_SIZE));
			this.updateReply();
		}));
		this._register(autorun(reader => {
			const availability = this.collaborationService.availability.read(reader);
			const error = this.localError.read(reader) ?? this.collaborationService.error.read(reader)
				?? this.collaborationService.availabilityError.read(reader) ?? this.collaborationService.activeRoom.read(reader)?.error;
			const loading = this.collaborationService.loading.read(reader);
			this.notice.textContent = error ?? (availability === 'connecting'
				? localize('room.connecting', "Connecting to the local agent host...")
				: availability !== 'available'
					? localize('room.offline', "Collaboration is unavailable. Worker status may be out of date; reconnect before taking action.")
					: loading ? localize('room.loading', "Loading room history...") : '');
			this.notice.hidden = !this.notice.textContent;
			this.notice.classList.toggle('error', !!error);
			this.retryLoad.hidden = !error && availability !== 'error' && availability !== 'unavailable';
			this.element.setAttribute('aria-busy', String(loading));
		}));
	}

	private get currentDraft() {
		const id = this.collaborationService.activeRoomId.get();
		return id ? this.collaborationService.getDraft(id) : undefined;
	}

	private renderSavedRooms(rooms: readonly IAgentHostRoom[], disabled: boolean): void {
		this.savedRoomsSection.hidden = rooms.length === 0;
		const ids = new Set(rooms.map(room => room.id));
		for (const [id, entry] of this.savedRoomElements) {
			if (!ids.has(id)) {
				this.savedRoomDisposables.delete(entry.disposables);
				entry.element.remove();
				this.savedRoomElements.delete(id);
			}
		}
		let previous: HTMLElement | undefined;
		for (const room of rooms) {
			let entry = this.savedRoomElements.get(room.id);
			if (!entry) {
				const disposables = this.savedRoomDisposables.add(new DisposableStore());
				const element = $('li.room-saved-room');
				const open = this.button(element, room.title, async () => {
					try {
						await this.collaborationService.selectRoom(room.id);
					} finally {
						if (!this._store.isDisposed && this.roomViewService.visible.get() && this.collaborationService.activeRoomId.get() === room.id) {
							this.focus();
						}
					}
				}, disposables);
				const state = element.appendChild($('span.room-hint'));
				state.setAttribute('aria-hidden', 'true');
				entry = { element, open, state, disposables };
				this.savedRoomElements.set(room.id, entry);
			}
			entry.open.textContent = room.title;
			entry.open.disabled = disabled;
			entry.open.setAttribute('aria-label', localize('room.openSaved', "Open {0}, {1}", room.title, roomStateLabel(room.state)));
			entry.state.textContent = roomStateLabel(room.state);
			const expected = previous ? previous.nextElementSibling : this.savedRoomsList.firstElementChild;
			if (expected !== entry.element) {
				this.savedRoomsList.insertBefore(entry.element, expected);
			}
			previous = entry.element;
		}
	}

	private updateDraft(replyTo: string | undefined): void {
		this.currentDraft?.update(this.input.value, replyTo);
	}

	private updateReply(): void {
		const replyId = this.currentDraft?.replyTo;
		const target = this.collaborationService.messages.get().messages.find(message => message.id === replyId);
		this.replyLabel.hidden = !replyId;
		this.cancelReply.hidden = !replyId;
		this.replyLabel.textContent = replyId ? localize('room.replying', "Replying to {0}", target?.authorName ?? replyId) : '';
	}

	private async chooseRepository(): Promise<void> {
		const selected = await this.fileDialogService.showOpenDialog({
			title: localize('room.selectRepository', "Choose a Local Git Repository"),
			canSelectFiles: false, canSelectFolders: true, canSelectMany: false, availableFileSystems: ['file'],
			defaultUri: this.repository,
		});
		if (selected?.[0] && !this._store.isDisposed && !this.collaborationService.activeRoomId.get()) {
			if (selected[0].scheme !== 'file') {
				throw new Error(localize('room.localOnly', "Choose a local Git repository."));
			}
			this.repository = selected[0];
			this.repositoryInput.value = selected[0].fsPath;
			this.saveCreationDraft();
		}
	}

	private saveCreationDraft(): void {
		this.roomViewService.saveCreationDraft({
			title: this.titleInput.value,
			goal: this.goalInput.value,
			instructions: this.instructionsInput.value,
			repositoryUri: this.repository?.toString(),
			baseRevision: this.baseInput.value,
			workerCount: this.countInput.value,
			model: this.modelInput.value,
		});
	}

	private async createRoom(): Promise<void> {
		if (!this.startForm.reportValidity()) {
			return;
		}
		if (!this.repository) {
			throw new Error(localize('room.repositoryRequired', "Choose a local Git repository before creating a room."));
		}
		if (!this.titleInput.value.trim() || !this.goalInput.value.trim()) {
			throw new Error(localize('room.goalRequired', "Enter a room title and a shared goal."));
		}
		const base = this.baseInput.value.trim();
		if (!base || base.startsWith('-') || /[\r\n]/.test(base)) {
			throw new Error(localize('room.invalidBase', "Enter a valid Git branch, tag, or commit."));
		}
		const model = this.modelInput.value;
		if (model && !this.collaborationService.models.get().some(candidate => candidate.id === model)) {
			throw new Error(localize('room.modelUnavailable', "The selected model is no longer available. Choose a model from the current host catalog."));
		}
		const repository = this.repository;
		const options = {
			title: this.titleInput.value.trim(), goal: this.goalInput.value.trim(), instructions: this.instructionsInput.value.trim(),
			workerCount: this.countInput.valueAsNumber, model: model || undefined,
		};
		if (this._store.isDisposed || this.collaborationService.activeRoomId.get() || !this.roomViewService.visible.get()) {
			return;
		}
		this.saveCreationDraft();
		const draft = this.roomViewService.creationDraft.get();
		const room = await this.collaborationService.createRoom({ ...options, repositoryUri: repository.toString(), baseRevision: base });
		if (equals(this.roomViewService.creationDraft.get(), draft)) {
			this.roomViewService.saveCreationDraft(undefined);
		}
		if (!this._store.isDisposed && this.roomViewService.visible.get() && this.collaborationService.activeRoomId.get() === room.id) {
			this.startButton.focus();
		}
	}

	private async startRun(): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		const maxTurns = this.turnsInput.value.trim() ? this.turnsInput.valueAsNumber : undefined;
		const timeoutMinutes = this.deadlineInput.value.trim() ? this.deadlineInput.valueAsNumber : undefined;
		if (this.turnsInput.validity.badInput || this.deadlineInput.validity.badInput
			|| (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 10000))
			|| (timeoutMinutes !== undefined && (!Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440))) {
			throw new Error(localize('room.finiteLimits', "Leave limits empty for no cap, or enter positive whole-number limits (at most 10000 turns and 1440 minutes)."));
		}
		await this.collaborationService.startRoom({
			...(maxTurns === undefined ? {} : { maxTurns }),
			...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
		});
		if (!this._store.isDisposed && this.roomViewService.visible.get() && this.collaborationService.activeRoomId.get() === roomId) {
			this.input.focus();
		}
	}

	private async sendMessage(mode: AgentHostRoomMessageMode = 'message'): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		this.updateDraft(this.currentDraft?.replyTo);
		await this.collaborationService.sendMessage(mode);
		if (roomId === this.collaborationService.activeRoomId.get() && !this._store.isDisposed) {
			this.followingLatest = true;
			this.collaborationService.setFollowingLatest(true);
			this.feed.scrollTop = this.feed.scrollHeight;
			this.input.value = this.currentDraft?.text ?? '';
			this.updateReply();
			this.hideMentions();
		}
	}

	private renderRoster(room: IAgentHostRoom, disabled: boolean): void {
		for (const member of room.members) {
			let elements = this.memberElements.get(member.id);
			if (!elements) {
				const element = this.roster.appendChild($('.room-member'));
				element.setAttribute('role', 'listitem');
				const open = this.button(element, member.name, () => this.openMember(member.id), this.memberDisposables);
				const details = element.appendChild($('details'));
				const summary = details.appendChild($('summary'));
				const state = summary.appendChild($('span.room-member-state'));
				const activity = summary.appendChild($('.room-member-activity'));
				const work = details.appendChild($('.room-member-work'));
				const error = details.appendChild($('.room-member-error'));
				const stop = this.button(details, localize('room.stopPeer', "Stop Peer"), () => this.collaborationService.stopMember(member.id), this.memberDisposables);
				const retry = this.button(details, localize('room.retryPeer', "Retry Peer"), () => this.collaborationService.retryMember(member.id), this.memberDisposables);
				elements = { element, open, state, activity, work, error, stop, retry };
				this.memberElements.set(member.id, elements);
			}
			elements.element.dataset.state = member.state;
			elements.open.textContent = member.name;
			elements.open.setAttribute('aria-label', localize('room.openPeer', "Open {0}'s existing session and approvals", member.name));
			elements.open.title = member.worktreeUri ?? '';
			elements.state.textContent = localize('room.memberSummary', "{0} | {1} turns", memberStateLabel(member.state), member.turns);
			elements.activity.textContent = member.activity ? localize('room.runtimeActivity', "Activity: {0}", member.activity) : '';
			elements.work.textContent = member.work ? localize('room.reportedWork', "Reported work: {0}{1}", member.work.description,
				member.work.nextStep ? localize('room.nextStep', "\nNext: {0}", member.work.nextStep) : '') : '';
			elements.error.textContent = member.error ?? '';
			elements.stop.disabled = disabled || ['stopped', 'stopping', 'failed', 'pending'].includes(member.state);
			elements.stop.setAttribute('aria-label', localize('room.stopPeerLabel', "Stop {0}", member.name));
			elements.retry.hidden = !['failed', 'interrupted'].includes(member.state);
			elements.retry.disabled = disabled || !['running', 'idle'].includes(room.state);
			elements.retry.setAttribute('aria-label', localize('room.retryPeerLabel', "Retry {0} within the current run limits", member.name));
		}
		const needsInput = room.members.filter(member => member.state === 'needsInput').length;
		if (this.previousNeedsInput !== undefined && needsInput > this.previousNeedsInput && this.roomViewService.visible.get()) {
			status(localize('room.approvals', "{0} peers need approval or input. Open their existing session to respond.", needsInput));
		}
		this.previousNeedsInput = needsInput;
	}

	private async openMember(memberId: string): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		const member = this.collaborationService.activeRoom.get()?.members.find(member => member.id === memberId);
		if (!member) {
			return;
		}
		const provider = this.sessionsProvidersService.getProvider(LOCAL_AGENT_HOST_PROVIDER_ID);
		const target = provider && isAgentHostProvider(provider)
			? await provider.resolveSessionChat(URI.parse(member.sessionUri), member.chatUri ? URI.parse(member.chatUri) : undefined, this.navigationCancellation.token)
			: undefined;
		if (this._store.isDisposed || this.collaborationService.activeRoomId.get() !== roomId) {
			return;
		}
		if (!target) {
			throw new Error(localize('room.sessionNotReady', "This peer's session is not yet available in the local session catalog. Try again after provisioning completes."));
		}
		await this.sessionsService.openChat(target.session, target.chat.resource);
	}

	private renderMessages(messages: readonly IAgentHostRoomMessage[]): void {
		const visible = new Set(messages.map(message => message.id));
		for (const [id, elements] of this.messageElements) {
			if (!visible.has(id)) {
				this.messageDisposables.delete(elements.disposables);
				elements.element.remove();
				this.messageElements.delete(id);
			}
		}
		let previous: HTMLElement | undefined;
		for (const message of messages) {
			let elements = this.messageElements.get(message.id);
			if (!elements) {
				const disposables = this.messageDisposables.add(new DisposableStore());
				const element = $('.room-message');
				element.setAttribute('role', 'listitem');
				const author = element.appendChild($('.room-message-author'));
				author.textContent = message.authorKind === 'human'
					? localize('room.humanAuthor', "{0} (human)", message.authorName) : message.authorName;
				const metadata = element.appendChild($('.room-message-meta'));
				const body = element.appendChild($('.room-message-body'));
				const rendered = disposables.add(new MutableDisposable<IRenderedMarkdown>());
				this.button(element, localize('room.reply', "Reply"), () => {
					if (message.authorKind === 'agent' && !this.input.value.trim()) {
						this.input.value = `@${message.authorName} `;
					}
					this.updateDraft(message.id);
					this.updateReply();
					this.input.focus();
				}, disposables);
				if (message.artifactId) {
					this.button(element, localize('room.reviewArtifact', "Review Published Artifact"), () => this.openArtifact(message.artifactId!), disposables);
				}
				const retry = message.authorKind === 'human' && (message.mentions.length || message.mode === 'steer')
					? this.button(element, localize('room.retryDelivery', "Retry Delivery"), () => this.collaborationService.retryMessage(message.id), disposables)
					: undefined;
				elements = { element, metadata, body, rendered, disposables, retry, text: undefined, message: undefined };
				this.messageElements.set(message.id, elements);
			}
			if (!equals(elements.message, message)) {
				elements.message = message;
				const date = new Date(message.timestamp).toLocaleString();
				const deliveries = this.deliveryLabels(message, this.collaborationService.activeRoom.get());
				const reply = message.replyTo ? localize('room.replyMetadata', "Reply to {0}", messages.find(candidate => candidate.id === message.replyTo)?.authorName ?? message.replyTo) : '';
				elements.metadata.textContent = [message.mode === 'steer' ? localize('room.humanGuidance', "Human guidance") : messageKindLabel(message.kind), date, reply, ...deliveries].filter(Boolean).join(' | ');
				elements.element.setAttribute('aria-label', localize('room.postLabel', "Post by {0}, {1}", message.authorName, date));
			}
			if (elements.retry) {
				elements.retry.hidden = !message.deliveries.some(delivery => ['pending', 'cancelled', 'failed'].includes(delivery.state));
				const state = this.collaborationService.activeRoom.get()?.state;
				elements.retry.disabled = state === 'paused' || state === 'stopping';
			}
			if (elements.text !== message.text) {
				elements.text = message.text;
				elements.rendered.value = this.markdownRenderer.render(new MarkdownString(message.text, { isTrusted: false, supportHtml: false }), {
					sanitizerConfig: { remoteImageIsAllowed: () => false },
				});
				elements.body.replaceChildren(elements.rendered.value.element);
			}
			const expected = previous ? previous.nextElementSibling : this.feed.firstElementChild;
			if (expected !== elements.element) {
				this.feed.insertBefore(elements.element, expected);
			}
			previous = elements.element;
		}
		this.restoreScrollPosition();
		const last = messages.at(-1);
		if (last && last.sequence > this.lastAnnouncedSequence) {
			if (this.lastAnnouncedSequence > 0 && this.roomViewService.visible.get()) {
				status(localize('room.newPost', "New room post from {0}", last.authorName));
			}
			this.lastAnnouncedSequence = last.sequence;
		}
	}

	private deliveryLabels(message: IAgentHostRoomMessage, room: IAgentHostRoom | undefined): string[] {
		if (message.authorKind === 'human' && message.mentions.length === 0 && message.mode !== 'steer') {
			return [localize('room.noRecipients', "Shared with room; no agents notified")];
		}
		return message.deliveries.map(delivery => {
			const name = room?.members.find(member => member.id === delivery.memberId)?.name ?? delivery.memberId;
			return localize('room.delivery', "{0}: {1}{2}", name, deliveryStateLabel(delivery.state), delivery.error ? ` (${delivery.error})` : '');
		});
	}

	private async openArtifact(artifactId: string): Promise<void> {
		const artifact = this.collaborationService.activeRoom.get()?.artifacts.find(artifact => artifact.id === artifactId);
		if (!artifact) {
			throw new Error(localize('room.artifactMissing', "The published artifact is no longer available in this room snapshot."));
		}
		const roomId = this.collaborationService.activeRoomId.get()!;
		const editor = await this.editorService.openEditor({
			resource: CollaborationArtifactProvider.resource(roomId, artifact),
			options: { pinned: true },
		});
		if (editor && !this._store.isDisposed && this.collaborationService.activeRoomId.get() === roomId) {
			this.roomViewService.close();
			editor.focus();
		}
	}

	private updateMentions(): void {
		this.mentionQuery = getCollaborationMentionQuery(this.input.value, this.input.selectionStart);
		this.suggestionMembers = this.mentionQuery
			? this.collaborationService.activeRoom.get()?.members.filter(member => member.name.toLowerCase().startsWith(this.mentionQuery!.query.toLowerCase())) ?? []
			: [];
		this.suggestionIndex = 0;
		this.suggestionDisposables.clear();
		this.suggestions.replaceChildren();
		for (const [index, member] of this.suggestionMembers.entries()) {
			const option = this.suggestions.appendChild($('li'));
			option.id = `${this.suggestionId}-${index}`;
			option.setAttribute('role', 'option');
			option.textContent = localize('room.mentionOption', "{0} - {1}", member.name, memberStateLabel(member.state));
			this.suggestionDisposables.add(addDisposableListener(option, EventType.MOUSE_DOWN, event => event.preventDefault()));
			this.suggestionDisposables.add(addDisposableListener(option, EventType.CLICK, () => {
				this.suggestionIndex = index;
				this.acceptMention();
			}));
		}
		this.updateSuggestionSelection();
	}

	private updateSuggestionSelection(): void {
		const shown = this.suggestionMembers.length > 0;
		this.suggestions.hidden = !shown;
		this.input.setAttribute('aria-expanded', String(shown));
		if (shown) {
			this.input.setAttribute('aria-activedescendant', `${this.suggestionId}-${this.suggestionIndex}`);
			for (const [index, child] of [...this.suggestions.children].entries()) {
				child.setAttribute('aria-selected', String(index === this.suggestionIndex));
			}
		} else {
			this.input.removeAttribute('aria-activedescendant');
		}
	}

	private acceptMention(): void {
		const member = this.suggestionMembers[this.suggestionIndex];
		if (!member || !this.mentionQuery) {
			return;
		}
		const currentQuery = getCollaborationMentionQuery(this.input.value, this.input.selectionStart);
		if (!currentQuery || !equals(currentQuery, this.mentionQuery)) {
			this.hideMentions();
			return;
		}
		const replacement = `@${member.name} `;
		this.input.setRangeText(replacement, this.mentionQuery.start, this.mentionQuery.end, 'end');
		this.updateDraft(this.currentDraft?.replyTo);
		this.hideMentions();
		this.input.focus();
	}

	private hideMentions(): void {
		this.suggestionMembers = [];
		this.mentionQuery = undefined;
		this.updateSuggestionSelection();
	}

	private onComposerKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) {
			return;
		}
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			event.stopPropagation();
			this.hideMentions();
			void this.perform(() => this.sendMessage('steer'), false);
			return;
		}
		if (event.key === 'Tab' && event.shiftKey) {
			this.hideMentions();
			return;
		}
		if (this.suggestionMembers.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'Escape') {
				this.hideMentions();
			} else if (event.key === 'Enter' || event.key === 'Tab') {
				this.acceptMention();
			} else {
				this.suggestionIndex = (this.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + this.suggestionMembers.length) % this.suggestionMembers.length;
				this.updateSuggestionSelection();
			}
		} else if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void this.perform(() => this.sendMessage(), false);
		} else if (event.key === 'Escape' && this.currentDraft?.replyTo) {
			event.preventDefault();
			this.updateDraft(undefined);
			this.updateReply();
		}
	}

	private textField(parent: HTMLElement, label: string): HTMLInputElement {
		const container = parent.appendChild($('label'));
		container.append(label);
		return container.appendChild($('input')) as HTMLInputElement;
	}

	private textArea(parent: HTMLElement, label: string): HTMLTextAreaElement {
		const container = parent.appendChild($('label'));
		container.append(label);
		return container.appendChild($('textarea')) as HTMLTextAreaElement;
	}

	private numberField(parent: HTMLElement, label: string, maximum?: number): HTMLInputElement {
		const field = this.textField(parent, label);
		field.type = 'number';
		field.min = '1';
		field.step = '1';
		field.required = true;
		if (maximum !== undefined) {
			field.max = String(maximum);
		}
		return field;
	}

	private button(parent: HTMLElement, label: string, action: () => void | Promise<void>, store: DisposableStore = this._store, exclusive = true): HTMLButtonElement {
		const button = parent.appendChild($('button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			void this.perform(action, exclusive && button !== this.send);
		}));
		return button;
	}

	private async perform(action: () => void | Promise<void>, busy = true): Promise<void> {
		if (busy && this.busy.get()) {
			return;
		}
		const roomId = this.collaborationService.activeRoomId.get();
		this.localError.set(undefined, undefined);
		try {
			const result = action();
			if (busy) {
				this.busy.set(true, undefined);
			}
			await result;
		} catch (error) {
			if (!isCancellationError(error) && !this._store.isDisposed && roomId === this.collaborationService.activeRoomId.get()) {
				const message = toErrorMessage(error);
				this.localError.set(message, undefined);
			}
		} finally {
			if (busy && !this._store.isDisposed) {
				this.busy.set(false, undefined);
			}
		}
	}

	focus(): void {
		if (this.collaborationService.activeRoomId.get() && !this.input.disabled) {
			this.input.focus();
		} else if (!this.collaborationService.activeRoomId.get() && !this.titleInput.disabled) {
			this.titleInput.focus();
		} else if (!this.retryLoad.hidden) {
			this.retryLoad.focus();
		} else {
			this.roomPicker.focus();
		}
	}

	restoreScrollPosition(): void {
		if (this.pendingScrollTop !== undefined) {
			if (this.feed.clientHeight > 0) {
				this.feed.scrollTop = this.pendingScrollTop;
				this.pendingScrollTop = undefined;
			}
		} else if (this.followingLatest) {
			this.feed.scrollTop = this.feed.scrollHeight;
		}
	}

	private saveScrollPosition(): void {
		if (this.previousRoomId) {
			this.roomViewService.saveScrollState({
				roomId: this.previousRoomId,
				scrollTop: this.pendingScrollTop ?? this.feed.scrollTop,
				followingLatest: this.followingLatest,
			});
		}
	}

	captureFocus(): () => void {
		const focused = getActiveElement();
		return () => {
			if (!this.roomViewService.visible.get()) {
				this.sessionsPartService.focusSession(this.sessionsService.activeSession.get());
				return;
			}
			const activeView = this.roomViewService.activeView.get();
			if (activeView && activeView !== this) {
				activeView.focus();
				return;
			}
			if (isHTMLElement(focused) && focused.isConnected && isAncestor(focused, this.element)) {
				focused.focus();
			} else {
				this.focus();
			}
		};
	}

	getAccessibleContent(): string {
		const room = this.collaborationService.activeRoom.get();
		if (!room) {
			return [
				localize('room.accessibleNew', "Agent Collab. Open a saved room or create a new collaboration room. Choose a local Git repository, committed base, model, goal, and one to ten equal Copilot peers. Create the room, then start the team or mention a peer. Turn and deadline limits are optional and unset by default."),
				...this.collaborationService.rooms.get().map(saved => localize('room.accessibleSavedRoom', "Saved room: {0}. {1}.", saved.title, roomStateLabel(saved.state))),
				this.notice.textContent ?? '',
			].join('\n\n');
		}
		return [
			localize('room.accessibleTitle', "{0}. {1}.", room.title, roomStateLabel(room.state)),
			localize('room.accessibleGoal', "Goal: {0}\nRules: {1}\nRepository: {2}\nPinned base: {3}", room.goal, room.instructions, room.repositoryUri, room.baseRevision),
			...room.members.map(member => localize('room.accessibleMember', "{0}: {1}. Activity: {2}. Reported work: {3}. Model: {4}. Worktree: {5}. {6}",
				member.name, memberStateLabel(member.state), member.activity ?? '', member.work?.description ?? '',
				member.model ?? localize('room.hostDefault', "Copilot host default"), member.worktreeUri ?? '', member.error ?? '')),
			...this.collaborationService.messages.get().messages.slice(-COLLABORATION_MESSAGE_PAGE_SIZE).map(message => localize('room.accessibleMessage', "{0}, {1}: {2}{3}\n{4}",
				message.authorName, new Date(message.timestamp).toLocaleString(), message.replyTo ? localize('room.accessibleReply', "Reply to {0}. ", message.replyTo) : '',
				[message.mode === 'steer' ? localize('room.humanGuidance', "Human guidance") : '', ...this.deliveryLabels(message, room)].filter(Boolean).join(', '), message.text)),
			...room.artifacts.map(artifact => localize('room.accessibleArtifact', "Published artifact: {0}. Base: {1}. Source: {2}.", artifact.title, artifact.baseRevision, artifact.sourceRevision)),
			this.notice.textContent ?? '',
		].join('\n\n');
	}

	private clearMessages(): void {
		this.messageDisposables.clear();
		this.messageElements.clear();
		this.feed.replaceChildren();
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		if (!this.collaborationService.activeRoomId.get()) {
			this.saveCreationDraft();
		}
		this.saveScrollPosition();
		this.clearMessages();
		super.dispose();
		this.element.remove();
	}
}
