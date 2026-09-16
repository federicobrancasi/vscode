/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostRoomDeliveryState, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { CollaborationHistory } from '../../browser/collaborationHistory.js';

interface IPageRequest {
	readonly query: IAgentHostRoomMessageQuery;
	readonly result: DeferredPromise<IAgentHostRoomMessagePage>;
}

class PageFetcher {
	readonly queries: IAgentHostRoomMessageQuery[] = [];
	private readonly pending: IPageRequest[] = [];
	private waiting: DeferredPromise<IPageRequest> | undefined;

	readonly fetch = (query: IAgentHostRoomMessageQuery): Promise<IAgentHostRoomMessagePage> => {
		const request = { query, result: new DeferredPromise<IAgentHostRoomMessagePage>() };
		this.queries.push(query);
		if (this.waiting) {
			const waiting = this.waiting;
			this.waiting = undefined;
			void waiting.complete(request);
		} else {
			this.pending.push(request);
		}
		return request.result.p;
	};

	next(): Promise<IPageRequest> {
		const request = this.pending.shift();
		if (request) {
			return Promise.resolve(request);
		}
		assert.strictEqual(this.waiting, undefined);
		this.waiting = new DeferredPromise<IPageRequest>();
		return this.waiting.p;
	}

	async respond(messages: readonly IAgentHostRoomMessage[]): Promise<void> {
		const request = await this.next();
		await request.result.complete(selectPage(messages, request.query));
	}
}

function message(sequence: number): IAgentHostRoomMessage {
	const authorKind = sequence % 3 === 0 ? 'system' : sequence % 3 === 1 ? 'human' : 'agent';
	return {
		id: `message-${sequence}`, sequence, authorId: authorKind, authorName: authorKind,
		authorKind, kind: authorKind === 'system' ? 'system' : 'message', text: `Message ${sequence}`,
		timestamp: sequence, mentions: [], deliveries: [],
	};
}

function messages(first: number, last: number): IAgentHostRoomMessage[] {
	return Array.from({ length: last - first + 1 }, (_, index) => message(first + index));
}

function delivered(record: IAgentHostRoomMessage, state: AgentHostRoomDeliveryState): IAgentHostRoomMessage {
	return { ...record, deliveries: [{ memberId: 'member', state }] };
}

function selectPage(messages: readonly IAgentHostRoomMessage[], query: IAgentHostRoomMessageQuery): IAgentHostRoomMessagePage {
	const source = messages.filter(message => !query.memberId || message.mentions.includes(query.memberId));
	const matching = source.filter(message => (query.after === undefined || message.sequence > query.after) && (query.before === undefined || message.sequence < query.before));
	const limit = Math.min(query.limit ?? 100, 200);
	const page = query.after === undefined ? matching.slice(-limit) : matching.slice(0, limit);
	return {
		messages: page,
		hasEarlier: !!page.length && source[0].sequence < page[0].sequence,
		hasLater: !!page.length && source[source.length - 1].sequence > page[page.length - 1].sequence,
	};
}

function snapshot(history: CollaborationHistory) {
	const page = history.page.get();
	return {
		sequences: page.messages.map(message => message.sequence),
		hasEarlier: page.hasEarlier,
		hasLater: page.hasLater,
		loading: history.loading.get(),
		loadingEarlier: history.loadingEarlier.get(),
		error: history.error.get(),
	};
}

suite('CollaborationHistory', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('inbox history pages sparse sequences, bridges new mail, and never mutates receipts', async () => {
		const queries: IAgentHostRoomMessageQuery[] = [];
		let records = [2, 6, 9, 20, 45].map(sequence => ({
			...message(sequence), mentions: ['member'], deliveries: [{ memberId: 'member', state: 'pending' as const }],
		}));
		const original = JSON.stringify(records);
		const history = store.add(new CollaborationHistory(async query => {
			queries.push(query);
			return selectPage(records, query);
		}, 2, 'member'));
		await history.loadLatest();
		await history.loadEarlier();
		await history.loadEarlier();
		const readOnly = JSON.stringify(records) === original;
		records = [...records, ...[60, 80, 90, 110, 140].map(sequence => ({
			...message(sequence), mentions: ['member'], deliveries: [{ memberId: 'member', state: 'pending' as const }],
		}))];
		await history.refresh();
		history.acceptMessage({ ...message(150), mentions: ['another-member'] });
		assert.deepStrictEqual({
			state: snapshot(history), readOnly,
			queriesAreBounded: queries.every(query => query.memberId === 'member' && query.limit === 2),
			receipts: history.page.get().messages.flatMap(message => message.deliveries.map(delivery => delivery.state)),
		}, {
			state: { sequences: [2, 6, 9, 20, 45, 60, 80, 90, 110, 140], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			readOnly: true, queriesAreBounded: true, receipts: Array(10).fill('pending'),
		});
	});

	test('an inbox rejects a page for another recipient rather than marking it handled', async () => {
		const history = store.add(new CollaborationHistory(async () => ({
			messages: [{ ...message(3), mentions: ['another-member'] }], hasEarlier: false, hasLater: false,
		}), 2, 'member'));
		await assert.rejects(history.loadLatest(), /inconsistent message history/);
		assert.deepStrictEqual(history.page.get().messages, []);
	});

	function setup(pageSize?: number) {
		const fetcher = new PageFetcher();
		const history = store.add(new CollaborationHistory(fetcher.fetch, pageSize));
		return { history, fetcher };
	}

	async function load(history: CollaborationHistory, fetcher: PageFetcher, records: readonly IAgentHostRoomMessage[]): Promise<void> {
		const pending = history.loadLatest();
		await fetcher.respond(records);
		await pending;
	}

	async function loadEarlier(history: CollaborationHistory, fetcher: PageFetcher, records: readonly IAgentHostRoomMessage[]): Promise<void> {
		const pending = history.loadEarlier();
		await fetcher.respond(records);
		await pending;
	}

	test('loads the default latest tail with every author kind and observable loading state', async () => {
		const { history, fetcher } = setup();
		const initial = snapshot(history);
		const pending = history.loadLatest();
		const loading = snapshot(history);
		await fetcher.respond(messages(1, 103));
		await pending;

		assert.deepStrictEqual({
			initial, loading, loaded: snapshot(history),
			authors: [...new Set(history.page.get().messages.map(message => message.authorKind))],
			queries: fetcher.queries,
		}, {
			initial: { sequences: [], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			loading: { sequences: [], hasEarlier: false, hasLater: false, loading: true, loadingEarlier: false, error: undefined },
			loaded: { sequences: messages(4, 103).map(message => message.sequence), hasEarlier: true, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			authors: ['human', 'agent', 'system'],
			queries: [{ limit: 100 }],
		});
	});

	test('prepends multiple earlier pages, shares an in-flight load, and stops at the beginning', async () => {
		const { history, fetcher } = setup(2);
		const records = messages(1, 7);
		await load(history, fetcher, records);
		const tail = history.page.get().messages;
		const first = history.loadEarlier();
		const duplicate = history.loadEarlier();
		const loading = snapshot(history);
		await fetcher.respond(records);
		await first;
		await loadEarlier(history, fetcher, records);
		await loadEarlier(history, fetcher, records);
		await history.loadEarlier();

		assert.deepStrictEqual({
			shared: first === duplicate,
			loading,
			page: history.page.get(),
			tailRetained: tail.every((message, index) => message === history.page.get().messages[index + 5]),
			queries: fetcher.queries,
		}, {
			shared: true,
			loading: { sequences: [6, 7], hasEarlier: true, hasLater: false, loading: false, loadingEarlier: true, error: undefined },
			page: { messages: records, hasEarlier: false, hasLater: false },
			tailRetained: true,
			queries: [{ limit: 2 }, { before: 6, limit: 2 }, { before: 4, limit: 2 }, { before: 2, limit: 2 }],
		});
	});

	test('bridges more than 200 new messages without dropping loaded history or leaving sequence holes', async () => {
		const { history, fetcher } = setup();
		await load(history, fetcher, messages(1, 100));
		const records = messages(1, 451);
		const pending = history.refresh();
		await fetcher.respond(records);
		for (let index = 0; index < 4; index++) {
			await fetcher.respond(records);
		}
		await pending;

		assert.deepStrictEqual({
			page: history.page.get(),
			queries: fetcher.queries,
		}, {
			page: { messages: records, hasEarlier: false, hasLater: false },
			queries: [
				{ limit: 100 }, { limit: 100 },
				{ after: 100, before: 352, limit: 100 },
				{ after: 200, before: 352, limit: 100 },
				{ after: 300, before: 352, limit: 100 },
				{ after: 0, before: 352, limit: 100 },
			],
		});
	});

	test('refresh initializes empty history without toggling loading on subsequent activity', async () => {
		const { history, fetcher } = setup(2);
		const first = history.refresh();
		const initiallyLoading = history.loading.get();
		await fetcher.respond([]);
		await first;
		const second = history.refresh();
		const subsequentlyLoading = history.loading.get();
		await fetcher.respond([]);
		await second;

		assert.deepStrictEqual({
			initiallyLoading, subsequentlyLoading, state: snapshot(history), queries: fetcher.queries,
		}, {
			initiallyLoading: true, subsequentlyLoading: false,
			state: { sequences: [], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			queries: [{ limit: 2 }, { limit: 2 }],
		});
	});

	test('coalesces refresh events and runs a fresh latest request for events received in flight', async () => {
		const { history, fetcher } = setup(2);
		await load(history, fetcher, messages(1, 2));
		const first = history.refresh();
		const request = await fetcher.next();
		const second = history.refresh();
		const third = history.refresh();
		const loading = history.loading.get();
		await request.result.complete(selectPage(messages(1, 3), request.query));
		await fetcher.respond(messages(1, 4));
		await fetcher.respond(messages(1, 4));
		await Promise.all([first, second, third]);

		assert.deepStrictEqual({
			shared: first === second && second === third,
			loading, page: history.page.get(), queries: fetcher.queries,
		}, {
			shared: true, loading: false,
			page: { messages: messages(1, 4), hasEarlier: false, hasLater: false },
			queries: [{ limit: 2 }, { limit: 2 }, { limit: 2 }, { after: 0, before: 3, limit: 2 }],
		});
	});

	test('queues refresh behind initialization without replacing the loaded range', async () => {
		const { history, fetcher } = setup(2);
		const latest = history.loadLatest();
		const refresh = history.refresh();
		await fetcher.respond(messages(1, 2));
		await fetcher.respond(messages(1, 3));
		await fetcher.respond(messages(1, 3));
		await Promise.all([latest, refresh]);

		assert.deepStrictEqual({
			page: history.page.get(), queries: fetcher.queries,
		}, {
			page: { messages: messages(1, 3), hasEarlier: false, hasLater: false },
			queries: [{ limit: 2 }, { limit: 2 }, { after: 0, before: 2, limit: 2 }],
		});
	});

	test('does not lose refresh events at the completion microtask boundary', async () => {
		const observed: number[][] = [];
		for (let delay = 0; delay < 16; delay++) {
			const started = new DeferredPromise<void>();
			const response = new DeferredPromise<IAgentHostRoomMessagePage>();
			let latestSequence = 2;
			let requests = 0;
			const history = store.add(new CollaborationHistory(async query => {
				if (++requests === 2) {
					void started.complete();
					return response.p;
				}
				return selectPage(messages(1, latestSequence), query);
			}, 2));
			await history.loadLatest();
			const first = history.refresh();
			await started.p;
			await response.complete(selectPage(messages(1, 2), { limit: 2 }));
			for (let microtask = 0; microtask < delay; microtask++) {
				await Promise.resolve();
			}
			latestSequence = 3;
			const second = history.refresh();
			await Promise.all([first, second]);
			observed.push(history.page.get().messages.map(message => message.sequence));
		}

		assert.deepStrictEqual(observed, Array.from({ length: 16 }, () => [1, 2, 3]));
	});

	test('authoritatively refreshes delivery changes throughout loaded scrollback, including retries', async () => {
		const { history, fetcher } = setup(2);
		const original = messages(1, 6).map(message => message.sequence === 1
			? delivered(message, 'pending') : message.sequence === 4 ? delivered(message, 'failed') : message);
		await load(history, fetcher, original);
		await loadEarlier(history, fetcher, original);
		await loadEarlier(history, fetcher, original);
		const updated = original.map(message => message.sequence === 1
			? delivered(message, 'submitted') : message.sequence === 4 ? delivered(message, 'pending') : message);
		const pending = history.refresh();
		await fetcher.respond(updated);
		await fetcher.respond(updated);
		await fetcher.respond(updated);
		await pending;

		assert.deepStrictEqual({
			page: history.page.get(), refreshQueries: fetcher.queries.slice(3),
		}, {
			page: { messages: updated, hasEarlier: false, hasLater: false },
			refreshQueries: [{ limit: 2 }, { after: 0, before: 5, limit: 2 }, { after: 2, before: 5, limit: 2 }],
		});
	});

	test('does not republish unchanged messages during an authoritative refresh', async () => {
		const { history, fetcher } = setup(2);
		const records = messages(1, 2);
		await load(history, fetcher, records);
		const page = history.page.get();
		let changes = 0;
		store.add(autorun(reader => {
			history.page.read(reader);
			changes++;
		}));
		const pending = history.refresh();
		await fetcher.respond(records.map(message => ({ ...message, mentions: [], deliveries: [] })));
		await pending;

		assert.deepStrictEqual({ changes, samePage: history.page.get() === page }, { changes: 1, samePage: true });
	});

	test('deduplicates repeated and inclusive boundary IDs while applying delivery updates', async () => {
		const { history, fetcher } = setup(2);
		const records = messages(1, 4);
		await load(history, fetcher, records);
		const pending = history.loadEarlier();
		const request = await fetcher.next();
		const updated = delivered(records[2], 'submitted');
		await request.result.complete({
			messages: [updated, records[1], records[0], records[1]],
			hasEarlier: false, hasLater: true,
		});
		await pending;

		assert.deepStrictEqual(history.page.get(), {
			messages: [records[0], records[1], updated, records[3]], hasEarlier: false, hasLater: false,
		});
	});

	for (const earlierFirst of [false, true]) {
		test(`merges an earlier load and live refresh when the earlier response finishes ${earlierFirst ? 'first' : 'last'}`, async () => {
			const { history, fetcher } = setup(2);
			const original = messages(1, 8).map(message => message.sequence === 5 ? delivered(message, 'pending') : message);
			const updated = original.map(message => message.sequence === 5 ? delivered(message, 'submitted') : message);
			await load(history, fetcher, original.slice(0, 6));
			const earlier = history.loadEarlier();
			const earlierRequest = await fetcher.next();
			const refresh = history.refresh();
			const latestRequest = await fetcher.next();
			const earlierPage: IAgentHostRoomMessagePage = { messages: original.slice(2, 5), hasEarlier: true, hasLater: true };
			if (earlierFirst) {
				await earlierRequest.result.complete(earlierPage);
				await earlier;
			}
			await latestRequest.result.complete(selectPage(updated, latestRequest.query));
			await fetcher.respond(updated);
			if (earlierFirst) {
				await fetcher.respond(updated);
			}
			await refresh;
			const liveWhileEarlierPending = !earlierFirst && history.loadingEarlier.get() && history.page.get().messages.at(-1)?.sequence === 8;
			if (!earlierFirst) {
				await earlierRequest.result.complete(earlierPage);
				await earlier;
			}

			assert.deepStrictEqual({
				page: history.page.get(),
				liveWhileEarlierPending,
				loading: history.loading.get(),
				loadingEarlier: history.loadingEarlier.get(),
			}, {
				page: { messages: updated.slice(2), hasEarlier: true, hasLater: false },
				liveWhileEarlierPending: !earlierFirst,
				loading: false, loadingEarlier: false,
			});
		});
	}

	for (const fails of [false, true]) {
		test(`keeps a send acknowledgement visible when an older refresh ${fails ? 'fails' : 'completes'}`, async () => {
			const { history, fetcher } = setup(2);
			const original = messages(1, 2);
			await load(history, fetcher, original);
			const refresh = history.refresh();
			const request = await fetcher.next();
			const acknowledgement = message(3);
			history.acceptMessage(acknowledgement);
			const immediate = snapshot(history);
			if (fails) {
				const rejected = assert.rejects(refresh, /Disconnected/);
				await request.result.error(new Error('Disconnected'));
				await rejected;
			} else {
				await request.result.complete(selectPage(original, request.query));
				await refresh;
			}

			assert.deepStrictEqual({
				immediate, page: history.page.get(), error: history.error.get(),
			}, {
				immediate: { sequences: [1, 2, 3], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
				page: { messages: [...original, acknowledgement], hasEarlier: false, hasLater: false },
				error: fails ? 'Disconnected' : undefined,
			});
		});
	}

	for (const state of ['reserved', 'submitted'] as const) {
		test(`does not roll back a ${state} receipt with a request started earlier`, async () => {
			const { history, fetcher } = setup(2);
			const original = [message(1), delivered(message(2), 'pending')];
			await load(history, fetcher, original);
			const refresh = history.refresh();
			const request = await fetcher.next();
			const acknowledgement = delivered(original[1], state);
			history.acceptMessage(acknowledgement);
			await request.result.complete(selectPage(original, request.query));
			await refresh;

			assert.deepStrictEqual(history.page.get(), { messages: [original[0], acknowledgement], hasEarlier: false, hasLater: false });
		});
	}

	test('keeps an acknowledgement received before an empty initial snapshot completes', async () => {
		const { history, fetcher } = setup(2);
		const pending = history.loadLatest();
		const request = await fetcher.next();
		history.acceptMessage(message(1));
		await request.result.complete({ messages: [], hasEarlier: false, hasLater: false });
		await pending;

		assert.deepStrictEqual(snapshot(history), {
			sequences: [1], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined,
		});
	});

	test('immediately retains a distant acknowledgement and bridges inclusive boundaries across staged pages', async () => {
		const { history, fetcher } = setup(2);
		await load(history, fetcher, messages(1, 2));
		history.acceptMessage(message(9));
		const immediate = snapshot(history);
		const pending = history.refresh();
		await fetcher.respond(messages(1, 9));
		for (const [first, last] of [[2, 4], [4, 6], [6, 7]]) {
			const request = await fetcher.next();
			await request.result.complete({ messages: messages(first, last), hasEarlier: true, hasLater: true });
		}
		await fetcher.respond(messages(1, 9));
		await pending;

		assert.deepStrictEqual({
			immediate, page: history.page.get(), queries: fetcher.queries,
		}, {
			immediate: { sequences: [1, 2, 9], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			page: { messages: messages(1, 9), hasEarlier: false, hasLater: false },
			queries: [
				{ limit: 2 }, { limit: 2 },
				{ after: 2, before: 8, limit: 2 }, { after: 4, before: 8, limit: 2 }, { after: 6, before: 8, limit: 2 },
				{ after: 0, before: 8, limit: 2 },
			],
		});
	});

	test('includes acknowledgements received while a gap is being bridged', async () => {
		const { history, fetcher } = setup(2);
		await load(history, fetcher, messages(1, 2));
		const pending = history.refresh();
		await fetcher.respond(messages(1, 7));
		const gap = await fetcher.next();
		history.acceptMessage(message(10));
		const immediate = snapshot(history);
		await gap.result.complete(selectPage(messages(1, 10), gap.query));
		for (let index = 0; index < 3; index++) {
			await fetcher.respond(messages(1, 10));
		}
		await pending;

		assert.deepStrictEqual({
			immediate, page: history.page.get(),
		}, {
			immediate: { sequences: [1, 2, 10], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			page: { messages: messages(1, 10), hasEarlier: false, hasLater: false },
		});
	});

	test('prioritizes a queued live refresh over the remaining delivery reconciliation pages', async () => {
		const { history, fetcher } = setup(2);
		const original = messages(1, 6);
		await load(history, fetcher, original);
		await loadEarlier(history, fetcher, original);
		await loadEarlier(history, fetcher, original);
		const pending = history.refresh();
		await fetcher.respond(original);
		const reconciliation = await fetcher.next();
		const queued = history.refresh();
		await reconciliation.result.complete(selectPage(original, reconciliation.query));
		const updated = messages(1, 7);
		await fetcher.respond(updated);
		for (let index = 0; index < 3; index++) {
			await fetcher.respond(updated);
		}
		await Promise.all([pending, queued]);

		assert.deepStrictEqual({
			page: history.page.get(), refreshQueries: fetcher.queries.slice(3),
		}, {
			page: { messages: updated, hasEarlier: false, hasLater: false },
			refreshQueries: [
				{ limit: 2 }, { after: 0, before: 5, limit: 2 },
				{ limit: 2 }, { after: 0, before: 6, limit: 2 }, { after: 2, before: 6, limit: 2 }, { after: 4, before: 6, limit: 2 },
			],
		});
	});

	test('replaces the range only on explicit latest loading and retains already loaded history on failure', async () => {
		const { history, fetcher } = setup(2);
		const original = messages(1, 6);
		await load(history, fetcher, original);
		await loadEarlier(history, fetcher, original);
		const previous = history.page.get();
		const failed = history.loadLatest();
		const rejected = assert.rejects(failed, /Latest unavailable/);
		await (await fetcher.next()).result.error(new Error('Latest unavailable'));
		await rejected;
		const retained = history.page.get() === previous;
		await load(history, fetcher, messages(1, 8));

		assert.deepStrictEqual({
			retained, state: snapshot(history),
		}, {
			retained: true,
			state: { sequences: [7, 8], hasEarlier: true, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
		});
	});

	test('explicit latest loading cancels older and refresh requests without losing a newer acknowledgement', async () => {
		const { history, fetcher } = setup(2);
		const original = messages(1, 6);
		await load(history, fetcher, original);
		const earlier = history.loadEarlier();
		const earlierRequest = await fetcher.next();
		const refresh = history.refresh();
		const refreshRequest = await fetcher.next();
		const cancelled = Promise.all([assert.rejects(earlier, isCancellationError), assert.rejects(refresh, isCancellationError)]);
		const latest = history.loadLatest();
		await cancelled;
		const latestRequest = await fetcher.next();
		history.acceptMessage(message(9));
		await latestRequest.result.complete(selectPage(messages(1, 8), latestRequest.query));
		await latest;
		await earlierRequest.result.complete(selectPage(original, earlierRequest.query));
		await refreshRequest.result.complete(selectPage(original, refreshRequest.query));

		assert.deepStrictEqual(snapshot(history), {
			sequences: [7, 8, 9], hasEarlier: true, hasLater: false, loading: false, loadingEarlier: false, error: undefined,
		});
	});

	test('ignores an older explicit latest request completing after its replacement', async () => {
		const { history, fetcher } = setup(2);
		const first = history.loadLatest();
		const firstRequest = await fetcher.next();
		const cancelled = assert.rejects(first, isCancellationError);
		const second = history.loadLatest();
		await cancelled;
		await fetcher.respond(messages(1, 6));
		await second;
		await firstRequest.result.complete(selectPage(messages(1, 2), firstRequest.query));

		assert.deepStrictEqual(snapshot(history), {
			sequences: [5, 6], hasEarlier: true, hasLater: false, loading: false, loadingEarlier: false, error: undefined,
		});
	});

	test('reset cancels initial loading immediately and ignores its result after another room is loaded', async () => {
		const { history, fetcher } = setup(2);
		const first = history.loadLatest();
		const firstRequest = await fetcher.next();
		const cancelled = assert.rejects(first, isCancellationError);
		history.reset();
		await cancelled;
		const cleared = snapshot(history);
		const otherRoom = messages(1, 2).map(message => ({ ...message, id: `other-${message.id}`, text: 'Other room' }));
		await load(history, fetcher, otherRoom);
		await firstRequest.result.complete(selectPage(messages(1, 6), firstRequest.query));

		assert.deepStrictEqual({
			cleared, page: history.page.get(), error: history.error.get(),
		}, {
			cleared: { sequences: [], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			page: { messages: otherRoom, hasEarlier: false, hasLater: false },
			error: undefined,
		});
	});

	test('reset ignores late errors and does not let cancelled cleanup clear a new loading state', async () => {
		const { history, fetcher } = setup(2);
		await load(history, fetcher, messages(1, 4));
		const earlier = history.loadEarlier();
		const earlierRequest = await fetcher.next();
		const refresh = history.refresh();
		const refreshRequest = await fetcher.next();
		const cancelled = Promise.all([assert.rejects(earlier, isCancellationError), assert.rejects(refresh, isCancellationError)]);
		history.reset();
		await cancelled;
		const replacement = history.loadLatest();
		const replacementRequest = await fetcher.next();
		await earlierRequest.result.error(new Error('Old earlier failure'));
		await refreshRequest.result.error(new Error('Old latest failure'));
		const duringReplacement = snapshot(history);
		await replacementRequest.result.complete(selectPage(messages(1, 2), replacementRequest.query));
		await replacement;

		assert.deepStrictEqual({
			duringReplacement, state: snapshot(history),
		}, {
			duringReplacement: { sequences: [], hasEarlier: false, hasLater: false, loading: true, loadingEarlier: false, error: undefined },
			state: { sequences: [1, 2], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
		});
	});

	test('dispose cancels both lanes, clears retained state, and prevents subsequent work', async () => {
		const { history, fetcher } = setup(2);
		const records = messages(1, 4);
		await load(history, fetcher, records);
		const earlier = history.loadEarlier();
		const earlierRequest = await fetcher.next();
		const refresh = history.refresh();
		const refreshRequest = await fetcher.next();
		const cancelled = Promise.all([assert.rejects(earlier, isCancellationError), assert.rejects(refresh, isCancellationError)]);
		history.dispose();
		await cancelled;
		await earlierRequest.result.complete(selectPage(records, earlierRequest.query));
		await refreshRequest.result.error(new Error('Late failure'));
		await Promise.all([
			assert.rejects(history.loadLatest(), isCancellationError),
			assert.rejects(history.loadEarlier(), isCancellationError),
			assert.rejects(history.refresh(), isCancellationError),
		]);
		assert.throws(() => history.acceptMessage(message(5)), isCancellationError);
		assert.deepStrictEqual({
			state: snapshot(history), requests: fetcher.queries.length,
		}, {
			state: { sequences: [], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
			requests: 3,
		});
	});

	test('initial failure is visible, rejects the caller, and permits retry', async () => {
		const { history, fetcher } = setup(2);
		const pending = history.loadLatest();
		const rejected = assert.rejects(pending, /Offline/);
		await (await fetcher.next()).result.error(new Error('Offline'));
		await rejected;
		const failed = snapshot(history);
		await load(history, fetcher, messages(1, 2));

		assert.deepStrictEqual({
			failed, retried: snapshot(history),
		}, {
			failed: { sequences: [], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: 'Offline' },
			retried: { sequences: [1, 2], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
		});
	});

	test('an earlier failure retains history and is not hidden by successful background refresh', async () => {
		const { history, fetcher } = setup(2);
		const records = messages(1, 4);
		await load(history, fetcher, records);
		const previous = history.page.get();
		const earlier = history.loadEarlier();
		const rejected = assert.rejects(earlier, /Earlier unavailable/);
		await (await fetcher.next()).result.error(new Error('Earlier unavailable'));
		await rejected;
		const refresh = history.refresh();
		await fetcher.respond(records);
		await refresh;
		const failed = snapshot(history);
		const retained = history.page.get() === previous;
		await loadEarlier(history, fetcher, records);

		assert.deepStrictEqual({
			retained, failed, retried: snapshot(history),
		}, {
			retained: true,
			failed: { sequences: [3, 4], hasEarlier: true, hasLater: false, loading: false, loadingEarlier: false, error: 'Earlier unavailable' },
			retried: { sequences: [1, 2, 3, 4], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
		});
	});

	test('a failed bridge keeps the acknowledgement and all previous rows, then retries without duplicates', async () => {
		const { history, fetcher } = setup(2);
		const records = messages(1, 9);
		await load(history, fetcher, records.slice(0, 2));
		history.acceptMessage(records[8]);
		const previous = history.page.get();
		const first = history.refresh();
		const rejected = assert.rejects(first, /Bridge unavailable/);
		await fetcher.respond(records);
		await (await fetcher.next()).result.error(new Error('Bridge unavailable'));
		await rejected;
		const retained = history.page.get() === previous;
		const failed = snapshot(history);
		const retry = history.refresh();
		for (let index = 0; index < 5; index++) {
			await fetcher.respond(records);
		}
		await retry;

		assert.deepStrictEqual({
			retained, failed, page: history.page.get(), error: history.error.get(),
		}, {
			retained: true,
			failed: { sequences: [1, 2, 9], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: 'Bridge unavailable' },
			page: { messages: records, hasEarlier: false, hasLater: false },
			error: undefined,
		});
	});

	test('a failed delivery reconciliation does not undo live messages and can be retried', async () => {
		const { history, fetcher } = setup(2);
		const original = [delivered(message(1), 'pending'), message(2)];
		await load(history, fetcher, original);
		const records = [delivered(original[0], 'submitted'), original[1], message(3)];
		const first = history.refresh();
		const rejected = assert.rejects(first, /Delivery unavailable/);
		await fetcher.respond(records);
		await (await fetcher.next()).result.error(new Error('Delivery unavailable'));
		await rejected;
		const failed = snapshot(history);
		const retry = history.refresh();
		await fetcher.respond(records);
		await fetcher.respond(records);
		await retry;

		assert.deepStrictEqual({
			failed, page: history.page.get(), error: history.error.get(),
		}, {
			failed: { sequences: [1, 2, 3], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: 'Delivery unavailable' },
			page: { messages: records, hasEarlier: false, hasLater: false },
			error: undefined,
		});
	});

	const invalidPages: readonly { name: string; messages: readonly IAgentHostRoomMessage[] }[] = [
		{ name: 'one ID assigned to two sequences', messages: [message(1), { ...message(2), id: message(1).id }] },
		{ name: 'one sequence assigned to two IDs', messages: [message(3), { ...message(3), id: 'conflicting' }] },
		{ name: 'a loaded ID moved to a new sequence', messages: [{ ...message(1), sequence: 3 }] },
		{ name: 'a loaded sequence assigned a new ID', messages: [{ ...message(2), id: 'conflicting' }] },
		{ name: 'a hole within an authoritative page', messages: [message(3), message(5)] },
		{ name: 'a zero sequence', messages: [message(0)] },
		{ name: 'a fractional sequence', messages: [message(1.5)] },
		{ name: 'an unsafe sequence', messages: [message(Number.MAX_SAFE_INTEGER + 1)] },
		{ name: 'an empty ID', messages: [{ ...message(3), id: '' }] },
	];

	for (const invalid of invalidPages) {
		test(`rejects ${invalid.name} without partially changing history`, async () => {
			const { history, fetcher } = setup(2);
			await load(history, fetcher, messages(1, 2));
			const previous = history.page.get();
			const pending = history.refresh();
			const rejected = assert.rejects(pending, /inconsistent message history/);
			await (await fetcher.next()).result.complete({ messages: invalid.messages, hasEarlier: false, hasLater: false });
			await rejected;

			assert.deepStrictEqual({
				retained: history.page.get() === previous,
				error: history.error.get(),
				loading: history.loading.get(),
			}, {
				retained: true,
				error: 'The room returned inconsistent message history. Retry loading the conversation.',
				loading: false,
			});
		});
	}

	for (const missing of [[], [message(2)], [message(4)]]) {
		test(`rejects a nonprogressing or incomplete bridge (${missing.map(message => message.sequence).join(',') || 'empty'})`, async () => {
			const { history, fetcher } = setup(2);
			await load(history, fetcher, messages(1, 2));
			const previous = history.page.get();
			const pending = history.refresh();
			const rejected = assert.rejects(pending, /inconsistent message history/);
			await fetcher.respond(messages(1, 6));
			await (await fetcher.next()).result.complete({ messages: missing, hasEarlier: !!missing.length, hasLater: !!missing.length });
			await rejected;

			assert.deepStrictEqual({
				retained: history.page.get() === previous, requests: fetcher.queries.length,
			}, { retained: true, requests: 3 });
		});
	}

	for (const earlierMessages of [[], messages(1, 2), [message(5)]]) {
		test(`rejects earlier pagination that omits the adjacent history (${earlierMessages.map(message => message.sequence).join(',') || 'empty'})`, async () => {
			const { history, fetcher } = setup(2);
			await load(history, fetcher, messages(1, 6));
			const previous = history.page.get();
			const pending = history.loadEarlier();
			const rejected = assert.rejects(pending, /inconsistent message history/);
			await (await fetcher.next()).result.complete({ messages: earlierMessages, hasEarlier: false, hasLater: !!earlierMessages.length });
			await rejected;

			assert.deepStrictEqual({
				retained: history.page.get() === previous,
				hasEarlier: history.page.get().hasEarlier,
				loadingEarlier: history.loadingEarlier.get(),
			}, { retained: true, hasEarlier: true, loadingEarlier: false });
		});
	}

	test('rejects conflicting acknowledgements visibly and accepts a subsequent valid acknowledgement', async () => {
		const { history, fetcher } = setup(2);
		await load(history, fetcher, messages(1, 2));
		const previous = history.page.get();
		assert.throws(() => history.acceptMessage({ ...message(3), id: message(1).id }), /inconsistent message history/);
		const rejected = { retained: history.page.get() === previous, error: history.error.get() };
		history.acceptMessage(message(3));

		assert.deepStrictEqual({
			rejected, state: snapshot(history),
		}, {
			rejected: { retained: true, error: 'The room returned inconsistent message history. Retry loading the conversation.' },
			state: { sequences: [1, 2, 3], hasEarlier: false, hasLater: false, loading: false, loadingEarlier: false, error: undefined },
		});
	});

	test('validates the host-supported page size before allocating a disposable', () => {
		for (const pageSize of [0, -1, 1.5, 201, Number.NaN]) {
			assert.throws(() => new CollaborationHistory(async () => ({ messages: [], hasEarlier: false, hasLater: false }), pageSize), RangeError);
		}
	});
});
