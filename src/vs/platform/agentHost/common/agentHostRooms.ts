/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const AgentHostRoomsChannelName = 'agentHostRooms';
export const MAX_ROOM_WORKERS = 10;
export const OpenCollaborationRoomCommandId = 'workbench.action.collaboration.open';

export type AgentHostRoomState = 'created' | 'running' | 'idle' | 'paused' | 'stopping' | 'stopped' | 'interrupted';
export type AgentHostRoomMemberState = 'pending' | 'starting' | 'working' | 'idle' | 'blocked' | 'needsInput' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
export type AgentHostRoomMessageKind = 'message' | 'work' | 'finding' | 'artifact' | 'system';
export type AgentHostRoomMessageMode = 'message' | 'steer';
export type AgentHostRoomDeliveryState = 'pending' | 'submitted' | 'steering' | 'delivered' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface IAgentHostRoomLimits {
	readonly maxTurns?: number;
	readonly timeoutMinutes?: number;
}

export interface IAgentHostRoomWork {
	readonly description: string;
	readonly nextStep?: string;
	readonly blocked: boolean;
	readonly updatedAt: number;
}

export interface IAgentHostRoomMember {
	readonly id: string;
	readonly name: string;
	readonly sessionUri: string;
	/** Host-resolved AHP default chat; optional for compatibility with older hosts. */
	readonly chatUri?: string;
	readonly model?: string;
	readonly state: AgentHostRoomMemberState;
	readonly worktreeUri?: string;
	readonly activity?: string;
	readonly work?: IAgentHostRoomWork;
	readonly error?: string;
	readonly turns: number;
}

export interface IAgentHostRoomRun {
	readonly id: string;
	readonly startedAt: number;
	readonly deadline?: number;
	readonly limits: IAgentHostRoomLimits;
	readonly admittedTurns: number;
}

export interface IAgentHostRoomArtifact {
	readonly id: string;
	readonly memberId: string;
	readonly title: string;
	readonly createdAt: number;
	readonly baseRevision: string;
	readonly sourceRevision: string;
	readonly uri: string;
}

export interface IAgentHostRoom {
	readonly id: string;
	readonly revision: number;
	readonly title: string;
	readonly goal: string;
	readonly instructions: string;
	readonly repositoryUri: string;
	readonly baseRevision: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly state: AgentHostRoomState;
	readonly members: readonly IAgentHostRoomMember[];
	readonly artifacts: readonly IAgentHostRoomArtifact[];
	readonly latestMessageSequence: number;
	readonly run?: IAgentHostRoomRun;
	readonly error?: string;
}

export interface IAgentHostRoomDelivery {
	readonly memberId: string;
	readonly state: AgentHostRoomDeliveryState;
	readonly turnId?: string;
	readonly error?: string;
}

export interface IAgentHostRoomMessage {
	readonly id: string;
	readonly sequence: number;
	readonly authorId: string;
	readonly authorName: string;
	readonly authorKind: 'human' | 'agent' | 'system';
	readonly kind: AgentHostRoomMessageKind;
	/** Absent on older records and ordinary discussion posts. */
	readonly mode?: AgentHostRoomMessageMode;
	readonly text: string;
	readonly timestamp: number;
	readonly mentions: readonly string[];
	readonly replyTo?: string;
	readonly artifactId?: string;
	readonly deliveries: readonly IAgentHostRoomDelivery[];
}

export interface IAgentHostRoomMessagePage {
	readonly messages: readonly IAgentHostRoomMessage[];
	readonly hasEarlier: boolean;
	readonly hasLater: boolean;
}

export interface IAgentHostRoomMessageQuery {
	readonly after?: number;
	readonly before?: number;
	readonly limit?: number;
}

export interface IAgentHostRoomCreateOptions {
	readonly title: string;
	readonly goal: string;
	readonly instructions?: string;
	readonly repositoryUri: string;
	/** Branch, tag, or commit to resolve and pin in the host's Git environment. Defaults to HEAD. */
	readonly baseRevision?: string;
	readonly workerCount: number;
	readonly model?: string;
}

export interface IAgentHostRoomPostOptions {
	/** Caller-generated idempotency key, retained when retrying a failed send. */
	readonly id: string;
	readonly text: string;
	readonly mentions: readonly string[];
	readonly replyTo?: string;
	/** Human-only steering. Without mentions, targets all members of the room. */
	readonly mode?: AgentHostRoomMessageMode;
}

export interface IAgentHostRoomsCapabilities {
	readonly version: 1;
	readonly available: boolean;
	readonly maxWorkers: number;
	readonly supportsSteering?: boolean;
}

export const IAgentHostRoomsService = createDecorator<IAgentHostRoomsService>('agentHostRoomsService');

/**
 * Local room authority exposed over the existing agent-host MessagePort.
 * URI values are strings so snapshots do not depend on IPC prototype revival.
 */
export interface IAgentHostRoomsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRoom: Event<IAgentHostRoom>;

	getCapabilities(): Promise<IAgentHostRoomsCapabilities>;
	listRooms(): Promise<readonly IAgentHostRoom[]>;
	getRoom(roomId: string): Promise<IAgentHostRoom>;
	createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom>;
	getMessages(roomId: string, query?: IAgentHostRoomMessageQuery): Promise<IAgentHostRoomMessagePage>;
	postMessage(roomId: string, message: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage>;
	/** Explicitly retry undelivered recipients of a saved human message without duplicating the post. */
	retryMessage(roomId: string, messageId: string): Promise<IAgentHostRoomMessage>;
	startRoom(roomId: string, limits: IAgentHostRoomLimits): Promise<IAgentHostRoom>;
	pauseRoom(roomId: string): Promise<IAgentHostRoom>;
	stopRoom(roomId: string): Promise<IAgentHostRoom>;
	stopMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	retryMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	/** Return immutable patch text; the separately published artifact.uri identifies its file. */
	getArtifact(roomId: string, artifactId: string): Promise<string>;
}
