/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomMember, IAgentHostRoomMessage } from '../common/agentHostRooms.js';
import { ResolveSessionConfigResult } from '../common/state/protocol/commands.js';
import { ModelSelection } from '../common/state/sessionState.js';

export const roomExcludedTools = ['task', 'search_code_subagent', 'runSubagent', 'run_subagent', 'run_agent', 'run_factory', 'create_session', 'send_message', 'delete_session', 'rubber_duck', 'fleet'];
export const roomCoordinatorTools = ['room_coordinator_snapshot', 'room_assign', 'room_post'] as const;
export const roomCoordinatorExclusiveTools = ['room_coordinator_snapshot', 'room_assign'] as const;

export type RoomContentValidator = (relativePaths: readonly string[]) => Promise<void>;

export interface IRoomSessionParticipant {
	readonly id: string;
	readonly sessionUri: string;
	readonly chatUri?: string;
	readonly worktreeUri?: string;
	readonly model?: string;
	readonly modelSelection?: ModelSelection;
	readonly pendingModel?: ModelSelection | null;
	readonly configuration?: IAgentHostRoomConfiguration;
}

export interface IRoomMemberExecution {
	readonly memberId: string;
	readonly initialized: boolean;
	readonly briefed?: boolean;
	readonly briefingTurnId?: string;
	readonly needsTurn: boolean;
	readonly turnId?: string;
	readonly runId?: string;
	readonly readSequence?: number;
	readonly nextAction?: 'continue' | 'wait';
}

export interface IRoomRecord {
	readonly version: 1;
	readonly room: IAgentHostRoom;
	readonly messages: readonly IAgentHostRoomMessage[];
	readonly executions: readonly IRoomMemberExecution[];
}

export interface IRoomStorage {
	load(): Promise<readonly IRoomRecord[]>;
	save(record: IRoomRecord): Promise<void>;
	isRepository(folderUri: string): Promise<boolean>;
	resolveRepository(repositoryUri: string, revision?: string, initialize?: boolean): Promise<{ repositoryUri: string; baseRevision: string }>;
	worktreeUri(roomId: string, memberId: string): string;
	ensureWorktree(room: IAgentHostRoom, participant: IRoomSessionParticipant, requireExisting?: boolean): Promise<void>;
	publishPatch(room: IAgentHostRoom, member: IAgentHostRoomMember, title: string, validateContent?: RoomContentValidator): Promise<IAgentHostRoomArtifact>;
	readArtifact(room: IAgentHostRoom, artifact: IAgentHostRoomArtifact, validateContent?: RoomContentValidator): Promise<string>;
}

export interface IRoomRuntimeEvent {
	readonly sessionUri: string;
	readonly turnId?: string;
	readonly state: 'working' | 'needsInput' | 'idle' | 'failed' | 'stopped';
	readonly activity?: string;
	readonly error?: string;
}

export interface IRoomRuntime extends IDisposable {
	readonly onDidChange: Event<IRoomRuntimeEvent>;
	validateModel(model: ModelSelection): void;
	getModel(participant: IRoomSessionParticipant): ModelSelection | undefined;
	publishModel(participant: IRoomSessionParticipant): void;
	applyModel(participant: IRoomSessionParticipant, model: ModelSelection): Promise<void>;
	resolveConfiguration(participant: IRoomSessionParticipant, configuration?: IAgentHostRoomConfiguration): Promise<ResolveSessionConfigResult>;
	applyConfiguration(participant: IRoomSessionParticipant, requested?: Partial<IAgentHostRoomConfiguration>): Promise<void>;
	prepare(room: IAgentHostRoom, participant: IRoomSessionParticipant, initialized: boolean): Promise<void>;
	isIdle(sessionUri: string): boolean;
	hasTurn(sessionUri: string, turnId: string): boolean;
	submit(sessionUri: string, turnId: string, prompt: string): void;
	/** Send guidance to the current turn; false means it is no longer accepting steering. */
	steer(sessionUri: string, turnId: string, prompt: string): Promise<boolean>;
	abort(sessionUri: string, turnId?: string): Promise<void>;
	assertContentAccess?(sessionUri: string, paths: readonly string[]): Promise<void>;
}
