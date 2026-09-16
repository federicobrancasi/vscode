/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AgentHostRoomDeliveryState, AgentHostRoomMemberState, AgentHostRoomMessageKind, AgentHostRoomState, IAgentHostRoom, IAgentHostRoomMessage } from '../../../../platform/agentHost/common/agentHostRooms.js';

export function messageKindLabel(kind: AgentHostRoomMessageKind): string {
	switch (kind) {
		case 'message': return localize('post.message', "Message");
		case 'work': return localize('post.work', "Work update");
		case 'finding': return localize('post.finding', "Finding");
		case 'artifact': return localize('post.artifact', "Published artifact");
		case 'system': return localize('post.system', "Room event");
	}
}

export function roomStateLabel(state: AgentHostRoomState): string {
	switch (state) {
		case 'created': return localize('room.created', "Ready to start");
		case 'running': return localize('room.running', "Running");
		case 'idle': return localize('room.idle', "Idle");
		case 'paused': return localize('room.paused', "Paused");
		case 'stopping': return localize('room.stopping', "Stopping");
		case 'stopped': return localize('room.stopped', "Stopped");
		case 'interrupted': return localize('room.interrupted', "Interrupted - explicit resume required");
	}
}

export function roomStatusLabel(room: IAgentHostRoom): string {
	if (room.archived) {
		return localize('room.archived', "Archive - read-only");
	}
	if (room.pauseReason === 'budget') {
		return localize('room.budgetExhausted', "Paused - turn budget exhausted");
	}
	if (room.pauseReason === 'deadline') {
		return localize('room.deadlineReached', "Paused - deadline reached");
	}
	return roomStateLabel(room.state);
}

export function memberStateLabel(state: AgentHostRoomMemberState): string {
	switch (state) {
		case 'pending': return localize('member.pending', "Queued");
		case 'starting': return localize('member.starting', "Starting");
		case 'working': return localize('member.working', "Working");
		case 'idle': return localize('member.idle', "Idle");
		case 'blocked': return localize('member.blocked', "Blocked");
		case 'needsInput': return localize('member.needsInput', "Needs approval or input");
		case 'stopping': return localize('member.stopping', "Stopping");
		case 'stopped': return localize('member.stopped', "Stopped");
		case 'failed': return localize('member.failed', "Failed");
		case 'interrupted': return localize('member.interrupted', "Interrupted");
	}
}

export function deliveryStateLabel(state: AgentHostRoomDeliveryState): string {
	switch (state) {
		case 'pending': return localize('delivery.pending', "Queued");
		case 'reserved': return localize('delivery.reserved', "Reserved");
		case 'submitted': return localize('delivery.submitted', "Submitted to native host");
		case 'failed': return localize('delivery.failed', "Failed");
		case 'cancelled': return localize('delivery.cancelled', "Cancelled");
		case 'interrupted': return localize('delivery.interrupted', "Interrupted");
	}
}

function deliveryStateDescription(state: AgentHostRoomDeliveryState): string {
	switch (state) {
		case 'pending': return localize('delivery.pendingDescription', "Waiting in the inbox. No input batch has been reserved for a turn.");
		case 'reserved': return localize('delivery.reservedDescription', "Turn budget and an immutable input batch are durably assigned before preparation and native submission. This is not delivered input.");
		case 'submitted': return localize('delivery.submittedDescription', "Handed to the native host path. This does not confirm provider acceptance or task completion.");
		case 'failed': return localize('delivery.failedDescription', "The delivery attempt failed. Task completion is not confirmed.");
		case 'interrupted': return localize('delivery.interruptedDescription', "The delivery outcome is uncertain. Provider acceptance and task completion are not confirmed.");
		case 'cancelled': return localize('delivery.cancelledDescription', "The delivery attempt was cancelled. Task completion is not confirmed.");
	}
}

export function messageAudienceLabel(message: IAgentHostRoomMessage, room: IAgentHostRoom | undefined): string {
	return message.mentions.length
		? localize('room.messageRecipients', "To: {0}", message.mentions.map(id => participantName(room, id)).join(', '))
		: localize('room.roomNote', "Room note - no agents notified");
}

export function messageDeliveryLabels(message: IAgentHostRoomMessage, room: IAgentHostRoom | undefined, includeDescription = false): string[] {
	return message.deliveries.map(delivery => {
		const name = participantName(room, delivery.memberId);
		const label = localize('room.delivery', "{0}: {1}{2}", name, deliveryStateLabel(delivery.state), delivery.error ? ` (${delivery.error})` : '');
		return includeDescription ? localize('room.deliveryDescription', "{0}. {1}", label, deliveryStateDescription(delivery.state)) : label;
	});
}

function participantName(room: IAgentHostRoom | undefined, id: string): string {
	const participants = room?.archived ? room.archivedSessions : room?.members;
	return participants?.find(participant => participant.id === id)?.name ?? id;
}
