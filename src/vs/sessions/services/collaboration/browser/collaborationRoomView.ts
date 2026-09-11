/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, derived, observableValue } from '../../../../base/common/observable.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICustomViewService } from '../../customView/browser/customViewService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ModelSelection } from '../../../../platform/agentHost/common/state/sessionState.js';
import { COLLABORATION_CUSTOM_VIEW_ID } from '../common/collaboration.js';

export { COLLABORATION_CUSTOM_VIEW_ID } from '../common/collaboration.js';

/** The room is a primary conversation surface, not a session-grid slot. */
export interface ICollaborationRoomView extends IDisposable {
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
}

export interface ICollaborationRoomPanelState {
	readonly visible: boolean;
	readonly width: number;
}

export interface ICollaborationRoomCreationDraft {
	readonly title: string;
	readonly goal: string;
	readonly instructions: string;
	readonly repositoryUri: string | undefined;
	readonly baseRevision: string;
	readonly workerCount: string;
	readonly model: string;
	readonly memberModels?: readonly (ModelSelection | undefined)[];
}

export const ICollaborationRoomViewService = createDecorator<ICollaborationRoomViewService>('collaborationRoomViewService');

export interface ICollaborationRoomViewService {
	readonly _serviceBrand: undefined;
	readonly visible: IObservable<boolean>;
	readonly activeView: IObservable<ICollaborationRoomView | undefined>;
	readonly scrollState: IObservable<ICollaborationRoomScrollState | undefined>;
	readonly creationDraft: IObservable<ICollaborationRoomCreationDraft | undefined>;
	readonly panelState: IObservable<ICollaborationRoomPanelState>;
	registerView(view: ICollaborationRoomView): IDisposable;
	saveScrollState(state: ICollaborationRoomScrollState): void;
	saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void;
	savePanelState(state: ICollaborationRoomPanelState): void;
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
	readonly panelState;

	constructor(
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		const width = storageService.getNumber('collaboration.roomPanel.width', StorageScope.PROFILE, 360);
		this.panelState = observableValue<ICollaborationRoomPanelState>(this, {
			visible: storageService.getBoolean('collaboration.roomPanel.visible', StorageScope.PROFILE, true),
			width: Number.isFinite(width) ? Math.max(300, Math.min(520, width)) : 360,
		});
	}

	registerView(view: ICollaborationRoomView): IDisposable {
		this.view.set(view, undefined);
		return toDisposable(() => {
			if (this.view.get() === view) {
				this.view.set(undefined, undefined);
			}
		});
	}

	saveScrollState(state: ICollaborationRoomScrollState): void {
		this.scrollState.set(state, undefined);
	}

	saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void {
		this.creationDraft.set(draft, undefined);
	}

	savePanelState(state: ICollaborationRoomPanelState): void {
		const width = Math.max(300, Math.min(520, state.width));
		this.panelState.set({ visible: state.visible, width }, undefined);
		this.storageService.store('collaboration.roomPanel.visible', state.visible, StorageScope.PROFILE, StorageTarget.USER);
		this.storageService.store('collaboration.roomPanel.width', width, StorageScope.PROFILE, StorageTarget.USER);
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
