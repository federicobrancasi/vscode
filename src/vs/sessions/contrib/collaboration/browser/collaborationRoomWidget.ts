/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../chat/browser/media/chatInput.css';
import './media/collaborationRoom.css';
import { $, getActiveElement, getWindow, isAncestor, isHTMLElement, trackFocus } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { toAction } from '../../../../base/common/actions.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { equals } from '../../../../base/common/objects.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomMessage, IAgentHostRoomMessagePage, MAX_ROOM_WORKERS } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { SessionModelInfo } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { isAgentHostProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ICollaborationRoomScrollState, ICollaborationRoomView, ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationRoomFocusedContext, ICollaborationRequest, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { CollaborationArtifactProvider } from './collaborationArtifactProvider.js';
import { collaborationAuthorAccent } from './collaborationColors.js';
import { CollaborationComposer } from './collaborationComposer.js';
import { CollaborationConfigurationPicker } from './collaborationConfigurationPicker.js';
import { CollaborationConversation, getCollaborationMessageAccessibleContent } from './collaborationConversation.js';
import { CollaborationHome } from './collaborationHome.js';
import { CollaborationModelCatalog, CollaborationModelPicker, getCollaborationMemberModelState } from './collaborationModelPicker.js';
import { CollaborationRequestWidget } from './collaborationRequestWidget.js';
import { memberStateLabel, roomStatusLabel } from './collaborationRoomLabels.js';
import { CollaborationRoomLayout } from './collaborationRoomLayout.js';
import { COLLABORATION_SETTINGS_CONTAINER_ID } from './collaborationSettingsView.js';
import { CollaborationTabs } from './collaborationTabs.js';

const RUN_TAB = 'run';
const AGENTS_TAB = 'agents';
const RULES_TAB = 'rules';
const APPROVALS_TAB = 'approvals';
const unsupportedMemberModelsMessage = localize('room.memberModelsUnavailable', "Reconnect or update the local agent host to choose a model for each peer.");

interface IMemberElements {
	readonly store: DisposableStore;
	readonly element: HTMLElement;
	readonly open: Button;
	readonly state: HTMLElement;
	readonly activity: HTMLElement;
	readonly model: CollaborationModelPicker;
	readonly error: HTMLElement;
	readonly stop: Button;
	readonly retry: Button;
	readonly remove: Button;
}

export class CollaborationRoomWidget extends Disposable implements ICollaborationRoomView {
	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly subtitle: HTMLElement;
	private readonly budgetStatus: HTMLElement;
	private readonly goalContent: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly retryLoad: Button;
	private readonly roster: HTMLElement;
	private readonly archivedSessions: HTMLElement;
	private readonly trustNotice: HTMLElement;
	private readonly trustMessage: HTMLElement;
	private readonly trustDirectories: HTMLElement;
	private readonly trustButton: Button;
	private readonly requestsSection: HTMLElement;
	private readonly requestsList: HTMLElement;
	private readonly feed: HTMLElement;
	private readonly historyControls: HTMLElement;
	private readonly historyStatus: HTMLElement;
	private readonly earlier: Button;
	private readonly latest: Button;
	private readonly restoreHidden: Button;
	private readonly inboxButton: Button;
	private readonly summaryButton: Button;
	private readonly layoutWidget: CollaborationRoomLayout;
	private readonly conversationPanel: HTMLElement;
	private readonly conversation: CollaborationConversation;
	private readonly composer: CollaborationComposer;
	private readonly panelButton: Button;
	private readonly attentionButton: Button;
	private readonly modelCatalog: CollaborationModelCatalog;
	private readonly home: CollaborationHome;
	private readonly tabs: CollaborationTabs;
	private readonly addMemberButton: Button;
	private readonly startButton: Button;
	private readonly extendButton: Button;
	private readonly pauseButton: Button;
	private readonly stopButton: Button;
	private readonly budgetField: HTMLElement;
	private readonly budgetLabel: HTMLLabelElement;
	private readonly turnBudget: InputBox;
	private readonly budgetValue = observableValue(this, '');
	private readonly budgetDrafts = new Map<string, string>();
	private readonly busy = observableValue(this, false);
	private readonly localError = observableValue<string | undefined>(this, undefined);
	private readonly memberElements = new Map<string, IMemberElements>();
	private readonly memberDisposables = this._register(new DisposableStore());
	private readonly archiveDisposables = this._register(new DisposableStore());
	private archivedSessionKey = '';
	private readonly requestElements = new Map<string, CollaborationRequestWidget>();
	private readonly requestDisposables = this._register(new DisposableStore());
	private readonly announcedDeliveryFailures = new Set<string>();
	private readonly scrollStates = new Map<string, ICollaborationRoomScrollState>();
	private followingLatest = true;
	private pendingScroll: ICollaborationRoomScrollState | undefined;
	private initialSelection = true;
	private previousRoomId: string | undefined;
	private previousInboxMemberId: string | undefined;
	private lastAnnouncedSequence = 0;
	private lastHeight = 0;
	private readonly navigationCancellation = new CancellationTokenSource();

	constructor(
		parent: HTMLElement,
		@ICollaborationService private readonly collaborationService: ICollaborationService,
		@ICollaborationRoomViewService private readonly roomViewService: ICollaborationRoomViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@IEditorService private readonly editorService: IEditorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService hoverService: IHoverService,
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
		this._register(toDisposable(() => focused.reset()));

		this.header = this.element.appendChild($('.room-header'));
		const headingContainer = this.header.appendChild($('.room-heading'));
		this.heading = headingContainer.appendChild($('h2'));
		this.subtitle = headingContainer.appendChild($('.room-subtitle'));
		this.budgetStatus = headingContainer.appendChild($('.room-budget-status'));
		this.budgetStatus.setAttribute('role', 'status');
		this._register(hoverService.setupDelayedHover(this.subtitle, () => {
			const room = this.collaborationService.activeRoom.get();
			return { content: room ? localize('room.repositorySummary', "{0}\nGoal: {1}", room.repositoryUri, room.goal) : '' };
		}));
		this.layoutWidget = this._register(instantiationService.createInstance(CollaborationRoomLayout, this.element,
			() => this.conversation?.layout(this.feed.clientWidth, this.feed.clientHeight)));
		this.conversationPanel = this.layoutWidget.main.appendChild($('.room-conversation-panel'));
		const filters = this.conversationPanel.appendChild($('.room-history-filter'));
		this.inboxButton = this.button(filters, localize('room.allMessages', "All Messages"), () => this.chooseInbox(), this._store, false);
		this.inboxButton.element.setAttribute('aria-haspopup', 'menu');
		this.summaryButton = this.button(filters, localize('room.askSummary', "Ask for Summary"), () => this.askForSummary());

		this.tabs = this._register(new CollaborationTabs(this.layoutWidget.panelHeader, () => { }));
		const tabContent = this.layoutWidget.panelContent.appendChild($('.room-tab-content'));
		const runPanel = tabContent.appendChild($('.room-tab-panel'));
		this.tabs.registerPanel(RUN_TAB, runPanel);
		this.budgetField = runPanel.appendChild($('.room-budget-field'));
		this.budgetLabel = this.budgetField.appendChild($('label.room-budget-label'));
		this.turnBudget = this._register(new InputBox(this.budgetField, contextViewService, {
			type: 'number', inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('room.turnBudget', "Turn budget"),
			placeholder: localize('room.turnBudgetPlaceholder', "Choose a finite number of turns"),
		}));
		this.turnBudget.inputElement.id = `room-turn-budget-${generateUuid()}`;
		this.turnBudget.inputElement.min = '1';
		this.turnBudget.inputElement.step = '1';
		this.budgetLabel.htmlFor = this.turnBudget.inputElement.id;
		this.budgetField.appendChild($('p.room-hint')).textContent = localize('room.budgetDisclaimer', "A turn budget limits automatic turns, not tokens or currency. Reserved input batches consume turns before preparation and native submission. Sending, opening, or resuming does not add turns.");
		this._register(this.turnBudget.onDidChange(value => {
			this.budgetValue.set(value, undefined);
			if (this.previousRoomId) {
				this.budgetDrafts.set(this.previousRoomId, value);
			}
		}));
		const runControls = runPanel.appendChild($('.room-run-controls-host'));
		this.startButton = this.button(runControls, localize('room.start', "Start"), () => this.startRun());
		this.startButton.element.classList.add('room-start');
		this.extendButton = this.button(runControls, localize('room.extend', "Extend"), () => this.extendRun());
		this.extendButton.element.classList.add('room-extend');
		this.pauseButton = this.button(runControls, localize('room.pause', "Pause"), () => this.collaborationService.pauseRoom());
		this.stopButton = this.button(runControls, localize('room.stop', "Stop All"), () => this.collaborationService.stopRoom());
		this.attentionButton = this.button(runControls, localize('room.attention', "Needs Attention"), () => this.revealAttention(), this._store, false);
		this.panelButton = this.button(this.header, localize('room.panelTitle', "Room Settings"), () => this.revealSettings(), this._store, false);
		this.layoutWidget.panel.id = `collaboration-panel-${generateUuid()}`;
		this.panelButton.element.setAttribute('aria-controls', this.layoutWidget.panel.id);
		this.modelCatalog = this._register(instantiationService.createInstance(CollaborationModelCatalog, collaborationService.models, error => {
			this.localError.set(toErrorMessage(error), undefined);
		}));
		const agentsPanel = tabContent.appendChild($('.room-tab-panel'));
		this.tabs.registerPanel(AGENTS_TAB, agentsPanel);
		this.roster = agentsPanel.appendChild($('.room-roster'));
		this.roster.setAttribute('role', 'list');
		this.roster.setAttribute('aria-label', localize('room.participants', "Copilot peers and current activity"));
		this.archivedSessions = agentsPanel.appendChild($('.room-archived-sessions'));
		this.archivedSessions.setAttribute('role', 'list');
		this.archivedSessions.setAttribute('aria-label', localize('room.archivedSessions', "Archived sessions"));
		this.addMemberButton = this.button(agentsPanel, localize('room.addMember', "Add Agent"), () => this.collaborationService.addMember());
		this.addMemberButton.element.classList.add('room-add-member');
		this.addMemberButton.element.setAttribute('aria-description', localize('room.addMemberDescription', "Adds a peer with its own session and worktree. Any automatic turn requires an authorized run and remaining budget."));

		const rulesPanel = tabContent.appendChild($('.room-tab-panel'));
		this.tabs.registerPanel(RULES_TAB, rulesPanel);
		this._register(instantiationService.createInstance(CollaborationConfigurationPicker, rulesPanel, error => {
			if (!isCancellationError(error)) {
				this.localError.set(toErrorMessage(error), undefined);
			}
		}));
		this.goalContent = rulesPanel.appendChild($('dl.room-goal'));
		this.notice = this.conversationPanel.appendChild($('.room-notice'));
		this.notice.setAttribute('role', 'status');
		this.retryLoad = this.button(this.conversationPanel, localize('room.reload', "Retry Loading"), async () => {
			if (this.collaborationService.availability.get() === 'available') {
				await this.collaborationService.loadMessages();
			} else {
				await this.collaborationService.refresh();
			}
		});
		const attention = tabContent.appendChild($('.room-tab-panel.room-attention'));
		this.tabs.registerPanel(APPROVALS_TAB, attention);
		this.trustNotice = attention.appendChild($('section.room-trust'));
		this.trustMessage = this.trustNotice.appendChild($('p'));
		this.trustMessage.setAttribute('role', 'status');
		const trustDetails = this.trustNotice.appendChild($('details'));
		trustDetails.appendChild($('summary')).textContent = localize('room.trustDirectories', "Source repository and participant worktrees");
		this.trustDirectories = trustDetails.appendChild($('pre'));
		this.trustDirectories.tabIndex = 0;
		this.trustDirectories.setAttribute('aria-label', localize('room.trustDirectories', "Source repository and participant worktrees"));
		this.trustButton = this.button(this.trustNotice, localize('room.trustWorkspace', "Trust Room Workspace"), () => this.collaborationService.requestWorkspaceTrust(), this._store, false);
		this.requestsSection = attention.appendChild($('section.room-requests'));
		this.requestsSection.appendChild($('h3')).textContent = localize('room.requestsHeading', "Approvals and questions");
		this.requestsList = this.requestsSection.appendChild($('.room-request-list'));

		this.home = this._register(instantiationService.createInstance(CollaborationHome, this.layoutWidget.main, this.modelCatalog, {
			isRepository: folderUri => this.collaborationService.isRepository(folderUri),
			confirmInitialize: path => this.confirmInitializeFolder(path),
			browseForFolder: current => this.browseForFolder(current),
			create: options => this.createRoom(options),
			open: roomId => this.perform(() => this.collaborationService.selectRoom(roomId)),
			readDraft: () => {
				const draft = this.roomViewService.creationDraft.get();
				return {
					goal: draft?.goal ?? '', folder: draft?.repositoryUri ? URI.parse(draft.repositoryUri).fsPath : '',
					count: draft?.workerCount ?? '3', instructions: draft?.instructions ?? '', baseRevision: draft?.baseRevision ?? '',
					memberNames: draft?.memberNames ?? [],
					memberModels: draft?.memberModels ?? (draft?.model ? Array.from({ length: MAX_ROOM_WORKERS }, () => ({ id: draft.model })) : []),
				};
			},
			saveDraft: draft => this.roomViewService.saveCreationDraft(draft && {
				title: '', goal: draft.goal, instructions: draft.instructions,
				repositoryUri: draft.folder ? URI.file(draft.folder).toString() : undefined,
				baseRevision: draft.baseRevision, workerCount: draft.count, model: '',
				memberNames: draft.memberNames, memberModels: draft.memberModels,
			}),
		}));
		this.historyStatus = this.conversationPanel.appendChild($('.room-history-status'));
		this.historyStatus.setAttribute('role', 'status');
		this.feed = this.conversationPanel.appendChild($('.room-feed'));
		this.conversation = this._register(instantiationService.createInstance(CollaborationConversation, this.feed, {
			reply: message => this.composer.replyTo(message),
			inspectParticipant: participantId => { void this.perform(() => this.openParticipant(participantId)); },
			openArtifact: artifactId => { void this.perform(() => this.openArtifact(artifactId)); },
			retry: messageId => { void this.perform(() => this.collaborationService.retryMessage(messageId)); },
			hide: message => { void this.perform(() => this.hideMessage(message), false); },
		}));
		this.historyControls = this.conversationPanel.appendChild($('.room-history-controls'));
		this.earlier = this.button(this.historyControls, localize('room.earlier', "Load Earlier Messages"), () => this.collaborationService.loadEarlierMessages(), this._store, false);
		this.latest = this.button(this.historyControls, localize('room.latest', "Jump to Latest"), async () => {
			await this.collaborationService.loadMessages();
			this.followingLatest = true;
			this.conversation.revealLatest();
		}, this._store, false);
		this.restoreHidden = this.button(this.historyControls, localize('room.restoreHidden', "Show Hidden Messages"), () => {
			const roomId = this.collaborationService.activeRoomId.get();
			if (roomId) {
				this.roomViewService.restoreHiddenMessages(roomId);
				this.focus();
				status(localize('room.messagesRestored', "Hidden messages are visible again."));
			}
		}, this._store, false);
		this._register(this.conversation.onDidScroll(() => {
			if (this.pendingScroll !== undefined) {
				return;
			}
			this.followingLatest = this.conversation.isFollowingLatest;
			this.updateHistoryControls(this.collaborationService.messages.get(), this.collaborationService.activeRoom.get());
			this.saveScrollPosition();
			if (this.conversation.scrollTop < 120 && !this.followingLatest && this.collaborationService.messages.get().hasEarlier
				&& !this.collaborationService.loadingEarlier.get()) {
				void this.perform(() => this.collaborationService.loadEarlierMessages(), false);
			}
		}));
		this.composer = this._register(instantiationService.createInstance(CollaborationComposer, this.conversationPanel, () => {
			this.localError.set(undefined, undefined);
			this.followingLatest = true;
			this.conversation.revealLatest();
		}, error => this.localError.set(toErrorMessage(error), undefined)));
		const updateHint = () => {
			const keybinding = this.keybindingService.lookupKeybinding('editor.action.accessibilityHelp')?.getAriaLabel();
			if (this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.CollaborationRoom) && keybinding) {
				this.element.setAttribute('aria-description', localize('room.accessibilityHint', "Press {0} for collaboration accessibility help.", keybinding));
			} else {
				this.element.removeAttribute('aria-description');
			}
		};
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.CollaborationRoom)) {
				updateHint();
			}
		}));
		this._register(keybindingService.onDidUpdateKeybindings(updateHint));
		updateHint();
		this.observeState();
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layout(this.element.clientWidth, this.lastHeight || this.element.clientHeight));
		this._register(toDisposable(() => observer.disconnect()));
		observer.observe(this.element);
		observer.observe(this.header);
	}

	private observeState(): void {
		this._register(autorun(reader => {
			const id = this.collaborationService.activeRoomId.read(reader);
			const inbox = this.collaborationService.inboxMemberId.read(reader);
			const saved = this.initialSelection ? this.roomViewService.scrollState.read(undefined) : undefined;
			this.initialSelection = false;
			if (id !== this.previousRoomId || inbox !== this.previousInboxMemberId) {
				this.saveScrollPosition();
				if (id !== this.previousRoomId) {
					this.memberDisposables.clear();
					this.memberElements.clear();
					this.roster.replaceChildren();
					this.previousRoomId = id;
					this.turnBudget.value = id ? this.budgetDrafts.get(id) ?? '' : '';
				}
				this.previousInboxMemberId = inbox;
				const scroll = this.scrollStates.get(JSON.stringify([id, inbox])) ?? (saved?.roomId === id && saved?.inboxMemberId === inbox ? saved : undefined);
				this.conversation.setMessages([], undefined);
				this.followingLatest = scroll?.followingLatest ?? true;
				this.pendingScroll = scroll;
				this.lastAnnouncedSequence = 0;
				this.announcedDeliveryFailures.clear();
				this.localError.set(undefined, undefined);
			}
		}));
		this._register(autorun(reader => {
			const room = this.collaborationService.activeRoom.read(reader);
			const trust = this.collaborationService.workspaceTrust.read(reader);
			const writable = this.collaborationService.canSend.read(reader) && !room?.archived;
			const available = this.collaborationService.availability.read(reader) === 'available';
			const requests = room?.archived ? [] : this.collaborationService.requests.read(reader);
			this.trustNotice.hidden = !room || room.archived === true || trust.state === 'trusted' || !writable;
			this.trustMessage.textContent = trust.error ?? (trust.state === 'requesting'
				? localize('room.trustRequesting', "Confirm workspace trust for the source repository. Each peer uses a separate local worktree.")
				: trust.state === 'checking' ? localize('room.trustChecking', "Checking trust for the room workspace...")
					: localize('room.trustNotice', "Trust the source repository before running agents or sending addressed messages. One decision covers only this room's exact local peer worktrees. Reading history remains available."));
			this.trustMessage.classList.toggle('error', !!trust.error);
			this.trustDirectories.textContent = [trust.repositoryUri ?? room?.repositoryUri, ...(trust.worktreeUris ?? room?.members.flatMap(member => member.worktreeUri ? [member.worktreeUri] : []) ?? [])].filter(Boolean).join('\n');
			this.trustButton.enabled = writable && available && trust.state !== 'checking' && trust.state !== 'requesting';
			this.requestsSection.hidden = !requests.length;
			this.renderRequests(requests, !writable || !available);
			this.updateTabs(room, requests);
			const count = requests.length + (this.trustNotice.hidden ? 0 : 1) + (room?.archived ? 0 : room?.members.filter(member => member.error || member.modelError || member.state === 'failed').length ?? 0);
			this.attentionButton.element.hidden = !count;
			this.attentionButton.label = localize('room.attentionCount', "Needs Attention ({0})", count);
		}));
		this._register(autorun(reader => {
			const room = this.collaborationService.activeRoom.read(reader);
			const roomId = this.collaborationService.activeRoomId.read(reader);
			const available = this.collaborationService.availability.read(reader) === 'available';
			const canSend = this.collaborationService.canSend.read(reader);
			const writable = available && canSend && !room?.archived;
			const busy = this.busy.read(reader);
			const activeMembers = room?.members.filter(member => !member.removed) ?? [];
			this.heading.textContent = room?.title ?? '';
			this.header.classList.toggle('room-header-empty', !room);
			this.subtitle.textContent = room ? localize('room.summary', "{0} | {1} peers | Base {2}", roomStatusLabel(room), room.archived ? room.members.length : activeMembers.length, room.baseRevision.slice(0, 8)) : '';
			const maximum = room?.run?.limits.maxTurns;
			const remaining = maximum === undefined ? undefined : Math.max(0, maximum - (room?.run?.admittedTurns ?? 0));
			this.budgetStatus.hidden = !room;
			this.budgetStatus.textContent = !room ? ''
				: room.archived ? localize('room.archiveBudget', "Archived experiment. No work can be started.")
					: maximum !== undefined ? localize('room.remainingBudget', "{0} turns remaining of {1}", remaining, maximum)
						: localize('room.noBudget', "No run authorized. Choose a turn budget before Start.");
			this.renderRoomRules(room);
			this.home.element.hidden = !!roomId;
			this.conversationPanel.hidden = !roomId;
			this.panelButton.element.hidden = !room;
			this.layoutWidget.element.classList.toggle('room-no-panel', !room);
			const budget = Number(this.budgetValue.read(reader));
			const validBudget = Number.isSafeInteger(budget) && budget > 0;
			this.budgetField.hidden = !room;
			const budgetLabel = room?.run ? localize('room.additionalTurns', "Additional turns") : localize('room.turnBudget', "Turn budget");
			this.budgetLabel.textContent = budgetLabel;
			this.turnBudget.setAriaLabel(budgetLabel);
			this.turnBudget.setEnabled(writable && !busy);
			this.startButton.label = room?.run ? localize('room.resume', "Resume") : localize('room.start', "Start");
			const exhausted = remaining === 0 || room?.pauseReason === 'budget';
			this.startButton.element.hidden = !room || room.state === 'running' || room.state === 'stopping' || exhausted;
			this.startButton.enabled = writable && !busy && !!room && ['created', 'idle', 'paused', 'stopped', 'interrupted'].includes(room.state)
				&& (room.run ? remaining !== undefined && remaining > 0 : validBudget);
			this.extendButton.element.hidden = !room?.run;
			this.extendButton.enabled = writable && !busy && !!room?.run && room.state !== 'stopping' && validBudget;
			this.pauseButton.element.hidden = !room || !['running', 'idle'].includes(room.state);
			this.stopButton.element.hidden = !room || ['created', 'stopped', 'stopping'].includes(room.state);
			this.pauseButton.enabled = writable && !busy;
			this.stopButton.enabled = writable && !busy;
			this.addMemberButton.element.hidden = !room || room.state === 'stopping';
			this.addMemberButton.enabled = writable && !busy && activeMembers.length < MAX_ROOM_WORKERS;
			this.addMemberButton.setTitle(activeMembers.length >= MAX_ROOM_WORKERS
				? localize('room.addMemberFull', "A room can hold at most {0} agents.", MAX_ROOM_WORKERS) : '');
			this.summaryButton.enabled = writable && !busy && !this.collaborationService.sending.read(reader) && activeMembers.length > 0;
			const inbox = this.collaborationService.inboxMemberId.read(reader);
			this.inboxButton.label = inbox
				? localize('room.inboxLabel', "Inbox: {0}", room?.members.find(member => member.id === inbox)?.name ?? inbox)
				: localize('room.allMessages', "All Messages");
			this.inboxButton.enabled = available && !!room;
			const supportsModels = this.collaborationService.canSetMemberModel.read(reader);
			const models = this.collaborationService.models.read(reader);
			this.home.setDisabled(busy || this.collaborationService.creating.read(reader) || !available || !canSend, supportsModels ? undefined : unsupportedMemberModelsMessage);
			if (room) {
				this.renderRoster(room, busy || !writable, models);
			}
			this.renderArchivedSessions(room);
		}));
		this._register(autorun(reader => {
			const page = this.collaborationService.messages.read(reader);
			const room = this.collaborationService.activeRoom.read(reader);
			const canSend = this.collaborationService.canSend.read(reader) && this.collaborationService.availability.read(reader) === 'available';
			const inbox = this.collaborationService.inboxMemberId.read(reader);
			const loadingEarlier = this.collaborationService.loadingEarlier.read(reader);
			this.historyStatus.hidden = !loadingEarlier;
			this.historyStatus.textContent = loadingEarlier ? localize('room.loadingEarlier', "Loading earlier messages...") : '';
			this.earlier.enabled = !loadingEarlier && this.collaborationService.availability.read(reader) === 'available';
			const hidden = room ? this.roomViewService.hiddenMessages.read(reader).get(room.id) : undefined;
			const addressedMessages = inbox ? page.messages.filter(message => message.mentions.includes(inbox)) : page.messages;
			const messages = addressedMessages.filter(message => !hidden?.has(message.id));
			this.restoreHidden.element.hidden = !hidden?.size;
			this.updateHistoryControls(page, room);
			this.conversation.setMessages(messages, room, canSend);
			for (const message of messages) {
				for (const delivery of message.deliveries.filter(delivery => delivery.state === 'failed' || delivery.state === 'interrupted')) {
					const key = `${room?.id}:${message.id}:${delivery.memberId}:${delivery.state}:${delivery.error ?? ''}`;
					if (!this.announcedDeliveryFailures.has(key)) {
						this.announcedDeliveryFailures.add(key);
						if (!room?.archived && this.lastAnnouncedSequence > 0 && this.roomViewService.visible.read(reader)) {
							status(localize('room.deliveryFailed', "Message delivery to {0} needs attention. {1}", room?.members.find(member => member.id === delivery.memberId)?.name ?? delivery.memberId, delivery.error ?? ''));
						}
					}
				}
			}
			this.restoreScrollPosition();
			const last = addressedMessages.at(-1);
			if (last && last.sequence > this.lastAnnouncedSequence) {
				if (!hidden?.has(last.id) && this.lastAnnouncedSequence > 0 && this.roomViewService.visible.read(reader)) {
					status(localize('room.newPost', "New room post from {0}", last.authorName));
				}
				this.lastAnnouncedSequence = last.sequence;
			}
		}));
		this._register(autorun(reader => {
			const availability = this.collaborationService.availability.read(reader);
			const room = this.collaborationService.activeRoom.read(reader);
			const error = this.localError.read(reader) ?? this.collaborationService.error.read(reader)
				?? this.collaborationService.requestError.read(reader) ?? this.collaborationService.availabilityError.read(reader) ?? room?.error;
			const loading = this.collaborationService.loading.read(reader);
			this.notice.textContent = error ?? (room?.archived
				? localize('room.archiveNotice', "Read-only archive. Messages, session links, worktrees, and published patches are preserved. Opening this room never resumes work.")
				: availability === 'connecting' ? localize('room.connecting', "Connecting to the local agent host...")
					: availability !== 'available' ? localize('room.offline', "Collaboration is unavailable. Peer status may be out of date; reconnect before taking action.")
						: loading ? localize('room.loading', "Loading room history...") : '');
			this.notice.hidden = !this.notice.textContent;
			this.notice.classList.toggle('error', !!error);
			this.retryLoad.element.hidden = !error && availability !== 'error' && availability !== 'unavailable';
			this.element.setAttribute('aria-busy', String(loading));
		}));
	}

	private hideMessage(message: IAgentHostRoomMessage): void {
		const room = this.collaborationService.activeRoom.get();
		if (!room || room.archived || message.authorKind === 'agent'
			|| !this.collaborationService.messages.get().messages.some(candidate => candidate.id === message.id)) {
			throw new Error(localize('room.hideUnavailable', "This message is no longer available to hide."));
		}
		this.roomViewService.hideMessage(room.id, message.id);
		this.focus();
		status(localize('room.messageHidden', "Message hidden for you. Room history and agent delivery are unchanged."));
	}

	private chooseInbox(): void {
		const room = this.collaborationService.activeRoom.get();
		if (!room) {
			return;
		}
		const choices = [
			{ id: undefined, label: localize('room.allMessages', "All Messages") },
			...room.members.map(member => ({ id: member.id, label: localize('room.inboxLabel', "Inbox: {0}", member.name) })),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.inboxButton.element,
			getActions: () => choices.map(choice => toAction({
				id: choice.id ?? 'all', label: choice.label, checked: choice.id === this.collaborationService.inboxMemberId.get(),
				run: () => this.perform(async () => {
					if (room.id === this.collaborationService.activeRoomId.get()) {
						await this.collaborationService.selectInbox(choice.id);
					}
				}, false),
			})),
			onHide: () => this.inboxButton.focus(),
		});
	}

	private async askForSummary(): Promise<void> {
		const room = this.collaborationService.activeRoom.get();
		if (!room) {
			return;
		}
		const choice = await this.quickInputService.pick(room.members.filter(member => !member.removed).map(member => ({
			label: member.name, description: memberStateLabel(member.state), memberId: member.id,
		})), {
			title: localize('room.askSummary', "Ask for Summary"),
			placeHolder: localize('room.summaryPeer', "Choose an existing peer. This is a shared inbox message using the current turn budget."),
		});
		if (choice && room.id === this.collaborationService.activeRoomId.get() && !this._store.isDisposed) {
			await this.collaborationService.askForSummary(choice.memberId);
		}
	}

	private async startRun(): Promise<void> {
		const room = this.collaborationService.activeRoom.get();
		if (!room) {
			return;
		}
		await this.collaborationService.startRoom(room.run ? {} : { maxTurns: Number(this.turnBudget.value) });
		if (!this._store.isDisposed && this.roomViewService.visible.get() && this.collaborationService.activeRoomId.get() === room.id) {
			this.turnBudget.value = '';
			this.composer.focus();
		}
	}

	private async extendRun(): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		await this.collaborationService.extendRun(Number(this.turnBudget.value));
		if (!this._store.isDisposed && roomId === this.collaborationService.activeRoomId.get()) {
			this.turnBudget.value = '';
		}
	}

	private renderRoomRules(room: IAgentHostRoom | undefined): void {
		this.goalContent.replaceChildren();
		if (!room) {
			return;
		}
		for (const [label, value] of [
			[localize('room.ruleGoal', "Goal"), room.goal],
			[localize('room.ruleInstructions', "Rules"), room.instructions],
			[localize('room.ruleRepository', "Folder"), URI.parse(room.repositoryUri).fsPath],
			[localize('room.ruleBase', "Pinned base"), room.baseRevision],
		] as const) {
			if (value) {
				this.goalContent.appendChild($('dt')).textContent = label;
				this.goalContent.appendChild($('dd')).textContent = value;
			}
		}
	}

	private updateTabs(room: IAgentHostRoom | undefined, requests: readonly ICollaborationRequest[]): void {
		this.tabs.element.hidden = !room;
		if (!room) {
			this.tabs.select(undefined);
			return;
		}
		const attention = requests.length + (this.trustNotice.hidden ? 0 : 1);
		const failing = room.archived ? 0 : room.members.filter(member => member.error || member.modelError || member.state === 'failed').length;
		this.tabs.setTabs([
			{ id: RUN_TAB, label: localize('room.tabRun', "Run") },
			{ id: AGENTS_TAB, label: localize('room.tabAgents', "Agents"), badge: failing || undefined },
			{ id: RULES_TAB, label: localize('room.tabRules', "Rules") },
			{ id: APPROVALS_TAB, label: localize('room.tabApprovals', "Approvals"), badge: attention || undefined },
		]);
	}

	private renderRoster(room: IAgentHostRoom, disabled: boolean, models: readonly SessionModelInfo[]): void {
		let restoreFocus = false;
		for (const [id, elements] of this.memberElements) {
			if (!room.members.some(member => member.id === id && (!member.removed || room.archived))) {
				restoreFocus ||= isAncestor(getActiveElement(), elements.element);
				this.memberDisposables.delete(elements.store);
				elements.element.remove();
				this.memberElements.delete(id);
			}
		}
		for (const member of room.members.filter(member => !member.removed || room.archived)) {
			let elements = this.memberElements.get(member.id);
			if (!elements) {
				const store = this.memberDisposables.add(new DisposableStore());
				const element = this.roster.appendChild($('.room-member'));
				element.setAttribute('role', 'listitem');
				const heading = element.appendChild($('.room-member-heading'));
				const open = this.button(heading, member.name, () => this.openParticipant(member.id), store);
				const state = heading.appendChild($('span.room-member-state'));
				const model = store.add(this.instantiationService.createInstance(CollaborationModelPicker, element, member.name, this.modelCatalog, async selection => {
					if (this.collaborationService.activeRoomId.get() !== room.id || this._store.isDisposed) {
						throw new CancellationError();
					}
					this.localError.set(undefined, undefined);
					try {
						await this.collaborationService.setMemberModel(member.id, selection);
					} catch (error) {
						if (!this._store.isDisposed && this.collaborationService.activeRoomId.get() === room.id && !isCancellationError(error)) {
							this.localError.set(toErrorMessage(error), undefined);
						}
						throw error;
					}
				}));
				const activity = element.appendChild($('.room-member-activity'));
				const error = element.appendChild($('.room-member-error'));
				const actions = heading.appendChild($('.room-member-actions'));
				const stop = this.button(actions, localize('room.stopPeer', "Stop"), () => this.collaborationService.stopMember(member.id), store);
				const retry = this.button(actions, localize('room.retryPeer', "Retry"), () => this.collaborationService.retryMember(member.id), store);
				const remove = this.button(actions, localize('room.removePeer', "Remove"), () => this.confirmRemoveMember(member.id), store);
				elements = { store, element, open, state, activity, model, error, stop, retry, remove };
				this.memberElements.set(member.id, elements);
			}
			elements.element.dataset.state = member.state;
			elements.open.element.style.color = collaborationAuthorAccent(room, member.id);
			const archivedSession = room.archived ? room.archivedSessions?.find(session => session.id === member.id) : undefined;
			const name = archivedSession?.name ?? member.name;
			elements.open.label = name;
			const hasSession = room.archived ? !!archivedSession : member.turns > 0;
			elements.open.enabled = hasSession;
			elements.open.setAriaLabel(room.archived
				? hasSession ? localize('room.inspectPeer', "Inspect {0}'s archived session", name)
					: localize('room.archiveSessionUnavailable', "No archived session link is available for {0}", name)
				: hasSession ? localize('room.openPeer', "Open {0}'s existing session for detailed activity and changes", member.name)
					: localize('room.openPeerWaiting', "{0} has not started yet, so it has no session to open", member.name));
			elements.open.setTitle(room.archived ? archivedSession?.worktreeUri ?? ''
				: hasSession ? member.worktreeUri ?? '' : localize('room.openPeerWaitingHint', "Opens once this peer takes its first turn."));
			elements.state.textContent = localize('room.memberSummary', "{0} | {1} turns", memberStateLabel(member.state), member.turns);
			elements.activity.textContent = member.activity ?? '';
			elements.activity.hidden = !elements.activity.textContent;
			const modelState = getCollaborationMemberModelState(member, models, !disabled && this.collaborationService.canSetMemberModel.get(), room.archived);
			elements.model.state.set(this.collaborationService.canSetMemberModel.get() || room.archived ? modelState : { ...modelState, detail: unsupportedMemberModelsMessage }, undefined);
			elements.error.textContent = member.error ?? '';
			elements.error.hidden = !member.error;
			const canResume = ['failed', 'stopped', 'interrupted', 'blocked'].includes(member.state);
			elements.stop.element.hidden = canResume;
			elements.stop.enabled = !disabled && !['stopping', 'pending'].includes(member.state);
			elements.stop.setAriaLabel(localize('room.stopPeerLabel', "Stop {0}", member.name));
			elements.retry.element.hidden = !canResume;
			elements.retry.enabled = !disabled && room.state !== 'stopping' && !!room.run && (room.run.limits.maxTurns ?? 0) > room.run.admittedTurns;
			const failed = ['failed', 'interrupted'].includes(member.state);
			elements.retry.label = failed ? localize('room.retryPeer', "Retry") : localize('room.resumePeer', "Resume");
			elements.retry.setAriaLabel(failed ? localize('room.retryPeerLabel', "Retry {0}", member.name) : localize('room.resumePeerLabel', "Resume {0}", member.name));
			elements.remove.element.hidden = room.members.filter(candidate => !candidate.removed).length <= 1;
			elements.remove.enabled = !disabled && room.state !== 'stopping';
			elements.remove.setAriaLabel(localize('room.removePeerLabel', "Remove {0} from the room", member.name));
		}
		if (restoreFocus) {
			this.focus();
		}
	}

	private renderArchivedSessions(room: IAgentHostRoom | undefined): void {
		const sessions = room?.archived ? room.archivedSessions?.filter(session => !room.members.some(member => member.id === session.id)) ?? [] : [];
		const key = JSON.stringify(sessions);
		if (key === this.archivedSessionKey) {
			return;
		}
		this.archivedSessionKey = key;
		this.archiveDisposables.clear();
		this.archivedSessions.replaceChildren();
		this.archivedSessions.hidden = !sessions.length;
		for (const session of sessions) {
			const row = this.archivedSessions.appendChild($('.room-member.room-archive-session'));
			row.setAttribute('role', 'listitem');
			this.button(row, localize('room.inspectSession', "Inspect {0}", session.name), () => this.openParticipant(session.id), this.archiveDisposables).setTitle(session.worktreeUri ?? '');
			if (session.worktreeUri) {
				row.appendChild($('.room-member-activity')).textContent = localize('room.archiveWorktree', "Worktree: {0}", session.worktreeUri);
			}
		}
	}

	private renderRequests(requests: readonly ICollaborationRequest[], disabled: boolean): void {
		const ids = new Set(requests.map(request => request.id));
		let restoreFocus = false;
		for (const [id, widget] of this.requestElements) {
			if (!ids.has(id)) {
				restoreFocus ||= widget.shouldRestoreFocus(getActiveElement());
				this.requestDisposables.delete(widget);
				this.requestElements.delete(id);
			}
		}
		let added = 0;
		for (const request of requests) {
			let widget = this.requestElements.get(request.id);
			if (!widget) {
				widget = this.requestDisposables.add(new CollaborationRequestWidget(this.requestsList, request, this.collaborationService, this.markdownRenderer, this.openerService));
				this.requestElements.set(request.id, widget);
				added++;
			}
			widget.update(request, disabled);
		}
		if (restoreFocus && this.roomViewService.visible.get()) {
			const next = [...this.requestElements.values()].map(widget => widget.getFocusTarget()).find(target => target !== undefined);
			if (next) {
				next.focus();
			} else {
				this.focus();
			}
		}
		if (added && this.roomViewService.visible.get()) {
			status(localize('room.approvals', "{0} new approval or input requests. Use Approvals and questions in this room to respond.", added));
		}
	}

	private async revealAttention(): Promise<void> {
		await this.revealSettings();
		const failed = this.collaborationService.activeRoom.get()?.members.find(member => member.error || member.modelError || member.state === 'failed');
		this.tabs.select(this.requestElements.size || !this.trustNotice.hidden || !failed ? APPROVALS_TAB : AGENTS_TAB);
		const request = [...this.requestElements.values()].map(widget => widget.getFocusTarget()).find(target => target);
		const member = failed ? this.memberElements.get(failed.id) : undefined;
		const target = request ?? (!this.trustNotice.hidden ? this.trustButton.element
			: failed?.modelError ? member?.model.element : member?.retry.enabled ? member.retry.element : member?.open.element);
		target?.scrollIntoView({ block: 'nearest' });
		target?.focus();
	}

	private async openParticipant(participantId: string): Promise<void> {
		const room = this.collaborationService.activeRoom.get();
		const participants = room?.archived ? room.archivedSessions : room?.members;
		const participant = participants?.find(participant => participant.id === participantId);
		if (!participant) {
			throw new Error(localize('room.participantLinkMissing', "No session link is available for this participant in the selected room."));
		}
		await this.openSession(participant.sessionUri, participant.chatUri);
	}

	private async openSession(sessionUri: string, chatUri: string | undefined): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		const provider = this.sessionsProvidersService.getProvider(LOCAL_AGENT_HOST_PROVIDER_ID);
		const target = provider && isAgentHostProvider(provider)
			? await provider.resolveSessionChat(URI.parse(sessionUri), chatUri ? URI.parse(chatUri) : undefined, this.navigationCancellation.token)
			: undefined;
		if (this._store.isDisposed || this.collaborationService.activeRoomId.get() !== roomId) {
			return;
		}
		if (!target) {
			throw new Error(this.collaborationService.activeRoom.get()?.archived
				? localize('room.archiveSessionNotReady', "This archived session is not available in the local session catalog. Its saved link and worktree are preserved; opening the archive never recreates or resumes it.")
				: localize('room.sessionNotReady', "This peer's session is not available in the local session catalog. Opening a room never creates a session. Start a budgeted run first, or retry after provisioning completes."));
		}
		await this.sessionsService.openChat(target.session, target.chat.resource);
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

	private updateHistoryControls(page: IAgentHostRoomMessagePage, room: IAgentHostRoom | undefined): void {
		const newPosts = this.collaborationService.inboxMemberId.get() ? 0 : (room?.latestMessageSequence ?? 0) - (page.messages.at(-1)?.sequence ?? 0);
		this.latest.element.hidden = this.followingLatest && !page.hasLater && newPosts <= 0;
		this.latest.label = newPosts > 0 ? localize('room.newPostsCount', "Show {0} New Posts", newPosts) : localize('room.latest', "Jump to Latest");
		this.earlier.element.hidden = !page.hasEarlier;
		this.historyControls.hidden = !room || (this.latest.element.hidden && this.earlier.element.hidden && this.restoreHidden.element.hidden);
	}

	private async browseForFolder(current: URI | undefined): Promise<URI | undefined> {
		const selected = await this.fileDialogService.showOpenDialog({
			title: localize('room.selectFolder', "Choose a Folder"),
			canSelectFiles: false, canSelectFolders: true, canSelectMany: false, availableFileSystems: [Schemas.file], defaultUri: current,
		});
		if (!selected?.[0] || this._store.isDisposed || this.collaborationService.activeRoomId.get()) {
			return undefined;
		}
		if (selected[0].scheme !== Schemas.file) {
			throw new Error(localize('room.localOnly', "Choose a local folder."));
		}
		return selected[0];
	}

	private async confirmInitializeFolder(path: string): Promise<boolean> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'question', message: localize('room.initializeFolder', "Set up this folder for collaboration?"),
			detail: localize('room.initializeFolderDetail', "{0}\n\nAgents each work in their own Git worktree, so this folder needs to be a Git repository. It will be initialized and its current contents committed as the starting point.", path),
			primaryButton: localize('room.initializeFolderConfirm', "Set Up Folder"),
		});
		return confirmed;
	}

	private async confirmRemoveMember(memberId: string): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		const member = this.collaborationService.activeRoom.get()?.members.find(candidate => candidate.id === memberId);
		if (!member) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning', message: localize('room.removePeerConfirm', "Remove {0} from this room?", member.name),
			detail: localize('room.removePeerDetail', "Any current turn is cancelled. Existing posts and published patches stay in the room, but the peer takes no further turns."),
			primaryButton: localize('room.removePeerAction', "Remove Agent"),
		});
		if (confirmed && roomId === this.collaborationService.activeRoomId.get() && !this._store.isDisposed) {
			await this.collaborationService.removeMember(memberId);
		}
	}

	private async createRoom(options: IAgentHostRoomCreateOptions): Promise<void> {
		if (options.memberModels?.some(model => model && !this.collaborationService.models.get().some(candidate => candidate.id === model.id))) {
			throw new Error(localize('room.modelUnavailable', "The selected model is no longer available. Choose a model from the current host catalog."));
		}
		if (this._store.isDisposed || this.collaborationService.activeRoomId.get() || !this.roomViewService.visible.get()) {
			return;
		}
		const draft = this.roomViewService.creationDraft.get();
		const room = await this.collaborationService.createRoom(options);
		if (equals(this.roomViewService.creationDraft.get(), draft)) {
			this.roomViewService.saveCreationDraft(undefined);
		}
		if (!this._store.isDisposed && this.roomViewService.visible.get() && this.collaborationService.activeRoomId.get() === room.id) {
			await this.revealSettings();
			this.tabs.select(RUN_TAB);
			this.turnBudget.focus();
		}
	}

	private button(parent: HTMLElement, label: string, action: () => void | Promise<void>, store: DisposableStore = this._store, exclusive = true): Button {
		const button = store.add(new Button(parent, { ...defaultButtonStyles, secondary: true }));
		button.label = label;
		store.add(button.onDidClick(() => { void this.perform(action, exclusive); }));
		return button;
	}

	private async perform(action: () => void | Promise<void>, busy = true): Promise<void> {
		if (busy && this.busy.get()) {
			return;
		}
		const roomId = this.collaborationService.activeRoomId.get();
		this.localError.set(undefined, undefined);
		try {
			if (busy) {
				this.busy.set(true, undefined);
			}
			await action();
		} catch (error) {
			if (!isCancellationError(error) && !this._store.isDisposed && roomId === this.collaborationService.activeRoomId.get()) {
				this.localError.set(toErrorMessage(error), undefined);
			}
		} finally {
			if (busy && !this._store.isDisposed) {
				this.busy.set(false, undefined);
			}
		}
	}

	focus(): void {
		if (!this.collaborationService.activeRoomId.get()) {
			this.home.focus();
		} else if (!this.composer.focus()) {
			if (!this.retryLoad.element.hidden) {
				this.retryLoad.focus();
			} else {
				this.conversation.focus();
			}
		}
	}

	private async revealSettings(): Promise<void> {
		await this.viewsService.openViewContainer(COLLABORATION_SETTINGS_CONTAINER_ID, true);
		this.layoutWidget.focusPanel();
	}

	layoutPanel(width: number, height: number): void {
		this.layoutWidget.layoutPanel(width, height);
	}

	layout(width: number, height: number): void {
		this.lastHeight = height;
		this.layoutWidget.layout(width, Math.max(0, height - this.header.offsetHeight));
		this.restoreScrollPosition();
	}

	restoreScrollPosition(): void {
		if (this.pendingScroll) {
			if (this.feed.clientHeight > 0 && this.conversation.length) {
				this.conversation.restoreScrollState(this.pendingScroll);
				this.pendingScroll = undefined;
			}
		} else if (this.followingLatest) {
			this.conversation.restoreScrollState({ roomId: this.previousRoomId ?? '', scrollTop: 0, followingLatest: true });
		}
	}

	private saveScrollPosition(): void {
		if (this.previousRoomId) {
			const state = { ...(this.pendingScroll ?? this.conversation.captureScrollState(this.previousRoomId)), inboxMemberId: this.previousInboxMemberId };
			this.scrollStates.set(JSON.stringify([this.previousRoomId, this.previousInboxMemberId]), state);
			this.roomViewService.saveScrollState(state);
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
			if (isHTMLElement(focused) && focused.isConnected && (isAncestor(focused, this.element) || isAncestor(focused, this.layoutWidget.panel))) {
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
				localize('room.accessibleNew', "Agent Collab. Describe the goal, choose a folder, and choose the peers and their models. Advanced holds shared rules and the Git branch. Creating or opening a room starts no paid work. Choose a finite turn budget before Start."),
				...this.collaborationService.rooms.get().map(saved => localize('room.accessibleSavedRoom', "Saved room: {0}. {1}.", saved.title, roomStatusLabel(saved))),
				this.notice.textContent ?? '',
			].join('\n\n');
		}
		const hidden = this.roomViewService.hiddenMessages.get().get(room.id);
		const inbox = this.collaborationService.inboxMemberId.get();
		return [
			localize('room.accessibleTitle', "{0}. {1}.", room.title, roomStatusLabel(room)),
			this.budgetStatus.textContent ?? '',
			localize('room.accessibleGoal', "Goal: {0}\nRules: {1}\nRepository: {2}\nPinned base: {3}", room.goal, room.instructions, room.repositoryUri, room.baseRevision),
			...room.members.map(member => {
				const model = getCollaborationMemberModelState(member, this.collaborationService.models.get(), this.collaborationService.canSetMemberModel.get(), room.archived);
				const archivedSession = room.archived ? room.archivedSessions?.find(session => session.id === member.id) : undefined;
				return localize('room.accessibleMember', "{0}: {1}. Activity: {2}. Selected model: {3}. {4} {5} Worktree: {6}. {7}",
					archivedSession?.name ?? member.name, memberStateLabel(member.state), member.activity ?? member.work?.description ?? '',
					model.selection?.id ?? localize('room.hostDefault', "Copilot host default"), model.detail ?? '', model.error ?? '',
					(room.archived ? archivedSession?.worktreeUri : member.worktreeUri) ?? '', member.error ?? '');
			}),
			...(this.trustNotice.hidden ? [] : [this.trustMessage.textContent ?? '', this.trustDirectories.textContent ?? '']),
			...[...this.requestElements.values()].map(request => request.getAccessibleContent()),
			String(this.inboxButton.label),
			...(hidden?.size ? [localize('room.accessibleHidden', "{0} messages hidden in this profile. Use Show Hidden Messages to restore them.", hidden.size)] : []),
			...this.collaborationService.messages.get().messages.filter(message => !hidden?.has(message.id) && (!inbox || message.mentions.includes(inbox)))
				.map(message => getCollaborationMessageAccessibleContent(message, room)),
			...room.artifacts.map(artifact => localize('room.accessibleArtifact', "Published artifact: {0}. Base: {1}. Source: {2}.", artifact.title, artifact.baseRevision, artifact.sourceRevision)),
			...(room.archivedSessions ?? []).map(session => localize('room.accessibleArchiveSession', "Archived session: {0}. Worktree: {1}. Inspection only.", session.name, session.worktreeUri ?? '')),
			this.notice.textContent ?? '',
		].join('\n\n');
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this.saveScrollPosition();
		this.conversation.setMessages([], undefined);
		super.dispose();
		this.element.remove();
	}
}
