/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs } from 'fs';
import { dirname, join, resolve } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { isWindows } from '../../../base/common/platform.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';

export function checkRoomData(condition: unknown, field: string): asserts condition {
	if (!condition) {
		throw new Error(localize('rooms.invalidData', "Invalid room storage data: {0}.", field));
	}
}

export function roomObject(value: unknown, field: string, keys?: readonly string[]): Record<string, unknown> {
	checkRoomData(value !== null && typeof value === 'object' && !Array.isArray(value), field);
	if (keys) {
		checkRoomData(Object.keys(value).every(key => keys.includes(key)), `${field} contains unknown fields`);
	}
	return value as Record<string, unknown>;
}

export function roomArray(value: unknown, field: string): readonly unknown[] {
	checkRoomData(Array.isArray(value), field);
	return value;
}

export function roomText(value: unknown, field: string, empty = false, limit = Number.POSITIVE_INFINITY): string {
	checkRoomData(typeof value === 'string' && value.length <= limit && !value.includes('\0') && (empty || value.trim().length > 0), field);
	return value;
}

export function roomId(value: unknown, field: string): string {
	const id = roomText(value, field);
	checkRoomData(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id), field);
	return id;
}

export function roomCount(value: unknown, field: string): number {
	checkRoomData(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, field);
	return value;
}

export function roomCommit(value: unknown, field: string): string {
	const commit = roomText(value, field);
	checkRoomData(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit), field);
	return commit;
}

export function roomLocalFile(value: unknown, field: string): URI {
	const uri = URI.parse(roomText(value, field), true);
	checkRoomData(uri.scheme === Schemas.file && !uri.authority && !uri.query && !uri.fragment && uri.path.startsWith('/'), field);
	checkRoomData(sameRoomFile(uri.fsPath, resolve(uri.fsPath)), field);
	return uri;
}

export function sameRoomFile(left: string, right: string): boolean {
	return extUriBiasedIgnorePathCase.isEqual(URI.file(left), URI.file(right));
}

export function hasRoomFileErrorCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === 'object' && !Array.isArray(error) && roomObject(error, 'file error').code === code;
}

export async function roomFileStat(path: string) {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if (hasRoomFileErrorCode(error, 'ENOENT')) {
			return undefined;
		}
		throw error;
	}
}

export async function removeRoomTemporaryFile(path: string): Promise<void> {
	try {
		await fs.unlink(path);
	} catch (error) {
		if (!hasRoomFileErrorCode(error, 'ENOENT')) {
			throw error;
		}
	}
}

/** Files below one host-owned namespace; no caller-provided URI grants read access. */
export class RoomFiles {
	constructor(readonly root: string, private readonly parent?: RoomFiles) { }

	path(...segments: string[]): string {
		return join(this.root, ...segments);
	}

	async directory(...segments: string[]): Promise<string> {
		await this.parent?.directory();
		const created = await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		checkRoomData((await fs.lstat(this.root)).isDirectory(), 'storage root is not a real directory');
		if (created) {
			let parent = this.root;
			do {
				parent = dirname(parent);
				await this.syncDirectory(parent);
			} while (!sameRoomFile(parent, dirname(created)));
		}
		let path = this.root;
		for (const segment of segments) {
			roomId(segment, 'storage directory');
			path = join(path, segment);
			if (!await roomFileStat(path)) {
				try {
					await fs.mkdir(path, { mode: 0o700 });
					await this.syncDirectory(dirname(path));
				} catch (error) {
					if (!hasRoomFileErrorCode(error, 'EEXIST')) {
						throw error;
					}
				}
			}
			checkRoomData((await fs.lstat(path)).isDirectory(), 'storage directory is not a real directory');
		}
		return path;
	}

	async hasDirectory(...segments: string[]): Promise<boolean> {
		if (this.parent && !await this.parent.hasDirectory()) {
			return false;
		}
		let path = this.root;
		for (const segment of ['', ...segments]) {
			path = join(path, segment);
			const stat = await roomFileStat(path);
			if (!stat) {
				return false;
			}
			checkRoomData(stat.isDirectory(), 'storage directory is not a real directory');
		}
		return true;
	}

	async read(path: string): Promise<string> {
		const entry = await fs.lstat(path);
		checkRoomData(entry.isFile() && !entry.isSymbolicLink(), 'stored record is not a regular file');
		const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			checkRoomData((await file.stat()).isFile(), 'stored record is not a regular file');
			return await file.readFile('utf8');
		} finally {
			await file.close();
		}
	}

	async write(path: string, contents: string, exclusive = false): Promise<void> {
		const previous = await roomFileStat(path);
		checkRoomData(!previous || previous.isFile() && !previous.isSymbolicLink(), 'stored record is not a regular file');
		const temporary = join(dirname(path), `.${generateUuid()}.tmp`);
		const file = await fs.open(temporary, 'wx', 0o600);
		try {
			try {
				await file.writeFile(contents, 'utf8');
				if (exclusive) {
					await file.chmod(0o400);
				}
				await file.sync();
			} finally {
				await file.close();
			}
			if (exclusive) {
				await fs.link(temporary, path);
			} else {
				await fs.rename(temporary, path);
			}
		} finally {
			await removeRoomTemporaryFile(temporary);
		}
		await this.syncDirectory(dirname(path));
	}

	private async syncDirectory(path: string): Promise<void> {
		if (!isWindows) {
			const directory = await fs.open(path, 'r');
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	}
}
