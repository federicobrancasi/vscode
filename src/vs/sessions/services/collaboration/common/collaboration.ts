/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IObservable } from '../../../../base/common/observable.js';
import { AgentHostRoomMessageMode, IAgentHostRoom, IAgentHostRoomCreateOptions, IAgentHostRoomLimits, IAgentHostRoomMessagePage, IAgentHostRoomMessageQuery } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { SessionModelInfo } from '../../../../platform/agentHost/common/state/protocol/state.js';
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
	readonly creating: IObservable<boolean>;
	readonly sending: IObservable<boolean>;
	readonly canSteer: IObservable<boolean>;
	readonly error: IObservable<string | undefined>;
	refresh(): Promise<void>;
	selectRoom(roomId: string | undefined): Promise<void>;
	createRoom(options: IAgentHostRoomCreateOptions): Promise<IAgentHostRoom>;
	loadMessages(query?: IAgentHostRoomMessageQuery): Promise<void>;
	setFollowingLatest(following: boolean): void;
	getDraft(roomId: string): CollaborationDraft;
	sendMessage(mode?: AgentHostRoomMessageMode): Promise<void>;
	retryMessage(messageId: string): Promise<void>;
	startRoom(limits: IAgentHostRoomLimits): Promise<void>;
	pauseRoom(): Promise<void>;
	stopRoom(): Promise<void>;
	stopMember(memberId: string): Promise<void>;
	retryMember(memberId: string): Promise<void>;
	getArtifact(roomId: string, artifactId: string): Promise<string>;
}
