/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/collaborationRoom.css';
import { $, addDisposableListener, EventType, getActiveElement, getWindow, isAncestor, isHTMLElement, trackFocus } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AgentHostRoomMessageMode, IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomMessagePage, MAX_ROOM_WORKERS } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { SessionModelInfo } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { isAgentHostProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ICollaborationRoomScrollState, ICollaborationRoomView, ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationRoomFocusedContext, ICollaborationRequest, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { getCollaborationMentionQuery, ICollaborationMentionQuery } from '../../../services/collaboration/common/collaborationMentions.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { deliveryStateLabel, memberStateLabel, roomStateLabel } from './collaborationRoomLabels.js';
import { CollaborationArtifactProvider } from './collaborationArtifactProvider.js';
import { CollaborationRequestWidget } from './collaborationRequestWidget.js';
import { CollaborationConfigurationPicker } from './collaborationConfigurationPicker.js';
import { CollaborationConversation } from './collaborationConversation.js';
import { CollaborationHome } from './collaborationHome.js';
import { CollaborationTabs } from './collaborationTabs.js';
import { CollaborationRoomLayout } from './collaborationRoomLayout.js';
import { CollaborationModelCatalog, CollaborationModelPicker, getCollaborationMemberModelState } from './collaborationModelPicker.js';
import { collaborationAuthorAccent } from './collaborationColors.js';

const RULES_TAB = 'rules';
const APPROVALS_TAB = 'approvals';

const unsupportedMemberModelsMessage = localize('room.memberModelsUnavailable', "Reconnect or update the local agent host to choose a model for each peer.");

interface IMemberElements {
	readonly element: HTMLElement;
	readonly open: HTMLButtonElement;
	readonly state: HTMLElement;
	readonly activity: HTMLElement;
	readonly model: CollaborationModelPicker;
	readonly error: HTMLElement;
	readonly stop: HTMLButtonElement;
	readonly retry: HTMLButtonElement;
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
	private readonly attention: HTMLElement;
	private readonly trustNotice: HTMLElement;
	private readonly trustMessage: HTMLElement;
	private readonly trustDirectories: HTMLElement;
	private readonly trustButton: HTMLButtonElement;
	private readonly requestsSection: HTMLElement;
	private readonly requestsList: HTMLElement;
	private readonly feed: HTMLElement;
	private readonly historyControls: HTMLElement;
	private readonly historyStatus: HTMLElement;
	private readonly latest: HTMLButtonElement;
	private readonly layoutWidget: CollaborationRoomLayout;
	private readonly conversation: CollaborationConversation;
	private readonly panelButton: HTMLButtonElement;
	private readonly attentionButton: HTMLButtonElement;
	private readonly modelCatalog: CollaborationModelCatalog;
	private readonly composer: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly send: HTMLButtonElement;
	private readonly steer: HTMLButtonElement;
	private readonly replyLabel: HTMLElement;
	private readonly cancelReply: HTMLButtonElement;
	private readonly suggestions: HTMLElement;
	private readonly home: CollaborationHome;
	private readonly tabs: CollaborationTabs;
	private readonly agentsPanel: HTMLElement;
	private readonly rulesPanel: HTMLElement;
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
	private readonly requestElements = new Map<string, CollaborationRequestWidget>();
	private readonly requestDisposables = this._register(new DisposableStore());
	private readonly suggestionDisposables = this._register(new DisposableStore());
	private readonly suggestionId = `collaboration-mentions-${generateUuid()}`;
	private suggestionMembers: readonly IAgentHostRoomMember[] = [];
	private suggestionIndex = 0;
	private mentionQuery: ICollaborationMentionQuery | undefined;
	private followingLatest = true;
	private pendingScroll: ICollaborationRoomScrollState | undefined;
	private initialSelection = true;
	private previousRoomId: string | undefined;
	private lastAnnouncedSequence = 0;
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
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@IEditorService private readonly editorService: IEditorService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
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
		this.layoutWidget = this._register(instantiationService.createInstance(CollaborationRoomLayout, this.element,
			() => this.conversation?.layout(this.feed.clientWidth, this.feed.clientHeight),
			visible => {
				this.panelButton?.setAttribute('aria-expanded', String(visible));
			}, () => this.panelButton.focus()));
		const panelHeader = this.layoutWidget.panelContent.appendChild($('.room-panel-header'));
		panelHeader.appendChild($('h3')).textContent = localize('room.panelTitle', "Room Settings");
		this.button(panelHeader, localize('room.closePanel', "Close"), () => {
			this.layoutWidget.setPanelVisible(false);
			this.panelButton.focus();
		}, this._store, false);
		const navigation = this.layoutWidget.panelContent.appendChild($('.room-navigation'));
		this.roomPicker = navigation.appendChild($('select')) as HTMLSelectElement;
		this.roomPicker.setAttribute('aria-label', localize('room.choose', "Choose collaboration room"));
		this._register(addDisposableListener(this.roomPicker, EventType.CHANGE, () => {
			void this.perform(() => this.collaborationService.selectRoom(this.roomPicker.value || undefined));
		}));
		this.button(navigation, localize('room.new', "New Room"), async () => {
			await this.collaborationService.selectRoom(undefined);
			this.layoutWidget.setPanelVisible(false);
			this.home.focus();
		});
		this.button(navigation, localize('room.back', "Back to Sessions"), () => {
			this.roomViewService.close();
		}, this._store, false);
		this.pauseButton = this.button(this.header, localize('room.pause', "Pause"), () => this.collaborationService.pauseRoom());
		this.stopButton = this.button(this.header, localize('room.stop', "Stop All"), () => this.collaborationService.stopRoom());
		this.attentionButton = this.button(this.header, localize('room.attention', "Needs Attention"), () => {
			this.layoutWidget.focusPanel();
			const failedMember = this.collaborationService.activeRoom.get()?.members.find(member => member.error || member.modelError || member.state === 'failed');
			this.tabs.select(this.requestElements.size || !this.trustNotice.hidden || !failedMember ? APPROVALS_TAB : `member:${failedMember.id}`);
			const target = [...this.requestElements.values()].map(widget => widget.getFocusTarget()).find(target => target);
			if (target) {
				target.scrollIntoView({ block: 'nearest' });
				target.focus();
			} else if (!this.trustNotice.hidden) {
				this.trustButton.scrollIntoView({ block: 'nearest' });
				this.trustButton.focus();
			} else {
				const failed = this.collaborationService.activeRoom.get()?.members.find(member => member.error || member.modelError || member.state === 'failed');
				const elements = failed ? this.memberElements.get(failed.id) : undefined;
				if (elements) {
					elements.element.scrollIntoView({ block: 'nearest' });
					(failed?.modelError ? elements.model.element : !elements.retry.hidden && !elements.retry.disabled ? elements.retry : elements.open).focus();
				}
			}
		}, this._store, false);
		this.panelButton = this.button(this.header, localize('room.panelTitle', "Room Settings"), () => {
			const visible = !this.layoutWidget.panelVisible;
			this.layoutWidget.setPanelVisible(visible);
			if (visible) {
				this.layoutWidget.focusPanel();
			}
		}, this._store, false);
		this.layoutWidget.panel.id = `collaboration-panel-${generateUuid()}`;
		this.panelButton.setAttribute('aria-controls', this.layoutWidget.panel.id);
		this.panelButton.setAttribute('aria-expanded', String(this.layoutWidget.panelVisible));
		this.panelButton.setAttribute('aria-description', localize('room.resizePanelHint', "When the side panel is open, use Left and Right Arrow to resize it."));
		this._register(addDisposableListener(this.panelButton, EventType.KEY_DOWN, event => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) {
				return;
			}
			const width = this.layoutWidget.resizePanel(event.key === 'ArrowLeft' ? 40 : -40);
			if (width !== undefined) {
				event.preventDefault();
				event.stopPropagation();
				status(localize('room.panelWidth', "Room settings width: {0} pixels.", width));
			}
		}));
		this.modelCatalog = this._register(instantiationService.createInstance(CollaborationModelCatalog, collaborationService.models, error => {
			this.localError.set(toErrorMessage(error), undefined);
		}));
		this.tabs = this._register(new CollaborationTabs(this.layoutWidget.panelContent, () => this.updateTabPanels()));
		const tabContent = this.layoutWidget.panelContent.appendChild($('.room-tab-content'));
		this.agentsPanel = tabContent.appendChild($('.room-tab-panel'));
		this.roster = this.agentsPanel.appendChild($('.room-roster'));
		this.roster.setAttribute('role', 'list');
		this.roster.setAttribute('aria-label', localize('room.participants', "Copilot peers and current activity"));
		this.rulesPanel = tabContent.appendChild($('.room-tab-panel'));
		this._register(instantiationService.createInstance(CollaborationConfigurationPicker, this.rulesPanel, error => {
			if (!isCancellationError(error)) {
				this.localError.set(toErrorMessage(error), undefined);
			}
		}));
		this.goalDetails = this.rulesPanel.appendChild($('details.room-goal')) as HTMLDetailsElement;
		this.goalDetails.open = true;
		this.goalDetails.appendChild($('summary')).textContent = localize('room.goalAndRules', "Shared goal, rules, and baseline");
		this.goalContent = this.goalDetails.appendChild($('p'));
		this.tabs.registerPanel(RULES_TAB, this.rulesPanel);

		this.notice = this.layoutWidget.main.appendChild($('.room-notice'));
		this.notice.setAttribute('role', 'status');
		this.retryLoad = this.button(this.layoutWidget.main, localize('room.reload', "Retry Loading"), async () => {
			if (this.collaborationService.availability.get() === 'available') {
				await this.collaborationService.loadMessages();
				if (!this.followingLatest && this.conversation.scrollTop < 120 && this.collaborationService.messages.get().hasEarlier) {
					await this.collaborationService.loadEarlierMessages();
				}
			} else {
				await this.collaborationService.refresh();
			}
		});
		this.attention = tabContent.appendChild($('.room-tab-panel.room-attention'));
		this.trustNotice = this.attention.appendChild($('section.room-trust'));
		this.trustMessage = this.trustNotice.appendChild($('p'));
		this.trustMessage.setAttribute('role', 'status');
		const trustDetails = this.trustNotice.appendChild($('details'));
		trustDetails.appendChild($('summary')).textContent = localize('room.trustDirectories', "Source repository and peer worktrees");
		this.trustDirectories = trustDetails.appendChild($('pre'));
		this.trustDirectories.tabIndex = 0;
		this.trustDirectories.setAttribute('aria-label', localize('room.trustDirectories', "Source repository and peer worktrees"));
		this.trustButton = this.button(this.trustNotice, localize('room.trustWorkspace', "Trust Room Workspace"), () => this.collaborationService.requestWorkspaceTrust(), this._store, false);
		this.requestsSection = this.attention.appendChild($('section.room-requests'));
		this.requestsSection.appendChild($('h3')).textContent = localize('room.requestsHeading', "Approvals and questions");
		this.requestsList = this.requestsSection.appendChild($('.room-request-list'));
		this.tabs.registerPanel(APPROVALS_TAB, this.attention);

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
					memberModels: draft?.memberModels ?? (draft?.model ? Array.from({ length: MAX_ROOM_WORKERS }, () => ({ id: draft.model })) : []),
				};
			},
			saveDraft: draft => this.roomViewService.saveCreationDraft(draft && {
				title: '', goal: draft.goal, instructions: draft.instructions,
				repositoryUri: draft.folder ? URI.file(draft.folder).toString() : undefined,
				baseRevision: draft.baseRevision, workerCount: draft.count, model: '', memberModels: draft.memberModels,
			}),
		}));

		this.runForm = this.rulesPanel.appendChild($('form.room-run-controls')) as HTMLFormElement;
		const limits = this.runForm.appendChild($('details.room-run-limits'));
		limits.appendChild($('summary')).textContent = localize('room.optionalLimits', "Optional run limits");
		this.turnsInput = this.numberField(limits, localize('room.turns', "Maximum total turns for this run"), 10000);
		this.deadlineInput = this.numberField(limits, localize('room.deadline', "Run deadline (minutes)"), 1440);
		this.turnsInput.required = false;
		this.deadlineInput.required = false;
		this.turnsInput.placeholder = localize('room.noLimit', "No limit");
		this.deadlineInput.placeholder = localize('room.noDeadline', "No deadline");
		this.startButton = this.button(this.header, localize('room.start', "Start"), () => this.startRun());
		this.header.insertBefore(this.startButton, this.pauseButton);
		this.startButton.classList.add('primary');
		this._register(addDisposableListener(this.runForm, EventType.SUBMIT, event => {
			event.preventDefault();
			void this.perform(() => this.startRun());
		}));
		const limitsHint = this.runForm.appendChild($('span.room-hint'));
		limitsHint.textContent = localize('room.limitsHint', "Start and Resume keep each peer's selected mode and permissions. Use the All peers menu to change the whole room. Managed approvals remain in this room. Limits are optional.");

		this.historyStatus = this.layoutWidget.main.appendChild($('.room-history-status'));
		this.historyStatus.setAttribute('role', 'status');
		this.feed = this.layoutWidget.main.appendChild($('.room-feed'));
		this.conversation = this._register(instantiationService.createInstance(CollaborationConversation, this.feed, {
			reply: message => {
				if (message.authorKind === 'agent' && !this.input.value.trim()) {
					this.input.value = `@${message.authorName} `;
				}
				this.updateDraft(message.id);
				this.updateReply();
				this.input.focus();
			},
			openArtifact: artifactId => { void this.perform(() => this.openArtifact(artifactId)); },
			retry: messageId => { void this.perform(() => this.collaborationService.retryMessage(messageId)); },
		}));
		this.historyControls = this.layoutWidget.main.appendChild($('.room-history-controls'));
		this.latest = this.button(this.historyControls, localize('room.latest', "Jump to Latest"), async () => {
			this.followingLatest = true;
			await this.collaborationService.loadMessages();
			this.conversation.revealLatest();
		});
		this._register(this.conversation.onDidScroll(() => {
			if (this.pendingScroll !== undefined) {
				return;
			}
			this.followingLatest = this.conversation.isFollowingLatest;
			this.updateLatestPostsButton(this.collaborationService.messages.get(), this.collaborationService.activeRoom.get());
			this.saveScrollPosition();
			if (this.conversation.scrollTop < 120 && !this.followingLatest && this.collaborationService.messages.get().hasEarlier
				&& !this.collaborationService.loadingEarlier.get()) {
				void this.perform(() => this.collaborationService.loadEarlierMessages(), false);
			}
		}));

		this.composer = this.layoutWidget.main.appendChild($('.room-composer'));
		this.replyLabel = this.composer.appendChild($('.room-hint'));
		this.cancelReply = this.button(this.composer, localize('room.cancelReply', "Cancel Reply"), () => {
			this.updateDraft(undefined);
			this.updateReply();
			this.input.focus();
		});
		this.input = this.composer.appendChild($('textarea')) as HTMLTextAreaElement;
		this.input.placeholder = localize('room.placeholder', "Message all Copilots, or @mention a peer");
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
		composerActions.appendChild($('span.room-hint')).textContent = localize('room.composerHint', "Send wakes finished peers: @mention someone, or notify everyone. Busy peers queue the message; Steer Agents sends live guidance.");
		this.send = this.button(composerActions, localize('room.send', "Send"), () => this.sendMessage());
		this.send.classList.add('primary');
		this.send.setAttribute('aria-description', localize('room.sendDescription', "Send to mentioned peers, or everyone when none are mentioned. Finished or stopped peers receive a new turn; busy peers receive the message on their next turn. Pause holds delivery."));
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
			for (const element of [this.element]) {
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
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layout(this.element.clientWidth, this.element.clientHeight));
		observer.observe(this.element);
		observer.observe(this.header);
		this._register({ dispose: () => observer.disconnect() });
	}

	private observeState(): void {
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
				this.pendingScroll = scrollState && scrollState.roomId === id ? scrollState : undefined;
				this.lastAnnouncedSequence = 0;
				this.localError.set(undefined, undefined);
				this.hideMentions();
				this.updateReply();
			}
		}));
		this._register(autorun(reader => {
			const room = this.collaborationService.activeRoom.read(reader);
			const trust = this.collaborationService.workspaceTrust.read(reader);
			const available = this.collaborationService.availability.read(reader) === 'available';
			const requests = this.collaborationService.requests.read(reader);
			this.trustNotice.hidden = !room || trust.state === 'trusted';
			const message = trust.error ?? (trust.state === 'requesting'
				? localize('room.trustRequesting', "Confirm workspace trust for the source repository. Each peer uses its own separate local worktree.")
				: trust.state === 'checking' ? localize('room.trustChecking', "Checking trust for the room workspace...")
					: localize('room.trustNotice', "Trust the source repository before sending messages, starting, resuming, retrying, steering, or allowing peers. One decision covers only this room's exact local peer worktrees. You can still read the conversation."));
			if (this.trustMessage.textContent !== message) {
				this.trustMessage.textContent = message;
			}
			this.trustMessage.classList.toggle('error', !!trust.error);
			this.trustDirectories.textContent = [trust.repositoryUri ?? room?.repositoryUri, ...(trust.worktreeUris ?? room?.members.flatMap(member => member.worktreeUri ? [member.worktreeUri] : []) ?? [])].filter(Boolean).join('\n');
			this.trustButton.disabled = !available || trust.state === 'checking' || trust.state === 'requesting';
			this.requestsSection.hidden = !requests.length;
			this.updateTabs(room, requests);
			const count = requests.length + (this.trustNotice.hidden ? 0 : 1) + (room?.members.filter(member => member.error || member.modelError || member.state === 'failed').length ?? 0);
			this.attentionButton.hidden = !count;
			this.attentionButton.textContent = localize('room.attentionCount', "Needs Attention ({0})", count);
		}));
		this._register(autorun(reader => this.renderRequests(
			this.collaborationService.requests.read(reader),
			this.collaborationService.availability.read(reader) !== 'available',
		)));
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
			// The home card carries its own title, so the header stays empty until a room is open.
			this.heading.textContent = room?.title ?? '';
			this.header.classList.toggle('room-header-empty', !room);
			this.subtitle.textContent = room ? localize('room.summary', "{0} | {1} peers | Base {2}{3}", roomStateLabel(room.state), room.members.length, room.baseRevision.slice(0, 8),
				room.run ? localize('room.runSummary', " | {0} turns{1}{2}", room.run.admittedTurns,
					room.run.limits.maxTurns === undefined ? '' : localize('room.turnLimit', " / {0} maximum", room.run.limits.maxTurns),
					room.run.deadline === undefined ? '' : localize('room.runDeadline', " | Deadline {0}", new Date(room.run.deadline).toLocaleTimeString())) : '') : '';
			this.subtitle.title = room ? localize('room.repositorySummary', "{0}\nGoal: {1}", room.repositoryUri, room.goal) : '';
			this.goalDetails.hidden = !room;
			this.goalContent.textContent = room ? localize('room.goalDetails', "Goal: {0}\nRules: {1}\nRepository: {2}\nPinned base: {3}", room.goal, room.instructions, room.repositoryUri, room.baseRevision) : '';
			this.home.element.hidden = !!roomId;
			this.runForm.hidden = !room || room.state === 'running' || room.state === 'stopping';
			this.roster.hidden = !room;
			this.historyControls.hidden = !room;
			this.feed.hidden = !roomId;
			this.composer.hidden = !room;
			// The home screen owns room selection and creation, so the settings panel
			// has nothing to offer until a room is open.
			this.panelButton.hidden = !room;
			this.layoutWidget.element.classList.toggle('room-no-panel', !room);
			if (!room && this.layoutWidget.panelVisible) {
				this.layoutWidget.setPanelVisible(false);
			}
			this.roomPicker.disabled = busy;
			this.startButton.textContent = room?.state === 'created' ? localize('room.start', "Start") : localize('room.resume', "Resume");
			this.startButton.hidden = !room || room.state === 'running' || room.state === 'stopping';
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
			const supportsModels = this.collaborationService.canSetMemberModel.read(reader);
			const models = this.collaborationService.models.read(reader);
			this.home.setDisabled(creationBusy || !available, supportsModels ? undefined : unsupportedMemberModelsMessage);
			if (room) {
				this.renderRoster(room, busy || !available, models);
			}
		}));
		this._register(autorun(reader => {
			const page = this.collaborationService.messages.read(reader);
			const room = this.collaborationService.activeRoom.read(reader);
			const loadingEarlier = this.collaborationService.loadingEarlier.read(reader);
			this.historyStatus.hidden = !loadingEarlier;
			this.historyStatus.textContent = loadingEarlier ? localize('room.loadingEarlier', "Loading earlier messages...") : '';
			this.updateLatestPostsButton(page, room);
			this.conversation.setMessages(page.messages, room);
			this.restoreScrollPosition();
			const last = page.messages.at(-1);
			if (last && last.sequence > this.lastAnnouncedSequence) {
				if (this.lastAnnouncedSequence > 0 && this.roomViewService.visible.read(reader)) {
					status(localize('room.newPost', "New room post from {0}", last.authorName));
				}
				this.lastAnnouncedSequence = last.sequence;
			}
			this.updateReply();
		}));
		this._register(autorun(reader => {
			const availability = this.collaborationService.availability.read(reader);
			const error = this.localError.read(reader) ?? this.collaborationService.error.read(reader)
				?? this.collaborationService.requestError.read(reader) ?? this.collaborationService.availabilityError.read(reader) ?? this.collaborationService.activeRoom.read(reader)?.error;
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

	private async browseForFolder(current: URI | undefined): Promise<URI | undefined> {
		const selected = await this.fileDialogService.showOpenDialog({
			title: localize('room.selectFolder', "Choose a Folder"),
			canSelectFiles: false, canSelectFolders: true, canSelectMany: false, availableFileSystems: ['file'],
			defaultUri: current,
		});
		if (!selected?.[0] || this._store.isDisposed || this.collaborationService.activeRoomId.get()) {
			return undefined;
		}
		if (selected[0].scheme !== Schemas.file) {
			throw new Error(localize('room.localOnly', "Choose a local folder."));
		}
		return selected[0];
	}

	/** Preparing a plain folder writes to it, so the exact path is always confirmed first. */
	private async confirmInitializeFolder(path: string): Promise<boolean> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'question',
			message: localize('room.initializeFolder', "Set up this folder for collaboration?"),
			detail: localize('room.initializeFolderDetail', "{0}\n\nAgents each work in their own Git worktree, so this folder needs to be a Git repository. It will be initialized and its current contents committed as the starting point.", path),
			primaryButton: localize('room.initializeFolderConfirm', "Set Up Folder"),
		});
		return confirmed;
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
			this.conversation.revealLatest();
			this.input.value = this.currentDraft?.text ?? '';
			this.updateReply();
			this.hideMentions();
		}
	}

	/** One tab per agent, then the shared rules and anything awaiting a decision. */
	private updateTabs(room: IAgentHostRoom | undefined, requests: readonly ICollaborationRequest[]): void {
		if (!room) {
			this.tabs.element.hidden = true;
			return;
		}
		this.tabs.element.hidden = false;
		const attention = requests.length + (this.trustNotice.hidden ? 0 : 1);
		this.tabs.setTabs([
			...room.members.map(member => ({
				id: `member:${member.id}`, label: member.name, accent: collaborationAuthorAccent(room, member.id),
				badge: requests.filter(request => request.memberId === member.id).length || undefined,
			})),
			{ id: RULES_TAB, label: localize('room.tabRules', "Rules") },
			{ id: APPROVALS_TAB, label: localize('room.tabApprovals', "Approvals"), badge: attention || undefined },
		]);
		this.updateTabPanels();
	}

	private updateTabPanels(): void {
		const active = this.tabs.activeTab;
		const member = active?.startsWith('member:') ? active.slice('member:'.length) : undefined;
		this.agentsPanel.hidden = !member;
		for (const [id, elements] of this.memberElements) {
			elements.element.hidden = id !== member;
		}
	}

	private renderRoster(room: IAgentHostRoom, disabled: boolean, models: readonly SessionModelInfo[]): void {
		for (const member of room.members) {
			let elements = this.memberElements.get(member.id);
			if (!elements) {
				const element = this.roster.appendChild($('.room-member'));
				element.setAttribute('role', 'listitem');
				const heading = element.appendChild($('.room-member-heading'));
				const open = this.button(heading, member.name, () => this.openMember(member.id), this.memberDisposables);
				const state = heading.appendChild($('span.room-member-state'));
				const model = this.memberDisposables.add(this.instantiationService.createInstance(CollaborationModelPicker, element, member.name, this.modelCatalog, async selection => {
					if (this.collaborationService.activeRoomId.get() !== room.id || this._store.isDisposed) {
						throw new CancellationError();
					}
					this.localError.set(undefined, undefined);
					try {
						await this.collaborationService.setMemberModel(member.id, selection);
					} catch (error) {
						if (!this._store.isDisposed && this.collaborationService.activeRoomId.get() === room.id && !this.layoutWidget.panelVisible && !isCancellationError(error)) {
							this.localError.set(toErrorMessage(error), undefined);
						}
						throw error;
					}
				}));
				const activity = element.appendChild($('.room-member-activity'));
				const error = element.appendChild($('.room-member-error'));
				const actions = heading.appendChild($('.room-member-actions'));
				const stop = this.button(actions, localize('room.stopPeer', "Stop"), () => this.collaborationService.stopMember(member.id), this.memberDisposables);
				const retry = this.button(actions, localize('room.retryPeer', "Retry"), () => this.collaborationService.retryMember(member.id), this.memberDisposables);
				elements = { element, open, state, activity, model, error, stop, retry };
				this.memberElements.set(member.id, elements);
			}
			elements.element.dataset.state = member.state;
			elements.open.style.color = collaborationAuthorAccent(room, member.id);
			elements.open.textContent = member.name;
			elements.open.setAttribute('aria-label', localize('room.openPeer', "Open {0}'s existing session for detailed activity and changes", member.name));
			elements.open.title = member.worktreeUri ?? '';
			elements.state.textContent = localize('room.memberSummary', "{0} | {1} turns", memberStateLabel(member.state), member.turns);
			elements.activity.textContent = member.activity ?? '';
			elements.activity.hidden = !member.activity;
			const modelState = getCollaborationMemberModelState(member, models, !disabled && this.collaborationService.canSetMemberModel.get());
			elements.model.state.set(this.collaborationService.canSetMemberModel.get() ? modelState : { ...modelState, detail: unsupportedMemberModelsMessage }, undefined);
			elements.error.textContent = member.error ?? '';
			elements.error.hidden = !member.error;
			elements.stop.disabled = disabled || ['stopped', 'stopping', 'failed', 'pending'].includes(member.state);
			elements.stop.setAttribute('aria-label', localize('room.stopPeerLabel', "Stop {0}", member.name));
			elements.retry.hidden = !['failed', 'interrupted'].includes(member.state);
			elements.retry.disabled = disabled || !['running', 'idle'].includes(room.state);
			elements.retry.setAttribute('aria-label', localize('room.retryPeerLabel', "Retry {0} within the current run limits", member.name));
		}
		this.updateTabPanels();
	}

	private renderRequests(requests: readonly ICollaborationRequest[], disabled: boolean): void {
		const ids = new Set(requests.map(request => request.id));
		let restoreFocus = false;
		for (const [id, widget] of this.requestElements) {
			if (!ids.has(id)) {
				const active = getActiveElement();
				restoreFocus ||= widget.shouldRestoreFocus(active);
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
			const next = [...this.requestElements.values()].map(widget => widget.getFocusTarget()).find(button => button !== undefined);
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

	private updateLatestPostsButton(page: IAgentHostRoomMessagePage, room: IAgentHostRoom | undefined): void {
		const newPosts = (room?.latestMessageSequence ?? 0) - (page.messages.at(-1)?.sequence ?? 0);
		this.latest.hidden = this.followingLatest && !page.hasLater && newPosts <= 0;
		this.latest.textContent = newPosts > 0 ? localize('room.newPostsCount', "Show {0} New Posts", newPosts) : localize('room.latest', "Jump to Latest");
		this.historyControls.hidden = !room || this.latest.hidden;
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
		} else if (!this.collaborationService.activeRoomId.get()) {
			this.home.focus();
		} else if (!this.retryLoad.hidden) {
			this.retryLoad.focus();
		} else {
			this.roomPicker.focus();
		}
	}

	layout(width: number, height: number): void {
		this.element.style.height = `${height}px`;
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
			this.roomViewService.saveScrollState(this.pendingScroll ?? this.conversation.captureScrollState(this.previousRoomId));
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
				localize('room.accessibleNew', "Agent Collab. Describe the goal, choose a folder, and pick how many Copilot agents to use and a model for each. Advanced holds shared rules, the Git branch, and optional run limits. Creating a room does not start paid work until you start it or send a message."),
				...this.collaborationService.rooms.get().map(saved => localize('room.accessibleSavedRoom', "Saved room: {0}. {1}.", saved.title, roomStateLabel(saved.state))),
				this.notice.textContent ?? '',
			].join('\n\n');
		}
		return [
			localize('room.accessibleTitle', "{0}. {1}.", room.title, roomStateLabel(room.state)),
			localize('room.accessibleGoal', "Goal: {0}\nRules: {1}\nRepository: {2}\nPinned base: {3}", room.goal, room.instructions, room.repositoryUri, room.baseRevision),
			...room.members.map(member => {
				const model = getCollaborationMemberModelState(member, this.collaborationService.models.get(), this.collaborationService.canSetMemberModel.get());
				return localize('room.accessibleMember', "{0}: {1}. Activity: {2}. Selected model: {3}. {4} {5} Worktree: {6}. {7}",
					member.name, memberStateLabel(member.state), member.activity ?? '',
					model.selection?.id ?? localize('room.hostDefault', "Copilot host default"), model.detail ?? '', model.error ?? '', member.worktreeUri ?? '', member.error ?? '');
			}),
			...(this.trustNotice.hidden ? [] : [this.trustMessage.textContent ?? '', this.trustDirectories.textContent ?? '']),
			...[...this.requestElements.values()].map(request => request.getAccessibleContent()),
			...this.collaborationService.messages.get().messages.map(message => localize('room.accessibleMessage', "{0}, {1}: {2}{3}\n{4}",
				message.authorName, new Date(message.timestamp).toLocaleString(), message.replyTo ? localize('room.accessibleReply', "Reply to {0}. ", message.replyTo) : '',
				[message.mode === 'steer' ? localize('room.humanGuidance', "Human guidance") : '', ...this.deliveryLabels(message, room)].filter(Boolean).join(', '), message.text)),
			...room.artifacts.map(artifact => localize('room.accessibleArtifact', "Published artifact: {0}. Base: {1}. Source: {2}.", artifact.title, artifact.baseRevision, artifact.sourceRevision)),
			this.notice.textContent ?? '',
		].join('\n\n');
	}

	private clearMessages(): void {
		this.conversation.setMessages([], undefined);
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this.saveScrollPosition();
		this.clearMessages();
		super.dispose();
		this.element.remove();
	}
}
