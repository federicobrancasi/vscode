/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IAgentHostRoom, IAgentHostRoomsService, OpenCollaborationRoomCommandId } from '../../../../../../platform/agentHost/common/agentHostRooms.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { IChatAgentRequest } from '../../../common/participants/chatAgents.js';

export async function findRoomForSession(rooms: IAgentHostRoomsService | undefined, session: URI): Promise<IAgentHostRoom | undefined> {
	return (await rooms?.listRooms())?.find(room =>
		room.members.some(member => isEqual(URI.parse(member.sessionUri), session))
		|| room.archivedSessions?.some(member => isEqual(URI.parse(member.sessionUri), session)));
}

/** Routes room-member follow-ups through the authenticated room inbox instead of an unadmitted turn. */
export async function forwardRoomFollowUp(
	rooms: IAgentHostRoomsService | undefined,
	session: URI,
	request: IChatAgentRequest,
	progress: (parts: IChatProgress[]) => void,
	token: CancellationToken,
	ensureAuthenticated: () => Promise<void>,
): Promise<boolean> {
	if (!rooms) {
		return false;
	}
	const room = await findRoomForSession(rooms, session);
	if (!room) {
		return false;
	}
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	if (room.archived) {
		throw new Error(localize('room.followupArchive', "This session belongs to a read-only room archive. Inspect its history and patches in the room; archived sessions cannot receive follow-ups."));
	}
	const member = room.members.find(member => isEqual(URI.parse(member.sessionUri), session));
	if (!member || member.removed) {
		throw new Error(localize('room.followupRemoved', "This peer has been removed from the collaboration room and cannot receive new messages."));
	}
	const capabilities = await rooms.getCapabilities();
	if (capabilities.version !== 2 || !capabilities.available || !capabilities.supportsInbox) {
		throw new Error(localize('room.followupUnsupported', "The host does not support inbox collaboration. Update or reconnect it before sending room follow-ups."));
	}
	if (request.variables.variables.length) {
		throw new Error(localize('room.followupAttachments', "Follow-ups to collaboration members currently support text only. Remove the attachments and send again, or open the collaboration room."));
	}
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	await ensureAuthenticated();
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	const message = await rooms.postMessage(room.id, {
		id: `followup-${request.requestId}`,
		text: request.message,
		mentions: [member.id],
	});
	const delivery = message.deliveries.find(delivery => delivery.memberId === member.id);
	if (!delivery) {
		throw new Error(localize('room.followupReceiptMissing', "The room saved the message but returned no recipient delivery receipt. Open the room to check its status before retrying."));
	}
	let detail: string;
	switch (delivery.state) {
		case 'reserved':
			detail = localize('room.followupReserved', "Reserved. Turn budget and an immutable input batch are durably assigned before preparation and native submission. This is not delivered input.");
			break;
		case 'submitted':
			detail = localize('room.followupSubmitted', "Submitted to native host. Handed to the native host path; this does not confirm provider acceptance or task completion.");
			break;
		case 'pending':
			detail = localize('room.followupQueued', "Queued for the peer's next turn. Sending resumes the addressed peer within the existing turn budget. Busy peers finish their current turn first.");
			break;
		case 'failed':
			detail = localize('room.followupFailed', "Delivery failed. Review the saved message in the room before retrying. {0}", delivery.error ?? '');
			break;
		case 'interrupted':
			detail = localize('room.followupInterrupted', "Delivery was interrupted and acceptance is uncertain. Review the saved message in the room before retrying. {0}", delivery.error ?? '');
			break;
		case 'cancelled':
			detail = localize('room.followupCancelled', "Delivery was cancelled. Review the saved message in the room before retrying.");
			break;
	}
	const description = localize('room.followupSent', "Your follow-up was shared in the collaboration room \"{0}\" and addressed to {1}. Only the addressed peer is requested to respond. {2}", room.title, member.name, detail);
	progress([{ kind: 'markdownContent', content: new MarkdownString(escapeMarkdownSyntaxTokens(description)) }]);
	if (CommandsRegistry.getCommand(OpenCollaborationRoomCommandId)) {
		progress([{
			kind: 'command',
			command: { id: OpenCollaborationRoomCommandId, title: localize('room.openFollowup', "Back to Room"), arguments: [room.id] },
		}]);
	}
	return true;
}
