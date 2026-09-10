/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostChatContribution, IAgentHostChatContributionContext, IIncomingRequest, IncomingRequestDisposition } from '../../../common/agentHostChatContributionsService.js';
import { IAgentHostRoomsController } from '../../agentHostRoomsController.js';

/** Requires a durable room reservation before any worker request reaches a provider. */
export class RoomTurnAdmissionContribution extends Disposable implements IAgentHostChatContribution {
	static readonly id = 'roomTurnAdmission';
	readonly order = -100;

	constructor(
		_context: IAgentHostChatContributionContext,
		@IAgentHostRoomsController private readonly rooms: IAgentHostRoomsController,
	) {
		super();
	}

	onIncomingRequest(request: IIncomingRequest): IncomingRequestDisposition | undefined {
		if (this.rooms.isRoomSessionUri(request.session)
			&& (request.clientId !== undefined || request.source !== 'direct' || !this.rooms.isAdmittedTurn(request.session, request.chat, request.turnId))) {
			return {
				kind: 'reject', stage: 'validation',
				error: { errorType: 'roomControlled', message: localize('rooms.controlledTurn', "Use the collaboration room to send messages or start this member.") },
			};
		}
		return undefined;
	}
}
