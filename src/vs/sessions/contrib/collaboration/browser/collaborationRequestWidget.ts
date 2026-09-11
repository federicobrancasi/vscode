/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { isChatInputRequestWithPlanReview } from '../../../../platform/agentHost/common/agentHostPlanReview.js';
import { ChatInputAnswer, ChatInputAnswerState, ChatInputAnswerValue, ChatInputAnswerValueKind, ChatInputQuestion, ChatInputQuestionKind, ChatInputResponseKind, ConfirmationOptionKind, StringOrMarkdown, ToolCallStatus } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { CollaborationRequestResponse, ICollaborationRequest, ICollaborationService } from '../../../services/collaboration/common/collaboration.js';

function plainText(value: StringOrMarkdown | undefined): string {
	return typeof value === 'string' ? value : value?.markdown ?? '';
}

function submitted(value: ChatInputAnswerValue): ChatInputAnswer {
	return { state: ChatInputAnswerState.Submitted, value };
}

interface IQuestionField {
	readonly question: ChatInputQuestion;
	readonly read: () => ChatInputAnswer | undefined;
}

/** A keyed request card whose input controls survive unrelated room and token updates. */
export class CollaborationRequestWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly body: HTMLElement;
	private readonly content: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly controls = this._register(new DisposableStore());
	private readonly rendered = this._register(new MutableDisposable<IRenderedMarkdown>());
	private readonly buttons: { readonly element: HTMLButtonElement; readonly authorizes: boolean }[] = [];
	private readonly fields: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[] = [];
	private request: ICollaborationRequest;
	private disabled = false;
	private submitting = false;
	private submittingFocus: HTMLElement | undefined;
	private failure: string | undefined;

	constructor(
		parent: HTMLElement,
		request: ICollaborationRequest,
		private readonly service: ICollaborationService,
		private readonly markdownRenderer: IMarkdownRendererService,
		private readonly openerService: IOpenerService,
	) {
		super();
		this.request = request;
		this.element = parent.appendChild($('.room-request'));
		this.element.setAttribute('role', 'group');
		this.title = this.element.appendChild($('h4'));
		this.title.id = `room-request-${generateUuid()}`;
		this.element.setAttribute('aria-labelledby', this.title.id);
		this.body = this.element.appendChild($('.room-request-body'));
		this.content = $('pre.room-request-content');
		this.content.tabIndex = 0;
		this.content.setAttribute('aria-label', localize('room.requestContent', "Tool input and result"));
		this.notice = this.element.appendChild($('.room-request-status'));
		this.notice.setAttribute('role', 'status');
		this.render();
		this.update(request, false);
	}

	update(request: ICollaborationRequest, disabled: boolean): void {
		const changed = request.version !== this.request.version;
		this.request = request;
		this.disabled = disabled;
		if (changed) {
			this.submitting = false;
			this.failure = undefined;
			this.render();
		}
		if (this.content.textContent !== (request.content ?? '')) {
			this.content.textContent = request.content ?? '';
		}
		this.content.hidden = !request.content;
		const busy = this.submitting || request.state === 'submitting';
		const error = this.failure ?? request.error ?? request.contentError;
		const message = busy ? localize('room.requestSubmitting', "Waiting for the agent host to confirm your response...")
			: request.contentLoading ? localize('room.requestLoading', "Loading the complete tool input and result...")
				: error ?? '';
		if (this.notice.textContent !== message) {
			this.notice.textContent = message;
		}
		this.notice.hidden = !this.notice.textContent;
		this.notice.classList.toggle('error', !!error && !busy);
		this.element.setAttribute('aria-busy', String(busy || !!request.contentLoading));
		for (const control of this.fields) {
			control.disabled = disabled || busy;
		}
		for (const button of this.buttons) {
			button.element.disabled = disabled || busy || button.authorizes && (!!request.contentLoading || !!request.contentError);
			button.element.setAttribute('aria-label', localize('room.requestActionLabel', "{0} for {1}", button.element.textContent, request.memberName));
		}
	}

	private render(): void {
		this.controls.clear();
		this.rendered.clear();
		this.buttons.length = 0;
		this.fields.length = 0;
		this.body.replaceChildren();
		const payload = this.request.payload;
		if (payload.kind === 'tool') {
			const tool = payload.toolCall;
			const title = tool.status === ToolCallStatus.PendingConfirmation ? plainText(tool.confirmationTitle) || tool.displayName
				: localize('room.requestResult', "Review {0}'s result", tool.displayName);
			this.title.textContent = localize('room.requestTitle', "{0}: {1}", this.request.memberName, title);
			this.body.appendChild($('p')).textContent = plainText(tool.invocationMessage);
			if (tool.status === ToolCallStatus.PendingResultConfirmation) {
				this.body.appendChild($('p')).textContent = plainText(tool.pastTenseMessage);
			}
			this.body.appendChild(this.content);
			const actions = this.body.appendChild($('.room-actions'));
			if (tool.status === ToolCallStatus.PendingConfirmation && tool.options !== undefined) {
				for (const option of tool.options) {
					if (option.kind === ConfirmationOptionKind.Approve || option.kind === ConfirmationOptionKind.Deny) {
						this.button(actions, option.label, () => ({ kind: 'tool', approved: option.kind === ConfirmationOptionKind.Approve, selectedOptionId: option.id }), option.kind === ConfirmationOptionKind.Approve);
					}
				}
			} else {
				this.button(actions, localize('room.requestAllow', "Allow"), () => ({ kind: 'tool', approved: true }), true);
				this.button(actions, localize('room.requestReject', "Reject"), () => ({ kind: 'tool', approved: false }), false);
			}
			this.body.appendChild($('p.room-hint')).textContent = localize('room.requestPolicy', "Approvals apply to the displayed request. Managed approvals remain one-time; Autopilot does not bypass them.");
			if ((typeof tool.toolInput !== 'string' && tool.toolInput) || (tool.status === ToolCallStatus.PendingResultConfirmation && tool.content?.some(part => part.type === 'resource'))) {
				const reload = actions.appendChild($('button')) as HTMLButtonElement;
				reload.type = 'button';
				reload.textContent = localize('room.requestReloadContent', "Reload Content");
				this.buttons.push({ element: reload, authorizes: false });
				this.controls.add(addDisposableListener(reload, EventType.CLICK, () => {
					void this.service.reloadRequestContent(this.request).catch(error => {
						if (!this._store.isDisposed) {
							this.failure = toErrorMessage(error);
							this.update(this.request, this.disabled);
						}
					});
				}));
			}
			return;
		}

		const input = payload.request;
		this.title.textContent = localize('room.requestQuestionTitle', "{0}: input needed", this.request.memberName);
		if (input.message) {
			this.body.appendChild($('p')).textContent = input.message;
		}
		if (isChatInputRequestWithPlanReview(input) && input.planReview) {
			const plan = input.planReview;
			this.title.textContent = localize('room.requestTitle', "{0}: {1}", this.request.memberName, plan.title);
			const markdown = new MarkdownString(plan.content);
			markdown.isTrusted = false;
			markdown.supportHtml = false;
			this.rendered.value = this.markdownRenderer.render(markdown);
			this.body.appendChild(this.rendered.value.element);
			const feedback = plan.canProvideFeedback ? this.textArea(this.body, localize('room.planFeedback', "Plan feedback (optional)")) : undefined;
			const actions = this.body.appendChild($('.room-actions'));
			for (const action of plan.actions) {
				this.button(actions, action.label, () => ({
					kind: 'input', response: ChatInputResponseKind.Accept,
					answers: {
						[plan.answerQuestionId]: submitted({
							kind: ChatInputAnswerValueKind.Selected, value: action.id,
							...(feedback?.value.trim() ? { freeformValues: [feedback.value.trim()] } : {}),
						}),
					},
				}), true);
			}
			if (feedback) {
				this.button(actions, localize('room.planSendFeedback', "Send Feedback"), () => {
					if (!feedback.value.trim()) {
						feedback.focus();
						return undefined;
					}
					return { kind: 'input', response: ChatInputResponseKind.Accept, answers: { [plan.answerQuestionId]: submitted({ kind: ChatInputAnswerValueKind.Text, value: feedback.value.trim() }) } };
				}, true);
			}
			this.button(actions, localize('room.requestReject', "Reject"), () => ({ kind: 'input', response: ChatInputResponseKind.Decline }), false);
			return;
		}
		if (input.url) {
			this.body.appendChild($('pre')).textContent = input.url;
			const actions = this.body.appendChild($('.room-actions'));
			this.button(actions, localize('room.requestOpenUrl', "Open Authorization Link"), async () => {
				const opened = await this.openerService.open(URI.parse(input.url!), { allowCommands: false, allowContributedOpeners: false });
				if (!opened) {
					throw new Error(localize('room.requestLinkNotOpened', "The authorization link was not opened. No response was sent."));
				}
				return { kind: 'input', response: ChatInputResponseKind.Accept };
			}, true);
			this.button(actions, localize('room.requestReject', "Reject"), () => ({ kind: 'input', response: ChatInputResponseKind.Decline }), false);
			return;
		}
		const form = this.body.appendChild($('form.room-request-form')) as HTMLFormElement;
		const fields = (input.questions ?? []).map(question => this.questionField(form, question, input.answers?.[question.id]));
		const complete = (): CollaborationRequestResponse | undefined => {
			const answers: Record<string, ChatInputAnswer> = {};
			for (const field of fields) {
				const answer = field.read();
				if (answer) {
					answers[field.question.id] = answer;
				}
			}
			return form.reportValidity() ? { kind: 'input', response: ChatInputResponseKind.Accept, answers } : undefined;
		};
		const actions = form.appendChild($('.room-actions'));
		this.button(actions, localize('room.requestSubmit', "Submit"), complete, true);
		this.button(actions, localize('room.requestReject', "Reject"), () => ({ kind: 'input', response: ChatInputResponseKind.Decline }), false);
		this.controls.add(addDisposableListener(form, EventType.SUBMIT, event => {
			event.preventDefault();
			void this.respond(complete);
		}));
	}

	private questionField(form: HTMLFormElement, question: ChatInputQuestion, answer: ChatInputAnswer | undefined): IQuestionField {
		const label = question.message;
		const fieldset = form.appendChild($('fieldset'));
		fieldset.appendChild($('legend')).textContent = question.title ?? question.message;
		if (question.title && question.message !== question.title) {
			fieldset.appendChild($('p')).textContent = question.message;
		}
		const value = answer?.state === ChatInputAnswerState.Draft || answer?.state === ChatInputAnswerState.Submitted ? answer.value : undefined;
		if (question.kind === ChatInputQuestionKind.Text) {
			const input = fieldset.appendChild($('input')) as HTMLInputElement;
			this.fields.push(input);
			input.setAttribute('aria-label', question.message);
			input.type = question.format === 'email' ? 'email' : question.format === 'uri' ? 'url' : question.format === 'date' ? 'date' : 'text';
			input.required = question.required === true;
			if (question.min !== undefined) { input.minLength = question.min; }
			if (question.max !== undefined) { input.maxLength = question.max; }
			input.value = value?.kind === ChatInputAnswerValueKind.Text ? value.value : question.defaultValue ?? '';
			return { question, read: () => input.value ? submitted({ kind: ChatInputAnswerValueKind.Text, value: input.value }) : undefined };
		}
		if (question.kind === ChatInputQuestionKind.Number || question.kind === ChatInputQuestionKind.Integer) {
			const input = fieldset.appendChild($('input')) as HTMLInputElement;
			this.fields.push(input);
			input.setAttribute('aria-label', question.message);
			input.type = 'number';
			input.step = question.kind === ChatInputQuestionKind.Integer ? '1' : 'any';
			input.required = question.required === true;
			if (question.min !== undefined) { input.min = String(question.min); }
			if (question.max !== undefined) { input.max = String(question.max); }
			const initial = value?.kind === ChatInputAnswerValueKind.Number ? value.value : question.defaultValue;
			input.value = initial !== undefined ? String(initial) : '';
			return { question, read: () => input.value && Number.isFinite(input.valueAsNumber) ? submitted({ kind: ChatInputAnswerValueKind.Number, value: input.valueAsNumber }) : undefined };
		}
		if (question.kind === ChatInputQuestionKind.Boolean) {
			const input = fieldset.appendChild($('select')) as HTMLSelectElement;
			this.fields.push(input);
			input.setAttribute('aria-label', question.message);
			input.add(new Option(localize('room.questionChoose', "Choose an Answer"), ''));
			input.add(new Option(localize('room.questionYes', "Yes"), 'true'));
			input.add(new Option(localize('room.questionNo', "No"), 'false'));
			input.required = question.required === true;
			const initial = value?.kind === ChatInputAnswerValueKind.Boolean ? value.value : question.defaultValue;
			input.value = initial !== undefined ? String(initial) : '';
			return { question, read: () => input.value ? submitted({ kind: ChatInputAnswerValueKind.Boolean, value: input.value === 'true' }) : undefined };
		}
		if (question.kind === ChatInputQuestionKind.SingleSelect || question.kind === ChatInputQuestionKind.MultiSelect) {
			const input = fieldset.appendChild($('select')) as HTMLSelectElement;
			this.fields.push(input);
			input.multiple = question.kind === ChatInputQuestionKind.MultiSelect;
			input.setAttribute('aria-label', question.message);
			if (!input.multiple) {
				input.add(new Option(localize('room.questionChoose', "Choose an Answer"), ''));
			}
			for (const option of question.options) {
				const label = option.description ? localize('room.questionOption', "{0} - {1}", option.label, option.description) : option.label;
				const selected = value?.kind === ChatInputAnswerValueKind.Selected ? value.value === option.id
					: value?.kind === ChatInputAnswerValueKind.SelectedMany && value.value.includes(option.id);
				input.add(new Option(label, option.id, false, !!selected));
			}
			const freeform = question.allowFreeformInput ? this.textArea(fieldset, localize('room.questionOther', "Other answer")) : undefined;
			if (freeform) {
				freeform.value = value?.kind === ChatInputAnswerValueKind.Text ? value.value
					: value?.kind === ChatInputAnswerValueKind.Selected || value?.kind === ChatInputAnswerValueKind.SelectedMany ? value.freeformValues?.join('\n') ?? '' : '';
			}
			this.controls.add(addDisposableListener(fieldset, EventType.INPUT, () => input.setCustomValidity('')));
			return {
				question, read: () => {
					const selected = Array.from(input.selectedOptions).map(option => option.value).filter(Boolean);
					const text = freeform?.value.trim();
					const count = selected.length + (text ? 1 : 0);
					const invalid = question.required && !count || question.kind === ChatInputQuestionKind.MultiSelect
						&& (question.min !== undefined && count < question.min || question.max !== undefined && count > question.max);
					input.setCustomValidity(invalid ? localize('room.questionRequired', "Choose the requested number of answers.") : '');
					if (question.kind === ChatInputQuestionKind.SingleSelect && !selected.length) {
						return text ? submitted({ kind: ChatInputAnswerValueKind.Text, value: text }) : undefined;
					}
					if (!count) { return undefined; }
					return submitted(question.kind === ChatInputQuestionKind.MultiSelect
						? { kind: ChatInputAnswerValueKind.SelectedMany, value: selected, ...(text ? { freeformValues: [text] } : {}) }
						: { kind: ChatInputAnswerValueKind.Selected, value: selected[0], ...(text ? { freeformValues: [text] } : {}) });
				}
			};
		}
		const unsupported = fieldset.appendChild($('input')) as HTMLInputElement;
		this.fields.push(unsupported);
		unsupported.setCustomValidity(localize('room.questionUnsupported', "Open this peer's session to answer this type of question."));
		unsupported.setAttribute('aria-label', label);
		return { question, read: () => undefined };
	}

	private textArea(parent: HTMLElement, label: string): HTMLTextAreaElement {
		const container = parent.appendChild($('label'));
		container.append(label);
		const input = container.appendChild($('textarea')) as HTMLTextAreaElement;
		this.fields.push(input);
		return input;
	}

	private button(parent: HTMLElement, label: string, response: () => CollaborationRequestResponse | undefined | Promise<CollaborationRequestResponse | undefined>, authorizes: boolean): void {
		const button = parent.appendChild($('button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.classList.toggle('primary', authorizes);
		this.buttons.push({ element: button, authorizes });
		this.controls.add(addDisposableListener(button, EventType.CLICK, () => { void this.respond(response); }));
	}

	private async respond(response: () => CollaborationRequestResponse | undefined | Promise<CollaborationRequestResponse | undefined>): Promise<void> {
		if (this.submitting || this.request.state === 'submitting' || this.disabled || this._store.isDisposed) {
			return;
		}
		const request = this.request;
		const active = getActiveElement();
		this.submittingFocus = isHTMLElement(active) && this.element.contains(active) ? active : undefined;
		this.submitting = true;
		this.failure = undefined;
		try {
			const result = await response();
			if (!result || this._store.isDisposed || request.version !== this.request.version) {
				return;
			}
			this.update(this.request, this.disabled);
			await this.service.respondToRequest(request, result);
		} catch (error) {
			if (!this._store.isDisposed && request.version === this.request.version) {
				this.failure = toErrorMessage(error);
			}
		} finally {
			if (!this._store.isDisposed && request.version === this.request.version) {
				this.submitting = false;
				this.update(this.request, this.disabled);
				if (this.submittingFocus?.isConnected && getActiveElement() === this.element.ownerDocument.body) {
					this.submittingFocus.focus();
				}
				this.submittingFocus = undefined;
			}
		}
	}

	shouldRestoreFocus(active: Element | null): boolean {
		return !!active && (this.element.contains(active) || !!this.submittingFocus && active === this.element.ownerDocument.body);
	}

	getFocusTarget(): HTMLButtonElement | undefined {
		return this.buttons.find(button => !button.element.disabled)?.element;
	}

	getAccessibleContent(): string {
		return [this.title.textContent, this.body.textContent, this.notice.textContent].filter(Boolean).join('\n');
	}

	override dispose(): void {
		super.dispose();
		this.element.remove();
	}
}
