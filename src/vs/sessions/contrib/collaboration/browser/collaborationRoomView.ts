/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constObservable } from '../../../../base/common/observable.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Menus } from '../../../browser/menus.js';
import { COLLABORATION_CUSTOM_VIEW_ID, ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { AbstractCustomView, ICustomViewDescriptor } from '../../../services/customView/browser/customView.js';
import { CollaborationRoomWidget } from './collaborationRoomWidget.js';

export class CollaborationRoomView extends AbstractCustomView {
	readonly title = constObservable(localize('room.surfaceTitle', "Agent Collab"));
	override readonly maxWidth = Number.POSITIVE_INFINITY;
	private widget: CollaborationRoomWidget | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICollaborationRoomViewService private readonly roomViewService: ICollaborationRoomViewService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('collaboration-view-content');
		this._register(toDisposable(() => container.classList.remove('collaboration-view-content')));
		this.widget = this._register(this.instantiationService.createInstance(CollaborationRoomWidget, container));
		this._register(this.roomViewService.registerView(this.widget));
	}

	layout(width: number, height: number): void {
		this.widget?.layout(width, height);
	}

	override focus(): void {
		this.widget?.focus();
	}
}

export const collaborationRoomViewDescriptor: ICustomViewDescriptor = {
	id: COLLABORATION_CUSTOM_VIEW_ID,
	ctor: new SyncDescriptor(CollaborationRoomView),
	actions: { style: 'toolbar', menuId: Menus.CustomViewCollaboration },
};
