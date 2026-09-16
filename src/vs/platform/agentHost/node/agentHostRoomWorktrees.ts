/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { SequencerByKey } from '../../../base/common/async.js';
import { deepFreeze, equals } from '../../../base/common/objects.js';
import { isAbsolute, join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostRoom, IAgentHostRoomArtifact, IAgentHostRoomMember } from '../common/agentHostRooms.js';
import { IRoomSessionParticipant, RoomContentValidator } from './agentHostRoomsTypes.js';
import { checkRoomData, hasRoomFileErrorCode, removeRoomTemporaryFile, roomCommit, RoomFiles, roomFileStat, roomId, roomLocalFile, roomText, sameRoomFile } from './agentHostRoomStorageUtils.js';

/** Git worktrees and immutable patches, independent from mailbox scheduling. */
export class AgentHostRoomWorktrees {
	private readonly queue = new SequencerByKey<string>();

	constructor(private readonly files: RoomFiles, private readonly logService: ILogService) { }

	async isRepository(folderUri: string): Promise<boolean> {
		const requested = roomLocalFile(folderUri, 'folderUri');
		const result = await this.git(requested.fsPath, ['rev-parse', '--show-toplevel'], undefined, undefined, true);
		if (!result) {
			return false;
		}
		return !!await this.git(result.trim(), ['rev-parse', '--verify', 'HEAD^{commit}'], undefined, undefined, true);
	}

	async resolveRepository(repositoryUri: string, revision = 'HEAD', initialize = false): Promise<{ repositoryUri: string; baseRevision: string }> {
		const requested = roomLocalFile(repositoryUri, 'folderUri');
		roomText(revision, 'revision');
		checkRoomData(!revision.startsWith('-'), 'invalid revision');
		if (initialize && !await this.isRepository(repositoryUri)) {
			await this.initialize(requested.fsPath);
		}
		const root = (await this.git(requested.fsPath, ['rev-parse', '--show-toplevel'])).trim();
		const repository = await fs.realpath(root);
		const baseRevision = (await this.git(repository, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
		return { repositoryUri: URI.file(repository).toString(), baseRevision: roomCommit(baseRevision, 'baseRevision') };
	}

	private async initialize(path: string): Promise<void> {
		const stat = await roomFileStat(path);
		checkRoomData(stat?.isDirectory(), 'folder does not exist');
		if (!await this.git(path, ['rev-parse', '--show-toplevel'], undefined, undefined, true)) {
			await this.git(path, ['init', '--quiet']);
		}
		const root = (await this.git(path, ['rev-parse', '--show-toplevel'])).trim();
		await this.git(root, ['add', '--all', '--', '.']);
		await this.git(root, ['-c', 'user.name=Agent Collab', '-c', 'user.email=agent-collab@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Baseline for Agent Collab']);
		this.logService.info('[AgentHostRooms] Initialized an explicitly authorized repository', root);
	}

	worktreeUri(room: string, member: string): string {
		return URI.file(this.files.path('worktrees', roomId(room, 'roomId'), roomId(member, 'memberId'))).toString();
	}

	ensureWorktree(room: IAgentHostRoom, member: IRoomSessionParticipant, requireExisting = false): Promise<void> {
		return this.queue.queue(room.id, () => this.prepare(room, member, requireExisting));
	}

	private async prepare(room: IAgentHostRoom, member: IRoomSessionParticipant, requireExisting: boolean): Promise<void> {
		checkRoomData(!room.archived, 'archived worktrees are read-only');
		const recorded = room.members.find(value => value.id === member.id && !value.removed);
		checkRoomData(recorded?.sessionUri === member.sessionUri && recorded.worktreeUri === member.worktreeUri, 'worktree participant is not in room');
		const worktree = roomLocalFile(this.worktreeUri(room.id, member.id), 'worktreeUri').fsPath;
		checkRoomData(!!member.worktreeUri && sameRoomFile(roomLocalFile(member.worktreeUri, 'member.worktreeUri').fsPath, worktree), 'member worktree identity');
		const repository = await this.resolveRepository(room.repositoryUri, room.baseRevision);
		checkRoomData(repository.baseRevision === room.baseRevision, 'room revision is not pinned');
		const original = roomLocalFile(repository.repositoryUri, 'repositoryUri').fsPath;
		checkRoomData(!sameRoomFile(original, worktree), 'worktree must be isolated from the original repository');
		await this.files.directory('worktrees', room.id);
		const existing = await roomFileStat(worktree);
		if (existing) {
			checkRoomData(existing.isDirectory() && !existing.isSymbolicLink(), 'worktree is not a real directory');
		} else {
			checkRoomData(!requireExisting, 'preserved worktree is missing; restore it before retrying');
			await this.git(original, ['worktree', 'add', '--detach', '--', worktree, room.baseRevision]);
		}
		const toplevel = (await this.git(worktree, ['rev-parse', '--show-toplevel'])).trim();
		checkRoomData(sameRoomFile(await fs.realpath(toplevel), await fs.realpath(worktree)), 'worktree is not the git toplevel');
		const originalCommon = (await this.git(original, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		const worktreeCommon = (await this.git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		checkRoomData(sameRoomFile(await fs.realpath(originalCommon), await fs.realpath(worktreeCommon)), 'worktree belongs to a different repository');
		await this.git(worktree, ['merge-base', '--is-ancestor', room.baseRevision, 'HEAD']);
	}

	publishPatch(room: IAgentHostRoom, member: IAgentHostRoomMember, title: string, validateContent?: RoomContentValidator): Promise<IAgentHostRoomArtifact> {
		return this.queue.queue(room.id, async () => {
			roomText(title, 'artifact.title');
			await this.prepare(room, member, true);
			const cwd = roomLocalFile(this.worktreeUri(room.id, member.id), 'worktreeUri').fsPath;
			const sourceRevision = roomCommit((await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(), 'sourceRevision');
			await this.git(cwd, ['merge-base', '--is-ancestor', room.baseRevision, sourceRevision]);
			checkRoomData((await this.git(cwd, ['ls-files', '--unmerged', '-z'])).length === 0, 'worktree has unresolved conflicts');
			if (validateContent) {
				const changed = await this.git(cwd, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', room.baseRevision, '--']);
				const untracked = await this.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
				await validateContent([...new Set((changed + untracked).split('\0').filter(path => path.length > 0))]);
			}
			const index = join(await this.files.directory('indexes'), `${generateUuid()}.index`);
			const env = { GIT_INDEX_FILE: index };
			let patch: string;
			try {
				const entries = await this.git(cwd, ['ls-files', '--stage', '--full-name', '-z']);
				await this.git(cwd, ['read-tree', '--empty'], env);
				await this.git(cwd, ['update-index', '-z', '--index-info'], env, entries);
				await this.git(cwd, ['add', '--all', '--', '.'], env);
				if (validateContent) {
					const paths = await this.git(cwd, ['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', room.baseRevision, '--'], env);
					await validateContent(paths.split('\0').filter(path => path.length > 0));
				}
				patch = await this.git(cwd, ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', room.baseRevision, '--'], env);
				checkRoomData((await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() === sourceRevision, 'member HEAD changed during patch publication');
			} finally {
				await removeRoomTemporaryFile(index);
				await removeRoomTemporaryFile(`${index}.lock`);
			}
			const id = generateUuid();
			const directory = await this.files.directory('artifacts', room.id);
			const uri = URI.file(join(directory, `${id}.patch`)).toString();
			await this.files.write(roomLocalFile(uri, 'artifact.uri').fsPath, patch, true);
			return deepFreeze({ id, memberId: member.id, title, createdAt: Date.now(), baseRevision: room.baseRevision, sourceRevision, uri });
		});
	}

	async readArtifact(room: IAgentHostRoom, artifact: IAgentHostRoomArtifact, validateContent?: RoomContentValidator, files = this.files): Promise<string> {
		roomId(room.id, 'roomId');
		roomId(artifact.id, 'artifact.id');
		checkRoomData(equals(room.artifacts.find(value => value.id === artifact.id), artifact), 'artifact is not a published room artifact');
		const path = files.path('artifacts', room.id, `${artifact.id}.patch`);
		checkRoomData(sameRoomFile(roomLocalFile(artifact.uri, 'artifact.uri').fsPath, path), 'artifact file identity');
		await files.hasDirectory('artifacts', room.id);
		const contents = await files.read(path);
		if (validateContent && contents.length) {
			const numstat = await this.git(roomLocalFile(room.repositoryUri, 'repositoryUri').fsPath, ['apply', '--numstat', '-z', '--'], undefined, contents);
			const paths = numstat.split('\0').filter(entry => entry.length > 0).map(entry => {
				const match = /^(?:\d+|-)\t(?:\d+|-)\t(?<path>[\s\S]+)$/.exec(entry);
				const relativePath = match?.groups?.path;
				checkRoomData(typeof relativePath === 'string' && !isAbsolute(relativePath) && !relativePath.split(/[\\/]/).includes('..'), 'artifact path is not repository-relative');
				return relativePath;
			});
			await validateContent(paths);
		}
		return contents;
	}

	private async git(cwd: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv, input?: string, probe = false): Promise<string> {
		const temporaryDirectory = await this.files.directory('git');
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.toUpperCase().startsWith('GIT_')) {
				env[key] = value;
			}
		}
		Object.assign(env, {
			GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
			LC_ALL: 'C',
			TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory,
		}, extraEnv);
		return new Promise((resolve, reject) => {
			const child = execFile('git', [
				'--no-pager',
				'-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false',
				...args.includes('commit') ? [] : ['-c', `core.hooksPath=${join(temporaryDirectory, 'no-hooks')}`],
				...args,
			], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
				if (error) {
					if (probe && /not a git repository|Needed a single revision|unknown revision|bad revision/i.test(stderr)) {
						resolve('');
					} else {
						reject(new Error(localize('rooms.gitFailed', "Room Git operation failed: {0}", stderr.trim() || error.message)));
					}
				} else {
					resolve(stdout);
				}
			});
			child.stdin?.on('error', error => {
				if (!hasRoomFileErrorCode(error, 'EPIPE')) {
					reject(error);
				}
			});
			child.stdin?.end(input);
		});
	}
}
