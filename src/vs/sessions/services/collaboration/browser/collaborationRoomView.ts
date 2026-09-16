/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, derived, observableValue } from '../../../../base/common/observable.js';
import { isStringArray } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICustomViewService } from '../../customView/browser/customViewService.js';
import { ModelSelection } from '../../../../platform/agentHost/common/state/sessionState.js';
import { COLLABORATION_CUSTOM_VIEW_ID } from '../common/collaboration.js';

export { COLLABORATION_CUSTOM_VIEW_ID } from '../common/collaboration.js';

const hiddenMessagesStorageKey = 'collaboration.hiddenMessages';

/** The room is a primary conversation surface, not a session-grid slot. */
export interface ICollaborationRoomView extends IDisposable {
	/** Size the settings panel to the side panel hosting it. */
	layoutPanel(width: number, height: number): void;
	focus(): void;
	captureFocus(): () => void;
	getAccessibleContent(): string;
}

export interface ICollaborationRoomScrollState {
	readonly roomId: string;
	readonly scrollTop: number;
	readonly followingLatest: boolean;
	readonly anchorMessageId?: string;
	readonly anchorOffset?: number;
	readonly inboxMemberId?: string;
}

export interface ICollaborationRoomCreationDraft {
	readonly title: string;
	readonly goal: string;
	readonly instructions: string;
	readonly repositoryUri: string | undefined;
	readonly baseRevision: string;
	readonly workerCount: string;
	readonly model: string;
	readonly memberNames?: readonly string[];
	readonly memberModels?: readonly (ModelSelection | undefined)[];
}

export const ICollaborationRoomViewService = createDecorator<ICollaborationRoomViewService>('collaborationRoomViewService');

export interface ICollaborationRoomViewService {
	readonly _serviceBrand: undefined;
	readonly visible: IObservable<boolean>;
	readonly activeView: IObservable<ICollaborationRoomView | undefined>;
	readonly scrollState: IObservable<ICollaborationRoomScrollState | undefined>;
	readonly creationDraft: IObservable<ICollaborationRoomCreationDraft | undefined>;
	/** Profile-local visibility markers; the authoritative room journal is unchanged. */
	readonly hiddenMessages: IObservable<ReadonlyMap<string, ReadonlySet<string>>>;
	/** The room's settings DOM, published so the Agents window side panel can host it. */
	readonly panelContent: IObservable<HTMLElement | undefined>;
	registerView(view: ICollaborationRoomView): IDisposable;
	publishPanelContent(content: HTMLElement | undefined): IDisposable;
	saveScrollState(state: ICollaborationRoomScrollState): void;
	saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void;
	hideMessage(roomId: string, messageId: string): void;
	restoreHiddenMessages(roomId: string): void;
	open(): void;
	close(): void;
}

export class CollaborationRoomViewService extends Disposable implements ICollaborationRoomViewService {
	declare readonly _serviceBrand: undefined;

	private readonly view = observableValue<ICollaborationRoomView | undefined>(this, undefined);
	readonly visible = derived(reader => this.customViewService.activeCustomView.read(reader)?.id === COLLABORATION_CUSTOM_VIEW_ID);
	readonly activeView = derived(reader => this.visible.read(reader) ? this.view.read(reader) : undefined);
	readonly scrollState = observableValue<ICollaborationRoomScrollState | undefined>(this, undefined);
	readonly creationDraft = observableValue<ICollaborationRoomCreationDraft | undefined>(this, undefined);
	readonly hiddenMessages = observableValue<ReadonlyMap<string, ReadonlySet<string>>>(this, new Map());
	readonly panelContent = observableValue<HTMLElement | undefined>(this, undefined);

	constructor(
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.hiddenMessages.set(this.readHiddenMessages(), undefined);
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, hiddenMessagesStorageKey, this._store)(() => {
			this.hiddenMessages.set(this.readHiddenMessages(), undefined);
		}));
	}

	hideMessage(roomId: string, messageId: string): void {
		if (!roomId || !messageId) {
			throw new Error(localize('room.hideMissingIdentity', "A room and message are required to hide a message."));
		}
		const hidden = this.hiddenMessages.get();
		if (hidden.get(roomId)?.has(messageId)) {
			return;
		}
		const updated = new Map(hidden);
		updated.set(roomId, new Set([...hidden.get(roomId) ?? [], messageId]));
		this.writeHiddenMessages(updated);
	}

	restoreHiddenMessages(roomId: string): void {
		const updated = new Map(this.hiddenMessages.get());
		if (updated.delete(roomId)) {
			this.writeHiddenMessages(updated);
		}
	}

	private writeHiddenMessages(hidden: ReadonlyMap<string, ReadonlySet<string>>): void {
		if (hidden.size) {
			this.storageService.store(hiddenMessagesStorageKey, JSON.stringify([...hidden].map(([roomId, messageIds]) => [roomId, [...messageIds]])), StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(hiddenMessagesStorageKey, StorageScope.PROFILE);
		}
	}

	private readHiddenMessages(): ReadonlyMap<string, ReadonlySet<string>> {
		const stored = this.storageService.get(hiddenMessagesStorageKey, StorageScope.PROFILE);
		const hidden = new Map<string, ReadonlySet<string>>();
		if (!stored) {
			return hidden;
		}
		try {
			const entries: unknown = JSON.parse(stored);
			if (!Array.isArray(entries)) {
				throw new Error('Expected a list of room visibility markers');
			}
			for (const entry of entries) {
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0]
					|| !isStringArray(entry[1]) || entry[1].some(id => !id) || hidden.has(entry[0])) {
					throw new Error('Invalid room visibility marker');
				}
				hidden.set(entry[0], new Set(entry[1]));
			}
			return hidden;
		} catch (error) {
			this.logService.warn('[CollaborationRoomView] Unable to restore hidden messages; showing the complete history', error);
			return new Map();
		}
	}

	registerView(view: ICollaborationRoomView): IDisposable {
		this.view.set(view, undefined);
		return toDisposable(() => {
			if (this.view.get() === view) {
				this.view.set(undefined, undefined);
			}
		});
	}

	publishPanelContent(content: HTMLElement | undefined): IDisposable {
		this.panelContent.set(content, undefined);
		return toDisposable(() => {
			if (this.panelContent.get() === content) {
				this.panelContent.set(undefined, undefined);
			}
		});
	}

	saveScrollState(state: ICollaborationRoomScrollState): void {
		this.scrollState.set(state, undefined);
	}

	saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void {
		this.creationDraft.set(draft, undefined);
	}

	open(): void {
		this.customViewService.showCustomView(COLLABORATION_CUSTOM_VIEW_ID);
		this.activeView.get()?.focus();
	}

	close(): void {
		if (this.visible.get()) {
			this.customViewService.hideCustomView();
		}
	}
}

registerSingleton(ICollaborationRoomViewService, CollaborationRoomViewService, InstantiationType.Delayed);
