/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AgentHostRoomDeliveryState, AgentHostRoomMemberState, AgentHostRoomMessageKind, AgentHostRoomResultOutcome, AgentHostRoomState, AgentHostRoomVerificationState, AgentHostRoomVerificationVerdict } from '../../../../platform/agentHost/common/agentHostRooms.js';

export function messageKindLabel(kind: AgentHostRoomMessageKind): string {
	switch (kind) {
		case 'message': return localize('post.message', "Message");
		case 'work': return localize('post.work', "Work update");
		case 'finding': return localize('post.finding', "Finding");
		case 'result': return localize('post.result', "Structured result");
		case 'verification': return localize('post.verification', "Result verification");
		case 'artifact': return localize('post.artifact', "Published artifact");
		case 'system': return localize('post.system', "Room event");
	}
}

export function resultOutcomeLabel(outcome: AgentHostRoomResultOutcome): string {
	switch (outcome) {
		case 'success': return localize('result.success', "Success");
		case 'negative': return localize('result.negative', "Negative result");
		case 'inconclusive': return localize('result.inconclusive', "Inconclusive");
		case 'blocked': return localize('result.blocked', "Blocked");
	}
}

export function verificationStateLabel(state: AgentHostRoomVerificationState): string {
	switch (state) {
		case 'pending': return localize('verification.pending', "Pending verification");
		case 'verified': return localize('verification.verified', "Verified");
		case 'rejected': return localize('verification.rejected', "Rejected");
	}
}

export function verificationVerdictLabel(verdict: AgentHostRoomVerificationVerdict): string {
	return verdict === 'verified' ? localize('verification.verdictVerified', "Verified") : localize('verification.verdictRejected', "Rejected");
}

export function roomStateLabel(state: AgentHostRoomState): string {
	switch (state) {
		case 'created': return localize('room.created', "Ready to start");
		case 'running': return localize('room.running', "Running");
		case 'idle': return localize('room.idle', "Waiting");
		case 'paused': return localize('room.paused', "Paused");
		case 'stopping': return localize('room.stopping', "Stopping");
		case 'stopped': return localize('room.stopped', "Stopped");
		case 'interrupted': return localize('room.interrupted', "Interrupted - explicit resume required");
	}
}

export function memberStateLabel(state: AgentHostRoomMemberState): string {
	switch (state) {
		case 'pending': return localize('member.pending', "Queued");
		case 'starting': return localize('member.starting', "Starting");
		case 'working': return localize('member.working', "Working");
		case 'idle': return localize('member.idle', "Waiting");
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
		case 'pending': return localize('delivery.pending', "Pending");
		case 'submitted': return localize('delivery.submitted', "Submitted");
		case 'steering': return localize('delivery.steering', "Sending guidance");
		case 'delivered': return localize('delivery.delivered', "Sent to active turn");
		case 'completed': return localize('delivery.completed', "Completed");
		case 'failed': return localize('delivery.failed', "Failed");
		case 'cancelled': return localize('delivery.cancelled', "Cancelled");
		case 'interrupted': return localize('delivery.interrupted', "Interrupted");
	}
}
