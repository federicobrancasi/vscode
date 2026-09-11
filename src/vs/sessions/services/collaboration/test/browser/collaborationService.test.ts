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
			override async getCapabilities(): Promise<IAgentHostRoomsCapabilities> { return { version: 1, available: true, maxWorkers: 10, supportsSteering: true, supportsConfiguration: true, supportsMemberModels: true }; }
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
		api.getCapabilities = async () => ({ version: 1, available: false, maxWorkers: 10, supportsSteering: false });
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
		draft.update('Advice', undefined);
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
		draft.update('First advice', undefined);
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
		service.getDraft('a').update('My advice', undefined);
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
		service.getDraft('a').update('Saved advice', undefined);
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
		service.getDraft('a').update('Advice for A', undefined);
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
		await assert.rejects(service.startRoom({ maxTurns: 2, timeoutMinutes: 1 }), /signing in/);
		assert.deepStrictEqual(starts, []);
	});

	desktopTest('signed-out users can read and stop rooms but cannot start peers', async () => {
		const { service, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		await assert.rejects(service.startRoom({ maxTurns: 2, timeoutMinutes: 1 }), /Sign in through the Accounts menu/);
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
		for (const text of ['Please respond', '@Copilot-1 Please respond']) {
			service.getDraft('a').update(text, undefined);
			await assert.rejects(service.sendMessage(), /Sign in through the Accounts menu/);
		}
		assert.deepStrictEqual({ posted, draft: service.getDraft('a').text }, { posted: false, draft: '@Copilot-1 Please respond' });
	});

	desktopTest('Send explicitly addresses all finished peers without mentions and preserves mention targeting', async () => {
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
		service.getDraft('a').update('One more question about the result', undefined);
		await service.sendMessage();
		service.getDraft('a').update('@Copilot-2 Check this detail', undefined);
		await service.sendMessage();
		assert.deepStrictEqual({
			messages: sent.map(message => ({ text: message.text, mentions: message.mentions, mode: message.mode })),
			separateStartCalls: starts,
		}, {
			messages: [
				{ text: 'One more question about the result', mentions: ['member-1', 'member-2', 'member-3'], mode: undefined },
				{ text: '@Copilot-2 Check this detail', mentions: ['member-2'], mode: undefined },
			],
			separateStartCalls: [],
		});
	});

	desktopTest('steering without mentions delegates the broadcast roster to the host', async () => {
		const { service, api, authenticationService } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getRoom = async id => ({
			...room(id, 2),
			members: [1, 2].map(index => ({ id: `member-${index}`, name: `Copilot-${index}`, sessionUri: `copilotcli:/${index}`, worktreeUri: `file:///rooms/a/member-${index}`, state: 'working' as const, turns: 1 })),
		});
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		const sent: IAgentHostRoomPostOptions[] = [];
		api.postMessage = async (_id, options) => { sent.push(options); return { ...post(options.id, options.text), sequence: sent.length }; };
		service.getDraft('a').update('Prioritize the form, not animations', undefined);
		await service.sendMessage('steer');
		assert.deepStrictEqual(sent.map(message => ({ text: message.text, mode: message.mode, mentions: message.mentions })), [{
			text: 'Prioritize the form, not animations', mode: 'steer', mentions: [],
		}]);
		service.getDraft('a').update('@Copilot-2 Check the form', undefined);
		await service.sendMessage('steer');
		assert.deepStrictEqual(sent[1].mentions, ['member-2']);
	});

	desktopTest('steering is not silently sent as discussion on an older host', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		api.getCapabilities = async () => ({ version: 1, available: true, maxWorkers: 10, supportsSteering: false });
		await service.refresh();
		await service.selectRoom('a');
		service.getDraft('a').update('New guidance', undefined);
		await assert.rejects(service.sendMessage('steer'), /does not support live room steering/);
		assert.deepStrictEqual({ canSteer: service.canSteer.get(), draft: service.getDraft('a').text }, { canSteer: false, draft: 'New guidance' });
	});

	desktopTest('broadcast steering cannot wake peers before authentication', async () => {
		const { service, api } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		let posted = false;
		api.postMessage = async (_room, options) => { posted = true; return post(options.id, options.text); };
		service.getDraft('a').update('Change direction', undefined);
		await assert.rejects(service.sendMessage('steer'), /Sign in through the Accounts menu/);
		assert.strictEqual(posted, false);
	});

	desktopTest('retry delivery reuses the saved human message identity rather than posting a duplicate', async () => {
		const { service, api, authenticationService } = setup();
		await waitForState(service.availability, state => state === 'available');
		const message: IAgentHostRoomMessage = {
			...post('original-id', '@Copilot-1 Please respond'),
			mentions: ['member-a'], deliveries: [{ memberId: 'member-a', state: 'pending' }],
		};
		api.getMessages = async () => ({ messages: [message], hasEarlier: false, hasLater: false });
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		const calls: string[][] = [];
		api.retryMessage = async (roomId, messageId) => { calls.push([roomId, messageId]); return message; };
		await service.retryMessage(message.id);
		assert.deepStrictEqual(calls, [['a', message.id]]);
	});

	desktopTest('a run requires the local host to accept the existing account credentials', async () => {
		const { service, host, authenticationService, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		host.authenticate = async () => ({ authenticated: false });
		await assert.rejects(service.startRoom({ maxTurns: 2, timeoutMinutes: 1 }), /did not accept/);
		assert.deepStrictEqual(starts, []);
		host.authenticate = async () => ({ authenticated: true });
		await service.startRoom({ maxTurns: 2, timeoutMinutes: 1 });
		assert.deepStrictEqual(starts, [{ roomId: 'a', limits: { maxTurns: 2, timeoutMinutes: 1 } }]);
	});

	desktopTest('navigation during authentication cannot start a run in a different room', async () => {
		const { service, authenticationService, starts } = setup();
		await waitForState(service.availability, state => state === 'available');
		await service.selectRoom('a');
		const sessions = new DeferredPromise<readonly AuthenticationSession[]>();
		authenticationService.getSessions = () => sessions.p;
		const starting = service.startRoom({ maxTurns: 2, timeoutMinutes: 1 });
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
		const message = { ...post('pending', '@Copilot-1 Retry'), mentions: ['member-1'], deliveries: [{ memberId: 'member-1', state: 'pending' as const }] };
		api.getMessages = async () => ({ messages: [message], hasEarlier: false, hasLater: false });
		await service.selectRoom('a');
		authenticationService.getSessions = async () => [authenticationSession];
		trusted.clear();
		trustRequest.requestResourcesTrust = async () => false;
		const calls: string[] = [];
		api.retryMember = async () => { calls.push('retryMember'); return withPeers('a'); };
		api.retryMessage = async () => { calls.push('retryMessage'); return message; };
		api.postMessage = async (_id, options) => { calls.push(options.mode ?? 'message'); return { ...post(options.id, options.text), sequence: message.sequence + 1 }; };

		await assert.rejects(service.startRoom({}), /trust was not granted/);
		await assert.rejects(service.retryMember('member-1'), /trust was not granted/);
		await assert.rejects(service.retryMessage('pending'), /trust was not granted/);
		service.getDraft('a').update('@Copilot-1 Please work', undefined);
		await assert.rejects(service.sendMessage(), /trust was not granted/);
		service.getDraft('a').update('Change direction', undefined);
		await assert.rejects(service.sendMessage('steer'), /trust was not granted/);
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
		await service.startRoom({});
		await service.selectRoom('a');
		await service.startRoom({});
		assert.deepStrictEqual({
			prompts: trustPrompts.map(prompt => prompt.uri.toString()),
			separateWorktreesExplained: trustPrompts[0]?.message?.includes('Every peer uses a separate local worktree'),
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
		await service.startRoom({});
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
		const starting = service.startRoom({});
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
