/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../base/common/async.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomMember, MAX_ROOM_WORKERS } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { readToolCallMeta } from '../../../../platform/agentHost/common/meta/agentToolCallMeta.js';
import { IAgentSubscription } from '../../../../platform/agentHost/common/state/agentSubscription.js';
import { ActionEnvelope, ActionType, ChatInputCompletedAction, ChatToolCallConfirmedAction, ChatToolCallResultConfirmedAction } from '../../../../platform/agentHost/common/state/protocol/actions.js';
import { ChatState, ConfirmationOptionKind, ContentRef, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { ContentEncoding } from '../../../../platform/agentHost/common/state/sessionProtocol.js';
import { buildDefaultChatUri, StateComponents } from '../../../../platform/agentHost/common/state/sessionState.js';
import { CollaborationRequestPayload, CollaborationRequestResponse, ICollaborationRequest } from '../common/collaboration.js';

type RequestAction = ChatToolCallConfirmedAction | ChatToolCallResultConfirmedAction | ChatInputCompletedAction;

interface IRequestEntry {
	value: ICollaborationRequest;
	pending?: { readonly promise: Promise<void>; readonly finish: (error?: Error) => void; action?: RequestAction };
}

interface IChatObservation {
	readonly store: DisposableStore;
	readonly subscription: IAgentSubscription<ChatState>;
	readonly chatUri: string;
	readonly entries: Map<string, IRequestEntry>;
	member: IAgentHostRoomMember;
}

function staleRequestError(): Error {
	return new Error(localize('room.requestStale', "This approval or input request is no longer current. Its response could not be confirmed. Review the room's current requests."));
}

/** Observes only live room chats, without constructing private chat models or optimistic approval UI. */
export class CollaborationRoomRequests extends Disposable {
	readonly requests = observableValue<readonly ICollaborationRequest[]>(this, []);
	readonly error = observableValue<string | undefined>(this, undefined);
	private readonly observations = new Map<string, IChatObservation>();
	private readonly subscriptionErrors = new Map<string, string>();
	private readonly observationStore = this._register(new DisposableStore());
	private scope = '';
	private nextVersion = 0;

	constructor(
		private readonly host: IAgentHostService,
		private readonly room: IObservable<IAgentHostRoom | undefined>,
		generation: IObservable<number>,
		private readonly authorize: () => Promise<void>,
		private readonly responseTimeout = 15000,
	) {
		super();
		this._register(host.onAgentHostExit(() => {
			for (const observation of this.observations.values()) {
				for (const entry of observation.entries.values()) {
					entry.pending?.finish(new Error(localize('room.requestDisconnected', "The local agent host disconnected before confirming this response. Reconnect and review the current request.")));
				}
			}
		}));
		this._register(autorun(reader => {
			const room = this.room.read(reader);
			const scope = JSON.stringify([room?.id, generation.read(reader)]);
			if (scope !== this.scope) {
				this.scope = scope;
				this.observationStore.clear();
				this.observations.clear();
				this.subscriptionErrors.clear();
			}
			// A member's session only exists once a turn has been admitted for it, so a
			// room that was created and never started has nothing to observe. Subscribing
			// anyway reports every peer as a failure the moment the room is reopened.
			const members = room?.members.filter(member => member.turns > 0 && !['pending', 'starting', 'failed'].includes(member.state)).slice(0, MAX_ROOM_WORKERS) ?? [];
			const desired = new Map(members.map(member => [member.chatUri ?? buildDefaultChatUri(member.sessionUri), member]));
			for (const uri of this.subscriptionErrors.keys()) {
				if (!desired.has(uri)) {
					this.subscriptionErrors.delete(uri);
				}
			}
			for (const [uri, observation] of this.observations) {
				if (!desired.has(uri)) {
					this.observationStore.delete(observation.store);
					this.observations.delete(uri);
					this.subscriptionErrors.delete(uri);
				}
			}
			for (const [chatUri, member] of desired) {
				const existing = this.observations.get(chatUri);
				if (existing && !(existing.subscription.value instanceof Error && existing.member.state !== member.state)) {
					existing.member = member;
					this.updateChat(existing);
				} else {
					if (existing) {
						this.observationStore.delete(existing.store);
						this.observations.delete(chatUri);
					}
					this.observeChat(chatUri, member);
				}
			}
			this.publish();
		}));
	}

	private observeChat(chatUri: string, member: IAgentHostRoomMember): void {
		const store = this.observationStore.add(new DisposableStore());
		try {
			const subscription = store.add(this.host.getSubscription(StateComponents.Chat, URI.parse(chatUri), 'CollaborationService.roomApprovals')).object;
			const observation: IChatObservation = { store, subscription, chatUri, member, entries: new Map() };
			this.observations.set(chatUri, observation);
			store.add(toDisposable(() => {
				for (const entry of observation.entries.values()) {
					entry.pending?.finish(staleRequestError());
				}
			}));
			store.add(subscription.onDidApplyAction(envelope => this.acceptReceipt(observation, envelope)));
			const state = observableFromEvent(this, Event.any<ChatState | Error>(subscription.onDidChange, subscription.onDidError ?? Event.None), () => subscription.value instanceof Error ? subscription.value : subscription.verifiedValue);
			store.add(autorun(reader => {
				state.read(reader);
				this.updateChat(observation);
			}));
		} catch (error) {
			this.observationStore.delete(store);
			this.observations.delete(chatUri);
			this.subscriptionErrors.set(chatUri, localize('room.requestSubscriptionFailed', "Could not load {0}'s approvals: {1}", member.name, toErrorMessage(error)));
		}
	}

	private payloads(observation: IChatObservation): Map<string, { turnId: string; payload: CollaborationRequestPayload }> {
		const result = new Map<string, { turnId: string; payload: CollaborationRequestPayload }>();
		const state = observation.subscription.verifiedValue;
		const turn = state?.resource === observation.chatUri ? state.activeTurn : undefined;
		for (const part of turn?.responseParts ?? []) {
			let payload: CollaborationRequestPayload;
			let identifier: string;
			if (part.kind === ResponsePartKind.ToolCall
				&& (part.toolCall.status === ToolCallStatus.PendingResultConfirmation
					|| part.toolCall.status === ToolCallStatus.PendingConfirmation && readToolCallMeta(part.toolCall).autoApproveBySetting !== true)) {
				payload = { kind: 'tool', toolCall: part.toolCall };
				identifier = `${part.toolCall.toolCallId}:${part.toolCall.status}`;
			} else if (part.kind === ResponsePartKind.InputRequest && part.response === undefined) {
				payload = { kind: 'input', request: part.request };
				identifier = part.request.id;
			} else {
				continue;
			}
			result.set(JSON.stringify([observation.chatUri, turn!.id, payload.kind, identifier]), { turnId: turn!.id, payload });
		}
		return result;
	}

	private updateChat(observation: IChatObservation): void {
		if (observation.store.isDisposed) {
			return;
		}
		if (observation.subscription.value instanceof Error) {
			const error = observation.subscription.value;
			this.subscriptionErrors.set(observation.chatUri, localize('room.requestSubscriptionFailed', "Could not load {0}'s approvals: {1}", observation.member.name, error.message));
			for (const entry of observation.entries.values()) {
				entry.pending?.finish(error);
			}
			this.publish();
			return;
		}
		this.subscriptionErrors.delete(observation.chatUri);
		const payloads = this.payloads(observation);
		for (const [id, entry] of observation.entries) {
			const current = payloads.get(id);
			if (!current || !equals(current.payload, entry.value.payload)) {
				if (entry.pending) {
					// Subscription changes precede their receipt; let a matching receipt settle first.
					queueMicrotask(() => {
						if (entry.pending && (!this.payloads(observation).has(id) || !equals(this.payloads(observation).get(id)?.payload, entry.value.payload))) {
							entry.pending.finish(staleRequestError());
							this.updateChat(observation);
						}
					});
					payloads.delete(id);
					continue;
				}
				observation.entries.delete(id);
			}
		}
		for (const [id, { turnId, payload }] of payloads) {
			let entry = observation.entries.get(id);
			if (!entry) {
				entry = {
					value: {
						id, version: ++this.nextVersion, roomId: this.room.get()!.id,
						memberId: observation.member.id, memberName: observation.member.name,
						chatUri: observation.chatUri, turnId, payload, state: 'ready',
					},
				};
				observation.entries.set(id, entry);
				void this.loadContent(observation, entry);
			} else if (entry.value.memberName !== observation.member.name) {
				entry.value = { ...entry.value, memberName: observation.member.name };
			}
		}
		this.publish();
	}

	private publish(): void {
		if (this._store.isDisposed) {
			return;
		}
		const requests = [...this.observations.values()].flatMap(observation => [...observation.entries.values()].map(entry => entry.value));
		if (!equals(requests, this.requests.get())) {
			this.requests.set(requests, undefined);
		}
		this.error.set([...this.subscriptionErrors.values()].join('\n') || undefined, undefined);
	}

	private entryFor(request: ICollaborationRequest): { observation: IChatObservation; entry: IRequestEntry } {
		const observation = this.observations.get(request.chatUri);
		const entry = observation?.entries.get(request.id);
		if (this._store.isDisposed || !observation || observation.store.isDisposed || !entry
			|| entry.value.version !== request.version || this.room.get()?.id !== request.roomId
			|| observation.subscription.value instanceof Error
			|| !equals(this.payloads(observation).get(request.id)?.payload, request.payload)) {
			throw staleRequestError();
		}
		return { observation, entry };
	}

	private actionFor(request: ICollaborationRequest, response: CollaborationRequestResponse): RequestAction {
		const payload = request.payload;
		if (payload.kind === 'input' && response.kind === 'input') {
			return { type: ActionType.ChatInputCompleted, requestId: payload.request.id, response: response.response, ...(response.answers ? { answers: response.answers } : {}) };
		}
		if (payload.kind !== 'tool' || response.kind !== 'tool') {
			throw staleRequestError();
		}
		const toolCall = payload.toolCall;
		if (response.approved && (request.contentLoading || request.contentError)) {
			throw new Error(localize('room.requestContentRequired', "Read the complete tool input and result before allowing this request."));
		}
		if (toolCall.status === ToolCallStatus.PendingResultConfirmation) {
			return { type: ActionType.ChatToolCallResultConfirmed, turnId: request.turnId, toolCallId: toolCall.toolCallId, approved: response.approved };
		}
		const option = toolCall.options?.find(option => option.id === response.selectedOptionId);
		if (toolCall.options !== undefined && (!option || response.approved !== (option.kind === ConfirmationOptionKind.Approve))
			|| toolCall.options === undefined && response.selectedOptionId !== undefined) {
			throw new Error(localize('room.requestOptionChanged', "Choose one of the current options supplied by the agent host."));
		}
		const base = { type: ActionType.ChatToolCallConfirmed as const, turnId: request.turnId, toolCallId: toolCall.toolCallId, ...(option ? { selectedOptionId: option.id } : {}) };
		return response.approved
			? { ...base, approved: true, confirmed: ToolCallConfirmationReason.UserAction }
			: { ...base, approved: false, reason: ToolCallCancellationReason.Denied };
	}

	respond(request: ICollaborationRequest, response: CollaborationRequestResponse): Promise<void> {
		let observation: IChatObservation;
		let entry: IRequestEntry;
		let action: RequestAction;
		try {
			({ observation, entry } = this.entryFor(request));
			if (entry.pending) {
				return entry.pending.promise;
			}
			action = this.actionFor(entry.value, response);
		} catch (error) {
			return Promise.reject(error);
		}
		const store = observation.store.add(new DisposableStore());
		let settled = false;
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			entry.pending = undefined;
			entry.value = { ...entry.value, state: error ? 'failed' : 'ready', error: error?.message };
			observation.store.delete(store);
			this.publish();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		entry.pending = { promise, finish };
		entry.value = { ...entry.value, state: 'submitting', error: undefined };
		this.publish();
		const dispatch = async () => {
			try {
				if (response.kind === 'tool' ? response.approved : response.response === 'accept') {
					await this.authorize();
				}
				if (settled) {
					return;
				}
				this.entryFor(request);
				entry.pending!.action = action;
				store.add(disposableTimeout(() => finish(new Error(localize('room.requestTimeout', "The local agent host did not acknowledge this response. Review the current request and try again."))), this.responseTimeout));
				this.host.dispatch(request.chatUri, action);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(toErrorMessage(error)));
			}
		};
		void dispatch();
		return promise;
	}

	private acceptReceipt(observation: IChatObservation, envelope: ActionEnvelope): void {
		if (envelope.channel !== observation.chatUri || envelope.origin?.clientId !== this.host.clientId) {
			return;
		}
		for (const entry of observation.entries.values()) {
			const pending = entry.pending;
			const action = envelope.action;
			const expected = pending?.action;
			const matches = expected?.type === ActionType.ChatInputCompleted
				? action.type === expected.type && action.requestId === expected.requestId && action.response === expected.response
				: expected?.type === ActionType.ChatToolCallConfirmed
					? action.type === expected.type && action.turnId === expected.turnId && action.toolCallId === expected.toolCallId
					&& action.approved === expected.approved && action.selectedOptionId === expected.selectedOptionId
					: expected?.type === ActionType.ChatToolCallResultConfirmed
					&& action.type === expected.type && action.turnId === expected.turnId && action.toolCallId === expected.toolCallId && action.approved === expected.approved;
			if (!pending || !matches) {
				continue;
			}
			const unchanged = equals(this.payloads(observation).get(entry.value.id)?.payload, entry.value.payload);
			pending.finish(envelope.rejectionReason ? new Error(envelope.rejectionReason)
				: unchanged ? new Error(localize('room.requestNotApplied', "The agent host acknowledged the response but the request is still pending. Review the request and try again.")) : undefined);
			this.updateChat(observation);
			break;
		}
	}

	async reloadContent(request: ICollaborationRequest): Promise<void> {
		const { observation, entry } = this.entryFor(request);
		if (!entry.value.contentLoading && !entry.pending) {
			await this.loadContent(observation, entry);
		}
	}

	private async loadContent(observation: IChatObservation, entry: IRequestEntry): Promise<void> {
		const { payload } = entry.value;
		if (payload.kind !== 'tool') {
			return;
		}
		const { toolCall } = payload;
		const content: (string | ContentRef)[] = [];
		if (toolCall.toolInput !== undefined) {
			content.push(toolCall.toolInput);
		}
		if (toolCall.status === ToolCallStatus.PendingResultConfirmation) {
			for (const part of toolCall.content ?? []) {
				if (part.type === ToolResultContentType.Text) {
					content.push(part.text);
				} else if (part.type === ToolResultContentType.Resource) {
					content.push(part);
				} else if (part.type === ToolResultContentType.FileEdit) {
					content.push(JSON.stringify(part, null, 2));
				} else if (part.type === ToolResultContentType.Terminal) {
					content.push(JSON.stringify(part, null, 2));
				} else {
					content.push(localize('room.requestOtherContent', "Additional {0} content is available in the peer's session.", part.type));
				}
			}
			if (toolCall.structuredContent) {
				content.push(JSON.stringify(toolCall.structuredContent, null, 2));
			}
		}
		if (content.every((part): part is string => typeof part === 'string')) {
			entry.value = { ...entry.value, content: content.join('\n\n'), contentLoading: false, contentError: undefined };
			return;
		}
		entry.value = { ...entry.value, contentLoading: true, contentError: undefined };
		this.publish();
		try {
			const result = await Promise.all(content.map(async part => {
				if (typeof part === 'string') {
					return part;
				}
				const response = await this.host.resourceRead(URI.parse(part.uri));
				return response.encoding === ContentEncoding.Base64 ? decodeBase64(response.data).toString() : response.data;
			}));
			if (!observation.store.isDisposed && observation.entries.get(entry.value.id) === entry) {
				entry.value = { ...entry.value, content: result.join('\n\n'), contentLoading: false };
			}
		} catch (error) {
			if (!observation.store.isDisposed && observation.entries.get(entry.value.id) === entry) {
				entry.value = { ...entry.value, contentLoading: false, contentError: toErrorMessage(error) };
			}
		}
		this.publish();
	}
}
