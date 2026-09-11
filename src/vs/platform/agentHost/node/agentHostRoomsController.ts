/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostRoomArtifact, IAgentHostRoomConfiguration, IAgentHostRoomsService } from '../common/agentHostRooms.js';
import { ModelSelection } from '../common/state/sessionState.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { AgentHostRooms, IRoomSessionTools } from './agentHostRooms.js';
import { AgentHostRoomsRuntime, IRoomSessionLifecycle } from './agentHostRoomsRuntime.js';
import { AgentHostRoomsStorage } from './agentHostRoomsStorage.js';
import { IRoomRecord, IRoomStorage } from './agentHostRoomsTypes.js';
import { IAgentHostProviderService } from './agentHostProviderService.js';
import { AgentHostStateManager, IAgentHostStateManager } from './agentHostStateManager.js';
import { IAgentHostTurnService } from './agentHostTurnService.js';

export const IAgentHostRoomsController = createDecorator<IAgentHostRoomsController>('agentHostRoomsController');

/** Internal authority; SDK tools never receive the human room-control surface. */
export interface IAgentHostRoomsController extends IAgentHostRoomsService, IRoomSessionTools {
	setMemberConfiguration(session: string, configuration: Partial<IAgentHostRoomConfiguration>, onApplied?: () => void): Promise<void>;
	getMemberModelForChat(session: string, chat: string): Promise<ModelSelection | undefined>;
	setMemberModelForChat(session: string, chat: string, model: ModelSelection): Promise<void>;
	isRoomSessionUri(session: string): boolean;
	isAdmittedTurn(session: string, chat: string, turnId: string): boolean;
	shutdown(): Promise<void>;
}

/** Registered in the primary graph; only the local host supplies a durable storage root. */
export class AgentHostRoomsController extends AgentHostRooms implements IAgentHostRoomsController {
	constructor(
		lifecycle: IRoomSessionLifecycle,
		private readonly storage: URI | IRoomStorage | undefined,
		@IAgentHostStateManager stateManager: AgentHostStateManager,
		@IAgentHostTurnService turnService: IAgentHostTurnService,
		@IAgentHostProviderService providers: IAgentHostProviderService,
		@IAgentConfigurationService configurationService: IAgentConfigurationService,
		@ILogService logService: ILogService,
	) {
		super(
			URI.isUri(storage) ? new AgentHostRoomsStorage(storage, logService) : storage ?? new UnavailableRoomStorage(),
			new AgentHostRoomsRuntime(lifecycle, stateManager, turnService, providers, configurationService),
			logService,
		);
	}

	override async getCapabilities() {
		const capabilities = await super.getCapabilities();
		return { ...capabilities, available: !!this.storage && capabilities.available };
	}
}

class UnavailableRoomStorage implements IRoomStorage {
	async load(): Promise<readonly IRoomRecord[]> { return []; }
	async save(): Promise<void> { throw this.unavailable(); }
	async resolveRepository(): Promise<{ repositoryUri: string; baseRevision: string }> { throw this.unavailable(); }
	worktreeUri(): string { throw this.unavailable(); }
	async ensureWorktree(): Promise<void> { throw this.unavailable(); }
	async publishPatch(): Promise<IAgentHostRoomArtifact> { throw this.unavailable(); }
	async readArtifact(): Promise<string> { throw this.unavailable(); }
	private unavailable(): Error { return new Error(localize('rooms.localOnly', "Collaboration rooms are available only on the local agent host.")); }
}
