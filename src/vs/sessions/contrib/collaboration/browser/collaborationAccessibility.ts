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
			localize('collaboration.help.overview', "You are in a collaboration room. You and the Copilot agents share a conversation and a goal. Agents choose their own work and post findings; there is no required lead agent."),
			localize('collaboration.help.sidebar', "Agent Collab in the Sessions sidebar opens this view. Its home lists saved rooms and a Create a room form. Choose a saved room with Tab and Enter. The room picker and New Room button remain available while a room is open. Returning through Agent Collab after opening a participant restores the selected room."),
			localize('collaboration.help.navigation', "Use Tab and Shift+Tab to move between room controls, participants, messages, and the message input. Participant buttons open the agent's existing room chat for detailed activity, changes, and tool approvals. Expand a participant's status summary for reported work and Stop or Retry actions."),
			localize('collaboration.help.primarySurface', "The room is a primary view, separate from the session grid. Back to Sessions ({0}) returns to the current session. Back to Room returns to the shared conversation without starting work. Message drafts and your position in older history are retained.", '<keybinding:workbench.action.collaboration.close>'),
			localize('collaboration.help.messages', "Messages identify their author. A normal post is visible to everyone but does not start a turn for every agent. Mention a participant with @ to notify that agent. Use the reply action to respond to a particular message."),
			localize('collaboration.help.steering', "Steer Agents sends human guidance to the mentioned peers, or to everyone if there are no mentions. Control or Command plus Enter in the composer also steers. Active peers receive guidance during their current turn; idle peers are scheduled. Pause holds guidance. Sending guidance does not interrupt an already-running external command or bypass approvals."),
			localize('collaboration.help.input', "In the message input, press Enter to send. Press Shift+Enter to insert a new line. Mention suggestions can be selected with the arrow keys and Enter; Escape dismisses the suggestions."),
			localize('collaboration.help.sentMessages', "After your message is saved, the conversation returns to the latest posts to reveal it. Incoming messages do not move you away from older history you are reading. A post without mentions is shared with the room but does not notify idle agents."),
			localize('collaboration.help.followups', "Text follow-ups from a member's individual chat are shared in this room and addressed to that member. A new human mention can start only its addressed peer, including after a previous run stopped. Back to Room only navigates; it does not restart agents."),
			localize('collaboration.help.memberBusyInput', "Native Queue and Steer are unavailable in a member's individual chat during an active turn. Use Back to Room in that chat or Agent Collab in the sidebar, then send through the room composer. Idle text-only follow-ups still use the shared room delivery path."),
			localize('collaboration.help.delivery', "A normal mention to a busy agent waits for its next turn; Steer Agents instead sends live guidance. Pause holds pending messages. Retry Delivery retries a saved pending, cancelled, or failed human message without posting it twice. Messages from agents cannot restart a stopped room."),
			localize('collaboration.help.steeringStatus', "Sending guidance means delivery is in progress. Sent to active turn means the runtime accepted the guidance, not proof that the model followed it. Interrupted means delivery could not be confirmed."),
			localize('collaboration.help.activity', "The participant list shows each agent's state, chosen work, and current activity. Waiting for approval, waiting for work, and failure are different states. An idle room does not mean the goal is solved."),
			localize('collaboration.help.controls', "Start and Resume run the team. Turn and deadline limits are optional and unset by default. Pause prevents new turns while current work finishes. Stop requests cancellation. Stopping is shown until execution has ended. A new human mention is an explicit request for only that peer to respond."),
			localize('collaboration.help.changes', "Each agent works in a separate Git worktree. Shared patches are available for review. Publishing a patch does not apply or merge it into your working branch."),
			localize('collaboration.help.accessibleView', "Open Accessible View ({0}) to read the room's participants and shared messages as plain text. Returning from Accessible View or this help restores your previous focus.", '<keybinding:editor.action.accessibleView>'),
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
