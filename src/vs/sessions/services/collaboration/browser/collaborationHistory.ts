/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { IObservable, observableValue, transaction } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery } from '../../../../platform/agentHost/common/agentHostRooms.js';

type HistoryOperation = 'latest' | 'earlier' | 'refresh';

interface IHistoryRequest {
	readonly generation: number;
	readonly result: DeferredPromise<void>;
}

interface IVersionedPage {
	readonly page: IAgentHostRoomMessagePage;
	readonly version: number;
}

interface IVersionedMessage {
	readonly message: IAgentHostRoomMessage;
	readonly version: number;
}

interface IHistoryBoundary {
	readonly sequence: number;
	readonly hasEarlier: boolean;
	readonly version: number;
}

interface IHistoryState {
	readonly records: Map<number, IVersionedMessage>;
	readonly boundary: IHistoryBoundary | undefined;
	readonly latestSequence: number;
	readonly page: IAgentHostRoomMessagePage;
}

const emptyPage: IAgentHostRoomMessagePage = { messages: [], hasEarlier: false, hasLater: false };

/** Maintains loaded scrollback independently of the viewport, with request-ordered authoritative updates. */
export class CollaborationHistory extends Disposable {
	private readonly _page = observableValue<IAgentHostRoomMessagePage>(this, emptyPage);
	readonly page: IObservable<IAgentHostRoomMessagePage> = this._page;
	private readonly _loading = observableValue(this, false);
	readonly loading: IObservable<boolean> = this._loading;
	private readonly _loadingEarlier = observableValue(this, false);
	readonly loadingEarlier: IObservable<boolean> = this._loadingEarlier;
	private readonly _error = observableValue<string | undefined>(this, undefined);
	readonly error: IObservable<string | undefined> = this._error;

	private readonly requests = new Map<HistoryOperation, IHistoryRequest>();
	private readonly errors = new Map<HistoryOperation | 'accept', string>();
	private records = new Map<number, IVersionedMessage>();
	private boundary: IHistoryBoundary | undefined;
	private latestSequence = 0;
	private generation = 0;
	private version = 0;
	private initialized = false;
	private refreshRequested = false;

	constructor(
		private readonly fetchPage: (query: IAgentHostRoomMessageQuery) => Promise<IAgentHostRoomMessagePage>,
		private readonly pageSize = 100,
		private readonly memberId?: string,
	) {
		if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
			throw new RangeError(localize('collaborationHistory.pageSize', "History page size must be an integer between 1 and 200."));
		}
		super();
	}

	/** Only an explicit latest load may replace an already loaded range. */
	loadLatest(): Promise<void> {
		if (this._store.isDisposed) {
			return Promise.reject(new CancellationError());
		}
		this.cancelRequests();
		this.errors.clear();
		return this.startRequest('latest', async generation => {
			const latest = await this.readPage({ limit: this.pageSize }, generation);
			const state = this.merge([latest], latest.version);
			this.initialized = true;
			this.commit(state);
		});
	}

	loadEarlier(): Promise<void> {
		if (this._store.isDisposed) {
			return Promise.reject(new CancellationError());
		}
		const running = this.requests.get('earlier');
		if (running) {
			return running.result.p;
		}
		if (!this.requests.has('latest') && !this._page.get().hasEarlier) {
			return Promise.resolve();
		}
		return this.startRequest('earlier', async generation => {
			await this.waitForLatest(generation);
			const current = this._page.get();
			const before = current.messages[0]?.sequence;
			if (before === undefined || !current.hasEarlier) {
				return;
			}
			const earlier = await this.readPage({ before, limit: this.pageSize }, generation);
			const additions = earlier.page.messages.filter(message => message.sequence < before);
			if (!additions.length || (!this.memberId && additions.at(-1)!.sequence !== before - 1)) {
				throw this.invalidHistory();
			}
			const state = this.merge([earlier]);
			this.initialized = true;
			this.commit(state);
		});
	}

	refresh(): Promise<void> {
		if (this._store.isDisposed) {
			return Promise.reject(new CancellationError());
		}
		this.refreshRequested = true;
		const running = this.requests.get('refresh');
		if (running) {
			return running.result.p;
		}
		return this.startRequest('refresh', async generation => {
			await this.waitForLatest(generation);
			this.refreshRequested = false;
			const latest = await this.refreshLatest(generation);
			await this.refreshEarlierRecords(latest, generation);
		});
	}

	/** A nonadjacent acknowledgement remains visible while refresh fills the intervening gap. */
	acceptMessage(message: IAgentHostRoomMessage): void {
		this.assertCurrent(this.generation);
		if (this.memberId && !message.mentions.includes(this.memberId)) {
			return;
		}
		try {
			const current = this._page.get();
			const page = this.normalizePage({
				messages: [message],
				hasEarlier: current.messages[0]?.sequence === message.sequence ? current.hasEarlier : message.sequence > 1,
				hasLater: false,
			});
			this.commit(this.merge([{ page, version: ++this.version }]));
			this.errors.delete('accept');
		} catch (error) {
			this.errors.delete('accept');
			this.errors.set('accept', toErrorMessage(error));
			throw error;
		} finally {
			this.updateStatus();
		}
	}

	reset(): void {
		this.cancelRequests();
		this.records.clear();
		this.errors.clear();
		this.boundary = undefined;
		this.latestSequence = 0;
		this.initialized = false;
		transaction(tx => {
			this._page.set(emptyPage, tx);
			this._loading.set(false, tx);
			this._loadingEarlier.set(false, tx);
			this._error.set(undefined, tx);
		});
	}

	cancelPendingRequests(): void {
		this.cancelRequests();
		this.updateStatus();
	}

	override dispose(): void {
		super.dispose();
		this.reset();
	}

	private startRequest(kind: HistoryOperation, work: (generation: number) => Promise<void>): Promise<void> {
		const request: IHistoryRequest = { generation: this.generation, result: new DeferredPromise<void>() };
		this.requests.set(kind, request);
		this.errors.delete(kind);
		this.updateStatus();
		void this.runRequest(kind, request, work);
		return request.result.p;
	}

	private async runRequest(kind: HistoryOperation, request: IHistoryRequest, work: (generation: number) => Promise<void>): Promise<void> {
		try {
			this.assertCurrent(request.generation);
			do {
				await work(request.generation);
				this.assertCurrent(request.generation);
			} while (kind === 'refresh' && this.refreshRequested);
		} catch (error) {
			if (request.generation === this.generation && !this._store.isDisposed) {
				this.errors.delete(kind);
				this.errors.set(kind, toErrorMessage(error));
			}
			void request.result.error(error);
			return;
		} finally {
			if (this.requests.get(kind) === request) {
				this.requests.delete(kind);
				this.updateStatus();
			}
		}
		void request.result.complete();
	}

	private async waitForLatest(generation: number): Promise<void> {
		await this.requests.get('latest')?.result.p;
		this.assertCurrent(generation);
	}

	private updateStatus(): void {
		transaction(tx => {
			this._loading.set(this.requests.has('latest') || (!this.initialized && this.requests.has('refresh')), tx);
			this._loadingEarlier.set(this.requests.has('earlier'), tx);
			this._error.set([...this.errors.values()].at(-1), tx);
		});
	}

	private cancelRequests(): void {
		this.generation++;
		for (const request of this.requests.values()) {
			void request.result.error(new CancellationError());
		}
		this.requests.clear();
		this.refreshRequested = false;
	}

	private assertCurrent(generation: number): void {
		if (generation !== this.generation || this._store.isDisposed) {
			throw new CancellationError();
		}
	}

	private async readPage(query: IAgentHostRoomMessageQuery, generation: number): Promise<IVersionedPage> {
		this.assertCurrent(generation);
		const version = ++this.version;
		const result = await this.fetchPage(this.memberId ? { ...query, memberId: this.memberId } : query);
		this.assertCurrent(generation);
		const page = this.normalizePage(result);
		if (query.after === undefined && query.before === undefined && page.hasLater) {
			throw this.invalidHistory();
		}
		for (const message of page.messages) {
			if ((query.after !== undefined && message.sequence <= query.after)
				|| (query.before !== undefined && message.sequence >= query.before)) {
				const boundary = message.sequence === query.after || message.sequence === query.before;
				if (!boundary) {
					throw this.invalidHistory();
				}
			}
		}
		return { page, version };
	}

	private async refreshLatest(generation: number): Promise<IVersionedPage> {
		const latest = await this.readPage({ limit: this.pageSize }, generation);
		const pages = [latest];
		let state = this.merge(pages);
		for (; !this.memberId;) {
			const messages = state.page.messages;
			const gap = messages.findIndex((message, index) => index > 0 && message.sequence !== messages[index - 1].sequence + 1);
			if (gap === -1) {
				break;
			}
			const after = messages[gap - 1].sequence;
			const before = messages[gap].sequence;
			const missing = await this.readPage({ after, before, limit: this.pageSize }, generation);
			this.assertProgress(missing.page, after, before);
			pages.push(missing);
			state = this.merge(pages);
		}
		this.initialized = true;
		this.commit(state);
		return latest;
	}

	private async refreshEarlierRecords(latest: IVersionedPage, generation: number): Promise<void> {
		const before = latest.page.messages[0]?.sequence;
		if (before === undefined) {
			return;
		}
		if (this.memberId) {
			let after = (this._page.get().messages[0]?.sequence ?? before) - 1;
			while (!this.refreshRequested && after < before - 1) {
				const updated = await this.readPage({ after, before, limit: this.pageSize }, generation);
				const additions = updated.page.messages.filter(message => message.sequence > after && message.sequence < before);
				if (!additions.length) {
					if (this._page.get().messages.some(message => message.sequence > after && message.sequence < before)) {
						throw this.invalidHistory();
					}
					break;
				}
				this.commit(this.merge([updated]));
				after = additions.at(-1)!.sequence;
			}
			return;
		}
		// Delivery retries can change even terminal records; refresh the loaded prefix, not just pending deliveries.
		while (!this.refreshRequested) {
			const stale = this._page.get().messages.find(message => message.sequence < before && this.records.get(message.sequence)!.version < latest.version);
			if (!stale) {
				return;
			}
			const after = stale.sequence - 1;
			const updated = await this.readPage({ after, before, limit: this.pageSize }, generation);
			this.assertProgress(updated.page, after, before);
			this.commit(this.merge([updated]));
		}
	}

	private assertProgress(page: IAgentHostRoomMessagePage, after: number, before: number): void {
		const first = page.messages.find(message => message.sequence > after && message.sequence < before);
		if (first?.sequence !== after + 1) {
			throw this.invalidHistory();
		}
	}

	private normalizePage(page: IAgentHostRoomMessagePage): IAgentHostRoomMessagePage {
		const records = new Map<number, IAgentHostRoomMessage>();
		const ids = new Map<string, number>();
		for (const message of page.messages) {
			if (!message.id || !Number.isSafeInteger(message.sequence) || message.sequence < 1
				|| (this.memberId !== undefined && !message.mentions.includes(this.memberId))
				|| (records.has(message.sequence) && records.get(message.sequence)!.id !== message.id)
				|| (ids.has(message.id) && ids.get(message.id) !== message.sequence)) {
				throw this.invalidHistory();
			}
			records.set(message.sequence, message);
			ids.set(message.id, message.sequence);
		}
		const messages = [...records.values()].sort((a, b) => a.sequence - b.sequence);
		if ((!messages.length && (page.hasEarlier || page.hasLater))
			|| (!this.memberId && messages.some((message, index) => index > 0 && message.sequence !== messages[index - 1].sequence + 1))) {
			throw this.invalidHistory();
		}
		return { messages, hasEarlier: page.hasEarlier, hasLater: page.hasLater };
	}

	private merge(pages: readonly IVersionedPage[], replaceThroughVersion?: number): IHistoryState {
		const records = new Map([...this.records].filter(([, record]) => replaceThroughVersion === undefined || record.version > replaceThroughVersion));
		const ids = new Map([...this.records.values()].map(record => [record.message.id, record.message.sequence]));
		let latestSequence = replaceThroughVersion === undefined ? this.latestSequence : 0;
		const boundaries = this.boundary ? [this.boundary] : [];
		for (const { page, version } of pages) {
			const first = page.messages[0];
			if (first) {
				boundaries.push({ sequence: first.sequence, hasEarlier: page.hasEarlier, version });
				latestSequence = Math.max(latestSequence, page.messages.at(-1)!.sequence + (page.hasLater ? 1 : 0));
			}
			for (const message of page.messages) {
				const previous = records.get(message.sequence);
				const original = this.records.get(message.sequence);
				if ((ids.has(message.id) && ids.get(message.id) !== message.sequence)
					|| (previous && previous.message.id !== message.id)
					|| (original && original.message.id !== message.id)) {
					throw this.invalidHistory();
				}
				ids.set(message.id, message.sequence);
				if (!previous || previous.version <= version) {
					records.set(message.sequence, {
						message: previous && equals(previous.message, message) ? previous.message : message,
						version,
					});
				}
			}
		}
		const messages = [...records.values()].map(record => record.message).sort((a, b) => a.sequence - b.sequence);
		const first = messages[0];
		const boundary = boundaries.filter(boundary => boundary.sequence === first?.sequence).sort((a, b) => b.version - a.version)[0];
		const last = messages.at(-1)?.sequence ?? 0;
		return {
			records,
			boundary,
			latestSequence: Math.max(latestSequence, last),
			page: {
				messages,
				hasEarlier: first ? (boundary?.hasEarlier ?? first.sequence > 1) : false,
				hasLater: latestSequence > last,
			},
		};
	}

	private commit(state: IHistoryState): void {
		this.records = state.records;
		this.boundary = state.boundary;
		this.latestSequence = state.latestSequence;
		const current = this._page.get();
		const unchanged = current.messages.length === state.page.messages.length && current.messages.every((message, index) => message === state.page.messages[index]);
		if (!unchanged || current.hasEarlier !== state.page.hasEarlier || current.hasLater !== state.page.hasLater) {
			this._page.set({ ...state.page, messages: unchanged ? current.messages : state.page.messages }, undefined);
		}
	}

	private invalidHistory(): Error {
		return new Error(localize('collaborationHistory.invalidHistory', "The room returned inconsistent message history. Retry loading the conversation."));
	}
}
