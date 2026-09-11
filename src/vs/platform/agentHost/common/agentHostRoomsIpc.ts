/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IAgentHostRoomCreateOptions, IAgentHostRoomsService } from './agentHostRooms.js';

export function createAgentHostRoomsClient(channel: IChannel): IAgentHostRoomsService {
	return ProxyChannel.toService<IAgentHostRoomsService>({
		call: (command, args, cancellationToken) => {
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
