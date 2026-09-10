/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Menus } from '../../../browser/menus.js';
import { COLLABORATION_CUSTOM_VIEW_ID, ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';
import { AbstractCustomView, ICustomViewDescriptor } from '../../../services/customView/browser/customView.js';
import { CollaborationRoomWidget } from './collaborationRoomWidget.js';

export class CollaborationRoomView extends AbstractCustomView {
	readonly title = constObservable(localize('room.surfaceTitle', "Agent Collab"));
	private widget: CollaborationRoomWidget | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICollaborationRoomViewService private readonly roomViewService: ICollaborationRoomViewService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this.widget = this._register(this.instantiationService.createInstance(CollaborationRoomWidget, container));
		this._register(this.roomViewService.registerView(this.widget));
	}

	layout(_width: number, height: number): void {
		if (this.widget) {
			this.widget.element.style.height = `${height}px`;
			this.widget.restoreScrollPosition();
		}
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
