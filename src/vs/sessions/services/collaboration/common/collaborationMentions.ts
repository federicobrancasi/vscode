/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';

export interface ICollaborationMention {
	readonly id: string;
	readonly name: string;
	readonly removed?: boolean;
}

export type CollaborationAudience = { readonly kind: 'note' } | { readonly kind: 'all' } | { readonly kind: 'member'; readonly memberId: string };

export interface ICollaborationMentionQuery {
	readonly start: number;
	readonly end: number;
	readonly query: string;
}

export function getCollaborationMentionQuery(text: string, cursor: number): ICollaborationMentionQuery | undefined {
	const prefix = text.slice(0, cursor);
	const match = /(?:^|\s)@(?<query>[\w-]*)$/.exec(prefix);
	if (!match?.groups) {
		return undefined;
	}
	return { start: cursor - match.groups.query.length - 1, end: cursor, query: match.groups.query };
}

export function getCollaborationRecipients(audience: CollaborationAudience, members: readonly ICollaborationMention[]): string[] {
	if (audience.kind === 'note') {
		return [];
	}
	const active = members.filter(member => !member.removed);
	if (audience.kind === 'all' && active.length) {
		return active.map(member => member.id);
	}
	if (audience.kind === 'member' && active.some(member => member.id === audience.memberId)) {
		return [audience.memberId];
	}
	throw new Error(localize('room.recipientUnavailable', "The selected recipient is no longer in this room. Choose an available peer or save a room note."));
}

/** Editing during an in-flight send must never be cleared by its late acknowledgement. */
export class CollaborationDraft {
	readonly state = observableValue<{ readonly text: string; readonly replyTo: string | undefined; readonly audience: CollaborationAudience }>(this, { text: '', replyTo: undefined, audience: { kind: 'all' } });
	private revision = 0;
	private pending: { readonly revision: number; readonly messageId: string; readonly mentions: readonly string[] } | undefined;

	get text(): string {
		return this.state.get().text;
	}

	get replyTo(): string | undefined {
		return this.state.get().replyTo;
	}

	get audience(): CollaborationAudience {
		return this.state.get().audience;
	}

	update(text: string, replyTo: string | undefined, audience = this.audience): void {
		if (this.text !== text || this.replyTo !== replyTo || !equals(this.audience, audience)) {
			this.revision++;
			this.pending = undefined;
			this.state.set({ text, replyTo, audience }, undefined);
		}
	}

	beginSend(messageId: string, mentions: readonly string[] = []): { readonly revision: number; readonly messageId: string; readonly text: string; readonly replyTo: string | undefined; readonly mentions: readonly string[] } {
		if (!this.pending) {
			this.pending = { revision: this.revision, messageId, mentions: [...mentions] };
		}
		return { ...this.pending, text: this.text, replyTo: this.replyTo };
	}

	acknowledge(revision: number): boolean {
		if (this.revision !== revision) {
			return false;
		}
		this.update('', undefined);
		this.pending = undefined;
		return true;
	}
}
