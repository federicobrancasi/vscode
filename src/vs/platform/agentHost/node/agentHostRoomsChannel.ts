/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../nls.js';
import { IAgentHostRoomsService } from '../common/agentHostRooms.js';

/** Keep member bindings and journal mutation helpers private to the host. */
export function createAgentHostRoomsChannel(rooms: IAgentHostRoomsService, disposables: DisposableStore): IServerChannel {
	const channel = ProxyChannel.fromService(rooms, disposables);
	const methods = new Set<string>([
		'getCapabilities', 'listRooms', 'getRoom', 'createRoom', 'getMessages', 'postMessage', 'retryMessage',
		'startRoom', 'pauseRoom', 'stopRoom', 'stopMember', 'retryMember', 'getArtifact',
		'getRoomConfiguration', 'setRoomConfiguration', 'setMemberModel',
	] satisfies (keyof IAgentHostRoomsService)[]);
	return {
		call: (context, command, args) => {
			if (!methods.has(command)) {
				return Promise.reject(new Error(`Unknown room method: ${command}`));
			}
			if (command === 'createRoom' && Array.isArray(args) && args.length === 2) {
				const options: unknown = args[0];
				if (!options || typeof options !== 'object' || Array.isArray(options)) {
					return Promise.reject(new Error(localize('rooms.invalidCreateOptions', "Invalid room create options.")));
				}
				return channel.call(context, command, [{ ...options, memberModels: args[1] }]);
			}
			return channel.call(context, command, args);
		},
		listen: (context, event, args) => {
			if (event !== 'onDidChangeRoom') {
				throw new Error(`Unknown room event: ${event}`);
			}
			return channel.listen(context, event, args);
		},
	};
}
