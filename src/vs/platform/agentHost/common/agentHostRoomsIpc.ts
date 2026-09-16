/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../nls.js';
import { IAgentHostRoomCreateOptions, IAgentHostRoomsCapabilities, IAgentHostRoomsService } from './agentHostRooms.js';

export function createAgentHostRoomsClient(channel: IChannel): IAgentHostRoomsService {
	const mutations = new Set<string>([
		'createRoom', 'postMessage', 'retryMessage', 'startRoom', 'extendRun', 'pauseRoom', 'stopRoom',
		'addMember', 'removeMember', 'stopMember', 'retryMember', 'setRoomConfiguration', 'setMemberModel',
	] satisfies (keyof IAgentHostRoomsService)[]);
	return ProxyChannel.toService<IAgentHostRoomsService>({
		call: async (command, args, cancellationToken) => {
			if (mutations.has(command)) {
				const capabilities = await channel.call<IAgentHostRoomsCapabilities>('getCapabilities', [], cancellationToken);
				if (capabilities.version !== 2 || !capabilities.available || capabilities.supportsInbox !== true) {
					throw new Error(localize('rooms.inboxUnavailable', "This host does not support executable inbox rooms. Upgrade the host to use room controls."));
				}
			}
			if (command === 'createRoom') {
				const [options] = args as [IAgentHostRoomCreateOptions];
				if (options.memberModels !== undefined) {
					// Top-level IPC arrays preserve undefined entries; arrays nested in JSON objects do not.
					return channel.call(command, [{ ...options, memberModels: undefined }, options.memberModels], cancellationToken);
				}
			}
			return channel.call(command, args, cancellationToken);
		},
		listen: (event, args) => channel.listen(event, args),
	});
}
