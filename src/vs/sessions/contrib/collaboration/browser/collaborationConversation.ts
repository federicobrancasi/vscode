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
import { IAgentHostRoom, IAgentHostRoomMessage } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { getChatMarkdownRenderOptions } from '../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { ICollaborationRoomScrollState } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { collaborationAuthorAccent } from './collaborationColors.js';
import { deliveryStateLabel, messageKindLabel } from './collaborationRoomLabels.js';

interface IConversationActions {
	reply(message: IAgentHostRoomMessage): void;
	openArtifact(artifactId: string): void;
	retry(messageId: string): void;
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
	private following = true;
	private updating = false;
	private pendingAnchor: ICollaborationRoomScrollState | undefined;

	constructor(
		container: HTMLElement,
		private readonly actions: IConversationActions,
		@IInstantiationService instantiation: IInstantiationService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
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
				getAriaLabel: message => localize('room.messageAria', "{0}, {1}: {2}", message.authorName, messageKindLabel(message.kind), message.text),
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

	/**
	 * Mirrors the agent chat's row structure and adopts its presentational classes,
	 * so a room post reads as a chat turn. The chat's own renderer is not reusable:
	 * it is driven by an IChatViewModel the room does not have.
	 */
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
		const changed = !equals(template.message, message) || template.roomState !== this.room?.state;
		const accent = collaborationAuthorAccent(this.room, message.authorId);
		// The chat identifies a speaker by avatar and name; ten agents still need telling apart.
		template.avatar.style.background = accent;
		template.element.classList.toggle('interactive-request', message.authorKind === 'human');
		template.element.classList.toggle('interactive-response', message.authorKind !== 'human');
		if (!changed) {
			return;
		}
		const hadFocus = isAncestor(getActiveElement(), template.element);
		const contentChanged = template.message?.text !== message.text;
		template.message = message;
		template.roomState = this.room?.state;
		template.element.dataset.messageId = message.id;
		template.author.textContent = message.authorName;
		template.avatar.textContent = message.authorName.replace(/[^0-9]/g, '') || message.authorName.slice(0, 1).toUpperCase();
		const delivery = message.authorKind === 'human' && !message.mentions.length && message.mode !== 'steer'
			? [localize('room.noRecipients', "Shared with room; no agents notified")]
			: message.deliveries.map(delivery => {
				const name = this.room?.members.find(member => member.id === delivery.memberId)?.name ?? delivery.memberId;
				return localize('room.delivery', "{0}: {1}{2}", name, deliveryStateLabel(delivery.state), delivery.error ? ` (${delivery.error})` : '');
			});
		const kind = message.mode === 'steer' ? localize('room.guidance', "Human guidance") : messageKindLabel(message.kind);
		const reply = message.replyTo ? localize('room.replyMetadata', "Reply to {0}", this.messages.find(item => item.id === message.replyTo)?.authorName ?? message.replyTo) : '';
		template.metadata.textContent = [kind, new Date(message.timestamp).toLocaleString(), reply, ...delivery].filter(Boolean).join(' | ');
		if (contentChanged || !template.markdown.value) {
			template.markdown.value = this.markdownRenderer.render(new MarkdownString(message.text, { isTrusted: false, supportHtml: false }), getChatMarkdownRenderOptions({
				asyncRenderCallback: () => this.scheduleMeasurements(),
			}));
			template.body.replaceChildren(template.markdown.value.element);
		}
		template.current.clear();
		template.actions.replaceChildren();
		const addButton = (label: string, run: () => void): Button => {
			const button = template.current.add(new Button(template.actions, { ...defaultButtonStyles, secondary: true }));
			button.label = label;
			template.current.add(button.onDidClick(run));
			return button;
		};
		addButton(localize('room.reply', "Reply"), () => this.actions.reply(message));
		if (message.artifactId) {
			addButton(localize('room.reviewArtifact', "Review Published Artifact"), () => this.actions.openArtifact(message.artifactId!));
		}
		if (message.authorKind === 'human' && message.deliveries.some(delivery => ['pending', 'cancelled', 'failed'].includes(delivery.state))) {
			addButton(localize('room.retryDelivery', "Retry Delivery"), () => this.actions.retry(message.id)).enabled = this.room?.state !== 'paused' && this.room?.state !== 'stopping';
		}
		if (hadFocus) {
			const firstAction = template.actions.firstElementChild;
			if (isHTMLElement(firstAction)) {
				firstAction.focus();
			}
		}
		this.scheduleMeasurements();
	}

	setMessages(messages: readonly IAgentHostRoomMessage[], room: IAgentHostRoom | undefined): void {
		const anchor = this.captureScrollState(room?.id ?? '');
		this.updating = true;
		try {
			this.room = room;
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
