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
export type AgentHostRoomCoordinatorState = 'pending' | 'starting' | 'working' | 'idle' | 'needsInput' | 'failed' | 'offline' | 'interrupted';
export type AgentHostRoomCoordinatorEventKind = 'activity' | 'result' | 'verification' | 'blocked' | 'failed' | 'needsInput' | 'assignmentCreated' | 'assignmentSuperseded' | 'assignmentCompleted' | 'memberAdded' | 'memberRemoved';
export type AgentHostRoomMessageKind = 'message' | 'work' | 'finding' | 'result' | 'verification' | 'artifact' | 'system';
export type AgentHostRoomMessageMode = 'message' | 'steer';
export type AgentHostRoomDeliveryState = 'pending' | 'submitted' | 'steering' | 'delivered' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AgentHostRoomResultOutcome = 'success' | 'negative' | 'inconclusive' | 'blocked';
export type AgentHostRoomVerificationVerdict = 'verified' | 'rejected';
export type AgentHostRoomVerificationState = 'pending' | AgentHostRoomVerificationVerdict;
export type AgentHostRoomAssignmentKind = 'work' | 'verification';
export type AgentHostRoomAssignmentState = 'pending' | 'completed' | 'superseded';
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

export interface IAgentHostRoomCoordinator {
	readonly id: string;
	readonly name: string;
	readonly sessionUri: string;
	readonly chatUri: string;
	readonly worktreeUri: string;
	readonly desiredModel?: ModelSelection;
	readonly appliedModel?: ModelSelection;
	readonly pendingModel?: ModelSelection;
	readonly modelError?: string;
	readonly state: AgentHostRoomCoordinatorState;
	readonly initialized: boolean;
	/** Latest room message sequence projected into an outgoing coordinator turn. */
	readonly cursor: number;
	/** Monotonic sequence for meaningful coordinator scheduling events. */
	readonly eventSequence: number;
	/** Event sequence completed by the coordinator. */
	readonly eventCursor: number;
	readonly pendingEvents: readonly AgentHostRoomCoordinatorEventKind[];
	/** @deprecated Retained only to read journals written by the interval-based prototype. */
	readonly nextEventTurnAt?: number;
	readonly turnId?: string;
	readonly activeEventSequence?: number;
	readonly activeEvents?: readonly AgentHostRoomCoordinatorEventKind[];
	readonly error?: string;
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
	/** Allow workers to request another turn with an explicit concrete next step. Absent on legacy rooms. */
	readonly continuous?: boolean;
	/** Persistent logical coordinator. Absent in journals written before coordinator support. */
	readonly coordinator?: IAgentHostRoomCoordinator;
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
	/** Explicit coordinator assignment satisfied by this result. */
	readonly assignmentId?: string;
	/** Derived by the host from verification messages; absent in persisted and legacy records. */
	readonly verificationState?: AgentHostRoomVerificationState;
}

export interface IAgentHostRoomAssignment {
	readonly assigneeIds: readonly string[];
	readonly kind: AgentHostRoomAssignmentKind;
	readonly description: string;
	readonly expectedEvidence: readonly string[];
	readonly resultId?: string;
	readonly supersedes?: string;
	readonly note?: string;
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
	readonly assignment?: IAgentHostRoomAssignment;
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
	/** Initial coordinator model. The coordinator identity is separate from the worker roster. */
	readonly coordinatorModel?: ModelSelection;
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
	readonly assignmentId?: string;
}

export interface IAgentHostRoomAssignOptions {
	readonly id: string;
	readonly assignees: readonly string[];
	readonly kind: AgentHostRoomAssignmentKind;
	readonly description: string;
	readonly expectedEvidence: readonly string[];
	readonly resultId?: string;
	readonly supersedes?: string;
	readonly note?: string;
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
	readonly supportsCoordinator?: boolean;
}

export interface IAgentHostRoomCoordinatorWorkerSnapshot {
	readonly id: string;
	readonly name: string;
	readonly state: AgentHostRoomMemberState;
	readonly removed: boolean;
	readonly turns: number;
	readonly work?: IAgentHostRoomWork;
	/** Derived only from current assignment assignees, never from status text. */
	readonly pairedWith: readonly string[];
	readonly assignmentIds: readonly string[];
	readonly evidenceIds: readonly string[];
}

export interface IAgentHostRoomCoordinatorAssignmentSnapshot {
	readonly id: string;
	readonly sequence: number;
	readonly kind: AgentHostRoomAssignmentKind;
	readonly description: string;
	readonly assigneeIds: readonly string[];
	readonly expectedEvidence: readonly string[];
	readonly resultId?: string;
	readonly supersedes?: string;
	readonly state: AgentHostRoomAssignmentState;
	readonly completedAssigneeIds: readonly string[];
	readonly evidenceIds: readonly string[];
}

export interface IAgentHostRoomCoordinatorResultSnapshot {
	readonly id: string;
	readonly sequence: number;
	readonly authorId: string;
	readonly assignmentId?: string;
	readonly title: string;
	readonly summary: string;
	readonly outcome: AgentHostRoomResultOutcome;
	readonly verificationState: AgentHostRoomVerificationState;
	readonly verificationIds: readonly string[];
	readonly evidence: readonly string[];
	readonly evidenceIds: readonly string[];
}

export interface IAgentHostRoomCoordinatorIssueSnapshot {
	readonly memberId: string;
	readonly kind: 'blocked' | 'failed' | 'needsInput';
	readonly description?: string;
	readonly evidenceIds: readonly string[];
}

export interface IAgentHostRoomCoordinatorHumanGuidanceSnapshot {
	readonly id: string;
	readonly sequence: number;
	readonly text: string;
	readonly evidenceIds: readonly string[];
}

export interface IAgentHostRoomCoordinatorUnownedWorkSnapshot {
	readonly id: string;
	readonly description: string;
	readonly memberId?: string;
	readonly evidenceIds: readonly string[];
}

export interface IAgentHostRoomCoordinatorSnapshot {
	readonly room: {
		readonly id: string;
		readonly title: string;
		readonly goal: string;
		readonly state: AgentHostRoomState;
		readonly sequence: number;
	};
	readonly coordinator: IAgentHostRoomCoordinator;
	readonly workers: readonly IAgentHostRoomCoordinatorWorkerSnapshot[];
	readonly assignments: readonly IAgentHostRoomCoordinatorAssignmentSnapshot[];
	readonly results: readonly IAgentHostRoomCoordinatorResultSnapshot[];
	readonly issues: readonly IAgentHostRoomCoordinatorIssueSnapshot[];
	readonly pendingHumanGuidance: readonly IAgentHostRoomCoordinatorHumanGuidanceSnapshot[];
	readonly unownedWork: readonly IAgentHostRoomCoordinatorUnownedWorkSnapshot[];
	readonly evidenceIds: readonly string[];
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
	ensureCoordinator(roomId: string): Promise<IAgentHostRoomCoordinator>;
	getCoordinator(roomId: string): Promise<IAgentHostRoomCoordinator | undefined>;
	setCoordinatorModel(roomId: string, model: ModelSelection | undefined): Promise<IAgentHostRoomCoordinator>;
	getCoordinatorSnapshot(roomId: string): Promise<IAgentHostRoomCoordinatorSnapshot>;
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
