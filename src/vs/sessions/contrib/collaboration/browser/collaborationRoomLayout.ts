/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType, getActiveElement, getWindow, isAncestor, isHTMLElement } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { LayoutPriority, Orientation, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { localize } from '../../../../nls.js';
import { ICollaborationRoomViewService } from '../../../services/collaboration/browser/collaborationRoomView.js';

/** Keeps room controls independent from the conversation's scroll position and lifetime. */
export class CollaborationRoomLayout extends Disposable {
	readonly element = $('.room-layout');
	readonly main = $('.room-main');
	readonly panel = $('aside.room-side-panel');
	readonly panelContent = $('.room-panel-content');
	private readonly panelHost = $('.room-panel-host');
	private readonly splitStore = this._register(new DisposableStore());
	private readonly scrollable: DomScrollableElement;
	private split: SplitView | undefined;
	private narrow: boolean | undefined;
	private drawerOpen = false;
	private width = 0;
	private height = 0;
	private updating = false;

	constructor(
		parent: HTMLElement,
		private readonly onLayout: () => void,
		private readonly onVisibility: (visible: boolean) => void,
		private readonly onDismiss: () => void,
		@ICollaborationRoomViewService private readonly views: ICollaborationRoomViewService,
	) {
		super();
		parent.appendChild(this.element);
		this.main.setAttribute('role', 'region');
		this.main.setAttribute('aria-label', localize('room.conversationPane', "Room conversation"));
		this.main.tabIndex = -1;
		this.panel.setAttribute('aria-label', localize('room.settingsPane', "Room settings"));
		this.panel.tabIndex = -1;
		this.panel.appendChild(this.panelContent);
		this.scrollable = this._register(new DomScrollableElement(this.panel, {
			vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden, useShadows: false,
		}));
		this.scrollable.getDomNode().classList.add('room-panel-scrollable');
		this.panelHost.appendChild(this.scrollable.getDomNode());
		const observer = new (getWindow(parent).ResizeObserver)(() => this.scrollable.scanDomNode());
		observer.observe(this.panelContent);
		this._register({ dispose: () => observer.disconnect() });
		this._register(addDisposableListener(this.panel, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && !event.defaultPrevented && this.narrow && this.drawerOpen) {
				event.preventDefault();
				event.stopPropagation();
				this.setPanelVisible(false);
				this.onDismiss();
			}
		}));
		this._register(autorun(reader => {
			views.panelState.read(reader);
			this.update();
		}));
	}

	get panelVisible(): boolean {
		return this.narrow ? this.drawerOpen : this.views.panelState.get().visible;
	}

	setPanelVisible(visible: boolean): void {
		this.drawerOpen = visible;
		if (!this.narrow) {
			this.views.savePanelState({ ...this.views.panelState.get(), visible });
		}
		this.update();
	}

	focusPanel(): void {
		this.setPanelVisible(true);
		this.panel.focus();
	}

	resizePanel(delta: number): number | undefined {
		if (!this.split?.isViewVisible(1)) {
			return undefined;
		}
		this.split.resizeView(1, this.split.getViewSize(1) + delta);
		const width = this.split.getViewSize(1);
		this.views.savePanelState({ visible: true, width });
		return width;
	}

	layout(width: number, height: number): void {
		this.width = Math.max(0, width);
		this.height = Math.max(0, height);
		const narrow = width < 900;
		const focused = getActiveElement();
		const restoreFocus = isHTMLElement(focused) && isAncestor(focused, this.element) ? focused : undefined;
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		if (this.narrow !== narrow) {
			this.splitStore.clear();
			this.split = undefined;
			this.narrow = narrow;
			this.element.replaceChildren();
			this.element.classList.toggle('room-layout-narrow', narrow);
			if (narrow) {
				this.element.append(this.main, this.panelHost);
			} else {
				this.split = this.splitStore.add(new SplitView(this.element, { orientation: Orientation.HORIZONTAL, proportionalLayout: false }));
				this.split.addView({
					element: this.main, minimumSize: 440, maximumSize: Number.POSITIVE_INFINITY,
					priority: LayoutPriority.High, onDidChange: Event.None,
					layout: size => {
						this.main.style.width = `${size}px`;
						this.main.style.height = `${this.height}px`;
						this.onLayout();
					},
				}, Math.max(440, width - this.views.panelState.get().width));
				this.split.addView({
					element: this.panelHost, minimumSize: 300, maximumSize: 520,
					priority: LayoutPriority.Low,
					onDidChange: Event.None,
					layout: size => this.layoutPanel(size),
				}, this.views.panelState.get().width);
				this.splitStore.add(this.split.onDidSashChange(() => {
					if (!this.updating && this.split?.isViewVisible(1)) {
						this.views.savePanelState({ visible: true, width: this.split.getViewSize(1) });
					}
				}));
			}
		}
		this.update();
		if (restoreFocus?.isConnected && getActiveElement() !== restoreFocus) {
			if (this.panelVisible || !isAncestor(restoreFocus, this.panel)) {
				restoreFocus.focus();
			} else {
				this.onDismiss();
			}
		}
	}

	private layoutPanel(width: number): void {
		this.panelHost.style.width = `${width}px`;
		this.panelHost.style.height = `${this.height}px`;
		this.scrollable.getDomNode().style.width = `${width}px`;
		this.scrollable.getDomNode().style.height = `${this.height}px`;
		this.panel.style.width = `${width}px`;
		this.panel.style.height = `${this.height}px`;
		this.scrollable.scanDomNode();
	}

	private update(): void {
		if (this.narrow === undefined || this.updating) {
			return;
		}
		this.updating = true;
		try {
			const visible = this.panelVisible;
			const focused = getActiveElement();
			if (!visible && isHTMLElement(focused) && isAncestor(focused, this.panel)) {
				this.main.focus();
			}
			if (this.split) {
				this.split.setViewVisible(1, visible);
				this.split.layout(this.width);
				if (visible) {
					this.split.resizeView(1, this.views.panelState.get().width);
				}
			} else {
				this.main.style.width = `${this.width}px`;
				this.main.style.height = `${this.height}px`;
				this.main.inert = visible;
				this.panelHost.hidden = !visible;
				this.layoutPanel(Math.min(this.width, this.views.panelState.get().width));
				this.onLayout();
			}
			if (!this.narrow) {
				this.main.inert = false;
				this.panelHost.hidden = false;
			}
			this.onVisibility(visible);
		} finally {
			this.updating = false;
		}
	}
}
