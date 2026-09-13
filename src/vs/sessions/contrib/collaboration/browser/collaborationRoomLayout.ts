/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { localize } from '../../../../nls.js';
import { ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';

/**
 * The room's main surface is the conversation alone. Its settings are published to
 * the Agents window side panel, beside Changes and Files, rather than drawn as a
 * second panel inside the room.
 */
export class CollaborationRoomLayout extends Disposable {
	readonly element = $('.room-layout');
	readonly main = $('.room-main');
	/** Carries `collaboration-room` so the room's styles still reach it once the side panel adopts it. */
	readonly panel = $('aside.collaboration-room.room-side-panel');
	/** Fixed strip above the scrolling body; the tab bar lives here. */
	readonly panelHeader = $('.room-panel-header-bar');
	readonly panelContent = $('.room-panel-content');
	private readonly panelBody = $('.room-panel-body');
	private readonly scrollable: DomScrollableElement;

	constructor(
		parent: HTMLElement,
		private readonly onLayout: () => void,
		@ICollaborationRoomViewService views: ICollaborationRoomViewService,
	) {
		super();
		parent.appendChild(this.element);
		this.main.setAttribute('role', 'region');
		this.main.setAttribute('aria-label', localize('room.conversationPane', "Room conversation"));
		this.main.tabIndex = -1;
		this.element.appendChild(this.main);

		this.panel.setAttribute('aria-label', localize('room.settingsPane', "Room settings"));
		this.panel.tabIndex = -1;
		this.panelBody.appendChild(this.panelContent);
		this.scrollable = this._register(new DomScrollableElement(this.panelBody, {
			vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden, useShadows: false,
		}));
		this.scrollable.getDomNode().classList.add('room-panel-scrollable');
		this.panel.append(this.panelHeader, this.scrollable.getDomNode());
		this._register(views.publishPanelContent(this.panel));
		const observer = new (getWindow(parent).ResizeObserver)(() => this.scrollable.scanDomNode());
		observer.observe(this.panel);
		this._register({ dispose: () => observer.disconnect() });
		this._register(addDisposableListener(this.panel, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				this.main.focus();
			}
		}));
	}

	/** True while the workbench side panel is showing the room's settings. */
	get panelVisible(): boolean {
		return this.panel.isConnected;
	}

	focusPanel(): void {
		this.panel.focus();
	}

	layout(width: number, height: number): void {
		this.element.style.width = `${Math.max(0, width)}px`;
		this.element.style.height = `${Math.max(0, height)}px`;
		this.main.style.width = `${Math.max(0, width)}px`;
		this.main.style.height = `${Math.max(0, height)}px`;
		this.onLayout();
	}

	/** Sizes the settings panel to whatever room the side panel gives it. */
	layoutPanel(width: number, height: number): void {
		this.panel.style.width = `${width}px`;
		this.panel.style.height = `${height}px`;
		const body = Math.max(0, height - this.panelHeader.clientHeight);
		this.scrollable.getDomNode().style.width = `${width}px`;
		this.scrollable.getDomNode().style.height = `${body}px`;
		this.panelBody.style.width = `${width}px`;
		this.scrollable.scanDomNode();
	}
}
