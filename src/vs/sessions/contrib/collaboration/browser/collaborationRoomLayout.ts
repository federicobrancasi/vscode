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

	/**
	 * The conversation fills the room through CSS. Writing pixel sizes here would
	 * fight the flex column it sits in, leaving the composer taller than its parent
	 * and clipped at the bottom.
	 */
	layout(_width: number, _height: number): void {
		this.onLayout();
	}

	/**
	 * The panel fills whatever the side panel gives it through CSS, so only the
	 * scrollbar needs telling. Measuring here instead would go stale whenever the
	 * pane resizes without re-laying out its adopted content.
	 */
	layoutPanel(_width: number, _height: number): void {
		this.scrollable.scanDomNode();
	}
}
