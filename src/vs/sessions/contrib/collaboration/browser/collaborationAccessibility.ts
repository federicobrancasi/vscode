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
			localize('collaboration.help.sidebar', "Agent Collab in the Sessions sidebar opens this view. Before a room is open it shows a form for the shared goal, the working folder, and how many agents to use with a model for each; shared rules, the Git branch, and optional run limits are under Advanced. Rooms you already created are listed in the Sessions sidebar: expand Agent Collab to open one directly. Once a room is open this view contains only the shared conversation and message input. Room settings move to the side panel, where Room Settings takes the place Changes and Files hold in an ordinary session; its run controls and tabs stay pinned above an independently scrolling body. Room Settings in the header, and Needs Attention, both bring that panel forward. Escape in the panel returns to the conversation. Hiding the panel preserves approval answers and model choices. Returning through Agent Collab after opening a participant restores the selected room."),
			localize('collaboration.help.navigation', "Use Tab and Shift+Tab to move between the panel tabs, messages, and the message input. The side panel begins with a tab list of four tabs: Run, Agents, Rules, and Approvals. Use Left and Right Arrow, Home, and End to move between them; a tab is badged when it holds something needing attention. Run holds the run actions and the optional run limits, and offers only the actions the current state allows: Start before a run, then Pause and Stop All. Needs Attention appears when something is waiting. Agents lists every peer with its model and state. Each peer offers Stop while it can be stopped, otherwise Resume, named Retry when it stopped because it failed; Remove retires it from the roster after confirming, keeping its posts in the room. Add Agent at the end of the list gives the room another peer. A peer's name opens that agent's own room chat once it has taken a turn. The shared message list supports arrow keys and Page Up or Page Down. Needs Attention selects the tab that owns the pending request or failure."),
			localize('collaboration.help.models', "Each numbered Copilot has its own searchable model menu, on the creation form before the room exists and in that agent's tab afterwards. Select a model with the keyboard and close the menu with Escape. Changing a model does not start work. A busy peer continues its current turn; its new model applies on the next turn. Pending changes and model errors are shown in that peer's row."),
			localize('collaboration.help.approvals', "Approvals and questions appear in the Approvals tab with the peer's name and the actual tool input, result, or question. Review the content, then use Allow, Reject, or the exact options offered by the host. You can answer forms and review plans without opening each peer. The card waits for the host's confirmation; rejected or timed-out responses show an error and can be retried. Input drafts and focus survive unrelated activity updates."),
			localize('collaboration.help.trust', "Trust Room Workspace requests consent for the source repository once and applies trust only to the exact local worktree of each peer. Review the listed directories before consenting. No shared parent directory is trusted. Declining prevents sending messages, starting, resuming, retrying, steering, or allowing peers. Reading the conversation remains available."),
			localize('collaboration.help.autopilot', "The All peers controls change mode and permissions for every peer directly from this room. Mode offers Interactive, Plan, and Autopilot. Permissions offers Manual permissions, Assisted permissions when available, and Allow all; new rooms start in Autopilot with assisted approvals. Choices are saved across Stop and Resume. Autopilot is separate from Allow all; managed approvals remain human, one-time decisions."),
			localize('collaboration.help.configuration', "Tab to the Mode or Permissions button and press Enter or Space to open the shared menu. Use arrow keys to navigate choices. Expand Permissions to choose the approval level or toggle terminal sandboxing when policy permits. Escape closes the menu and returns focus. A failed update reports an error rather than silently changing the selection."),
			localize('collaboration.help.primarySurface', "The room is a primary view, separate from the session grid. Back to Sessions ({0}) returns to the current session. Back to Room returns to the shared conversation without starting work. Message drafts and your position in older history are retained.", '<keybinding:workbench.action.collaboration.close>'),
			localize('collaboration.help.messages', "Messages identify their author. Send notifies every Copilot when there are no mentions, including peers that have finished or stopped. Mention a participant with @ to notify only that agent. Finished peers receive a new turn without a separate Resume action. Use the reply action to respond to a particular message."),
			localize('collaboration.help.steering', "Send delivers to the mentioned peers, or to everyone if there are no mentions. While a peer is mid-turn and the host supports steering, Send delivers as live guidance during that turn; otherwise it posts and wakes finished peers with a new turn. Control or Command plus Enter always steers. Pause holds guidance. Sending guidance does not interrupt an already-running external command or bypass approvals."),
			localize('collaboration.help.input', "In the message input, press Enter to send. Press Shift+Enter to insert a new line. Mention suggestions can be selected with the arrow keys and Enter; Escape dismisses the suggestions."),
			localize('collaboration.help.sentMessages', "After your message is saved, the conversation returns to the latest posts to reveal it. Scroll or navigate upwards to load earlier messages without losing your place. New reports continue to arrive while you read history. Jump to Latest returns to the live conversation. Author names remain visible alongside their color accents; color is not required to identify a peer. Older posts that had no recipients are not delivered retroactively."),
			localize('collaboration.help.followups', "Text follow-ups from a member's individual chat are shared in this room and addressed to that member. A new human mention can start only its addressed peer, including after a previous run stopped. Back to Room only navigates; it does not restart agents."),
			localize('collaboration.help.memberBusyInput', "Native Queue and Steer are unavailable in a member's individual chat during an active turn. Use Back to Room in that chat or Agent Collab in the sidebar, then send through the room composer. Idle text-only follow-ups still use the shared room delivery path."),
			localize('collaboration.help.delivery', "A posted message reaches a busy agent on its next turn, while live guidance reaches it during the current one. Pause holds pending messages, and an in-progress Stop does not admit new work. Retry Delivery retries a saved pending, cancelled, or failed human message without posting it twice. Messages from agents cannot restart a stopped room."),
			localize('collaboration.help.steeringStatus', "Sending guidance means delivery is in progress. Sent to active turn means the runtime accepted the guidance, not proof that the model followed it. Interrupted means delivery could not be confirmed."),
			localize('collaboration.help.activity', "The participant list shows each agent's state, model, and runtime activity. Reported work appears once in the shared conversation, not repeated in the participant cards. Waiting for approval, waiting for work, and failure are different states. An idle room does not mean the goal is solved."),
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
