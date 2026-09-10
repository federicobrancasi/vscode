/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CollaborationDraft, getCollaborationMentionQuery, getCollaborationMentionTargets } from '../../common/collaborationMentions.js';

suite('CollaborationMentions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('completes only the mention at the cursor, not email addresses', () => {
		assert.deepStrictEqual(getCollaborationMentionQuery('Ask @Cop', 8), { start: 4, end: 8, query: 'Cop' });
		assert.deepStrictEqual(getCollaborationMentionQuery('@', 1), { start: 0, end: 1, query: '' });
		assert.strictEqual(getCollaborationMentionQuery('user@example', 12), undefined);
		assert.strictEqual(getCollaborationMentionQuery('@Copilot-1 done', 15), undefined);
	});

	test('mentions resolve to exact stable members and deduplicate', () => {
		const members = [{ id: 'one', name: 'Copilot-1' }, { id: 'ten', name: 'Copilot-10' }];
		assert.deepStrictEqual(getCollaborationMentionTargets('@Copilot-10, @copilot-1 @Copilot-10', members), ['ten', 'one']);
		assert.deepStrictEqual(getCollaborationMentionTargets('ordinary room post', members), []);
		assert.throws(() => getCollaborationMentionTargets('@Copilot-11', members), /No peer named/);
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

	test('changing a failed send from discussion to steering allocates a different idempotency key', () => {
		const draft = new CollaborationDraft();
		draft.update('Change direction', undefined);
		const discussion = draft.beginSend('discussion', 'message');
		const steering = draft.beginSend('steering', 'steer');
		assert.notStrictEqual(discussion.messageId, steering.messageId);
		assert.strictEqual(draft.beginSend('retry', 'steer').messageId, steering.messageId);
	});
});
