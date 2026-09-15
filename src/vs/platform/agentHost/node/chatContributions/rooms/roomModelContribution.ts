/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../log/common/log.js';
import { IAgentHostChatContribution, IAgentHostChatContributionContext, IAppliedClientAction, IHydrationContext, IRestoredChat } from '../../../common/agentHostChatContributionsService.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { MessageKind } from '../../../common/state/sessionState.js';
import { IAgentHostRoomsController } from '../../agentHostRoomsController.js';

export class RoomModelContribution extends Disposable implements IAgentHostChatContribution {
	static readonly id = 'roomModel';
	readonly order = 610;

	constructor(
		_context: IAgentHostChatContributionContext,
		@IAgentHostRoomsController private readonly rooms: IAgentHostRoomsController,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	onDidApplyClientAction(observed: IAppliedClientAction): void {
		if (observed.action.type !== ActionType.ChatDraftChanged || !observed.action.draft?.model) {
			return;
		}
		const operation = this.rooms.isCoordinatorChat(observed.session, observed.channel)
			? this.rooms.setCoordinatorModelForChat(observed.session, observed.channel, observed.action.draft.model)
			: this.rooms.isRoomSessionUri(observed.session)
				? this.rooms.setMemberModelForChat(observed.session, observed.channel, observed.action.draft.model)
				: undefined;
		void operation?.catch(error => this.logService.warn('[RoomModelContribution] Failed to save the room model selection', error));
	}

	async onHydrateChat(context: IHydrationContext, restored: IRestoredChat): Promise<IRestoredChat> {
		const model = this.rooms.isCoordinatorChat(context.session, context.chat)
			? await this.rooms.getCoordinatorModelForChat(context.session, context.chat)
			: await this.rooms.getMemberModelForChat(context.session, context.chat);
		return model ? { ...restored, draft: { text: '', origin: { kind: MessageKind.User }, ...restored.draft, model } } : restored;
	}
}
