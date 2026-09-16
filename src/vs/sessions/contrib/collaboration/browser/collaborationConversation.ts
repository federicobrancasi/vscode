/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, getActiveElement, getWindow, isAncestor, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import '../../../../workbench/contrib/chat/browser/widget/media/chat.css';
import { IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Emitter } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomArchiveSession, IAgentHostRoomMessage } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { Link } from '../../../../platform/opener/browser/link.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { getChatMarkdownRenderOptions } from '../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { ICollaborationRoomScrollState } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { collaborationAuthorAccent } from './collaborationColors.js';
import { messageAudienceLabel, messageDeliveryLabels, messageKindLabel } from './collaborationRoomLabels.js';

interface IConversationActions {
	reply(message: IAgentHostRoomMessage): void;
	inspectParticipant(participantId: string): void;
	openArtifact(artifactId: string): void;
	retry(messageId: string): void;
	hide(message: IAgentHostRoomMessage): void;
}

interface IMessageTemplate {
	readonly element: HTMLElement;
	readonly avatar: HTMLElement;
	readonly author: HTMLElement;
	readonly metadata: HTMLElement;
	readonly body: HTMLElement;
	readonly actions: HTMLElement;
	readonly lifetime: DisposableStore;
	readonly current: DisposableStore;
	readonly markdown: MutableDisposable<IRenderedMarkdown>;
	message?: IAgentHostRoomMessage;
	roomState?: IAgentHostRoom['state'];
	readOnly?: boolean;
	archived?: boolean;
	archivedSessions?: readonly IAgentHostRoomArchiveSession[];
}

/** A virtualized, variable-height shared transcript, independent from all peer chat models. */
export class CollaborationConversation extends Disposable {
	readonly element: HTMLElement;
	private readonly list: WorkbenchList<IAgentHostRoomMessage>;
	private readonly _onDidScroll = this._register(new Emitter<void>());
	readonly onDidScroll = this._onDidScroll.event;
	private readonly measure = this._register(new MutableDisposable());
	private readonly templates = new Set<IMessageTemplate>();
	private messages: readonly IAgentHostRoomMessage[] = [];
	private room: IAgentHostRoom | undefined;
	private canSend = false;
	private following = true;
	private updating = false;
	private pendingAnchor: ICollaborationRoomScrollState | undefined;

	constructor(
		container: HTMLElement,
		private readonly actions: IConversationActions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.element = container;
		const delegate: IListVirtualDelegate<IAgentHostRoomMessage> = {
			getHeight: () => 140,
			getTemplateId: () => 'collaboration-message',
			hasDynamicHeight: () => true,
		};
		const renderer: IListRenderer<IAgentHostRoomMessage, IMessageTemplate> = {
			templateId: 'collaboration-message',
			renderTemplate: parent => this.createTemplate(parent),
			renderElement: (message, _index, template) => this.renderMessage(message, template),
			disposeElement: (_message, _index, template) => {
				template.current.clear();
				template.markdown.clear();
				template.message = undefined;
			},
			disposeTemplate: template => {
				this.templates.delete(template);
				template.lifetime.dispose();
			},
		};
		this.list = this._register(instantiation.createInstance(WorkbenchList<IAgentHostRoomMessage>,
			'CollaborationConversation', container, delegate, [renderer], {
			identityProvider: { getId: message => message.id },
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('room.feed', "Shared conversation"),
				getWidgetRole: () => 'list',
				getRole: () => 'listitem',
				getAriaLabel: message => getCollaborationMessageAccessibleContent(message, this.room),
			},
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: message => `${message.authorName} ${message.text}` },
			supportDynamicHeights: true,
			setRowLineHeight: false,
			horizontalScrolling: false,
			multipleSelectionSupport: false,
			mouseSupport: false,
			alwaysConsumeMouseWheel: false,
		}));
		this._register(this.list.onDidScroll(() => {
			if (!this.updating) {
				this.following = this.list.scrollHeight - this.list.scrollTop - this.list.renderHeight < 48;
				this._onDidScroll.fire();
			}
		}));
		const observer = new (getWindow(container).ResizeObserver)(() => this.layout(container.clientWidth, container.clientHeight));
		observer.observe(container);
		this._register({ dispose: () => observer.disconnect() });
	}

	get isFollowingLatest(): boolean { return this.following; }
	get scrollTop(): number { return this.list.scrollTop; }
	get length(): number { return this.list.length; }

	/** Reuses chat presentation without constructing a private session or chat model. */
	private createTemplate(parent: HTMLElement): IMessageTemplate {
		const lifetime = new DisposableStore();
		const element = parent.appendChild($('article.room-message.interactive-item-container'));
		const header = element.appendChild($('.header'));
		const user = header.appendChild($('.user'));
		const avatarContainer = user.appendChild($('.avatar-container'));
		const avatar = avatarContainer.appendChild($('.avatar.codicon-avatar'));
		const author = user.appendChild($('h3.username'));
		const detail = user.appendChild($('.detail-container')).appendChild($('span.detail'));
		const body = element.appendChild($('.value')).appendChild($('.chat-markdown-part'));
		const template: IMessageTemplate = {
			element,
			avatar,
			author,
			metadata: detail,
			body,
			actions: element.appendChild($('.room-message-actions')),
			lifetime,
			current: lifetime.add(new DisposableStore()),
			markdown: lifetime.add(new MutableDisposable()),
		};
		this.templates.add(template);
		const observer = new (getWindow(parent).ResizeObserver)(() => this.scheduleMeasurements());
		observer.observe(element);
		lifetime.add({ dispose: () => observer.disconnect() });
		return template;
	}

	private renderMessage(message: IAgentHostRoomMessage, template: IMessageTemplate): void {
		const readOnly = !this.canSend || this.room?.archived === true;
		const archivedSessions = this.room?.archived ? this.room.archivedSessions : undefined;
		const authorSession = archivedSessions?.find(session => session.id === message.authorId);
		const changed = !equals(template.message, message) || template.roomState !== this.room?.state || template.readOnly !== readOnly
			|| template.archived !== this.room?.archived || !equals(template.archivedSessions, archivedSessions);
		const accent = collaborationAuthorAccent(this.room, message.authorId);
		// The chat identifies a speaker by avatar and name; ten agents still need telling apart.
		template.avatar.style.background = accent;
		template.element.classList.toggle('interactive-request', message.authorKind === 'human');
		template.element.classList.toggle('interactive-response', message.authorKind !== 'human');
		if (!changed) {
			return;
		}
		const focused = getActiveElement();
		const hadFocus = isAncestor(focused, template.element);
		const authorHadFocus = isAncestor(focused, template.author);
		const contentChanged = template.message?.text !== message.text || template.archived !== this.room?.archived;
		template.current.clear();
		template.message = message;
		template.roomState = this.room?.state;
		template.readOnly = readOnly;
		template.archived = this.room?.archived;
		template.archivedSessions = archivedSessions;
		template.body.classList.toggle('room-message-plain', this.room?.archived === true);
		template.element.dataset.messageId = message.id;
		template.author.textContent = message.authorName;
		if (authorSession) {
			template.author.textContent = '';
			const label = localize('room.inspectAuthor', "Inspect {0}'s archived session", message.authorName);
			template.current.add(this.instantiation.createInstance(Link, template.author, {
				label: message.authorName,
				href: authorSession.chatUri ?? authorSession.sessionUri,
				title: authorSession.worktreeUri ? localize('room.inspectAuthorWorktree', "{0}\nWorktree: {1}", label, authorSession.worktreeUri) : label,
			}, { opener: () => this.actions.inspectParticipant(message.authorId) }));
			template.author.firstElementChild?.setAttribute('aria-label', label);
		}
		template.avatar.textContent = message.authorName.replace(/[^0-9]/g, '') || message.authorName.slice(0, 1).toUpperCase();
		const delivery = messageDeliveryLabels(message, this.room);
		const kind = messageKindLabel(message.kind);
		const reply = message.replyTo ? localize('room.replyMetadata', "Reply to {0}", this.messages.find(item => item.id === message.replyTo)?.authorName ?? message.replyTo) : '';
		template.metadata.textContent = [kind, new Date(message.timestamp).toLocaleString(), messageAudienceLabel(message, this.room), reply, ...delivery].filter(Boolean).join(' | ');
		const description = messageDeliveryLabels(message, this.room, true).join('\n');
		if (description) {
			template.metadata.setAttribute('aria-description', description);
			template.current.add(this.hoverService.setupDelayedHover(template.metadata, { content: description }));
		} else {
			template.metadata.removeAttribute('aria-description');
		}
		if (this.room?.archived) {
			template.markdown.clear();
			template.body.textContent = message.text;
		} else if (contentChanged || !template.markdown.value) {
			template.markdown.value = this.markdownRenderer.render(new MarkdownString(message.text, { isTrusted: false, supportHtml: false }), getChatMarkdownRenderOptions({
				asyncRenderCallback: () => this.scheduleMeasurements(),
			}));
			template.body.replaceChildren(template.markdown.value.element);
		}
		template.actions.replaceChildren();
		const addButton = (label: string, run: () => void): Button => {
			const button = template.current.add(new Button(template.actions, { ...defaultButtonStyles, secondary: true }));
			button.label = label;
			template.current.add(button.onDidClick(run));
			return button;
		};
		addButton(localize('room.reply', "Reply"), () => this.actions.reply(message)).enabled = !readOnly;
		if (message.replyTo) {
			if (this.messages.some(candidate => candidate.id === message.replyTo)) {
				addButton(localize('room.showOriginal', "Show Original"), () => {
					const original = this.messages.findIndex(candidate => candidate.id === message.replyTo);
					this.following = false;
					this.list.reveal(original);
					this.list.setFocus([original]);
					this.list.domFocus();
				});
			}
		}
		if (message.artifactId) {
			addButton(localize('room.reviewArtifact', "Review Published Artifact"), () => this.actions.openArtifact(message.artifactId!));
		}
		for (const artifactId of new Set(message.artifactIds?.filter(id => id !== message.artifactId))) {
			const title = this.room?.artifacts.find(artifact => artifact.id === artifactId)?.title ?? artifactId;
			addButton(localize('room.reviewResultArtifact', "Review Patch: {0}", title), () => this.actions.openArtifact(artifactId));
		}
		if (message.authorKind === 'human' && message.deliveries.some(delivery => ['interrupted', 'cancelled', 'failed'].includes(delivery.state))) {
			addButton(localize('room.retryDelivery', "Retry Delivery"), () => this.actions.retry(message.id)).enabled = !readOnly && this.room?.state !== 'stopping';
		}
		if (message.authorKind !== 'agent' && !this.room?.archived) {
			const hide = addButton(localize('room.hideMessage', "Hide for Me"), () => this.actions.hide(message));
			template.current.add(this.hoverService.setupDelayedHover(hide.element, {
				content: localize('room.hideMessageDetail', "Hide this message in this profile. Room history and agent delivery are unchanged. Use Show Hidden Messages to restore it."),
			}));
		}
		if (hadFocus) {
			const target = authorHadFocus ? template.author.firstElementChild
				: [...template.actions.children].find(element => element.getAttribute('aria-disabled') !== 'true');
			if (isHTMLElement(target)) {
				target.focus();
			} else {
				this.list.domFocus();
			}
		}
		this.scheduleMeasurements();
	}

	setMessages(messages: readonly IAgentHostRoomMessage[], room: IAgentHostRoom | undefined, canSend = true): void {
		const anchor = this.captureScrollState(room?.id ?? '');
		this.updating = true;
		try {
			this.room = room;
			this.canSend = canSend;
			let prefix = 0;
			while (prefix < messages.length && prefix < this.messages.length && equals(messages[prefix], this.messages[prefix])) {
				prefix++;
			}
			let suffix = 0;
			while (suffix < messages.length - prefix && suffix < this.messages.length - prefix
				&& equals(messages[messages.length - 1 - suffix], this.messages[this.messages.length - 1 - suffix])) {
				suffix++;
			}
			this.messages = messages;
			if (prefix < this.list.length || prefix < messages.length) {
				this.list.splice(prefix, this.list.length - prefix - suffix, messages.slice(prefix, messages.length - suffix));
			}
			for (const template of this.templates) {
				if (template.message) {
					this.renderMessage(template.message, template);
				}
			}
			this.restoreScrollState(this.pendingAnchor ?? anchor);
		} finally {
			this.updating = false;
		}
	}

	layout(width: number, height: number): void {
		if (width <= 0 || height <= 0) {
			return;
		}
		const anchor = this.captureScrollState(this.room?.id ?? '');
		this.updating = true;
		try {
			this.list.layout(height, width);
			this.restoreScrollState(this.pendingAnchor ?? anchor);
		} finally {
			this.updating = false;
		}
	}

	private scheduleMeasurements(): void {
		if (this._store.isDisposed || !this.list) {
			return;
		}
		this.measure.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
			const anchor = this.captureScrollState(this.room?.id ?? '');
			this.updating = true;
			try {
				for (const template of this.templates) {
					if (!template.message || !template.element.isConnected) {
						continue;
					}
					const index = this.messages.findIndex(message => message.id === template.message?.id);
					const height = template.element.offsetHeight;
					if (index >= 0 && height > 0 && Math.abs(this.list.getElementHeight(index) - height) > 1) {
						this.list.updateElementHeight(index, height);
					}
				}
				this.restoreScrollState(this.pendingAnchor ?? anchor);
			} finally {
				this.updating = false;
			}
		});
	}

	captureScrollState(roomId: string): ICollaborationRoomScrollState {
		const index = this.list?.firstVisibleIndex ?? -1;
		return {
			roomId, followingLatest: this.following, scrollTop: this.list?.scrollTop ?? 0,
			anchorMessageId: index >= 0 && index < this.messages.length ? this.messages[index].id : undefined,
			anchorOffset: index >= 0 && index < this.messages.length ? this.list.scrollTop - this.list.getElementTop(index) : undefined,
		};
	}

	restoreScrollState(state: ICollaborationRoomScrollState): void {
		this.following = state.followingLatest;
		if (!this.list.renderHeight) {
			this.pendingAnchor = state;
			return;
		}
		const updating = this.updating;
		this.updating = true;
		try {
			if (state.followingLatest) {
				this.list.scrollTop = this.list.scrollHeight;
			} else {
				const index = state.anchorMessageId ? this.messages.findIndex(message => message.id === state.anchorMessageId) : -1;
				this.list.scrollTop = index >= 0 ? this.list.getElementTop(index) + (state.anchorOffset ?? 0) : state.scrollTop;
			}
		} finally {
			this.updating = updating;
		}
		this.pendingAnchor = undefined;
	}

	revealLatest(): void {
		this.following = true;
		this.updating = true;
		try {
			this.list.scrollTop = this.list.scrollHeight;
		} finally {
			this.updating = false;
		}
		this._onDidScroll.fire();
	}

	focus(): void { this.list.domFocus(); }
}

export function getCollaborationMessageAccessibleContent(message: IAgentHostRoomMessage, room: IAgentHostRoom | undefined): string {
	const artifacts = [...new Set([...(message.artifactId ? [message.artifactId] : []), ...(message.artifactIds ?? [])])];
	return [
		localize('room.messageAria', "{0}, {1}, {2}", message.authorName, new Date(message.timestamp).toLocaleString(), messageKindLabel(message.kind)),
		messageAudienceLabel(message, room),
		...messageDeliveryLabels(message, room, true),
		...(message.replyTo ? [localize('room.replyMetadata', "Reply to {0}", message.replyTo)] : []),
		message.text,
		...artifacts.map(id => localize('room.messageArtifact', "Published artifact: {0}", room?.artifacts.find(artifact => artifact.id === id)?.title ?? id)),
	].join('\n');
}
