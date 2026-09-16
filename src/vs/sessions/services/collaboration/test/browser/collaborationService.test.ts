/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { observableValue, waitForState } from '../../../../../base/common/observable.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomLimits, IAgentHostRoomMessage, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery, IAgentHostRoomPostOptions, IAgentHostRoomsCapabilities, IAgentHostRoomsService } from '../../../../../platform/agentHost/common/agentHostRooms.js';
import { GITHUB_COPILOT_PROTECTED_RESOURCE, IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { PolicyState, RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService, ResourceTrustRequestOptions } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { AuthenticationSession, IAuthenticationService } from '../../../../../workbench/services/authentication/common/authentication.js';
import { CollaborationService } from '../../browser/collaborationService.js';
import { ICollaborationRoomView, ICollaborationRoomViewService } from '../../browser/collaborationRoomView.js';
import { CollaborationEnabledSettingId } from '../../common/collaboration.js';

function room(id: string, revision = 1): IAgentHostRoom {
	return {
		id, revision, title: id, goal: 'Shared goal', instructions: 'Equal peers',
		repositoryUri: 'file:///repo', baseRevision: 'base', createdAt: 0, updatedAt: 0,
		state: 'created', members: [], artifacts: [], latestMessageSequence: 0,
	};
}

function post(id: string, text: string): IAgentHostRoomMessage {
	return {
		id, text, sequence: 1, authorId: 'human', authorKind: 'human', authorName: 'You',
		kind: 'message', timestamp: 0, mentions: [], deliveries: [],
	};
}

suite('CollaborationService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const desktopTest = isWeb ? test.skip : test;

	function setup(enabled = true, aiDisabled = false) {
		const starts: { roomId: string; limits: IAgentHostRoomLimits }[] = [];
		const changed = disposables.add(new Emitter<IAgentHostRoom>());
		const exited = disposables.add(new Emitter<number>());
		const configuration = new TestConfigurationService({
			[CollaborationEnabledSettingId]: enabled,
			'chat.disableAIFeatures': aiDisabled,
		});
		disposables.add(configuration.onDidChangeConfigurationEmitter);
		const api = new class extends mock<IAgentHostRoomsService>() {
			override readonly onDidChangeRoom = changed.event;
			override async getCapabilities(): Promise<IAgentHostRoomsCapabilities> {
				return {
					version: 2,
					available: true,
					maxWorkers: 10,
					supportsInbox: true,
					supportsConfiguration: true,
					supportsMemberModels: true,
				};
			}
			override async listRooms(): Promise<readonly IAgentHostRoom[]> { return [room('a'), room('b')]; }
			override async getRoom(id: string): Promise<IAgentHostRoom> { return room(id); }
			override async getMessages(_roomId: string, _query?: IAgentHostRoomMessageQuery): Promise<IAgentHostRoomMessagePage> { return { messages: [], hasEarlier: false, hasLater: false }; }
			override async postMessage(_roomId: string, options: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage> { return post(options.id, options.text); }
			override async getArtifact(roomId: string, artifactId: string): Promise<string> { return `${roomId}/${artifactId}`; }
			override async startRoom(roomId: string, limits: IAgentHostRoomLimits): Promise<IAgentHostRoom> {
				starts.push({ roomId, limits });
				return { ...room(roomId, 2), state: 'running' };
			}
			override async stopRoom(roomId: string): Promise<IAgentHostRoom> { return { ...room(roomId, 2), state: 'stopped' }; }
		}();
		const subscription = new class extends mock<IAgentSubscription<RootState>>() {
			override readonly value: RootState = {
				agents: [{
					provider: 'copilotcli', displayName: 'Copilot', description: '',
					protectedResources: [GITHUB_COPILOT_PROTECTED_RESOURCE],
					models: [
						{ id: 'allowed', provider: 'copilotcli', name: 'Available Model' },
						{ id: 'blocked', provider: 'copilotcli', name: 'Policy Disabled Model', policyState: PolicyState.Disabled },
					]
				}]
			};
			override readonly onDidChange = Event.None;
		}();
		const authenticationPending = observableValue('authenticationPending', false);
		const host = new class extends mock<IAgentHostService>() {
			override readonly rooms = api;
			override readonly rootState = subscription;
			override readonly onAgentHostExit = exited.event;
			override readonly onAgentHostStart = Event.None;
			override readonly authenticationPending = authenticationPending;
			override readonly getSubscription = (() => ({
				object: { value: undefined, verifiedValue: undefined, onDidChange: Event.None, onWillApplyAction: Event.None, onDidApplyAction: Event.None },
				dispose() { },
			})) as IAgentHostService['getSubscription'];
			override async authenticate() { return { authenticated: true }; }
		}();
		const authenticationService = new class extends mock<IAuthenticationService>() {
			override readonly onDidChangeSessions = Event.None;
			override async getOrActivateProviderIdForServer() { return 'github'; }
			override async getSessions(): Promise<readonly AuthenticationSession[]> { return []; }
		}();
		const trusted = new Set<string>(['file:///repo']);
		const trustPrompts: ResourceTrustRequestOptions[] = [];
		const trustGrants: string[][] = [];
		const trustChanged = disposables.add(new Emitter<void>());
		const trustManagement = new class extends mock<IWorkspaceTrustManagementService>() {
			override readonly onDidChangeTrustedFolders = trustChanged.event;
			override async getUriTrustInfo(uri: URI) { return { uri, trusted: trusted.has(uri.toString()) }; }
			override async setUrisTrust(uris: URI[], value: boolean) {
				trustGrants.push(uris.map(uri => uri.toString()));
				for (const uri of uris) {
					if (value) { trusted.add(uri.toString()); } else { trusted.delete(uri.toString()); }
				}
				trustChanged.fire();
			}
		}();
		const trustRequest = new class extends mock<IWorkspaceTrustRequestService>() {
			override async requestResourcesTrust(options: ResourceTrustRequestOptions) {
				trustPrompts.push(options);
				trusted.add(options.uri.toString());
				return true;
			}
		}();
		const views = new class extends mock<ICollaborationRoomViewService>() {
			override readonly visible = observableValue(this, true);
			override readonly activeView = observableValue<ICollaborationRoomView | undefined>(this, new class extends mock<ICollaborationRoomView>() { }());
		}();
		const service = disposables.add(new CollaborationService(host, configuration, authenticationService, new NullLogService(), trustManagement, trustRequest, views));
		return { service, api, changed, exited, authenticationService, authenticationPending, host, starts, trusted, trustPrompts, trustGrants, trustManagement, trustRequest, views };
	}

	function setupSignedIn() {
		const context = setup();
		context.authenticationService.getSessions = async () => [authenticationSession];
		return context;
	}

	desktopTest('remains disabled without explicit experimental opt-in', () => {
		const { service } = setup(false);
		assert.strictEqual(service.availability.get(), 'disabled');
		assert.deepStrictEqual(service.models.get(), []);
		assert.deepStrictEqual(service.rooms.get(), []);
	});

	desktopTest('respects the current AI-disable switch even with collaboration opted in', () => {
		const { service } = setup(true, true);
		assert.strictEqual(service.availability.get(), 'disabled');
		assert.deepStrictEqual(service.rooms.get(), []);
	});

	desktopTest('a pending creation remains observable and cannot be duplicated by a recreated view', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		const pending = new DeferredPromise<IAgentHostRoom>();
		api.createRoom = () => pending.p;
		const options = { title: 'Room', goal: 'Goal', repositoryUri: 'file:///repo', workerCount: 2 };
		const creation = service.createRoom(options);
		assert.strictEqual(service.creating.get(), true);
		await assert.rejects(service.createRoom(options), /already being created/);
		await pending.complete(room('created'));
		await creation;
		assert.strictEqual(service.creating.get(), false);
		assert.strictEqual(service.activeRoomId.get(), 'created');
	});

	desktopTest('uses the actual host catalog and filters policy-disabled models', async () => {
		const { service } = setup();
		await waitForState(service.availability, state => state === 'available');
		assert.deepStrictEqual(service.models.get().map(model => model.id), ['allowed']);
	});

	desktopTest('keeps supported navigation through a disconnect but removes it for an unsupported host', async () => {
		const { service, api, exited } = setup();
		await waitForState(service.availability, state => state === 'available');
		assert.strictEqual(service.supported.get(), true);
		exited.fire(1);
		assert.strictEqual(service.availability.get(), 'unavailable');
		assert.strictEqual(service.supported.get(), true);
		api.getCapabilities = async () => ({ version: 2, available: false, maxWorkers: 10, supportsInbox: false });
		await service.refresh();
		assert.strictEqual(service.supported.get(), false);
	});
	desktopTest('late room loading cannot replace another selection', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		const pending = new DeferredPromise<IAgentHostRoom>();
		api.getRoom = id => id === 'a' ? pending.p : Promise.resolve(room(id));
		const first = service.selectRoom('a');
		await service.selectRoom('b');
		await pending.complete(room('a', 10));
		await first;
		assert.strictEqual(service.activeRoomId.get(), 'b');
		assert.strictEqual(service.activeRoom.get()?.id, 'b');
	});

	desktopTest('host events update observable roster and reject old revisions', async () => {
		const { service, changed } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		changed.fire({ ...room('a', 3), state: 'paused' });
		changed.fire({ ...room('a', 2), state: 'running' });
		assert.strictEqual(service.activeRoom.get()?.state, 'paused');
		assert.deepStrictEqual(service.rooms.get().map(room => room.id), ['a', 'b']);
	});

	desktopTest('background room updates do not announce a loading indicator on every activity event', async () => {
		const { service, api, changed } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const pending = new DeferredPromise<IAgentHostRoomMessagePage>();
		api.getMessages = () => pending.p;
		changed.fire({ ...room('a', 2), latestMessageSequence: 1 });
		assert.strictEqual(service.loading.get(), false);
		await pending.complete({ messages: [post('new', 'Posted')], hasEarlier: false, hasLater: false });
		await waitForState(service.messages, page => page.messages[0]?.id === 'new');
		assert.strictEqual(service.loading.get(), false);
	});

	desktopTest('message paging is bounded and late pages cannot replace new rooms', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const pending = new DeferredPromise<IAgentHostRoomMessagePage>();
		const requested = new DeferredPromise<void>();
		api.getMessages = async (roomId, query) => {
			assert.strictEqual(query?.limit, 100);
			if (roomId === 'a') {
				void requested.complete();
				return pending.p;
			}
			return { messages: [post('new-room', 'Current')], hasEarlier: false, hasLater: false };
		};
		const first = service.loadMessages();
		const cancelled = assert.rejects(first, isCancellationError);
		await requested.p;
		await service.selectRoom('b');
		await pending.complete({ messages: [post('old-room', 'Old')], hasEarlier: false, hasLater: false });
		await cancelled;
		assert.strictEqual(service.messages.get().messages[0].id, 'new-room');
	});

	desktopTest('sending failures preserve drafts and idempotency keys', async () => {
		const { service, api } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const draft = service.getDraft('a');
		draft.update('Advice', undefined, { kind: 'note' });
		const ids: string[] = [];
		api.postMessage = async (_id, options) => {
			ids.push(options.id);
			if (ids.length === 1) {
				throw new Error('Send failed');
			}
			return post(options.id, options.text);
		};
		await assert.rejects(service.sendMessage(), /Send failed/);
		assert.strictEqual(draft.text, 'Advice');
		assert.strictEqual(service.sending.get(), false);
		await service.sendMessage();
		assert.strictEqual(ids[0], ids[1]);
		assert.strictEqual(draft.text, '');
	});

	desktopTest('send acknowledgement does not erase text edited while sending', async () => {
		const { service, api } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const pending = new DeferredPromise<IAgentHostRoomMessage>();
		api.postMessage = () => pending.p;
		const draft = service.getDraft('a');
		draft.update('First advice', undefined, { kind: 'note' });
		const sending = service.sendMessage();
		draft.update('New advice', 'reply');
		await pending.complete(post('first', 'First advice'));
		await sending;
		assert.strictEqual(draft.text, 'New advice');
		assert.strictEqual(draft.replyTo, 'reply');
	});

	desktopTest('a sent post is revealed from older history before an in-flight refresh completes', async () => {
		const { service, api, changed } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		const posts = [1, 2, 3].map(sequence => ({ ...post(`post-${sequence}`, `Post ${sequence}`), sequence }));
		api.getMessages = async (_id, query) => query?.before
			? { messages: posts.filter(message => message.sequence < query.before!), hasEarlier: false, hasLater: true }
			: { messages: posts.slice(1), hasEarlier: true, hasLater: false };
		await service.selectRoom('a');
		await service.loadEarlierMessages();
		const stale = new DeferredPromise<IAgentHostRoomMessagePage>();
		const queries: (IAgentHostRoomMessageQuery | undefined)[] = [];
		api.getMessages = (_id, query) => {
			queries.push(query);
			return queries.length === 1 ? stale.p : Promise.resolve({
				messages: posts.filter(message => (query?.after === undefined || message.sequence > query.after) && (query?.before === undefined || message.sequence < query.before)),
				hasEarlier: query?.after !== undefined, hasLater: query?.before !== undefined,
			});
		};
		api.postMessage = async (_id, options) => {
			const saved = { ...post(options.id, options.text), sequence: 4 };
			posts.push(saved);
			changed.fire({ ...room('a', 2), latestMessageSequence: 4 });
			return saved;
		};
		service.getDraft('a').update('My advice', undefined, { kind: 'note' });
		await service.sendMessage();
		assert.deepStrictEqual({
			visible: service.messages.get().messages.map(message => message.text),
			hasEarlier: service.messages.get().hasEarlier,
			draft: service.getDraft('a').text,
		}, { visible: ['Post 1', 'Post 2', 'Post 3', 'My advice'], hasEarlier: false, draft: '' });

		await stale.complete({ messages: posts.slice(0, 3), hasEarlier: false, hasLater: false });
		await service.loadMessages();
		assert.deepStrictEqual({
			visible: service.messages.get().messages.map(message => message.text),
		}, { visible: ['Post 1', 'Post 2', 'Post 3', 'My advice'] });
	});

	desktopTest('a saved message remains visible if refreshing history fails', async () => {
		const { service, api } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		api.getMessages = async () => { throw new Error('History refresh failed'); };
		service.getDraft('a').update('Saved advice', undefined, { kind: 'note' });
		await service.sendMessage();
		await waitForState(service.error, error => error === 'History refresh failed');
		assert.deepStrictEqual({
			visible: service.messages.get().messages.map(message => message.text),
			draft: service.getDraft('a').text,
			sending: service.sending.get(),
		}, { visible: ['Saved advice'], draft: '', sending: false });
	});

	desktopTest('a late send acknowledgement does not replace a different room history', async () => {
		const { service, api } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const pending = new DeferredPromise<IAgentHostRoomMessage>();
		const posted = new DeferredPromise<void>();
		api.postMessage = () => { void posted.complete(); return pending.p; };
		service.getDraft('a').update('Advice for A', undefined, { kind: 'note' });
		const sending = service.sendMessage();
		await posted.p;
		api.getMessages = async () => ({ messages: [post('b-post', 'Room B history')], hasEarlier: false, hasLater: false });
		await service.selectRoom('b');
		await pending.complete(post('a-post', 'Advice for A'));
		await sending;
		assert.deepStrictEqual({
			room: service.activeRoomId.get(),
			visible: service.messages.get().messages.map(message => message.text),
			originalDraft: service.getDraft('a').text,
		}, { room: 'b', visible: ['Room B history'], originalDraft: '' });
	});

	desktopTest('incoming posts merge with loaded scrollback rather than replacing it with a newer page', async () => {
		const { service, api, changed } = setup();
		await waitForState(service.availability, state => state === 'available');
		const posts = [1, 2, 3].map(sequence => ({ ...post(`post-${sequence}`, `Post ${sequence}`), sequence }));
		api.getMessages = async (_id, query) => {
			if (query?.before !== undefined) {
				return { messages: posts.filter(message => message.sequence < query.before!), hasEarlier: false, hasLater: true };
			}
			if (query?.after !== undefined) {
				return { messages: posts.filter(message => message.sequence > query.after!), hasEarlier: true, hasLater: false };
			}
			return { messages: posts.slice(-2), hasEarlier: true, hasLater: false };
		};
		await service.selectRoom('a');
		await service.loadEarlierMessages();
		posts.push({ ...post('post-4', 'New report'), sequence: 4 });
		changed.fire({ ...room('a', 2), latestMessageSequence: 4 });
		await waitForState(service.messages, page => page.messages.at(-1)?.sequence === 4);
		assert.deepStrictEqual(service.messages.get().messages.map(message => message.text), ['Post 1', 'Post 2', 'Post 3', 'New report']);
	});

	desktopTest('scrolling within the latest page does not freeze out new peer reports', async () => {
		const { service, api, changed } = setup();
		await service.refresh();
		const queries: (IAgentHostRoomMessageQuery | undefined)[] = [];
		let messages = [post('human', 'Please review')];
		api.getMessages = async (_id, query) => {
			queries.push(query);
			return { messages, hasEarlier: false, hasLater: false };
		};
		await service.selectRoom('a');
		messages = [...messages, { ...post('report', 'Implemented the accessibility changes'), sequence: 2, authorKind: 'agent', authorId: 'peer', authorName: 'Copilot-1', kind: 'finding' }];
		changed.fire({ ...room('a', 2), latestMessageSequence: 2 });
		await waitForState(service.messages, page => page.messages.length === 2);
		assert.ok(queries.every(query => query?.limit === 100));
		assert.deepStrictEqual(service.messages.get().messages.map(message => message.authorName), ['You', 'Copilot-1']);
	});

	desktopTest('room configuration changes use the selected room authority and accept only its acknowledgement', async () => {
		const { service, api } = setup();
		await service.refresh();
		await service.selectRoom('a');
		const updates: { id: string; configuration: Partial<IAgentHostRoomConfiguration> }[] = [];
		api.setRoomConfiguration = async (id, configuration) => {
			updates.push({ id, configuration });
			return { ...room(id, 2), title: 'Configured room' };
		};
		await service.setConfiguration({ mode: 'plan' });
		assert.deepStrictEqual({ updates, title: service.activeRoom.get()?.title }, {
			updates: [{ id: 'a', configuration: { mode: 'plan' } }], title: 'Configured room',
		});
		api.setRoomConfiguration = async () => { throw new Error('Host rejected configuration'); };
		await assert.rejects(service.setConfiguration({ mode: 'interactive' }), /Host rejected/);
		assert.strictEqual(service.activeRoom.get()?.title, 'Configured room');
	});

	desktopTest('a model selection updates only the addressed peer without starting or trusting workspaces', async () => {
		const { service, api, starts, trustPrompts } = setup();
		await service.refresh();
		await service.selectRoom('a');
		const calls: { roomId: string; memberId: string; model: string | undefined }[] = [];
		api.setMemberModel = async (roomId, memberId, model) => {
			calls.push({ roomId, memberId, model: model?.id });
			return { ...room(roomId, 2), title: 'Model saved' };
		};
		await service.setMemberModel('peer-2', { id: 'allowed' });
		assert.deepStrictEqual({ calls, starts, trustPrompts, title: service.activeRoom.get()?.title }, {
			calls: [{ roomId: 'a', memberId: 'peer-2', model: 'allowed' }], starts: [], trustPrompts: [], title: 'Model saved',
		});
		api.setMemberModel = async () => { throw new Error('Model disabled by policy'); };
		await assert.rejects(service.setMemberModel('peer-2', { id: 'blocked' }), /Model disabled by policy/);
	});

	desktopTest('disconnect invalidates in-flight snapshots without reporting stopped workers', async () => {
		const { service, api, exited } = setup();
		await waitForState(service.availability, state => state === 'available');
		const pending = new DeferredPromise<IAgentHostRoom>();
		api.getRoom = () => pending.p;
		const loading = service.selectRoom('a');
		exited.fire(1);
		await pending.complete({ ...room('a', 5), state: 'running' });
		await loading;
		assert.strictEqual(service.availability.get(), 'unavailable');
		assert.strictEqual(service.activeRoom.get()?.revision, 1);
		assert.strictEqual(service.loading.get(), false);
	});

	desktopTest('history loading failure does not misreport an available host as disconnected', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		api.getMessages = async () => { throw new Error('History failed'); };
		await assert.rejects(service.refresh(), /History failed/);
		assert.strictEqual(service.availability.get(), 'available');
		assert.strictEqual(service.error.get(), 'History failed');
		assert.strictEqual(service.loading.get(), false);
	});

	desktopTest('artifact reads retain their explicit room identity after navigation', async () => {
		const { service } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('b');
		assert.strictEqual(await service.getArtifact('a', 'published'), 'a/published');
	});

	desktopTest('storage readiness never authorizes a run while host sign-in is pending', async () => {
		const { service, authenticationPending, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		authenticationPending.set(true, undefined);
		await assert.rejects(service.startRoom({ maxTurns: 4 }), /signing in/);
		assert.deepStrictEqual(starts, []);
	});

	desktopTest('signed-out users can read and stop rooms but cannot start peers', async () => {
		const { service, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		await assert.rejects(service.startRoom({ maxTurns: 4 }), /Sign in through the Accounts menu/);
		assert.deepStrictEqual(starts, []);
		await service.stopRoom();
		assert.strictEqual(service.activeRoom.get()?.state, 'stopped');
	});

	const authenticationSession: AuthenticationSession = {
		id: 'test-session', accessToken: 'synthetic-test-token', scopes: ['read:user', 'user:email'],
		account: { id: 'test-account', label: 'Test Account' },
	};

	desktopTest('both unmentioned and targeted sends require authentication before waking peers', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => ({
			...room(id, 2),
			members: [{ id: 'member-a', name: 'Copilot-1', sessionUri: 'copilotcli:/a', state: 'stopped', turns: 1 }],
		});

		await service.selectRoom('a');
		let posted = false;
		api.postMessage = async (_room, options) => { posted = true; return post(options.id, options.text); };
		for (const [text, audience] of [
			['Please respond', { kind: 'note' }],
			['Please respond', { kind: 'all' }],
			['@Copilot-1 Please respond', { kind: 'member', memberId: 'member-a' }],
		] as const) {
			service.getDraft('a').update(text, undefined, audience);
			await assert.rejects(service.sendMessage(), /Sign in through the Accounts menu/);
		}
		assert.deepStrictEqual({ posted, draft: service.getDraft('a').text }, { posted: false, draft: '@Copilot-1 Please respond' });
	});

	desktopTest('explicit audiences send notes, all peers, or a specific peer without parsing mentions', async () => {
		const { service, api, starts } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => ({
			...withPeers(id, 3), state: 'stopped',
			members: withPeers(id, 3).members.map(member => ({ ...member, state: 'stopped' })),
		});
		await service.selectRoom('a');
		const sent: IAgentHostRoomPostOptions[] = [];
		api.postMessage = async (_id, options) => {
			sent.push(options);
			return { ...post(options.id, options.text), sequence: sent.length, mentions: options.mentions };
		};
		service.getDraft('a').update('@Copilot-2 This is only a note', undefined, { kind: 'note' });
		await service.sendMessage();
		service.getDraft('a').update('One more question about the result', undefined, { kind: 'all' });
		await service.sendMessage();
		service.getDraft('a').update('@Copilot-1 Check this detail', undefined, { kind: 'member', memberId: 'member-2' });
		await service.sendMessage();
		assert.deepStrictEqual({
			messages: sent.map(message => ({ text: message.text, mentions: message.mentions })),
			separateStartCalls: starts,
		}, {
			messages: [
				{ text: '@Copilot-2 This is only a note', mentions: [] },
				{ text: 'One more question about the result', mentions: ['member-1', 'member-2', 'member-3'] },
				{ text: '@Copilot-1 Check this detail', mentions: ['member-2'] },
			],
			separateStartCalls: [],
		});
	});

	desktopTest('a new human draft is explicitly addressed to all six peers by default', async () => {
		const { service, api, starts } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => withPeers(id, 6);
		await service.selectRoom('a');
		const sent: IAgentHostRoomPostOptions[] = [];
		api.postMessage = async (_id, options) => {
			sent.push(options);
			return { ...post(options.id, options.text), mentions: options.mentions };
		};
		service.getDraft('a').update('Focus exclusively on URI formatting', undefined);
		await service.sendMessage();
		assert.deepStrictEqual({
			audience: service.getDraft('a').audience,
			recipients: sent.map(message => message.mentions),
			separateStarts: starts,
		}, {
			audience: { kind: 'all' },
			recipients: [['member-1', 'member-2', 'member-3', 'member-4', 'member-5', 'member-6']],
			separateStarts: [],
		});
	});

	desktopTest('creating, opening, refreshing, and filtering never authorize work', async () => {
		const { service, api, starts, trustPrompts, authenticationService } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => withPeers(id);
		api.createRoom = async () => withPeers('new');
		let authenticationRequests = 0;
		authenticationService.getSessions = async () => { authenticationRequests++; return []; };
		await service.createRoom({ title: 'New', goal: 'Work', repositoryUri: 'file:///repo', workerCount: 2 });
		await service.selectRoom('a');
		await service.selectInbox('member-1');
		await service.loadMessages();
		await service.selectInbox(undefined);
		assert.deepStrictEqual({ starts, trustPrompts, authenticationRequests }, { starts: [], trustPrompts: [], authenticationRequests: 0 });
	});

	desktopTest('older hosts keep readable history but cannot accept inbox writes or create rooms', async () => {
		const { service, api, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getCapabilities = async () => ({ version: 1, available: true, maxWorkers: 10 });
		await service.refresh();
		await service.selectRoom('a');
		service.getDraft('a').update('New guidance', undefined);
		await assert.rejects(service.sendMessage(), /does not support inbox collaboration/);
		await assert.rejects(service.startRoom({ maxTurns: 4 }), /does not support inbox collaboration/);
		await assert.rejects(service.createRoom({ title: 'New', goal: 'Work', repositoryUri: 'file:///repo', workerCount: 2 }), /does not support inbox collaboration/);
		assert.deepStrictEqual({
			canSend: service.canSend.get(), canConfigure: service.canConfigure.get(), starts, draft: service.getDraft('a').text,
			readOnlyExplained: service.availabilityError.get()?.includes('read-only'),
		}, { canSend: false, canConfigure: false, starts: [], draft: 'New guidance', readOnlyExplained: true });
	});

	desktopTest('a summary uses the chosen existing peer inbox without replacing the composer draft or starting another run', async () => {
		const { service, api, starts } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => withPeers(id);
		await service.selectRoom('a');
		service.getDraft('a').update('My unfinished note', 'previous', { kind: 'note' });
		const sent: IAgentHostRoomPostOptions[] = [];
		api.postMessage = async (_id, options) => { sent.push(options); return { ...post(options.id, options.text), mentions: options.mentions }; };
		await service.askForSummary('member-2');
		assert.deepStrictEqual({
			recipients: sent.map(message => message.mentions),
			ordinaryMessage: Object.keys(sent[0]).sort(),
			draft: service.getDraft('a').state.get(), starts,
		}, {
			recipients: [['member-2']], ordinaryMessage: ['id', 'mentions', 'text'],
			draft: { text: 'My unfinished note', replyTo: 'previous', audience: { kind: 'note' } }, starts: [],
		});
	});

	desktopTest('first Start requires a finite positive integer budget and preserves the exact approved limit', async () => {
		const { service, starts } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		for (const maxTurns of [undefined, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
			await assert.rejects(service.startRoom({ maxTurns }), /finite turn budget/);
		}
		await service.startRoom({ maxTurns: 7 });
		assert.deepStrictEqual(starts, [{ roomId: 'a', limits: { maxTurns: 7 } }]);
	});

	desktopTest('exhaustion requires Extend, while Resume never replaces the existing run budget', async () => {
		const { service, api, starts } = setupSignedIn();
		await waitForState(service.availability, state => state === 'available');
		const run = { id: 'existing-run', startedAt: 1, limits: { maxTurns: 3 }, admittedTurns: 3 };
		api.getRoom = async id => ({ ...room(id, 2), state: 'paused', pauseReason: 'budget', run });
		await service.selectRoom('a');
		await assert.rejects(service.startRoom({}), /budget is exhausted/);
		await assert.rejects(service.startRoom({ maxTurns: 20 }), /Use Extend/);
		const extensions: number[] = [];
		api.extendRun = async (id, additionalTurns) => {
			extensions.push(additionalTurns);
			return { ...room(id, 3), state: 'idle', run: { ...run, limits: { maxTurns: run.limits.maxTurns + additionalTurns } } };
		};
		await assert.rejects(service.extendRun(0), /finite turn budget/);
		await service.extendRun(4);
		const extended = service.activeRoom.get()?.run;
		await service.startRoom({});
		assert.deepStrictEqual({ extensions, extended, starts }, {
			extensions: [4], extended: { ...run, limits: { maxTurns: 7 } }, starts: [{ roomId: 'a', limits: {} }],
		});
	});

	desktopTest('archives reject every room write before authentication or workspace trust', async () => {
		const { service, api, starts, trustPrompts, authenticationService } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => ({ ...withPeers(id), archived: true });
		await service.selectRoom('a');
		let authenticated = 0;
		authenticationService.getSessions = async () => { authenticated++; return [authenticationSession]; };
		service.getDraft('a').update('Do not send', undefined, { kind: 'all' });
		for (const operation of [
			() => service.sendMessage(), () => service.askForSummary('member-1'), () => service.retryMessage('old'),
			() => service.startRoom({ maxTurns: 4 }), () => service.extendRun(4), () => service.pauseRoom(), () => service.stopRoom(),
			() => service.addMember(), () => service.removeMember('member-1'), () => service.stopMember('member-1'), () => service.retryMember('member-1'),
			() => service.setMemberModel('member-1', { id: 'allowed' }), () => service.setConfiguration({ mode: 'plan' }),
			() => service.requestWorkspaceTrust(),
		]) {
			await assert.rejects(async () => operation(), /archive/);
		}
		await service.selectInbox('member-1');
		assert.deepStrictEqual({
			starts, trustPrompts, authenticated, requests: service.requests.get(), artifact: await service.getArtifact('a', 'patch'),
		}, { starts: [], trustPrompts: [], authenticated: 0, requests: [], artifact: 'a/patch' });
	});

	desktopTest('inbox filters page sparse history without changing receipts, drafts, or loaded room history', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => withPeers(id);
		const records = Array.from({ length: 401 }, (_, index) => ({
			...post(`post-${index}`, `Post ${index}`), sequence: index + 1,
			mentions: index % 2 ? ['member-1'] : ['member-2'],
			deliveries: [{ memberId: index % 2 ? 'member-1' : 'member-2', state: 'pending' as const }],
		}));
		const original = JSON.stringify(records);
		const queries: IAgentHostRoomMessageQuery[] = [];
		api.getMessages = async (_id, query = {}) => {
			queries.push(query);
			const all = records.filter(message => !query.memberId || message.mentions.includes(query.memberId));
			const candidates = all.filter(message => (query.after === undefined || message.sequence > query.after) && (query.before === undefined || message.sequence < query.before));
			const page = query.after === undefined ? candidates.slice(-(query.limit ?? 100)) : candidates.slice(0, query.limit ?? 100);
			return { messages: page, hasEarlier: !!page.length && all[0].sequence < page[0].sequence, hasLater: !!page.length && all.at(-1)!.sequence > page.at(-1)!.sequence };
		};
		await service.selectRoom('a');
		const roomHistory = service.messages.get().messages;
		service.getDraft('a').update('Preserve me', undefined, { kind: 'member', memberId: 'member-2' });
		await service.selectInbox('member-1');
		await service.loadEarlierMessages();
		const inbox = service.messages.get();
		await service.selectInbox(undefined);
		assert.deepStrictEqual({
			inboxCount: inbox.messages.length, recipients: [...new Set(inbox.messages.flatMap(message => message.mentions))], earlier: inbox.hasEarlier,
			roomHistory: service.messages.get().messages, receiptsUnchanged: JSON.stringify(records) === original,
			bounded: queries.every(query => query.limit === 100), filtered: queries.some(query => query.memberId === 'member-1'),
			draft: service.getDraft('a').state.get(),
		}, {
			inboxCount: 200, recipients: ['member-1'], earlier: false, roomHistory, receiptsUnchanged: true, bounded: true, filtered: true,
			draft: { text: 'Preserve me', replyTo: undefined, audience: { kind: 'member', memberId: 'member-2' } },
		});
	});

	desktopTest('switching inboxes during background refresh cannot publish stale rows or cancellation errors', async () => {
		const { service, api, changed } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => withPeers(id);
		await service.selectRoom('a');
		const pending = new DeferredPromise<IAgentHostRoomMessagePage>();
		const requested = new DeferredPromise<void>();
		const addressed = { ...post('addressed', 'Peer inbox'), sequence: 7, mentions: ['member-1'] };
		api.getMessages = async (_id, query) => {
			if (query?.memberId) {
				return { messages: [addressed], hasEarlier: false, hasLater: false };
			}
			void requested.complete();
			return pending.p;
		};
		changed.fire({ ...withPeers('a'), revision: 3, latestMessageSequence: 7 });
		await requested.p;
		await service.selectInbox('member-1');
		await pending.complete({ messages: [post('stale', 'Old room page')], hasEarlier: false, hasLater: false });
		await Promise.resolve();
		assert.deepStrictEqual({
			messages: service.messages.get().messages.map(message => message.id), inbox: service.inboxMemberId.get(),
			loading: service.loading.get(), error: service.error.get(),
		}, { messages: ['addressed'], inbox: 'member-1', loading: false, error: undefined });
	});

	desktopTest('retry delivery reuses the saved human message identity rather than posting a duplicate', async () => {
		const { service, api, authenticationService } = setup();
		await waitForState(service.availability, state => state === 'available');
		const message: IAgentHostRoomMessage = {
			...post('original-id', '@Copilot-1 Please respond'),
			mentions: ['member-a'], deliveries: [{ memberId: 'member-a', state: 'interrupted' }],
		};
		api.getMessages = async () => ({ messages: [message], hasEarlier: false, hasLater: false });
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		const calls: string[][] = [];
		api.retryMessage = async (roomId, messageId) => { calls.push([roomId, messageId]); return message; };
		await service.retryMessage(message.id);
		assert.deepStrictEqual(calls, [['a', message.id]]);
	});

	for (const state of ['pending', 'reserved', 'submitted'] as const) {
		desktopTest(`${state} inbox inputs cannot be retried or implicitly replayed`, async () => {
			const { service, api, authenticationService } = setup();
			await waitForState(service.availability, state => state === 'available');
			const message: IAgentHostRoomMessage = {
				...post('original', 'Keep the immutable input'),
				mentions: ['member-1'], deliveries: [{ memberId: 'member-1', state, turnId: state === 'pending' ? undefined : 'original-turn' }],
			};
			api.getMessages = async () => ({ messages: [message], hasEarlier: false, hasLater: false });
			await service.selectRoom('a');
			let retries = 0;
			let authentications = 0;
			api.retryMessage = async () => { retries++; return message; };
			authenticationService.getSessions = async () => { authentications++; return [authenticationSession]; };
			await assert.rejects(service.retryMessage(message.id), /interrupted, cancelled, or failed delivery/);
			assert.deepStrictEqual({ retries, authentications, messages: service.messages.get().messages }, {
				retries: 0, authentications: 0, messages: [message],
			});
		});
	}

	desktopTest('a run requires the local host to accept the existing account credentials', async () => {
		const { service, host, authenticationService, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		host.authenticate = async () => ({ authenticated: false });
		await assert.rejects(service.startRoom({ maxTurns: 4 }), /did not accept/);
		assert.deepStrictEqual(starts, []);
		host.authenticate = async () => ({ authenticated: true });
		await service.startRoom({ maxTurns: 4 });
		assert.deepStrictEqual(starts, [{ roomId: 'a', limits: { maxTurns: 4 } }]);
	});

	desktopTest('navigation during authentication cannot start a run in a different room', async () => {
		const { service, authenticationService, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const sessions = new DeferredPromise<readonly AuthenticationSession[]>();
		authenticationService.getSessions = () => sessions.p;
		const starting = service.startRoom({ maxTurns: 4 });
		const rejected = assert.rejects(starting, isCancellationError);
		await service.selectRoom('b');
		await sessions.complete([authenticationSession]);
		await rejected;
		assert.deepStrictEqual(starts, []);
	});

	function withPeers(id: string, count = 2): IAgentHostRoom {
		return {
			...room(id, 2),
			state: 'running',
			members: Array.from({ length: count }, (_value, index) => ({
				id: `member-${index + 1}`, name: `Copilot-${index + 1}`, sessionUri: `copilotcli:/${id}-${index + 1}`,
				worktreeUri: `file:///rooms/${id}/member-${index + 1}`, state: 'working' as const, turns: 1,
			})),
		};
	}

	desktopTest('rejected workspace trust blocks every send and execution-authorizing route but preserves history', async () => {
		const { service, api, authenticationService, trusted, trustRequest, trustGrants, starts } = setup();
		await waitForState(service.availability, value => value === 'available');
		api.getRoom = async id => withPeers(id);
		const message = { ...post('pending', '@Copilot-1 Retry'), mentions: ['member-1'], deliveries: [{ memberId: 'member-1', state: 'failed' as const }] };
		api.getMessages = async () => ({ messages: [message], hasEarlier: false, hasLater: false });
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		trusted.clear();
		trustRequest.requestResourcesTrust = async () => false;
		const calls: string[] = [];
		api.retryMember = async () => { calls.push('retryMember'); return withPeers('a'); };
		api.retryMessage = async () => { calls.push('retryMessage'); return message; };
		api.postMessage = async (_id, options) => { calls.push('message'); return { ...post(options.id, options.text), sequence: message.sequence + 1 }; };

		await assert.rejects(service.startRoom({ maxTurns: 4 }), /trust was not granted/);
		await assert.rejects(service.retryMember('member-1'), /trust was not granted/);
		await assert.rejects(service.retryMessage('pending'), /trust was not granted/);
		service.getDraft('a').update('@Copilot-1 Please work', undefined, { kind: 'member', memberId: 'member-1' });
		await assert.rejects(service.sendMessage(), /trust was not granted/);
		service.getDraft('a').update('Change direction', undefined, { kind: 'all' });
		await assert.rejects(service.sendMessage(), /trust was not granted/);
		service.getDraft('a').update('One more question', undefined);
		await assert.rejects(service.sendMessage(), /trust was not granted/);
		await service.loadMessages();
		assert.deepStrictEqual({
			starts, calls, trustGrants, draft: service.getDraft('a').text, history: service.messages.get().messages.map(message => message.id),
		}, { starts: [], calls: [], trustGrants: [], draft: 'One more question', history: ['pending'] });
	});

	desktopTest('one source trust decision covers exactly ten local peer worktrees and survives resume', async () => {
		const { service, api, authenticationService, trusted, trustPrompts, trustGrants, starts } = setup();
		await waitForState(service.availability, value => value === 'available');
		const peers = withPeers('a', 10);
		api.getRoom = async () => peers;
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		trusted.clear();
		const first = service.requestWorkspaceTrust();
		const second = service.requestWorkspaceTrust();
		assert.strictEqual(first, second);
		await Promise.all([first, second]);
		await service.startRoom({ maxTurns: 4 });
		await service.selectRoom('a');
		await service.startRoom({ maxTurns: 4 });
		assert.deepStrictEqual({
			prompts: trustPrompts.map(prompt => prompt.uri.toString()),
			separateWorktreesExplained: trustPrompts[0]?.message?.includes('Each peer uses a separate local worktree'),
			grants: trustGrants,
			starts: starts.length,
		}, {
			prompts: ['file:///repo'],
			separateWorktreesExplained: true,
			grants: [peers.members.map(member => member.worktreeUri)],
			starts: 2,
		});
	});

	desktopTest('already trusted sources inherit only to canonical local peer worktrees', async () => {
		const { service, api, authenticationService, trustPrompts, trustGrants } = setup();
		await waitForState(service.availability, value => value === 'available');
		api.getRoom = async id => withPeers(id);
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		await service.startRoom({ maxTurns: 4 });
		assert.deepStrictEqual({ trustPrompts, trustGrants }, {
			trustPrompts: [], trustGrants: [['file:///rooms/a/member-1', 'file:///rooms/a/member-2']],
		});
	});

	desktopTest('changing rooms during consent cannot grant stale worktrees or start peers', async () => {
		const { service, api, authenticationService, trusted, trustRequest, trustGrants, starts } = setup();
		await waitForState(service.availability, value => value === 'available');
		api.getRoom = async id => withPeers(id);
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		trusted.clear();
		const consent = new DeferredPromise<boolean>();
		const prompted = new DeferredPromise<void>();
		trustRequest.requestResourcesTrust = () => { void prompted.complete(); return consent.p; };
		const starting = service.startRoom({ maxTurns: 4 });
		const rejected = assert.rejects(starting, isCancellationError);
		await prompted.p;
		await service.selectRoom('b');
		await assert.rejects(service.requestWorkspaceTrust(), /pending workspace trust decision/);
		await consent.complete(true);
		await rejected;
		assert.deepStrictEqual({ trustGrants, starts, room: service.activeRoomId.get() }, { trustGrants: [], starts: [], room: 'b' });
	});

	desktopTest('disposing and recreating a room view invalidates its outstanding consent', async () => {
		const { service, api, trusted, trustRequest, trustGrants, views } = setup();
		await waitForState(service.availability, value => value === 'available');
		api.getRoom = async id => withPeers(id);
		await service.selectRoom('a');
		trusted.clear();
		const consent = new DeferredPromise<boolean>();
		const prompted = new DeferredPromise<void>();
		trustRequest.requestResourcesTrust = () => { void prompted.complete(); return consent.p; };
		const trusting = service.requestWorkspaceTrust();
		const rejected = assert.rejects(trusting, isCancellationError);
		await prompted.p;
		const view = views.activeView.get();
		views.activeView.set(undefined, undefined);
		views.activeView.set(view, undefined);
		await consent.complete(true);
		await rejected;
		assert.deepStrictEqual(trustGrants, []);
	});

	desktopTest('trust rejects remote directories and changed canonical room identities', async () => {
		const { service, api, trustGrants, trustPrompts } = setup();
		await waitForState(service.availability, value => value === 'available');
		api.getRoom = async id => withPeers(id);
		await service.selectRoom('a');
		api.getRoom = async id => ({ ...withPeers(id), repositoryUri: 'file:///unrelated' });
		await assert.rejects(service.requestWorkspaceTrust(), /identity changed/);
		api.getRoom = async id => ({
			...withPeers(id, 1),
			members: [{ ...withPeers(id, 1).members[0], worktreeUri: 'vscode-remote://remote/repo' }],
		});
		await service.selectRoom('b');
		await assert.rejects(service.requestWorkspaceTrust(), /exact local repository/);
		assert.deepStrictEqual({ trustGrants, trustPrompts }, { trustGrants: [], trustPrompts: [] });
	});
});
