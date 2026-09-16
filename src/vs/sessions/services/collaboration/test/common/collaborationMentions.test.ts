/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CollaborationDraft, getCollaborationMentionQuery, getCollaborationRecipients } from '../../common/collaborationMentions.js';

suite('CollaborationMentions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('completes only the mention at the cursor, not email addresses', () => {
		assert.deepStrictEqual(getCollaborationMentionQuery('Ask @Cop', 8), { start: 4, end: 8, query: 'Cop' });
		assert.deepStrictEqual(getCollaborationMentionQuery('@', 1), { start: 0, end: 1, query: '' });
		assert.strictEqual(getCollaborationMentionQuery('user@example', 12), undefined);
		assert.strictEqual(getCollaborationMentionQuery('@Copilot-1 done', 15), undefined);
	});

	test('explicit audiences resolve to stable members and exclude removed peers', () => {
		const members = [{ id: 'one', name: 'Copilot-1' }, { id: 'ten', name: 'Copilot-10' }, { id: 'removed', name: 'Removed', removed: true }];
		assert.deepStrictEqual([
			getCollaborationRecipients({ kind: 'note' }, members),
			getCollaborationRecipients({ kind: 'all' }, members),
			getCollaborationRecipients({ kind: 'member', memberId: 'ten' }, members),
		], [[], ['one', 'ten'], ['ten']]);
		assert.throws(() => getCollaborationRecipients({ kind: 'member', memberId: 'removed' }, members), /no longer in this room/);
	});

	test('new drafts address all current peers and passive notes remain an explicit choice', () => {
		const draft = new CollaborationDraft();
		draft.update('Focus on URI formatting', undefined);
		const members = [{ id: 'one', name: 'First' }, { id: 'new-peer', name: 'New peer' }];
		const recipients = getCollaborationRecipients(draft.audience, members);
		draft.update(draft.text, undefined, { kind: 'note' });
		assert.deepStrictEqual({
			recipients,
			noteRecipients: getCollaborationRecipients(draft.audience, members),
		}, { recipients: ['one', 'new-peer'], noteRecipients: [] });
	});

	test('a failed send retains its idempotency key for retry', () => {
		const draft = new CollaborationDraft();
		draft.update('Advice', 'original');
		const first = draft.beginSend('message-one');
		assert.deepStrictEqual(draft.beginSend('message-two'), first);
		assert.strictEqual(draft.acknowledge(first.revision), true);
		assert.strictEqual(draft.text, '');
		assert.strictEqual(draft.replyTo, undefined);
	});

	test('late send acknowledgements never erase edits or replies', () => {
		const draft = new CollaborationDraft();
		draft.update('First advice', undefined);
		const first = draft.beginSend('message-one');
		draft.update('New advice', 'another-message');
		assert.strictEqual(draft.acknowledge(first.revision), false);
		assert.strictEqual(draft.text, 'New advice');
		assert.strictEqual(draft.replyTo, 'another-message');
		assert.strictEqual(draft.beginSend('message-two').messageId, 'message-two');
	});

	test('changing the visible audience allocates a new idempotency key, but roster changes do not rewrite a pending send', () => {
		const draft = new CollaborationDraft();
		draft.update('Change direction', undefined, { kind: 'note' });
		const note = draft.beginSend('note', []);
		draft.update(draft.text, draft.replyTo, { kind: 'all' });
		const addressed = draft.beginSend('addressed', ['one']);
		const retried = draft.beginSend('retry', ['one', 'two']);
		assert.deepStrictEqual({
			note: note.messageId, addressed: addressed.messageId, retried: retried.messageId, recipients: retried.mentions,
		}, { note: 'note', addressed: 'addressed', retried: 'addressed', recipients: ['one'] });
	});

	test('text mentions and edits do not change the selected audience', () => {
		const draft = new CollaborationDraft();
		draft.update('@Copilot-2 Hello', undefined, { kind: 'member', memberId: 'one' });
		draft.update('@Copilot-3 Hello', undefined);
		const pending = draft.beginSend('message', ['one']);
		draft.update(draft.text, undefined, { kind: 'note' });
		assert.deepStrictEqual({ cleared: draft.acknowledge(pending.revision), draft: draft.state.get() }, {
			cleared: false, draft: { text: '@Copilot-3 Hello', replyTo: undefined, audience: { kind: 'note' } },
		});
	});
});
