/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AbstractChatView } from '../../../browser/parts/chatView.js';
import { isAgentHostProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

export class CollaborationCoordinatorSessionNotReadyError extends Error { }

/**
 * Hosts the coordinator's real Sessions chat inside the room instead of
 * recreating chat rendering or input behavior.
 */
export class CollaborationCoordinatorView extends Disposable {
	readonly element = $('.room-coordinator-chat');
	private readonly chatView = this._register(new MutableDisposable<AbstractChatView>());
	private readonly load = this._register(new MutableDisposable<CancellationTokenSource>());
	private current: string | undefined;
	private width = 0;
	private height = 0;

	constructor(
		@IChatViewFactory private readonly chatViewFactory: IChatViewFactory,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
	) {
		super();
	}

	async setCoordinator(sessionUri: string, chatUri: string | undefined, title: string, createdAt: number, worktreeUri: string): Promise<void> {
		const key = `${sessionUri}\n${chatUri ?? ''}`;
		if (this.current === key && this.chatView.value) {
			return;
		}
		if (this.current !== key) {
			this.chatView.clear();
			this.element.replaceChildren();
		}
		this.current = key;
		const cancellation = new CancellationTokenSource();
		this.load.value?.cancel();
		this.load.value = cancellation;
		const provider = this.sessionsProvidersService.getProvider(LOCAL_AGENT_HOST_PROVIDER_ID);
		const target = provider && isAgentHostProvider(provider)
			? await provider.resolveSessionChat(URI.parse(sessionUri), chatUri ? URI.parse(chatUri) : undefined, cancellation.token, {
				title,
				createdAt,
				worktreeUri: URI.parse(worktreeUri),
			})
			: undefined;
		if (cancellation.token.isCancellationRequested || this._store.isDisposed || this.current !== key) {
			throw new CancellationError();
		}
		if (!target) {
			throw new CollaborationCoordinatorSessionNotReadyError(localize('room.coordinatorSessionNotReady', "The coordinator session is not available yet."));
		}
		const view = this.chatViewFactory.createChatView();
		view.setPrimary(true);
		view.setActive(true);
		view.setVisible(true);
		view.setChat(target.chat, target.session.sessionId, target.session);
		view.layout(this.width, this.height, 0, 0);
		this.element.replaceChildren(view.element);
		this.chatView.value = view;
	}

	clear(): void {
		this.current = undefined;
		this.load.value?.cancel();
		this.load.clear();
		this.chatView.clear();
		this.element.replaceChildren();
	}

	setVisible(visible: boolean): void {
		this.chatView.value?.setVisible(visible);
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.chatView.value?.layout(width, height, 0, 0);
	}

	focus(): void {
		this.chatView.value?.focus();
	}
}
