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
export const OpenCollaborationRoomCommandId = 'workbench.action.collaboration.open';
export const NewCollaborationRoomCommandId = 'workbench.action.collaboration.new';

export type AgentHostRoomState = 'created' | 'running' | 'idle' | 'paused' | 'stopping' | 'stopped' | 'interrupted';
export type AgentHostRoomMemberState = 'pending' | 'starting' | 'working' | 'idle' | 'blocked' | 'needsInput' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
export type AgentHostRoomMessageKind = 'message' | 'work' | 'finding' | 'result' | 'verification' | 'artifact' | 'system';
export type AgentHostRoomMessageMode = 'message' | 'steer';
export type AgentHostRoomDeliveryState = 'pending' | 'submitted' | 'steering' | 'delivered' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AgentHostRoomResultOutcome = 'success' | 'negative' | 'inconclusive' | 'blocked';
export type AgentHostRoomVerificationVerdict = 'verified' | 'rejected';
export type AgentHostRoomVerificationState = 'pending' | AgentHostRoomVerificationVerdict;
export type IAgentHostRoomModelSelection = ModelSelection;

export interface IAgentHostRoomConfiguration {
	readonly mode: SessionMode;
	readonly autoApprove: AutoApproveLevel;
	readonly sandboxEnabled: SessionSandboxEnabled;
}

export const defaultAgentHostRoomConfiguration: IAgentHostRoomConfiguration = {
	mode: 'autopilot', autoApprove: 'default', sandboxEnabled: 'default',
};

/**
 * Applied to members of a newly created room. Existing and legacy rooms keep
 * {@link defaultAgentHostRoomConfiguration} so reopening one never silently
 * escalates its approval level.
 */
export const newAgentHostRoomConfiguration: IAgentHostRoomConfiguration = {
	...defaultAgentHostRoomConfiguration, autoApprove: 'assisted',
};

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
	/** Display-compatible selected ID: pendingModel takes precedence over modelSelection. */
	readonly model?: string;
	/** Last provider-acknowledged selection; absent until a model is known to be applied. */
	readonly modelSelection?: ModelSelection;
	/** Saved next selection, without interrupting an active turn. Null requests the provider's explicit Auto model. */
	readonly pendingModel?: ModelSelection | null;
	readonly modelError?: string;
	readonly state: AgentHostRoomMemberState;
	readonly worktreeUri?: string;
	readonly activity?: string;
	readonly work?: IAgentHostRoomWork;
	readonly error?: string;
	readonly turns: number;
	/**
	 * Removed from the roster by the human. Its messages and published patches stay in
	 * the room, so the identity is kept rather than deleted, but it takes no further
	 * turns and is not a recipient.
	 */
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
	/** Keep admitting turns for idle members that have no explicit next step. Absent on legacy rooms. */
	readonly continuous?: boolean;
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

export interface IAgentHostRoomResult {
	readonly title: string;
	readonly summary: string;
	readonly outcome: AgentHostRoomResultOutcome;
	readonly evidence: readonly string[];
	readonly artifactIds: readonly string[];
	/** Derived by the host from verification messages; absent in persisted and legacy records. */
	readonly verificationState?: AgentHostRoomVerificationState;
}

export interface IAgentHostRoomVerification {
	readonly resultId: string;
	readonly verdict: AgentHostRoomVerificationVerdict;
	readonly evidence: readonly string[];
}

export interface IAgentHostRoomMessage {
	readonly id: string;
	readonly sequence: number;
	readonly authorId: string;
	readonly authorName: string;
	readonly authorKind: 'human' | 'agent' | 'system';
	readonly kind: AgentHostRoomMessageKind;
	/** Absent on older records and ordinary queued messages. */
	readonly mode?: AgentHostRoomMessageMode;
	readonly text: string;
	readonly timestamp: number;
	readonly mentions: readonly string[];
	readonly replyTo?: string;
	readonly artifactId?: string;
	readonly result?: IAgentHostRoomResult;
	readonly verification?: IAgentHostRoomVerification;
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
	/** Prepare a plain folder for collaboration (git init plus a baseline commit) when it is not yet a repository. */
	readonly initializeRepository?: boolean;
	readonly workerCount: number;
	readonly model?: string;
	/** Keep idle members working without an explicit next step. Defaults to true for new rooms. */
	readonly continuous?: boolean;
	/** Ordered by worker index. Names must be unique lowercase kebab-case identifiers. */
	readonly memberNames?: readonly string[];
	/** Ordered by worker index. An undefined entry uses the legacy model option, or the provider default. */
	readonly memberModels?: readonly (ModelSelection | undefined)[];
}

export interface IAgentHostRoomPostOptions {
	/** Caller-generated idempotency key, retained when retrying a failed send. */
	readonly id: string;
	readonly text: string;
	/** Explicit recipients. The room composer supplies every peer when its text has no @mentions. */
	readonly mentions: readonly string[];
	readonly replyTo?: string;
	/** Human-only live steering. Without recipients, targets all members; ordinary messages use the explicit recipients above. */
	readonly mode?: AgentHostRoomMessageMode;
}

export interface IAgentHostRoomPublishResultOptions {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly outcome: AgentHostRoomResultOutcome;
	readonly evidence: readonly string[];
	readonly artifactIds: readonly string[];
}

export interface IAgentHostRoomVerifyResultOptions {
	readonly id: string;
	readonly resultId: string;
	readonly verdict: AgentHostRoomVerificationVerdict;
	readonly evidence: readonly string[];
}

export interface IAgentHostRoomsCapabilities {
	readonly version: 1;
	readonly available: boolean;
	readonly maxWorkers: number;
	readonly supportsSteering?: boolean;
	readonly supportsConfiguration?: boolean;
	readonly supportsMemberModels?: boolean;
	readonly supportsStructuredResults?: boolean;
	readonly supportsResultVerification?: boolean;
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
	/** Whether a folder can already back a room, so callers can offer to prepare it first. */
	isRepository(folderUri: string): Promise<boolean>;
	listRooms(): Promise<readonly IAgentHostRoom[]>;
	getRoom(roomId: string): Promise<IAgentHostRoom>;
	createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom>;
	getMessages(roomId: string, query?: IAgentHostRoomMessageQuery): Promise<IAgentHostRoomMessagePage>;
	postMessage(roomId: string, message: IAgentHostRoomPostOptions): Promise<IAgentHostRoomMessage>;
	verifyResult(roomId: string, verification: IAgentHostRoomVerifyResultOptions): Promise<IAgentHostRoomMessage>;
	/** Explicitly retry undelivered recipients of a saved human message without duplicating the post. */
	retryMessage(roomId: string, messageId: string): Promise<IAgentHostRoomMessage>;
	startRoom(roomId: string, limits: IAgentHostRoomLimits): Promise<IAgentHostRoom>;
	pauseRoom(roomId: string): Promise<IAgentHostRoom>;
	stopRoom(roomId: string): Promise<IAgentHostRoom>;
	addMember(roomId: string, model?: ModelSelection): Promise<IAgentHostRoom>;
	removeMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	stopMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	retryMember(roomId: string, memberId: string): Promise<IAgentHostRoom>;
	getRoomConfiguration(roomId: string): Promise<ResolveSessionConfigResult>;
	setRoomConfiguration(roomId: string, configuration: Partial<IAgentHostRoomConfiguration>): Promise<IAgentHostRoom>;
	/** Undefined selects the catalog's explicit Auto model; rejects when Auto is unavailable. */
	setMemberModel(roomId: string, memberId: string, model: ModelSelection | undefined): Promise<IAgentHostRoom>;
	/** Return immutable patch text; the separately published artifact.uri identifies its file. */
	getArtifact(roomId: string, artifactId: string): Promise<string>;
}
