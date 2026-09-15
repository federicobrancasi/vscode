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
			localize('collaboration.help.overview', "You are in a collaboration room. The Coordinator is your main chat for status and broad direction. Copilot workers remain equal peers, keep collaborating directly, and post evidence after meaningful work. The coordinator supervises without blocking worker progress."),
			localize('collaboration.help.sidebar', "Agent Collab in the Sessions sidebar opens this view. Before a room is open it shows a form for the shared goal, working folder, coordinator model, worker count, and a model for each worker; shared rules and the Git branch are under Advanced. Rooms you already created are listed in the Sessions sidebar. Once a room is open, Coordinator is the default standard chat. Activity contains the shared worker log and direct-message input. Room settings move to the side panel, where Run, Agents, Rules, and Approvals stay available. Returning through Agent Collab after opening a participant restores the selected room."),
			localize('collaboration.help.navigation', "The main tab list has Coordinator and Activity. Use Left and Right Arrow, Home, and End to move between them. Coordinator uses the standard chat keyboard behavior. Activity contains the shared message list and input; its badge counts unread meaningful evidence rather than every progress line. The side panel has Run, Agents, Rules, and Approvals with the same arrow-key navigation. Run offers only actions the current state allows. Agents shows the coordinator separately above every worker. Each worker offers Stop while it can work, otherwise Resume or Retry; Remove retires it while preserving its posts. A worker's name opens its own chat."),
			localize('collaboration.help.models', "The coordinator and every worker have separate searchable model menus on the creation form and in Room Settings. Select a model with the keyboard and close the menu with Escape. Changing a model does not start work. A busy participant keeps its current model until the next turn. Pending changes and model errors remain visible."),
			localize('collaboration.help.approvals', "Approvals and questions appear in the Approvals tab with the peer's name and the actual tool input, result, or question. Review the content, then use Allow, Reject, or the exact options offered by the host. You can answer forms and review plans without opening each peer. The card waits for the host's confirmation; rejected or timed-out responses show an error and can be retried. Input drafts and focus survive unrelated activity updates."),
			localize('collaboration.help.trust', "Trust Room Workspace requests consent for the source repository once and applies trust only to the exact local worktrees of the coordinator and workers. Review the listed directories before consenting. No shared parent directory is trusted. Declining prevents agent execution and direct worker messaging. Reading Activity remains available."),
			localize('collaboration.help.autopilot', "The All peers controls change mode and permissions for every peer directly from this room. Mode offers Interactive, Plan, and Autopilot. Permissions offers Manual permissions, Assisted permissions when available, and Allow all; new rooms start in Autopilot with assisted approvals. Choices are saved across Stop and Resume. Autopilot is separate from Allow all; managed approvals remain human, one-time decisions."),
			localize('collaboration.help.configuration', "Tab to the Mode or Permissions button and press Enter or Space to open the shared menu. Use arrow keys to navigate choices. Expand Permissions to choose the approval level or toggle terminal sandboxing when policy permits. Escape closes the menu and returns focus. A failed update reports an error rather than silently changing the selection."),
			localize('collaboration.help.primarySurface', "The room is a primary view, separate from the session grid. Back to Sessions ({0}) returns to the current session. Back to Room returns to the shared conversation without starting work. Message drafts and your position in older history are retained.", '<keybinding:workbench.action.collaboration.close>'),
			localize('collaboration.help.messages', "In Activity, messages identify their author. Send addresses every worker when there are no mentions, or only workers mentioned with @, bypassing the coordinator. Running workers receive human guidance; stopped workers keep it pending until Resume. Structured assignments explicitly identify one assignee or a paired group, their objective, expected evidence, and completion or supersession state. Structured results show their outcome, evidence, patches, and verification state. Review Result appends an attributed verdict; it does not apply or merge a patch."),
			localize('collaboration.help.coordinatorAuthority', "Tell the coordinator what to investigate, assign, pair, redirect, or verify in its chat. Pairing is authoritative only when an assignment names multiple workers. The coordinator cannot Stop, Resume, Add, Remove, approve permissions, or answer worker questions for you. Those actions remain in Room Settings. If the coordinator fails or is offline, workers and Activity continue."),
			localize('collaboration.help.steering', "Send delivers to the mentioned peers, or to everyone if there are no mentions. While a peer is mid-turn and the host supports steering, Send delivers as live guidance during that turn; otherwise it is available on the next admitted turn. Control or Command plus Enter always steers. Pause holds guidance, and Stop blocks it until Resume. Sending guidance does not interrupt an already-running external command or bypass approvals."),
			localize('collaboration.help.input', "In the message input, press Enter to send. Press Shift+Enter to insert a new line. Mention suggestions can be selected with the arrow keys and Enter; Escape dismisses the suggestions."),
			localize('collaboration.help.sentMessages', "After your message is saved, the conversation returns to the latest posts to reveal it. Scroll or navigate upwards to load earlier messages without losing your place. New reports continue to arrive while you read history. Jump to Latest returns to the live conversation. Author names remain visible alongside their color accents; color is not required to identify a peer. Older posts that had no recipients are not delivered retroactively."),
			localize('collaboration.help.followups', "Text follow-ups from a member's individual chat are shared in this room and addressed to that member. Guidance sent after Stop remains pending until Resume. Back to Room only navigates; it does not restart agents."),
			localize('collaboration.help.memberBusyInput', "Native Queue and Steer are unavailable in a member's individual chat during an active turn. Use Back to Room in that chat or Agent Collab in the sidebar, then send through the room composer. Idle text-only follow-ups still use the shared room delivery path."),
			localize('collaboration.help.delivery', "A posted message reaches a running agent on its next turn, while live guidance reaches it during the current one. Pause holds pending messages, and Stop does not admit new work. Retry Delivery marks a saved cancelled or failed human message pending without posting it twice; Resume admits the next turn. Messages from agents cannot restart a stopped room."),
			localize('collaboration.help.steeringStatus', "Sending guidance means delivery is in progress. Sent to active turn means the runtime accepted the guidance, not proof that the model followed it. Interrupted means delivery could not be confirmed."),
			localize('collaboration.help.activity', "The participant list shows each agent's state, model, and runtime activity. Reported work appears once in the shared conversation, not repeated in the participant cards. Waiting for approval, waiting for work, and failure are different states. An idle room does not mean the goal is solved."),
			localize('collaboration.help.controls', "Start and Resume run the team continuously. Pause prevents new turns while current work finishes. Stop requests cancellation and blocks new work until Resume. Stopping is shown until execution has ended. A human mention addresses only that peer."),
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
