/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { AutoApproveLevel, SessionMode } from './agentHostSchema.js';
import type { SessionSandboxEnabled } from './sessionConfigKeys.js';
import type { ResolveSessionConfigResult } from './state/protocol/commands.js';
import type { ModelSelection } from './state/sessionState.js';

export const AgentHostRoomsChannelName = 'agentHostRooms';
export const MAX_ROOM_WORKERS = 10;
export const MAX_ROOM_MESSAGE_LENGTH = 8000;
export const MAX_ROOM_INBOX_BATCH_SIZE = 20;
export const MAX_ROOM_INBOX_BATCH_CHARACTERS = 16000;
export const OpenCollaborationRoomCommandId = 'workbench.action.collaboration.open';
export const NewCollaborationRoomCommandId = 'workbench.action.collaboration.new';

export type AgentHostRoomState = 'created' | 'running' | 'idle' | 'paused' | 'stopping' | 'stopped' | 'interrupted';
export type AgentHostRoomMemberState = 'pending' | 'starting' | 'working' | 'idle' | 'blocked' | 'needsInput' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
export type AgentHostRoomMessageKind = 'message' | 'work' | 'finding' | 'artifact' | 'system';
export type AgentHostRoomDeliveryState = 'pending' | 'reserved' | 'submitted' | 'failed' | 'interrupted' | 'cancelled';
export type IAgentHostRoomModelSelection = ModelSelection;

export interface IAgentHostRoomConfiguration {
	readonly mode: SessionMode;
	readonly autoApprove: AutoApproveLevel;
	readonly sandboxEnabled: SessionSandboxEnabled;
}

export const defaultAgentHostRoomConfiguration: IAgentHostRoomConfiguration = {
	mode: 'autopilot', autoApprove: 'default', sandboxEnabled: 'default',
};

export const newAgentHostRoomConfiguration: IAgentHostRoomConfiguration = {
	...defaultAgentHostRoomConfiguration, autoApprove: 'assisted',
};

export interface IAgentHostRoomLimits {
	/** Required before the first Start; omitted only when resuming an existing budget. */
	readonly maxTurns?: number;
	readonly timeoutMinutes?: number;
}

export interface IAgentHostRoomWork {
	readonly description: string;
	readonly blocked: boolean;
	readonly updatedAt: number;
}

export interface IAgentHostRoomMember {
	readonly id: string;
	readonly name: string;
	readonly sessionUri: string;
	readonly chatUri?: string;
	readonly model?: string;
	/** Last provider-acknowledged model, not merely the selected preference. */
	readonly modelSelection?: ModelSelection;
	/** Null requests the provider's explicit Auto selection. */
	readonly pendingModel?: ModelSelection | null;
	readonly modelError?: string;
	readonly state: AgentHostRoomMemberState;
	readonly worktreeUri?: string;
	readonly activity?: string;
	readonly work?: IAgentHostRoomWork;
	readonly error?: string;
	readonly turns: number;
	readonly removed?: boolean;
	readonly configuration?: IAgentHostRoomConfiguration;
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

export interface IAgentHostRoomArchiveSession {
	readonly id: string;
	readonly name: string;
	readonly sessionUri: string;
	readonly chatUri?: string;
	readonly worktreeUri?: string;
}

/** A room's presentation snapshot; archived experiments are never executable. */
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
	readonly archived?: boolean;
	/** Historical session links, including participants that were not workers. */
	readonly archivedSessions?: readonly IAgentHostRoomArchiveSession[];
	readonly pauseReason?: 'user' | 'budget' | 'deadline';
	readonly members: readonly IAgentHostRoomMember[];
	readonly artifacts: readonly IAgentHostRoomArtifact[];
	readonly latestMessageSequence: number;
	readonly run?: IAgentHostRoomRun;
	readonly error?: string;
}

/** Reservation and host submission only, not provider acceptance or task completion. */
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
	readonly text: string;
	readonly timestamp: number;
	/** Explicit recipient identities. Empty means a passive room note. */
	readonly mentions: readonly string[];
	readonly replyTo?: string;
	readonly artifactId?: string;
	readonly artifactIds?: readonly string[];
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
	/** Filter the shared history to messages addressed to this member. */
	readonly memberId?: string;
}

export interface IAgentHostRoomCreateOptions {
	readonly title: string;
	readonly goal: string;
	readonly instructions?: string;
	readonly repositoryUri: string;
	readonly baseRevision?: string;
	readonly initializeRepository?: boolean;
	readonly workerCount: number;
	readonly model?: string;
	readonly memberNames?: readonly string[];
	readonly memberModels?: readonly (ModelSelection | undefined)[];
}

export interface IAgentHostRoomPostOptions {
	readonly id: string;
	readonly text: string;
	/** Supplied explicitly by the caller; text is never parsed to change the audience. */
	readonly mentions: readonly string[];
	readonly replyTo?: string;
	readonly artifactIds?: readonly string[];
}

export interface IAgentHostRoomsCapabilities {
	readonly version: 1 | 2;
	readonly available: boolean;
	readonly maxWorkers: number;
	readonly supportsInbox?: boolean;
	readonly supportsConfiguration?: boolean;
	readonly supportsMemberModels?: boolean;
}

export const IAgentHostRoomsService = createDecorator<IAgentHostRoomsService>('agentHostRoomsService');

/** The human-facing room API. Worker tools receive a narrower, session-bound interface. */
export interface IAgentHostRoomsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRoom: Event<IAgentHostRoom>;

	getCapabilities(): Promise<IAgentHostRoomsCapabilities>;
	isRepository(folderUri: string): Promise<boolean>;
	listRooms(): Promise<readonly IAgentHostRoom[]>;
	getRoom(roomId: string): Promise<IAgentHostRoom>;
	createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom>;
	getMessages(roomId: string, query?: IAgentHostRoomMessageQuery): Promise<IAgentHostRoomMessagePage>;
	postMessage(roomId: string, message: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage>;
	retryMessage(roomId: string, messageId: string): Promise<IAgentHostRoomMessage>;
	startRoom(roomId: string, limits: IAgentHostRoomLimits): Promise<IAgentHostRoom>;
	/** Explicitly add to the existing budget, never silently replace its run identity. */
	extendRun(roomId: string, additionalTurns: number): Promise<IAgentHostRoom>;
	pauseRoom(roomId: string): Promise<IAgentHostRoom>;
	stopRoom(roomId: string): Promise<IAgentHostRoom>;
	addMember(roomId: string, model?: ModelSelection): Promise<IAgentHostRoom>;
	removeMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	stopMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	retryMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	getRoomConfiguration(roomId: string): Promise<ResolveSessionConfigResult>;
	setRoomConfiguration(roomId: string, configuration: Partial<IAgentHostRoomConfiguration>): Promise<IAgentHostRoom>;
	setMemberModel(roomId: string, memberId: string, model: ModelSelection | undefined): Promise<IAgentHostRoom>;
	getArtifact(roomId: string, artifactId: string): Promise<string>;
}
