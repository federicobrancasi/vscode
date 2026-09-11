/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IAgentHostRoom } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { asCssVariable, registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';

const participantAccents = [
	['#72B7FF', '#005A9C'], ['#8ED6A0', '#236637'], ['#D8A3FF', '#6D389B'], ['#FFB482', '#965000'], ['#72D5DB', '#006E77'],
	['#F291AA', '#A22B52'], ['#E3CE7F', '#6C6000'], ['#AFA9FF', '#4F46A5'], ['#CEBAA5', '#795139'], ['#ACE0CA', '#006452'],
].map(([dark, light], index) => registerColor(
	`agents.collaboration.participant${index + 1}`,
	{ dark, light, hcDark: dark, hcLight: light },
	localize('collaboration.participantAccent', "The author accent for collaboration participant {0}.", index + 1),
));

export function collaborationAuthorAccent(room: IAgentHostRoom | undefined, authorId: string): string {
	const index = room?.members.findIndex(member => member.id === authorId) ?? -1;
	return asCssVariable(participantAccents[index] ?? foreground);
}
