/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IObservable } from '../../../../base/common/observable.js';
import { AgentHostRoomMessageMode, IAgentHostRoom, IAgentHostRoomConfiguration, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessagePage } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { ResolveSessionConfigResult } from '../../../../platform/agentHost/common/state/protocol/commands.js';
import { ChatInputAnswer, ChatInputRequest, ChatInputResponseKind, ModelSelection, SessionModelInfo, ToolCallConfirmationState } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { CollaborationDraft } from './collaborationMentions.js';

export const CollaborationEnabledSettingId = 'chat.agentHost.collaboration.enabled';
export const COLLABORATION_CUSTOM_VIEW_ID = 'sessions.collaborationRoom';
export const CollaborationRoomFocusedContext = new RawContextKey<boolean>('collaborationRoomFocused', false);
export const CollaborationRoomVisibleContext = new RawContextKey<boolean>('collaborationRoomVisible', false);
export const CollaborationAvailableContext = new RawContextKey<boolean>('collaborationRoomAvailable', false);
export const CollaborationSupportedContext = new RawContextKey<boolean>('collaborationRoomSupported', false);
export const CollaborationSidebarContext = ContextKeyExpr.and(
	ChatContextKeys.enabled,
	ContextKeyExpr.equals(`config.${CollaborationEnabledSettingId}`, true),
	CollaborationSupportedContext,
)!;
export const COLLABORATION_SECTION_ID = 'agent-collab';
export const COLLABORATION_MESSAGE_PAGE_SIZE = 100;

export type CollaborationAvailability = 'disabled' | 'connecting' | 'available' | 'unavailable' | 'error';

export interface ICollaborationWorkspaceTrust {
	readonly state: 'checking' | 'untrusted' | 'requesting' | 'trusted' | 'unavailable';
	readonly repositoryUri?: string;
	readonly worktreeUris?: readonly string[];
	readonly error?: string;
}

export type CollaborationRequestPayload =
	| { readonly kind: 'tool'; readonly toolCall: ToolCallConfirmationState }
	| { readonly kind: 'input'; readonly request: ChatInputRequest };

/** A pending request from a selected room member's server-confirmed active turn. */
export interface ICollaborationRequest {
	readonly id: string;
	readonly version: number;
	readonly roomId: string;
	readonly memberId: string;
	readonly memberName: string;
	readonly chatUri: string;
	readonly turnId: string;
	readonly payload: CollaborationRequestPayload;
	readonly state: 'ready' | 'submitting' | 'failed';
	readonly error?: string;
	readonly content?: string;
	readonly contentLoading?: boolean;
	readonly contentError?: string;
}

export type CollaborationRequestResponse =
	| { readonly kind: 'tool'; readonly approved: boolean; readonly selectedOptionId?: string }
	| { readonly kind: 'input'; readonly response: ChatInputResponseKind; readonly answers?: Record<string, ChatInputAnswer> };

export const ICollaborationService = createDecorator<ICollaborationService>('collaborationService');

/** Observable, renderer-local facade over the authoritative local room host. */
export interface ICollaborationService {
	readonly _serviceBrand: undefined;
	readonly availability: IObservable<CollaborationAvailability>;
	/** Last known host support, retained during temporary disconnections. */
	readonly supported: IObservable<boolean>;
	readonly availabilityError: IObservable<string | undefined>;
	readonly rooms: IObservable<readonly IAgentHostRoom[]>;
	readonly activeRoomId: IObservable<string | undefined>;
	readonly activeRoom: IObservable<IAgentHostRoom | undefined>;
	readonly messages: IObservable<IAgentHostRoomMessagePage>;
	readonly models: IObservable<readonly SessionModelInfo[]>;
	readonly loading: IObservable<boolean>;
	readonly loadingEarlier: IObservable<boolean>;
	readonly creating: IObservable<boolean>;
	readonly sending: IObservable<boolean>;
	readonly canSteer: IObservable<boolean>;
	readonly canConfigure: IObservable<boolean>;
	readonly canSetMemberModel: IObservable<boolean>;
	readonly error: IObservable<string | undefined>;
	readonly workspaceTrust: IObservable<ICollaborationWorkspaceTrust>;
	readonly requests: IObservable<readonly ICollaborationRequest[]>;
	readonly requestError: IObservable<string | undefined>;
	requestWorkspaceTrust(): Promise<void>;
	respondToRequest(request: ICollaborationRequest, response: CollaborationRequestResponse): Promise<void>;
	reloadRequestContent(request: ICollaborationRequest): Promise<void>;
	getConfiguration(): Promise<ResolveSessionConfigResult>;
	setConfiguration(configuration: Partial<IAgentHostRoomConfiguration>): Promise<void>;
	setMemberModel(memberId: string, model: ModelSelection | undefined): Promise<void>;
	refresh(): Promise<void>;
	/** Whether a folder can already back a room, so the UI can offer to prepare it. */
	isRepository(folderUri: string): Promise<boolean>;
	selectRoom(roomId: string | undefined): Promise<void>;
	createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom>;
	loadMessages(): Promise<void>;
	loadEarlierMessages(): Promise<void>;
	getDraft(roomId: string): CollaborationDraft;
	sendMessage(mode?: AgentHostRoomMessageMode): Promise<void>;
	retryMessage(messageId: string): Promise<void>;
	startRoom(limits: IAgentHostRoomLimits): Promise<void>;
	pauseRoom(): Promise<void>;
	stopRoom(): Promise<void>;
	addMember(model?: ModelSelection): Promise<void>;
	stopMember(memberId: string): Promise<void>;
	retryMember(memberId: string): Promise<void>;
	getArtifact(roomId: string, artifactId: string): Promise<string>;
}
