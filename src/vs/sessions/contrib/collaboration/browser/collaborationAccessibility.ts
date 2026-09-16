/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry, IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { CollaborationRoomFocusedContext } from '../../../services/collaboration/common/collaboration.js';

export class CollaborationAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 150;
	readonly name = 'collaborationRoomHelp';
	readonly type = AccessibleViewType.Help;
	readonly when = CollaborationRoomFocusedContext;

	getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const view = accessor.get(ICollaborationRoomViewService).activeView.get();
		if (!view) {
			return undefined;
		}
		const content = [
			localize('collaboration.help.overview', "You are in a collaboration room. Independent Copilot peers exchange messages through a shared inbox. The room has one conversation, not a separate coordinator chat. Creating, opening, resizing, or filtering a room never starts paid work."),
			localize('collaboration.help.sidebar', "Agent Collab in the Sessions sidebar opens this view. The creation form asks for a shared goal, working folder, peer count, and a model for each peer. Shared rules and the Git branch are under Advanced. Saved rooms remain in the sidebar. Room Settings opens Run, Agents, Rules, and Approvals in the side panel."),
			localize('collaboration.help.navigation', "The shared conversation leads. All Messages opens a menu to filter history to a peer's inbox. Filtering and loading history never mark mail as handled. Tab through the conversation, history controls, and input. The side-panel tab list supports Left and Right Arrow, Home, and End, and retains focus when badges update."),
			localize('collaboration.help.audience', "The room composer sends to all peers. There is no audience selector. Typing or completing an @name only inserts text; it never changes the recipients. Replies link to the original message and still address all peers. To address only one peer, send a follow-up in that peer's individual chat."),
			localize('collaboration.help.input', "In the message input, press Enter to send an ordinary inbox message. Control or Command plus Enter also sends an ordinary message, not live steering. Press Shift+Enter for a new line. Mention suggestions support arrow keys, Enter, and Tab; Escape dismisses them. Draft text and reply references survive unrelated updates."),
			localize('collaboration.help.delivery', "Queued means a message is saved in the inbox but no input batch is reserved. Reserved means turn budget and an immutable input batch are durably assigned before preparation and native submission; it is not delivered input. Submitted to native host means handed to the native host path, not provider acceptance or task completion. Busy peers receive queued mail after their current turn, without concurrent turns or mid-turn steering. Delivery tooltips and Accessible View explain these boundaries. Only failed, interrupted, or cancelled deliveries can be retried; queued, reserved, and submitted inputs must not be replayed."),
			localize('collaboration.help.budget', "Before the first Start, enter a required finite turn budget in Run. The header displays remaining turns. Every admitted turn, including an initial activation, consumes budget when its input batch is durably reserved, before preparation or native submission. Several inbox messages can share one reserved batch; message counts are not delivered-turn counts. At exhaustion, queued mail remains saved and Extend requires an explicit number of additional turns. Messages, Resume, and adding peers do not reset the run budget. A turn budget is not a guaranteed token or currency cap."),
			localize('collaboration.help.controls', "Start authorizes the first finite run. Sending an addressed human message starts or resumes its recipients within the existing budget; no separate Resume action is needed. Pause holds new admissions while current work settles. Stop requests cancellation. Later human Send or Resume can reopen work, but peer messages, passive notes, and old send retries cannot undo Stop. Sending during cancellation is refused until stopping settles. Idle means no current runnable mail, not that the shared goal is solved."),
			localize('collaboration.help.summary', "Ask for Summary lets you choose an existing peer. The request is an ordinary shared inbox message using the same budget and approvals. It creates no special manager or summary session."),
			localize('collaboration.help.models', "Every peer has its own searchable model menu on the creation form and in Agents. Select with the keyboard and close with Escape. Changing a model does not start work. A busy peer keeps its current model until the next turn. Pending choices and model errors remain visible. A peer's name opens its existing ordinary Sessions chat for detailed activity and changes."),
			localize('collaboration.help.approvals', "Approvals shows the peer's name and actual tool input, result, or question. Review the content and use Allow, Reject, or the exact options offered by the host. The card waits for host confirmation; rejected or timed-out responses show an error. Input drafts and focus survive unrelated messages. Room messages cannot bypass approvals."),
			localize('collaboration.help.trust', "Trust Room Workspace requests consent for the source repository and only its exact local peer worktrees. Review the listed directories first; no shared parent directory is trusted. Declining prevents agent execution and addressed messaging. Reading history remains available."),
			localize('collaboration.help.configuration', "The All peers Mode and Permissions controls use the normal host configuration and managed policy. Autopilot is separate from Allow all. New rooms use assisted approvals. Tab to a control, press Enter or Space, and use arrow keys in its menu. Escape closes the menu and restores focus. Failed changes report an error."),
			localize('collaboration.help.history', "Load Earlier Messages retains your position in scrollback while new messages arrive. Jump to Latest returns to the live conversation. Messages show sender, explicit recipients, reply references, delivery labels, and published patch links. Color is not needed to identify a peer."),
			localize('collaboration.help.hiddenMessages', "Human messages and room events offer Hide for Me. This hides the message in this profile's conversation and Accessible View, including after reopening the window. It does not delete room history, cancel delivery, or remove context already seen by agents. Show Hidden Messages restores hidden posts for the current room."),
			localize('collaboration.help.followups', "Text follow-ups from a peer's individual chat use the same authenticated shared inbox. During an active turn, native Queue and Steer are unavailable for room peers; use Back to Room to queue the message. Ordinary non-room Queue and Steer are unchanged. Back to Room only navigates and never resumes work."),
			localize('collaboration.help.archives', "An Archive - read-only label identifies old experiments. Author names with a saved session link open that archived session for inspection. Agents also lists historical participants who were not workers, with their preserved worktrees and inspect-only session links, without adding them to the worker roster. Projected message text, replies, diagnostics, and immutable patches remain readable. Historical interrupted deliveries are not task success. Message, model, membership, approval, and run controls cannot write to an archive. Archived native chats are read-only too."),
			localize('collaboration.help.changes', "Each peer uses a separate Git worktree. Review Published Artifact and Review Patch open immutable published contributions. Publishing or reviewing a patch does not apply or merge it into your working branch."),
			localize('collaboration.help.primarySurface', "The room is a primary view separate from the session grid. Back to Sessions ({0}) returns to the current session. Back to Room restores the selected room, draft, and history position without starting work.", '<keybinding:workbench.action.collaboration.close>'),
			localize('collaboration.help.accessibleView', "Open Accessible View ({0}) to read participants, budget, and the selected conversation as plain text. Closing Accessible View or this help restores your previous focus.", '<keybinding:editor.action.accessibleView>'),
		].join('\n\n');
		return new AccessibleContentProvider(
			AccessibleViewProviderId.CollaborationRoom,
			{ type: AccessibleViewType.Help },
			() => content,
			view.captureFocus(),
			AccessibilityVerbositySettingId.CollaborationRoom,
		);
	}
}

export class CollaborationAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 150;
	readonly name = 'collaborationRoom';
	readonly type = AccessibleViewType.View;
	readonly when = CollaborationRoomFocusedContext;

	getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const view = accessor.get(ICollaborationRoomViewService).activeView.get();
		if (!view) {
			return undefined;
		}
		return new AccessibleContentProvider(
			AccessibleViewProviderId.CollaborationRoom,
			{ type: AccessibleViewType.View, language: 'plaintext' },
			() => view.getAccessibleContent(),
			view.captureFocus(),
			AccessibilityVerbositySettingId.CollaborationRoom,
		);
	}
}

AccessibleViewRegistry.register(new CollaborationAccessibilityHelp());
AccessibleViewRegistry.register(new CollaborationAccessibleView());
