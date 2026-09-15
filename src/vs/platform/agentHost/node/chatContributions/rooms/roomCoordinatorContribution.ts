/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IAgentHostChatContribution, IAgentHostChatContributionContext, IOutgoingTurn, ISendContribution } from '../../../common/agentHostChatContributionsService.js';
import { IAgentHostRoomsController } from '../../agentHostRoomsController.js';

const roomCoordinatorInstructions = [
	'You coordinate this collaboration room for the human while workers continue collaborating directly.',
	'Base status and progress claims only on the deterministic snapshot below, and cite its evidence IDs when explaining who is assigned, paired, blocked, or finished.',
	'Use room_assign for explicit work, pairing, redirection, and verification requests. A pair exists only when one assignment names multiple assignees. Use room_post only for a useful informational Activity note.',
	'Never imply that workers need your permission to continue. You cannot stop, resume, add, or remove workers, answer approvals, change permissions, edit worker files, or launch nested agents.',
].join('\n');

export class RoomCoordinatorContribution extends Disposable implements IAgentHostChatContribution {
	static readonly id = 'roomCoordinator';
	readonly order = 550;

	constructor(
		_context: IAgentHostChatContributionContext,
		@IAgentHostRoomsController private readonly rooms: IAgentHostRoomsController,
	) {
		super();
	}

	async onOutgoingTurn(turn: IOutgoingTurn): Promise<ISendContribution | undefined> {
		if (!this.rooms.isCoordinatorChat(turn.session, turn.chat)) {
			return undefined;
		}
		const snapshot = await this.rooms.getCoordinatorTurnSnapshot(turn.session, turn.chat, turn.turnId);
		if (!snapshot) {
			return undefined;
		}
		return {
			text: [
				turn.message.text,
				'<room_coordinator_instructions>',
				roomCoordinatorInstructions,
				'</room_coordinator_instructions>',
				'<room_coordinator_snapshot>',
				JSON.stringify(snapshot),
				'</room_coordinator_snapshot>',
			].join('\n\n'),
		};
	}
}
