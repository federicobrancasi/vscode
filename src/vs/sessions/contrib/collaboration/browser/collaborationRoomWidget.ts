/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../chat/browser/media/chatInput.css';
import './media/collaborationRoom.css';
import { $, addDisposableListener, EventType, getActiveElement, getWindow, isAncestor, isHTMLElement, trackFocus } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { AgentHostRoomMessageMode, AgentHostRoomVerificationVerdict, IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomMember, IAgentHostRoomMessage, IAgentHostRoomMessagePage, MAX_ROOM_WORKERS } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { SessionModelInfo } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { isAgentHostProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ICollaborationRoomScrollState, ICollaborationRoomView, ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationRoomFocusedContext, ICollaborationRequest, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { getCollaborationMentionQuery, ICollaborationMentionQuery } from '../../../services/collaboration/common/collaborationMentions.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { coordinatorStateLabel, deliveryStateLabel, memberStateLabel, resultOutcomeLabel, roomStateLabel, verificationStateLabel, verificationVerdictLabel } from './collaborationRoomLabels.js';
import { CollaborationArtifactProvider } from './collaborationArtifactProvider.js';
import { CollaborationRequestWidget } from './collaborationRequestWidget.js';
import { CollaborationConfigurationPicker } from './collaborationConfigurationPicker.js';
import { CollaborationConversation } from './collaborationConversation.js';
import { CollaborationCoordinatorSessionNotReadyError, CollaborationCoordinatorView } from './collaborationCoordinatorView.js';
import { CollaborationHome } from './collaborationHome.js';
import { CollaborationTabs } from './collaborationTabs.js';
import { COLLABORATION_SETTINGS_CONTAINER_ID } from './collaborationSettingsView.js';
import { CollaborationRoomLayout } from './collaborationRoomLayout.js';
import { CollaborationModelCatalog, CollaborationModelPicker, getCollaborationCoordinatorModelState, getCollaborationMemberModelState } from './collaborationModelPicker.js';
import { collaborationAuthorAccent } from './collaborationColors.js';

const RUN_TAB = 'run';
const AGENTS_TAB = 'agents';
const RULES_TAB = 'rules';
const APPROVALS_TAB = 'approvals';
const COORDINATOR_TAB = 'coordinator';
const ACTIVITY_TAB = 'activity';

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
	readonly remove: HTMLButtonElement;
}

export class CollaborationRoomWidget extends Disposable implements ICollaborationRoomView {
	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly subtitle: HTMLElement;
	private readonly goalContent: HTMLElement;
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
	private readonly inputArea: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly send: HTMLButtonElement;
	private readonly replyLabel: HTMLElement;
	private readonly cancelReply: HTMLButtonElement;
	private readonly suggestions: HTMLElement;
	private readonly home: CollaborationHome;
	private readonly runControls: HTMLElement;
	private lastHeight = 0;
	private readonly tabs: CollaborationTabs;
	private readonly mainTabs: CollaborationTabs;
	private readonly mainTabsHeader: HTMLElement;
	private readonly mainTabContent: HTMLElement;
	private readonly coordinatorPanel: HTMLElement;
	private readonly coordinatorPlaceholder: HTMLElement;
	private readonly coordinatorView: CollaborationCoordinatorView;
	private readonly activityPanel: HTMLElement;
	private readonly agentsPanel: HTMLElement;
	private readonly coordinatorSettings: HTMLElement;
	private readonly coordinatorSettingsState: HTMLElement;
	private readonly coordinatorModelPicker: CollaborationModelPicker;
	private readonly addMemberButton: HTMLButtonElement;
	private readonly runPanel: HTMLElement;
	private readonly rulesPanel: HTMLElement;
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
	private coordinatorLoadVersion = 0;
	private coordinatorLoadKey: string | undefined;
	private coordinatorRetryKey: string | undefined;
	private coordinatorRetryAttempts = 0;
	private readonly coordinatorRetry = this._register(new MutableDisposable());
	private coordinatorAutoSelectedRoomId: string | undefined;
	private readonly activitySeenEvents = new Map<string, ReadonlySet<string>>();
	private readonly announcedAssignmentFailures = new Set<string>();
	private followingLatest = true;
	private pendingScroll: ICollaborationRoomScrollState | undefined;
	private initialSelection = true;
	private previousRoomId: string | undefined;
	private lastAnnouncedSequence = 0;
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
			() => this.conversation?.layout(this.feed.clientWidth, this.feed.clientHeight)));
		this.mainTabsHeader = this.layoutWidget.main.appendChild($('.room-main-tabs-header'));
		this.mainTabs = this._register(new CollaborationTabs(
			this.mainTabsHeader,
			id => this.onMainTabChanged(id),
			localize('room.mainTabsLabel', "Collaboration room views"),
		));
		this.mainTabs.element.classList.add('room-main-tabs');
		this.mainTabContent = this.layoutWidget.main.appendChild($('.room-main-tab-content'));
		this.coordinatorPanel = this.mainTabContent.appendChild($('.room-main-tab-panel.room-coordinator-panel'));
		this.coordinatorPlaceholder = this.coordinatorPanel.appendChild($('.room-coordinator-placeholder'));
		this.coordinatorPlaceholder.textContent = localize('room.coordinatorPreparing', "Preparing the coordinator...");
		this.coordinatorView = this._register(instantiationService.createInstance(CollaborationCoordinatorView));
		this.coordinatorView.element.hidden = true;
		this.coordinatorPanel.appendChild(this.coordinatorView.element);
		this.activityPanel = this.mainTabContent.appendChild($('.room-main-tab-panel.room-activity-panel'));
		this.mainTabs.registerPanel(COORDINATOR_TAB, this.coordinatorPanel);
		this.mainTabs.registerPanel(ACTIVITY_TAB, this.activityPanel);
		this.mainTabs.setTabs([
			{ id: COORDINATOR_TAB, label: localize('room.tabCoordinator', "Coordinator") },
			{ id: ACTIVITY_TAB, label: localize('room.tabActivity', "Activity") },
		]);
		// Activity remains the fallback until the coordinator chat has resolved.
		this.mainTabs.select(ACTIVITY_TAB);
		this.tabs = this._register(new CollaborationTabs(this.layoutWidget.panelHeader, () => this.updateTabPanels()));
		const tabContent = this.layoutWidget.panelContent.appendChild($('.room-tab-content'));
		this.runPanel = tabContent.appendChild($('.room-tab-panel'));
		this.tabs.registerPanel(RUN_TAB, this.runPanel);
		this.runControls = this.runPanel.appendChild($('.room-run-controls-host'));
		this.pauseButton = this.button(this.runControls, localize('room.pause', "Pause"), () => this.collaborationService.pauseRoom());
		this.stopButton = this.button(this.runControls, localize('room.stop', "Stop All"), () => this.collaborationService.stopRoom());
		this.attentionButton = this.button(this.runControls, localize('room.attention', "Needs Attention"), async () => {
			await this.revealSettings();
			const failedMember = this.collaborationService.activeRoom.get()?.members.find(member => member.error || member.modelError || member.state === 'failed');
			this.tabs.select(this.requestElements.size || !this.trustNotice.hidden || !failedMember ? APPROVALS_TAB : AGENTS_TAB);
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
		// Settings live in the Agents window side panel, beside Changes and Files.
		this.panelButton = this.button(this.header, localize('room.panelTitle', "Room Settings"), () => this.revealSettings(), this._store, false);
		this.layoutWidget.panel.id = `collaboration-panel-${generateUuid()}`;
		this.panelButton.setAttribute('aria-controls', this.layoutWidget.panel.id);
		this.modelCatalog = this._register(instantiationService.createInstance(CollaborationModelCatalog, collaborationService.models, error => {
			this.localError.set(toErrorMessage(error), undefined);
		}));
		this.agentsPanel = tabContent.appendChild($('.room-tab-panel'));
		this.coordinatorSettings = this.agentsPanel.appendChild($('section.room-coordinator-settings'));
		const coordinatorHeading = this.coordinatorSettings.appendChild($('.room-coordinator-settings-heading'));
		coordinatorHeading.appendChild($('h3')).textContent = localize('room.coordinator', "Coordinator");
		this.coordinatorSettingsState = coordinatorHeading.appendChild($('span.room-member-state'));
		this.coordinatorModelPicker = this._register(instantiationService.createInstance(
			CollaborationModelPicker,
			this.coordinatorSettings,
			localize('room.coordinator', "Coordinator"),
			this.modelCatalog,
			model => this.collaborationService.setCoordinatorModel(model),
		));
		this.roster = this.agentsPanel.appendChild($('.room-roster'));
		this.roster.setAttribute('role', 'list');
		this.roster.setAttribute('aria-label', localize('room.participants', "Copilot peers and current activity"));
		this.addMemberButton = this.button(this.agentsPanel, localize('room.addMember', "Add Agent"), () => this.collaborationService.addMember());
		this.addMemberButton.classList.add('room-add-member');
		this.addMemberButton.setAttribute('aria-description', localize('room.addMemberDescription', "Adds a Copilot peer with its own session and worktree. In a running room it starts working straight away, which consumes model tokens."));
		this.tabs.registerPanel(AGENTS_TAB, this.agentsPanel);
		this.rulesPanel = tabContent.appendChild($('.room-tab-panel'));
		this._register(instantiationService.createInstance(CollaborationConfigurationPicker, this.rulesPanel, error => {
			if (!isCancellationError(error)) {
				this.localError.set(toErrorMessage(error), undefined);
			}
		}));
		this.goalContent = this.rulesPanel.appendChild($('dl.room-goal'));
		this.tabs.registerPanel(RULES_TAB, this.rulesPanel);

		this.notice = this.activityPanel.appendChild($('.room-notice'));
		this.notice.setAttribute('role', 'status');
		this.retryLoad = this.button(this.activityPanel, localize('room.reload', "Retry Loading"), async () => {
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
		trustDetails.appendChild($('summary')).textContent = localize('room.trustDirectories', "Source repository and participant worktrees");
		this.trustDirectories = trustDetails.appendChild($('pre'));
		this.trustDirectories.tabIndex = 0;
		this.trustDirectories.setAttribute('aria-label', localize('room.trustDirectories', "Source repository and participant worktrees"));
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
					coordinatorModel: draft?.coordinatorModel,
					memberNames: draft?.memberNames ?? [],
					memberModels: draft?.memberModels ?? (draft?.model ? Array.from({ length: MAX_ROOM_WORKERS }, () => ({ id: draft.model })) : []),
				};
			},
			saveDraft: draft => this.roomViewService.saveCreationDraft(draft && {
				title: '', goal: draft.goal, instructions: draft.instructions,
				repositoryUri: draft.folder ? URI.file(draft.folder).toString() : undefined,
				baseRevision: draft.baseRevision, workerCount: draft.count, model: '',
				coordinatorModel: draft.coordinatorModel, memberNames: draft.memberNames, memberModels: draft.memberModels,
			}),
		}));

		this.startButton = this.button(this.runControls, localize('room.start', "Start"), () => this.startRun());
		this.runControls.insertBefore(this.startButton, this.pauseButton);
		this.startButton.classList.add('primary');

		this.historyStatus = this.activityPanel.appendChild($('.room-history-status'));
		this.historyStatus.setAttribute('role', 'status');
		this.feed = this.activityPanel.appendChild($('.room-feed'));
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
			reviewResult: message => { void this.perform(() => this.reviewResult(message)); },
			retry: messageId => { void this.perform(() => this.collaborationService.retryMessage(messageId)); },
		}));
		this.historyControls = this.activityPanel.appendChild($('.room-history-controls'));
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

		this.composer = this.activityPanel.appendChild($('.room-composer'));
		this.replyLabel = this.composer.appendChild($('.room-hint'));
		this.cancelReply = this.button(this.composer, localize('room.cancelReply', "Cancel Reply"), () => {
			this.updateDraft(undefined);
			this.updateReply();
			this.input.focus();
		});
		// The composer adopts the Agents window chat input's own container and toolbar
		// structure, so it reads as that input rather than a second kind of composer.
		this.inputArea = this.composer.appendChild($('.new-chat-input-area'));
		this.input = this.inputArea.appendChild($('textarea')) as HTMLTextAreaElement;
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
		const composerActions = this.inputArea.appendChild($('.sessions-chat-toolbar.room-composer-actions'));
		composerActions.appendChild($('span.room-hint')).textContent = localize('room.mentionHint', "@ to mention");
		this.send = this.button(composerActions, '', () => this.sendMessage(), this._store, false);
		this.send.classList.add('room-send', ...ThemeIcon.asClassNameArray(Codicon.arrowUp));
		this.send.setAttribute('aria-label', localize('room.send', "Send"));
		this.send.setAttribute('aria-description', localize('room.sendDescription', "Send to mentioned peers, or everyone when none are mentioned. Busy peers receive human guidance during their current turn. Stopped peers receive saved guidance after Resume. Pause holds delivery."));
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
		this._register(addDisposableListener(this.input, EventType.FOCUS, () => this.inputArea.classList.add('focused')));
		this._register(addDisposableListener(this.input, EventType.BLUR, () => {
			this.inputArea.classList.remove('focused');
			this.hideMentions();
		}));
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
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layout(this.element.clientWidth, this.lastHeight || this.element.clientHeight));
		observer.observe(this.element);
		observer.observe(this.header);
		this._register({ dispose: () => observer.disconnect() });
	}

	private observeState(): void {
		this._register(autorun(reader => {
			const id = this.collaborationService.activeRoomId.read(reader);
			const scrollState = this.initialSelection ? this.roomViewService.scrollState.read(undefined) : undefined;
			this.initialSelection = false;
			if (id !== this.previousRoomId) {
				this.previousRoomId = id;
				this.mainTabs.select(id ? ACTIVITY_TAB : undefined);
				this.memberDisposables.clear();
				this.memberElements.clear();
				this.roster.replaceChildren();
				this.clearMessages();
				this.followingLatest = scrollState && scrollState.roomId === id ? scrollState.followingLatest : true;
				this.pendingScroll = scrollState && scrollState.roomId === id ? scrollState : undefined;
				this.lastAnnouncedSequence = 0;
				this.announcedAssignmentFailures.clear();
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
				? localize('room.trustRequesting', "Confirm workspace trust for the source repository. The coordinator and each worker use separate local worktrees.")
				: trust.state === 'checking' ? localize('room.trustChecking', "Checking trust for the room workspace...")
					: localize('room.trustNotice', "Trust the source repository before running agents or sending direct worker guidance. One decision covers only this room's exact local participant worktrees. You can still read Activity."));
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
			const canCoordinate = this.collaborationService.canCoordinate.read(reader);
			const trust = this.collaborationService.workspaceTrust.read(reader);
			const busy = this.busy.read(reader);
			const creationBusy = busy || this.collaborationService.creating.read(reader);
			// The home card carries its own title, so the header stays empty until a room is open.
			this.heading.textContent = room?.title ?? '';
			this.header.classList.toggle('room-header-empty', !room);
			// Removed peers keep their posts but are no longer part of the room's roster.
			const activeMembers = room?.members.filter(member => !member.removed) ?? [];
			this.subtitle.textContent = room ? localize('room.summary', "{0} | {1} peers | Base {2}{3}", roomStateLabel(room.state), activeMembers.length, room.baseRevision.slice(0, 8),
				room.run ? localize('room.runSummary', " | {0} turns", room.run.admittedTurns) : '') : '';
			this.subtitle.title = room ? localize('room.repositorySummary', "{0}\nGoal: {1}", room.repositoryUri, room.goal) : '';
			this.renderRoomRules(room);
			this.home.element.hidden = !!roomId;
			this.mainTabsHeader.hidden = !room;
			this.mainTabContent.hidden = !room;
			this.roster.hidden = !room;
			this.historyControls.hidden = !room;
			this.feed.hidden = !roomId;
			this.composer.hidden = !room;
			// The home screen owns room selection and creation, so the settings panel
			// has nothing to offer until a room is open.
			this.panelButton.hidden = !room;
			this.layoutWidget.element.classList.toggle('room-no-panel', !room);
			void this.loadCoordinator(room, canCoordinate, available && trust.state === 'trusted');
			this.startButton.textContent = room?.state === 'created' ? localize('room.start', "Start") : localize('room.resume', "Resume");
			this.updateMainTabs(room, this.collaborationService.messages.read(reader).messages);
			this.startButton.hidden = !room || room.state === 'running' || room.state === 'stopping';
			const canStart = !!room && ['created', 'idle', 'paused', 'stopped', 'interrupted'].includes(room.state);
			this.startButton.disabled = busy || !available || !canStart;
			// Only the actions that apply to the room's current state are offered, rather
			// than showing every action and disabling most of them.
			const canPause = !!room && ['running', 'idle'].includes(room.state);
			const canStop = !!room && !['created', 'stopped', 'stopping'].includes(room.state);
			this.pauseButton.hidden = !canPause;
			this.stopButton.hidden = !canStop;
			this.pauseButton.disabled = busy || !available;
			this.stopButton.disabled = busy || !available;
			// A stopped room can still be resumed, so it can still gain a peer; only an
			// in-flight cancellation withdraws the action. The host caps the roster.
			const atCapacity = !!room && room.members.filter(member => !member.removed).length >= MAX_ROOM_WORKERS;
			this.addMemberButton.hidden = !room || room.state === 'stopping';
			this.addMemberButton.disabled = busy || !available || atCapacity;
			this.addMemberButton.title = atCapacity
				? localize('room.addMemberFull', "A room can hold at most {0} agents.", MAX_ROOM_WORKERS)
				: '';
			const sending = this.collaborationService.sending.read(reader);
			this.send.disabled = !available || sending;
			this.send.classList.toggle('sending', sending);
			this.input.disabled = !available;
			const supportsModels = this.collaborationService.canSetMemberModel.read(reader);
			const models = this.collaborationService.models.read(reader);
			const coordinator = room?.coordinator;
			this.coordinatorSettings.hidden = !room || !canCoordinate;
			this.coordinatorSettingsState.textContent = coordinator ? coordinatorStateLabel(coordinator.state) : localize('room.coordinatorNotPrepared', "Not prepared");
			if (coordinator) {
				this.coordinatorModelPicker.state.set(getCollaborationCoordinatorModelState(coordinator, models, !busy && available), undefined);
			} else {
				this.coordinatorModelPicker.state.set({ selection: undefined, enabled: false, detail: localize('room.coordinatorNotPreparedDetail', "Prepared after the room is trusted.") }, undefined);
			}
			this.home.setDisabled(creationBusy || !available, supportsModels ? undefined : unsupportedMemberModelsMessage);
			if (room) {
				this.renderRoster(room, busy || !available, models);
			}

		}));
		this._register(autorun(reader => {
			const page = this.collaborationService.messages.read(reader);
			const room = this.collaborationService.activeRoom.read(reader);
			const canVerifyResults = this.collaborationService.canVerifyResults.read(reader);
			const loadingEarlier = this.collaborationService.loadingEarlier.read(reader);
			this.historyStatus.hidden = !loadingEarlier;
			this.historyStatus.textContent = loadingEarlier ? localize('room.loadingEarlier', "Loading earlier messages...") : '';
			this.updateMainTabs(room, page.messages);
			this.updateLatestPostsButton(page, room);
			if (this.mainTabs.activeTab === ACTIVITY_TAB) {
				this.conversation.setMessages(page.messages, room, canVerifyResults);
			}
			let assignmentFailure: { assignment: IAgentHostRoomMessage; memberName: string; error: string | undefined } | undefined;
			for (const message of page.messages) {
				if (!message.assignment) {
					continue;
				}
				for (const delivery of message.deliveries.filter(delivery => delivery.state === 'failed')) {
					const key = `${room?.id}:${message.id}:${delivery.memberId}:${delivery.error ?? ''}`;
					if (!this.announcedAssignmentFailures.has(key)) {
						this.announcedAssignmentFailures.add(key);
						assignmentFailure ??= {
							assignment: message,
							memberName: room?.members.find(member => member.id === delivery.memberId)?.name ?? delivery.memberId,
							error: delivery.error,
						};
					}
				}
			}
			if (assignmentFailure && this.lastAnnouncedSequence > 0 && this.roomViewService.visible.read(reader)) {
				status(localize('room.assignmentDeliveryFailed', "Assignment delivery to {0} failed: {1}. {2}",
					assignmentFailure.memberName, assignmentFailure.assignment.assignment!.description,
					assignmentFailure.error ?? localize('room.noFailureDetail', "No failure detail was provided")));
			}
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

	private onMainTabChanged(id: string): void {
		const coordinatorVisible = id === COORDINATOR_TAB;
		const room = this.collaborationService.activeRoom.get();
		if (id === ACTIVITY_TAB && room) {
			const messages = this.collaborationService.messages.get().messages;
			this.activitySeenEvents.set(room.id, this.meaningfulActivityEvents(room, messages));
			this.updateMainTabs(room, messages);
			this.conversation?.setMessages(messages, room, this.collaborationService.canVerifyResults.get());
		}
		this.coordinatorView.setVisible(coordinatorVisible);
		this.coordinatorView.layout(this.coordinatorPanel.clientWidth, this.coordinatorPanel.clientHeight);
		this.conversation?.layout(this.feed?.clientWidth ?? 0, this.feed?.clientHeight ?? 0);
	}

	private updateMainTabs(room: IAgentHostRoom | undefined, messages: readonly IAgentHostRoomMessage[]): void {
		let unread = 0;
		if (room) {
			const current = this.meaningfulActivityEvents(room, messages);
			const seen = this.activitySeenEvents.get(room.id) ?? current;
			if (!this.activitySeenEvents.has(room.id) || this.mainTabs.activeTab === ACTIVITY_TAB) {
				this.activitySeenEvents.set(room.id, current);
			} else {
				unread = [...current].filter(event => !seen.has(event)).length;
			}
		}
		this.mainTabs.setTabs([
			{ id: COORDINATOR_TAB, label: localize('room.tabCoordinator', "Coordinator") },
			{
				id: ACTIVITY_TAB,
				label: localize('room.tabActivity', "Activity"),
				badge: unread || undefined,
				badgeLabel: unread ? localize('room.activityUnread', "Activity, {0} unread meaningful updates", unread) : undefined,
			},
		]);
	}

	private meaningfulActivityEvents(room: IAgentHostRoom, messages: readonly IAgentHostRoomMessage[]): ReadonlySet<string> {
		const events = new Set<string>();
		for (const member of room.members) {
			events.add(`member:${member.id}:${member.removed ? 'removed' : 'present'}`);
			if (member.error || member.modelError || ['blocked', 'failed', 'needsInput'].includes(member.state)) {
				events.add(`member:${member.id}:${member.state}:${member.error ?? member.modelError ?? ''}`);
			}
		}
		for (const message of messages) {
			if (message.assignment || message.result || message.verification || message.kind === 'finding' || message.kind === 'artifact' || message.kind === 'work') {
				events.add(`message:${message.id}`);
			}
			for (const delivery of message.assignment?.assigneeIds.flatMap(assigneeId =>
				message.deliveries.filter(candidate => candidate.memberId === assigneeId && candidate.state === 'failed')) ?? []) {
				events.add(`assignment:${message.id}:${delivery.memberId}:failed:${delivery.error ?? ''}`);
			}
		}
		return events;
	}

	private async loadCoordinator(room: IAgentHostRoom | undefined, canCoordinate: boolean, authorized: boolean): Promise<void> {
		const coordinatorIdentity = room?.coordinator?.initialized
			? `${room.coordinator.sessionUri}\n${room.coordinator.chatUri}`
			: 'uninitialized';
		const loadKey = `${room?.id ?? 'none'}:${canCoordinate}:${authorized}:${coordinatorIdentity}`;
		if (this.coordinatorLoadKey === loadKey) {
			return;
		}
		if (this.coordinatorRetryKey !== loadKey) {
			this.coordinatorRetryKey = loadKey;
			this.coordinatorRetryAttempts = 0;
			this.coordinatorRetry.clear();
		}
		this.coordinatorLoadKey = loadKey;
		const version = ++this.coordinatorLoadVersion;
		if (!room || !canCoordinate) {
			this.coordinatorView.clear();
			this.coordinatorView.element.hidden = true;
			this.coordinatorPlaceholder.hidden = false;
			this.coordinatorPlaceholder.textContent = room
				? localize('room.coordinatorUnsupported', "This local agent host does not support a coordinator.")
				: localize('room.coordinatorPreparing', "Preparing the coordinator...");
			return;
		}
		if (!authorized) {
			this.coordinatorView.clear();
			this.coordinatorView.element.hidden = true;
			this.coordinatorPlaceholder.hidden = false;
			this.coordinatorPlaceholder.textContent = localize('room.coordinatorNeedsTrust', "Trust the room from Approvals to prepare the coordinator.");
			return;
		}
		this.coordinatorPlaceholder.hidden = false;
		this.coordinatorPlaceholder.textContent = localize('room.coordinatorPreparing', "Preparing the coordinator...");
		try {
			const coordinator = room.coordinator?.initialized ? room.coordinator : await this.collaborationService.ensureCoordinator();
			await this.coordinatorView.setCoordinator(coordinator.sessionUri, coordinator.chatUri, localize('room.coordinatorChatTitle', "Coordinator: {0}", room.title), room.createdAt, coordinator.worktreeUri);
			if (version !== this.coordinatorLoadVersion || room.id !== this.collaborationService.activeRoomId.get()) {
				return;
			}
			this.coordinatorLoadKey = `${room.id}:true:true:${coordinator.sessionUri}\n${coordinator.chatUri}`;
			this.coordinatorRetryKey = this.coordinatorLoadKey;
			this.coordinatorRetryAttempts = 0;
			this.coordinatorRetry.clear();
			this.coordinatorPlaceholder.hidden = true;
			this.coordinatorView.element.hidden = false;
			if (this.coordinatorAutoSelectedRoomId !== room.id) {
				this.coordinatorAutoSelectedRoomId = room.id;
				this.mainTabs.select(COORDINATOR_TAB);
			}
			this.coordinatorView.layout(this.coordinatorPanel.clientWidth, this.coordinatorPanel.clientHeight);
		} catch (error) {
			if (version !== this.coordinatorLoadVersion || isCancellationError(error)) {
				return;
			}
			this.coordinatorLoadKey = undefined;
			if (error instanceof CollaborationCoordinatorSessionNotReadyError && this.coordinatorRetryAttempts < 20) {
				this.coordinatorRetryAttempts++;
				this.coordinatorPlaceholder.hidden = false;
				this.coordinatorPlaceholder.textContent = localize('room.coordinatorPreparing', "Preparing the coordinator...");
				this.coordinatorRetry.value = disposableTimeout(() => {
					if (!this._store.isDisposed && room.id === this.collaborationService.activeRoomId.get()) {
						void this.loadCoordinator(room, canCoordinate, authorized);
					}
				}, 500);
				return;
			}
			this.coordinatorView.element.hidden = true;
			this.coordinatorPlaceholder.hidden = false;
			this.coordinatorPlaceholder.textContent = localize('room.coordinatorFailed', "Coordinator unavailable: {0}. Activity continues.", toErrorMessage(error));
			this.mainTabs.select(ACTIVITY_TAB);
		}
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

	/** Removal cancels live work, so it is confirmed rather than acted on immediately. */
	private async confirmRemoveMember(memberId: string): Promise<void> {
		const member = this.collaborationService.activeRoom.get()?.members.find(candidate => candidate.id === memberId);
		if (!member) {
			return;
		}
		const working = ['working', 'starting', 'needsInput', 'blocked'].includes(member.state);
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('room.removePeerConfirm', "Remove {0} from this room?", member.name),
			detail: working
				? localize('room.removePeerWorkingDetail', "Its current turn is cancelled. Posts it already made, and any patches it published, stay in the room, but it takes no further turns.")
				: localize('room.removePeerDetail', "Posts it already made, and any patches it published, stay in the room, but it takes no further turns."),
			primaryButton: localize('room.removePeerAction', "Remove Agent"),
		});
		if (confirmed) {
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
			this.startButton.focus();
		}
	}

	private async startRun(): Promise<void> {
		const roomId = this.collaborationService.activeRoomId.get();
		await this.collaborationService.startRoom();
		if (!this._store.isDisposed && this.roomViewService.visible.get() && this.collaborationService.activeRoomId.get() === roomId) {
			this.input.focus();
		}
	}

	/**
	 * Sending is one action. When the host supports steering and a peer is mid-turn,
	 * the post is delivered as live guidance so it lands during that turn; otherwise
	 * it is an ordinary post for the next admitted turn.
	 */
	private sendMode(): AgentHostRoomMessageMode {
		const busy = this.collaborationService.activeRoom.get()?.members.some(member => ['working', 'blocked', 'needsInput'].includes(member.state));
		return busy && this.collaborationService.canSteer.get() ? 'steer' : 'message';
	}

	private async sendMessage(mode: AgentHostRoomMessageMode = this.sendMode()): Promise<void> {
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

	/**
	 * The room's brief, as labelled fields rather than one run-on paragraph. These are
	 * fixed once a room exists; what the human can still change sits above them.
	 */
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
			if (!value) {
				continue;
			}
			this.goalContent.appendChild($('dt')).textContent = label;
			this.goalContent.appendChild($('dd')).textContent = value;
		}
	}

	/** Four fixed tabs: what the run is doing, who is in it, its rules, and its decisions. */
	private updateTabs(room: IAgentHostRoom | undefined, requests: readonly ICollaborationRequest[]): void {
		if (!room) {
			this.tabs.element.hidden = true;
			// Clear the selection so the next room opens on Run rather than inheriting
			// whichever tab the previous one left behind.
			this.tabs.select(undefined);
			return;
		}
		this.tabs.element.hidden = false;
		const attention = requests.length + (this.trustNotice.hidden ? 0 : 1);
		const failing = room.members.filter(member => member.error || member.modelError || member.state === 'failed').length;
		this.tabs.setTabs([
			{ id: RUN_TAB, label: localize('room.tabRun', "Run") },
			{ id: AGENTS_TAB, label: localize('room.tabAgents', "Agents"), badge: failing || undefined },
			{ id: RULES_TAB, label: localize('room.tabRules', "Rules") },
			{ id: APPROVALS_TAB, label: localize('room.tabApprovals', "Approvals"), badge: attention || undefined },
		]);
		this.updateTabPanels();
	}

	/** Every peer is listed together, so the tab strip stays the same width as the room grows. */
	private updateTabPanels(): void {
		for (const elements of this.memberElements.values()) {
			elements.element.hidden = false;
		}
	}

	private renderRoster(room: IAgentHostRoom, disabled: boolean, models: readonly SessionModelInfo[]): void {
		for (const [id, elements] of this.memberElements) {
			if (room.members.some(member => member.id === id && member.removed)) {
				elements.element.remove();
				this.memberElements.delete(id);
			}
		}
		for (const member of room.members.filter(member => !member.removed)) {
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
				const remove = this.button(actions, localize('room.removePeer', "Remove"), () => this.confirmRemoveMember(member.id), this.memberDisposables);
				elements = { element, open, state, activity, model, error, stop, retry, remove };
				this.memberElements.set(member.id, elements);
			}
			elements.element.dataset.state = member.state;
			elements.open.style.color = collaborationAuthorAccent(room, member.id);
			elements.open.textContent = member.name;
			// A peer only has a chat once it has taken a turn, so offering to open one
			// before that leads to a dead end.
			const hasSession = member.turns > 0;
			elements.open.disabled = !hasSession;
			elements.open.setAttribute('aria-label', hasSession
				? localize('room.openPeer', "Open {0}'s existing session for detailed activity and changes", member.name)
				: localize('room.openPeerWaiting', "{0} has not started yet, so it has no session to open", member.name));
			elements.open.title = hasSession ? (member.worktreeUri ?? '') : localize('room.openPeerWaitingHint', "Opens once this peer takes its first turn.");
			elements.state.textContent = localize('room.memberSummary', "{0} | {1} turns", memberStateLabel(member.state), member.turns);
			elements.activity.textContent = member.activity ?? '';
			elements.activity.hidden = !member.activity;
			const modelState = getCollaborationMemberModelState(member, models, !disabled && this.collaborationService.canSetMemberModel.get());
			elements.model.state.set(this.collaborationService.canSetMemberModel.get() ? modelState : { ...modelState, detail: unsupportedMemberModelsMessage }, undefined);
			elements.error.textContent = member.error ?? '';
			elements.error.hidden = !member.error;
			// A peer offers the one action that applies to it: Stop while it can still be
			// stopped, otherwise Resume to put it back to work. Retry is the same call,
			// named for a peer that stopped because it failed.
			const canResume = ['failed', 'stopped', 'interrupted', 'blocked'].includes(member.state);
			elements.stop.hidden = canResume;
			elements.stop.disabled = disabled || ['stopping', 'pending'].includes(member.state);
			elements.stop.setAttribute('aria-label', localize('room.stopPeerLabel', "Stop {0}", member.name));
			elements.retry.hidden = !canResume;
			// Resuming a peer starts a run for it, so a stopped room is exactly when the
			// action is wanted; only an in-flight cancellation withdraws it.
			elements.retry.disabled = disabled || room.state === 'stopping';
			const failed = ['failed', 'interrupted'].includes(member.state);
			elements.retry.textContent = failed ? localize('room.retryPeer', "Retry") : localize('room.resumePeer', "Resume");
			elements.retry.setAttribute('aria-label', failed
				? localize('room.retryPeerLabel', "Retry {0}", member.name)
				: localize('room.resumePeerLabel', "Resume {0}", member.name));
			elements.retry.title = room.state === 'stopping'
				? localize('room.resumePeerStopping', "Wait for the room to finish stopping.")
				: '';
			// A room keeps at least one agent, and its past posts survive the removal.
			elements.remove.hidden = room.members.filter(candidate => !candidate.removed).length <= 1;
			elements.remove.disabled = disabled || room.state === 'stopping';
			elements.remove.setAttribute('aria-label', localize('room.removePeerLabel', "Remove {0} from the room", member.name));
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
			throw new Error(member.turns > 0
				? localize('room.sessionNotReady', "This peer's session is not yet available in the local session catalog. Try again after provisioning completes.")
				: localize('room.sessionNotStarted', "{0} has not taken a turn yet, so it has no session to open. Start the room, or send a message, to give it one.", member.name));
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

	private async reviewResult(message: IAgentHostRoomMessage): Promise<void> {
		if (!message.result) {
			throw new Error(localize('room.resultMissing', "The structured result is no longer available."));
		}
		const roomId = this.collaborationService.activeRoomId.get();
		const choices: { readonly label: string; readonly description: string; readonly verdict: AgentHostRoomVerificationVerdict }[] = [
			{
				label: localize('room.verifyResult', "Verify Result"),
				description: localize('room.verifyResultDescription', "The evidence independently supports this result"),
				verdict: 'verified',
			},
			{
				label: localize('room.rejectResult', "Reject Result"),
				description: localize('room.rejectResultDescription', "The evidence does not support this result"),
				verdict: 'rejected',
			},
		];
		const choice = await this.quickInputService.pick(choices, {
			title: localize('room.reviewResultTitle', "Review result: {0}", message.result.title),
			placeHolder: localize('room.reviewResultPlaceholder', "Choose an independent verdict"),
		});
		if (!choice) {
			return;
		}
		const evidence = await this.quickInputService.input({
			title: localize('room.reviewEvidenceTitle', "Evidence for {0}", choice.label),
			prompt: localize('room.reviewEvidencePrompt', "Describe what you checked and the observed result"),
			validateInput: async value => {
				if (!value.trim()) {
					return localize('room.reviewEvidenceRequired', "Verification evidence is required.");
				}
				return value.length > 2000 ? localize('room.reviewEvidenceTooLong', "Verification evidence must be at most 2000 characters.") : undefined;
			},
		});
		if (evidence === undefined || roomId !== this.collaborationService.activeRoomId.get()) {
			return;
		}
		await this.collaborationService.verifyResult(message.id, choice.verdict, evidence);
		status(choice.verdict === 'verified'
			? localize('room.resultVerifiedStatus', "Result verified")
			: localize('room.resultRejectedStatus', "Result rejected"));
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
		if (this.mainTabs.activeTab === COORDINATOR_TAB) {
			this.coordinatorView.focus();
		} else if (this.collaborationService.activeRoomId.get() && !this.input.disabled) {
			this.input.focus();
		} else if (!this.collaborationService.activeRoomId.get()) {
			this.home.focus();
		} else if (!this.retryLoad.hidden) {
			this.retryLoad.focus();
		} else {
			this.tabs.focusActive();
		}
	}

	/** Brings the side panel forward so the room's settings are on screen and focused. */
	private async revealSettings(): Promise<void> {
		await this.viewsService.openViewContainer(COLLABORATION_SETTINGS_CONTAINER_ID, true);
		this.layoutWidget.focusPanel();
	}

	layoutPanel(width: number, height: number): void {
		this.layoutWidget.layoutPanel(width, height);
	}

	layout(width: number, height: number): void {
		// The element fills its container through CSS. Setting its height here while
		// also observing it would let any content that cannot shrink lock the size in.
		this.lastHeight = height;
		this.layoutWidget.layout(width, Math.max(0, height - this.header.offsetHeight));
		this.coordinatorView.layout(this.coordinatorPanel.clientWidth, this.coordinatorPanel.clientHeight);
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
				localize('room.accessibleNew', "Agent Collab. Describe the goal, choose a folder, and pick how many Copilot agents to use and a model for each. Advanced holds shared rules and the Git branch. Creating a room does not start paid work until you start it or send a message."),
				...this.collaborationService.rooms.get().map(saved => localize('room.accessibleSavedRoom', "Saved room: {0}. {1}.", saved.title, roomStateLabel(saved.state))),
				this.notice.textContent ?? '',
			].join('\n\n');
		}
		return [
			localize('room.accessibleTitle', "{0}. {1}.", room.title, roomStateLabel(room.state)),
			localize('room.accessibleGoal', "Goal: {0}\nRules: {1}\nRepository: {2}\nPinned base: {3}", room.goal, room.instructions, room.repositoryUri, room.baseRevision),
			...(room.coordinator ? [localize('room.accessibleCoordinator', "Coordinator: {0}. Selected model: {1}. Last room sequence read: {2}. Evidence records: {3}. Worktree: {4}.",
				coordinatorStateLabel(room.coordinator.state), room.coordinator.desiredModel?.id ?? room.coordinator.appliedModel?.id ?? localize('room.hostDefault', "Copilot host default"),
				room.coordinator.cursor, this.collaborationService.messages.get().messages.filter(message => message.assignment || message.result || message.verification).map(message => message.id).join(', ') || localize('room.noEvidenceRecords', "None"),
				room.coordinator.worktreeUri)] : []),
			...room.members.map(member => {
				const model = getCollaborationMemberModelState(member, this.collaborationService.models.get(), this.collaborationService.canSetMemberModel.get());
				return localize('room.accessibleMember', "{0}: {1}. Activity: {2}. Selected model: {3}. {4} {5} Worktree: {6}. {7}",
					member.name, memberStateLabel(member.state), member.activity ?? '',
					model.selection?.id ?? localize('room.hostDefault', "Copilot host default"), model.detail ?? '', model.error ?? '', member.worktreeUri ?? '', member.error ?? '');
			}),
			...(this.trustNotice.hidden ? [] : [this.trustMessage.textContent ?? '', this.trustDirectories.textContent ?? '']),
			...[...this.requestElements.values()].map(request => request.getAccessibleContent()),
			...this.collaborationService.messages.get().messages.map(message => this.accessibleMessage(message, room)),
			...room.artifacts.map(artifact => localize('room.accessibleArtifact', "Published artifact: {0}. Base: {1}. Source: {2}.", artifact.title, artifact.baseRevision, artifact.sourceRevision)),
			this.notice.textContent ?? '',
		].join('\n\n');
	}

	private accessibleMessage(message: IAgentHostRoomMessage, room: IAgentHostRoom): string {
		const metadata = [
			message.replyTo ? localize('room.accessibleReply', "Reply to {0}. ", message.replyTo) : '',
			message.mode === 'steer' ? localize('room.humanGuidance', "Human guidance") : '',
			...this.deliveryLabels(message, room),
		].filter(Boolean).join(', ');
		if (message.result) {
			const patches = message.result.artifactIds.map(artifactId => room.artifacts.find(artifact => artifact.id === artifactId)?.title ?? artifactId).join(', ');
			return localize('room.accessibleResult', "{0}, {1}. Structured result: {2}. Outcome: {3}. Verification: {4}. {5}\nSummary: {6}\nEvidence: {7}\nPublished patches: {8}",
				message.authorName, new Date(message.timestamp).toLocaleString(), message.result.title, resultOutcomeLabel(message.result.outcome),
				verificationStateLabel(message.result.verificationState ?? 'pending'), metadata, message.result.summary,
				message.result.evidence.join('; '), patches || localize('room.accessibleNoPatches', "None"));
		}
		if (message.verification) {
			return localize('room.accessibleVerification', "{0}, {1}. Result verification: {2} result {3}. {4}\nEvidence: {5}",
				message.authorName, new Date(message.timestamp).toLocaleString(), verificationVerdictLabel(message.verification.verdict),
				message.verification.resultId, metadata, message.verification.evidence.join('; '));
		}
		if (message.assignment) {
			const assignment = message.assignment;
			const assignees = assignment.assigneeIds.map(id => room.members.find(member => member.id === id)?.name ?? id).join(', ');
			const superseded = this.collaborationService.messages.get().messages.some(candidate => candidate.assignment?.supersedes === message.id);
			const completed = assignment.kind === 'work'
				? assignment.assigneeIds.every(id => this.collaborationService.messages.get().messages.some(candidate => candidate.authorId === id && candidate.result?.assignmentId === message.id))
				: assignment.assigneeIds.every(id => this.collaborationService.messages.get().messages.some(candidate => candidate.authorId === id && candidate.verification?.resultId === assignment.resultId));
			const state = superseded ? localize('room.assignmentSuperseded', "Superseded") : completed ? localize('room.assignmentCompleted', "Completed") : localize('room.assignmentPending', "Pending");
			return localize('room.accessibleAssignment', "{0}, {1}. {2} assignment, {3}. Assigned to: {4}.\nObjective: {5}\nExpected evidence: {6}\nSupersedes: {7}\nResult to verify: {8}\nCoordination note: {9}",
				message.authorName, new Date(message.timestamp).toLocaleString(), assignment.kind === 'verification' ? localize('room.verificationAssignment', "Verification") : localize('room.workAssignment', "Work"),
				state, assignees, assignment.description, assignment.expectedEvidence.join('; '), assignment.supersedes ?? localize('room.none', "None"),
				assignment.resultId ?? localize('room.none', "None"), assignment.note ?? localize('room.none', "None"));
		}
		return localize('room.accessibleMessage', "{0}, {1}: {2}{3}\n{4}",
			message.authorName, new Date(message.timestamp).toLocaleString(), message.replyTo ? localize('room.accessibleReply', "Reply to {0}. ", message.replyTo) : '',
			[message.mode === 'steer' ? localize('room.humanGuidance', "Human guidance") : '', ...this.deliveryLabels(message, room)].filter(Boolean).join(', '), message.text);
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
