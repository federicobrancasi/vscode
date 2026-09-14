/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, derived, observableValue } from '../../../../base/common/observable.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICustomViewService } from '../../customView/browser/customViewService.js';
import { ModelSelection } from '../../../../platform/agentHost/common/state/sessionState.js';
import { COLLABORATION_CUSTOM_VIEW_ID } from '../common/collaboration.js';

export { COLLABORATION_CUSTOM_VIEW_ID } from '../common/collaboration.js';

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
	/** The room's settings DOM, published so the Agents window side panel can host it. */
	readonly panelContent: IObservable<HTMLElement | undefined>;
	registerView(view: ICollaborationRoomView): IDisposable;
	publishPanelContent(content: HTMLElement | undefined): IDisposable;
	saveScrollState(state: ICollaborationRoomScrollState): void;
	saveCreationDraft(draft: ICollaborationRoomCreationDraft | undefined): void;
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
	readonly panelContent = observableValue<HTMLElement | undefined>(this, undefined);

	constructor(
		@ICustomViewService private readonly customViewService: ICustomViewService,
	) {
		super();
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
