/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AgentHostRoomMessageMode } from '../../../../platform/agentHost/common/agentHostRooms.js';

export interface ICollaborationMention {
	readonly id: string;
	readonly name: string;
}

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

export function getCollaborationMentionTargets(text: string, members: readonly ICollaborationMention[]): string[] {
	const names = new Map(members.map(member => [member.name.toLowerCase(), member.id]));
	const result = new Set<string>();
	for (const match of text.matchAll(/(?:^|\s)@(?<name>[\w-]+)(?=$|[^\w-])/g)) {
		const id = names.get(match.groups!.name.toLowerCase());
		if (!id) {
			throw new Error(localize('room.unknownMention', "No peer named @{0} belongs to this room. Choose a peer from mention completion.", match.groups!.name));
		}
		result.add(id);
	}
	return [...result];
}

/** Editing during an in-flight send must never be cleared by its late acknowledgement. */
export class CollaborationDraft {
	readonly state = observableValue<{ readonly text: string; readonly replyTo: string | undefined }>(this, { text: '', replyTo: undefined });
	private revision = 0;
	private pending: { readonly revision: number; readonly messageId: string; readonly mode: AgentHostRoomMessageMode } | undefined;

	get text(): string {
		return this.state.get().text;
	}

	get replyTo(): string | undefined {
		return this.state.get().replyTo;
	}

	update(text: string, replyTo: string | undefined): void {
		if (this.text !== text || this.replyTo !== replyTo) {
			this.revision++;
			this.pending = undefined;
			this.state.set({ text, replyTo }, undefined);
		}
	}

	beginSend(messageId: string, mode: AgentHostRoomMessageMode = 'message'): { readonly revision: number; readonly messageId: string; readonly text: string; readonly replyTo: string | undefined } {
		if (!this.pending || this.pending.mode !== mode) {
			this.pending = { revision: this.revision, messageId, mode };
		}
		return { revision: this.pending.revision, messageId: this.pending.messageId, text: this.text, replyTo: this.replyTo };
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
