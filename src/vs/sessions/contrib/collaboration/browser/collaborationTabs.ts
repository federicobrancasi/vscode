/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';

export interface ICollaborationTab {
	readonly id: string;
	readonly label: string;
	/** Rendered next to the label when the tab needs the human's attention. */
	readonly badge?: number;
	readonly accent?: string;
}

/**
 * A tab strip for the room panel, following the Agents window composite bar:
 * a real tablist with roving focus, so the room does not invent its own
 * keyboard model.
 */
export class CollaborationTabs extends Disposable {
	readonly element: HTMLElement;
	private readonly tabStore = this._register(new DisposableStore());
	private readonly buttons = new Map<string, HTMLElement>();
	private readonly panels = new Map<string, HTMLElement>();
	private tabs: readonly ICollaborationTab[] = [];
	private active: string | undefined;

	constructor(parent: HTMLElement, private readonly onDidChangeTab: (id: string) => void) {
		super();
		this.element = parent.appendChild($('.room-tabs'));
		this.element.setAttribute('role', 'tablist');
		this.element.setAttribute('aria-label', localize('room.tabsLabel', "Room panels"));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, event => this.onKeyDown(event)));
	}

	/** Register the content element a tab reveals. Panels are kept alive while hidden. */
	registerPanel(id: string, panel: HTMLElement): void {
		panel.setAttribute('role', 'tabpanel');
		this.panels.set(id, panel);
		this.applySelection();
	}

	setTabs(tabs: readonly ICollaborationTab[]): void {
		const unchanged = tabs.length === this.tabs.length
			&& tabs.every((tab, index) => tab.id === this.tabs[index].id && tab.label === this.tabs[index].label
				&& tab.badge === this.tabs[index].badge && tab.accent === this.tabs[index].accent);
		this.tabs = tabs;
		if (!unchanged) {
			this.render();
		}
		if (!this.active || !tabs.some(tab => tab.id === this.active)) {
			this.select(tabs[0]?.id);
		} else {
			this.applySelection();
		}
	}

	select(id: string | undefined): void {
		if (id === this.active) {
			return;
		}
		this.active = id;
		this.applySelection();
		if (id) {
			this.onDidChangeTab(id);
		}
	}

	get activeTab(): string | undefined {
		return this.active;
	}

	focusActive(): void {
		(this.active ? this.buttons.get(this.active) : undefined)?.focus();
	}

	private render(): void {
		this.tabStore.clear();
		this.buttons.clear();
		this.element.textContent = '';
		for (const tab of this.tabs) {
			const button = this.element.appendChild($('button.room-tab')) as HTMLButtonElement;
			button.id = `room-tab-${generateUuid()}`;
			button.setAttribute('role', 'tab');
			button.type = 'button';
			button.appendChild($('span.room-tab-label')).textContent = tab.label;

			if (tab.badge) {
				button.appendChild($('span.room-tab-badge')).textContent = String(tab.badge);
				button.setAttribute('aria-label', localize('room.tabWithBadge', "{0}, {1} need attention", tab.label, tab.badge));
			}
			this.tabStore.add(addDisposableListener(button, EventType.CLICK, () => this.select(tab.id)));
			this.buttons.set(tab.id, button);
		}
		this.applySelection();
	}

	private applySelection(): void {
		for (const [id, button] of this.buttons) {
			const selected = id === this.active;
			// The author accent identifies the agent, but only the active tab wears it.
			const accent = this.tabs.find(tab => tab.id === id)?.accent;
			button.style.color = selected && accent ? accent : '';
			button.setAttribute('aria-selected', String(selected));
			button.tabIndex = selected ? 0 : -1;
			button.classList.toggle('active', selected);
			const panel = this.panels.get(id);
			if (panel) {
				panel.hidden = !selected;
				button.setAttribute('aria-controls', panel.id || (panel.id = `room-tabpanel-${generateUuid()}`));
				panel.setAttribute('aria-labelledby', button.id);
			}
		}
		for (const [id, panel] of this.panels) {
			if (!this.buttons.has(id)) {
				panel.hidden = true;
			}
		}
	}

	private onKeyDown(event: KeyboardEvent): void {
		const order = this.tabs.map(tab => tab.id);
		const current = this.active ? order.indexOf(this.active) : -1;
		let next: number | undefined;
		switch (event.key) {
			case 'ArrowLeft': next = current <= 0 ? order.length - 1 : current - 1; break;
			case 'ArrowRight': next = current < 0 || current === order.length - 1 ? 0 : current + 1; break;
			case 'Home': next = 0; break;
			case 'End': next = order.length - 1; break;
			default: return;
		}
		if (next !== undefined && order[next]) {
			event.preventDefault();
			event.stopPropagation();
			this.select(order[next]);
			this.focusActive();
		}
	}
}
