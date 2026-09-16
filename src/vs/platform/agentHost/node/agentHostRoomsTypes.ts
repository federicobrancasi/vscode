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
	readonly turnId?: string;
	readonly runId?: string;
}

export interface IRoomRecord {
	readonly version: 2;
	readonly room: IAgentHostRoom;
	readonly messages: readonly IAgentHostRoomMessage[];
	readonly executions: readonly IRoomMemberExecution[];
}

/** Display-only projection of an untouched legacy journal. */
export interface IRoomArchive {
	readonly room: IAgentHostRoom;
	readonly messages: readonly IAgentHostRoomMessage[];
	/** Includes historical coordinator sessions, which also remain read-only. */
	readonly sessionUris: readonly string[];
}

export interface IRoomStorage {
	load(): Promise<readonly IRoomRecord[]>;
	loadArchives(): Promise<readonly IRoomArchive[]>;
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

/** The provider owns the model/tool loop; the room only submits bounded inbox input. */
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
	abort(sessionUri: string, turnId?: string): Promise<void>;
	assertContentAccess?(sessionUri: string, paths: readonly string[]): Promise<void>;
}
