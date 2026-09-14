/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const MAX_AGENT_HOST_ROOM_MEMBER_NAME_LENGTH = 64;

const adjectives = [
	'caffeinated',
	'chaotic',
	'curious',
	'disciplined',
	'electric',
	'fearless',
	'glitchy',
	'hyper',
	'logical',
	'neon',
	'quantum',
	'recursive',
	'relentless',
	'sassy',
	'sleepy',
	'turbo',
] as const;

const nouns = [
	'android',
	'automaton',
	'bot',
	'circuit',
	'compiler',
	'cyborg',
	'datapoint',
	'droid',
	'kernel',
	'neuron',
	'oracle',
	'robot',
	'silicon',
	'tensor',
	'token',
	'transformer',
] as const;

export function isAgentHostRoomMemberName(value: string): boolean {
	return value.length <= MAX_AGENT_HOST_ROOM_MEMBER_NAME_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value);
}

export function generateAgentHostRoomMemberName(existingNames: Iterable<string>): string {
	const taken = new Set([...existingNames].map(name => name.toLowerCase()));
	const combinations = adjectives.length * nouns.length;
	const start = Math.floor(Math.random() * combinations);
	for (let offset = 0; offset < combinations; offset++) {
		const index = (start + offset) % combinations;
		const name = `${adjectives[Math.floor(index / nouns.length)]}-${nouns[index % nouns.length]}`;
		if (!taken.has(name)) {
			return name;
		}
	}
	let suffix = taken.size + 1;
	while (taken.has(`recursive-agent-${suffix}`)) {
		suffix++;
	}
	return `recursive-agent-${suffix}`;
}
