/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoomMember, IAgentHostRoomMessage, MAX_ROOM_MESSAGE_LENGTH } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { ICollaborationService } from '../../../services/collaboration/common/collaboration.js';
import { getCollaborationMentionQuery, ICollaborationMentionQuery } from '../../../services/collaboration/common/collaborationMentions.js';
import { memberStateLabel } from './collaborationRoomLabels.js';

/** The shared room composer always addresses all peers, including replies. */
export class CollaborationComposer extends Disposable {
	readonly element: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly inputArea: HTMLElement;
	private readonly send: Button;
	private readonly replyLabel: HTMLElement;
	private readonly cancelReply: Button;
	private readonly hint: HTMLElement;
	private readonly suggestions: HTMLElement;
	private readonly suggestionDisposables = this._register(new DisposableStore());
	private readonly suggestionId = `collaboration-mentions-${generateUuid()}`;
	private suggestionMembers: readonly IAgentHostRoomMember[] = [];
	private suggestionIndex = 0;
	private mentionQuery: ICollaborationMentionQuery | undefined;

	constructor(
		parent: HTMLElement,
		private readonly onSent: () => void,
		private readonly onError: (error: Error) => void,
		@ICollaborationService private readonly collaboration: ICollaborationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
		this.element = parent.appendChild($('.room-composer'));
		this.replyLabel = this.element.appendChild($('.room-hint.room-reply'));
		this.cancelReply = this._register(new Button(this.element, { ...defaultButtonStyles, secondary: true }));
		this.cancelReply.label = localize('room.cancelReply', "Cancel Reply");
		this._register(this.cancelReply.onDidClick(() => {
			this.updateDraft(this.input.value, undefined);
			this.input.focus();
		}));
		this.inputArea = this.element.appendChild($('.new-chat-input-area'));
		this.input = this.inputArea.appendChild($<HTMLTextAreaElement>('textarea'));
		this.input.maxLength = MAX_ROOM_MESSAGE_LENGTH;
		this.input.placeholder = localize('room.placeholder', "Message all peers");
		this.input.setAttribute('role', 'combobox');
		this.input.setAttribute('aria-multiline', 'true');
		this.input.setAttribute('aria-autocomplete', 'list');
		this.input.setAttribute('aria-haspopup', 'listbox');
		this.input.setAttribute('aria-expanded', 'false');
		this.input.setAttribute('aria-controls', this.suggestionId);
		this.suggestions = this.element.appendChild($('ul.room-mentions'));
		this.suggestions.id = this.suggestionId;
		this.suggestions.setAttribute('role', 'listbox');
		this.suggestions.setAttribute('aria-label', localize('room.mentions', "Insert a peer's name"));
		this.suggestions.hidden = true;
		const actions = this.inputArea.appendChild($('.sessions-chat-toolbar.room-composer-actions'));
		actions.appendChild($('span.room-hint')).textContent = localize('room.mentionHint', "@ inserts a name; messages go to all peers");
		this.send = this._register(new Button(actions, defaultButtonStyles));
		this.send.element.classList.add('room-send');
		this.send.label = localize('room.send', "Send");
		this._register(this.send.onDidClick(() => { void this.sendMessage(); }));
		this.hint = this.element.appendChild($('.room-hint.room-delivery-hint'));
		this._register(addDisposableListener(this.input, EventType.INPUT, () => {
			this.updateDraft(this.input.value, this.draft?.replyTo);
			this.updateMentions();
		}));
		this._register(addDisposableListener(this.input, EventType.CLICK, () => this.updateMentions()));
		this._register(addDisposableListener(this.input, EventType.KEY_DOWN, event => this.onKeyDown(event)));
		this._register(addDisposableListener(this.input, EventType.KEY_UP, event => {
			if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
				this.updateMentions();
			}
		}));
		this._register(addDisposableListener(this.input, EventType.FOCUS, () => this.inputArea.classList.add('focused')));
		this._register(addDisposableListener(this.input, EventType.BLUR, () => {
			this.inputArea.classList.remove('focused');
			this.hideMentions();
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.CollaborationRoom)) {
				this.updateInputLabel();
			}
		}));
		this._register(keybindingService.onDidUpdateKeybindings(() => this.updateInputLabel()));
		this._register(autorun(reader => {
			const id = collaboration.activeRoomId.read(reader);
			const room = collaboration.activeRoom.read(reader);
			const draft = id ? collaboration.getDraft(id).state.read(reader) : undefined;
			const writable = collaboration.availability.read(reader) === 'available' && collaboration.canSend.read(reader) && !!room && !room.archived;
			const sending = collaboration.sending.read(reader);
			this.element.hidden = !room;
			if (this.input.value !== (draft?.text ?? '')) {
				this.input.value = draft?.text ?? '';
				this.hideMentions();
			}
			this.input.disabled = !writable;
			this.send.enabled = writable && !sending && !!draft?.text.trim();
			this.send.element.classList.toggle('sending', sending);
			const reply = collaboration.messages.read(reader).messages.find(message => message.id === draft?.replyTo);
			this.replyLabel.hidden = !draft?.replyTo;
			this.cancelReply.element.hidden = !draft?.replyTo;
			this.cancelReply.enabled = writable;
			this.replyLabel.textContent = draft?.replyTo ? localize('room.replying', "Replying to {0}", reply?.authorName ?? draft.replyTo) : '';
			this.hint.textContent = room?.archived
				? localize('room.archiveComposer', "Archive: messages and session links are available for inspection only.")
				: !room?.run
					? localize('room.initialBudget', "Choose a finite turn budget in Run before sending to agents.")
					: (room.run.limits.maxTurns ?? 0) <= room.run.admittedTurns
						? localize('room.exhaustedBudget', "Extend the exhausted turn budget in Run before sending to agents.")
						: localize('room.inboxDelivery', "Send starts or resumes all peers using the remaining budget. Busy peers receive the message after their current turn. Sending never adds turns.");
			this.updateInputLabel();
		}));
	}

	private get draft() {
		const id = this.collaboration.activeRoomId.get();
		return id ? this.collaboration.getDraft(id) : undefined;
	}

	private updateDraft(text: string, replyTo: string | undefined): void {
		this.draft?.update(text, replyTo, { kind: 'all' });
	}

	replyTo(message: IAgentHostRoomMessage): void {
		if (this.input.disabled) {
			return;
		}
		this.updateDraft(this.input.value, message.id);
		this.input.focus();
	}

	private async sendMessage(): Promise<void> {
		if (!this.send.enabled) {
			return;
		}
		const roomId = this.collaboration.activeRoomId.get();
		try {
			this.updateDraft(this.input.value, this.draft?.replyTo);
			await this.collaboration.sendMessage();
			if (!this._store.isDisposed && roomId === this.collaboration.activeRoomId.get()) {
				this.hideMentions();
				this.onSent();
			}
		} catch (error) {
			if (!this._store.isDisposed && roomId === this.collaboration.activeRoomId.get() && !isCancellationError(error)) {
				this.onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private updateInputLabel(): void {
		const keybinding = this.keybindingService.lookupKeybinding('editor.action.accessibilityHelp')?.getAriaLabel();
		const hint = this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.CollaborationRoom) && keybinding
			? localize('room.accessibilityHint', " Press {0} for collaboration accessibility help.", keybinding) : '';
		this.input.setAttribute('aria-label', localize('room.inputLabel', "Message all peers in the collaboration room.{0}", hint));
	}

	private updateMentions(): void {
		this.mentionQuery = getCollaborationMentionQuery(this.input.value, this.input.selectionStart);
		this.suggestionMembers = this.mentionQuery
			? this.collaboration.activeRoom.get()?.members.filter(member => !member.removed && member.name.toLowerCase().startsWith(this.mentionQuery!.query.toLowerCase())) ?? []
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
		this.suggestions.hidden = !this.suggestionMembers.length;
		this.input.setAttribute('aria-expanded', String(!this.suggestions.hidden));
		if (this.suggestions.hidden) {
			this.input.removeAttribute('aria-activedescendant');
		} else {
			this.input.setAttribute('aria-activedescendant', `${this.suggestionId}-${this.suggestionIndex}`);
			for (const [index, child] of [...this.suggestions.children].entries()) {
				child.setAttribute('aria-selected', String(index === this.suggestionIndex));
			}
		}
	}

	private acceptMention(): void {
		const member = this.suggestionMembers[this.suggestionIndex];
		if (!member || !this.mentionQuery || !equals(getCollaborationMentionQuery(this.input.value, this.input.selectionStart), this.mentionQuery)) {
			this.hideMentions();
			return;
		}
		this.input.setRangeText(`@${member.name} `, this.mentionQuery.start, this.mentionQuery.end, 'end');
		this.updateDraft(this.input.value, this.draft?.replyTo);
		this.hideMentions();
		this.input.focus();
	}

	private hideMentions(): void {
		this.suggestionMembers = [];
		this.mentionQuery = undefined;
		this.updateSuggestionSelection();
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) {
			return;
		}
		if (event.key === 'Tab' && event.shiftKey) {
			this.hideMentions();
			return;
		}
		if (this.suggestionMembers.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !event.ctrlKey && !event.metaKey) {
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
			event.stopPropagation();
			void this.sendMessage();
		} else if (event.key === 'Escape' && this.draft?.replyTo) {
			event.preventDefault();
			this.updateDraft(this.input.value, undefined);
		}
	}

	focus(): boolean {
		if (this.input.disabled) {
			return false;
		}
		this.input.focus();
		return true;
	}
}
