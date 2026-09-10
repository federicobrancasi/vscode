/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent } from '@github/copilot-sdk';
import { localize } from '../../../../nls.js';

/** The SDK's accepted message ID, never its text, binds guidance to the original turn. */
export function roomSteeringMetadataKey(messageId: string): string {
	return `agentHost.roomSteering.${messageId}`;
}

export function roomSteeringContent(prompt: string): string {
	return localize('room.humanGuidance', "Human guidance:\n\n{0}", prompt);
}

export function roomSteeringEventIds(event: Extract<SessionEvent, { type: 'user.message' }>): readonly string[] {
	return [event.id, event.data.interactionId].filter((id): id is string => typeof id === 'string' && id.length > 0);
}
