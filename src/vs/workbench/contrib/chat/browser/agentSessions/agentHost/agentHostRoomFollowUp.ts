/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IAgentHostRoomsService, OpenCollaborationRoomCommandId } from '../../../../../../platform/agentHost/common/agentHostRooms.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IChatProgress } from '../../../common/chatService/chatService.js';
import { IChatAgentRequest } from '../../../common/participants/chatAgents.js';

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
	const room = (await rooms.listRooms()).find(room => room.members.some(member => member.sessionUri === session.toString()));
	if (!room) {
		return false;
	}
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	if (request.variables.variables.length) {
		throw new Error(localize('room.followupAttachments', "Follow-ups to collaboration members currently support text only. Remove the attachments and send again, or open the collaboration room."));
	}
	await ensureAuthenticated();
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	const member = room.members.find(member => member.sessionUri === session.toString())!;
	await rooms.postMessage(room.id, {
		id: `followup-${request.requestId}`,
		text: request.message,
		mentions: [member.id],
	});
	const description = room.state === 'paused' || room.state === 'stopping'
		? localize('room.followupWaiting', "Your follow-up was saved in the shared collaboration room \"{0}\" for {1}. The room is paused or stopping, so the message is pending. Open the room to resume or retry delivery when it is ready.", room.title, member.name)
		: localize('room.followupSent', "Your follow-up was shared in the collaboration room \"{0}\" and addressed to {1}. Only the addressed peer is requested to respond. Follow its delivery status and response in the room.", room.title, member.name);
	progress([{ kind: 'markdownContent', content: new MarkdownString(escapeMarkdownSyntaxTokens(description)) }]);
	if (CommandsRegistry.getCommand(OpenCollaborationRoomCommandId)) {
		progress([{
			kind: 'command',
			command: { id: OpenCollaborationRoomCommandId, title: localize('room.openFollowup', "Back to Room"), arguments: [room.id] },
		}]);
	}
	return true;
}
