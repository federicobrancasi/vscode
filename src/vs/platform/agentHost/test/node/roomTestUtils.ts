/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IAgentHostRoomsController } from '../../node/agentHostRoomsController.js';

export function createNoopRoomsController(): IAgentHostRoomsController {
	const unavailable = async (): Promise<never> => { throw new Error('Unexpected room operation'); };
	return {
		_serviceBrand: undefined,
		onDidChangeRoom: Event.None,
		getCapabilities: async () => ({ version: 1, available: false, maxWorkers: 10 }),
		isRepository: async () => false,
		listRooms: async () => [],
		getRoom: unavailable,
		createRoom: unavailable,
		getMessages: unavailable,
		postMessage: unavailable,
		retryMessage: unavailable,
		startRoom: unavailable,
		pauseRoom: unavailable,
		stopRoom: unavailable,
		addMember: unavailable,
		removeMember: unavailable,
		stopMember: unavailable,
		retryMember: unavailable,
		getRoomConfiguration: unavailable,
		setRoomConfiguration: unavailable,
		setMemberConfiguration: unavailable,
		setMemberModel: unavailable,
		setContinuous: unavailable,
		getMemberModelForChat: async () => undefined,
		setMemberModelForChat: unavailable,
		getArtifact: unavailable,
		isRoomSession: () => false,
		isRoomSessionUri: () => false,
		isAdmittedTurn: () => false,
		read: unavailable,
		readArtifact: unavailable,
		post: unavailable,
		sharePatch: unavailable,
		beforeTool: () => { throw new Error('Unexpected room tool'); },
		shutdown: async () => { },
	};
}
