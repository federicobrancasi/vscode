/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived, IObservable, observableValue, transaction } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IAgentHostRoomCoordinator, IAgentHostRoomMember } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { ModelSelection, SessionModelInfo } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentHostLanguageModelProvider } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostLanguageModelProvider.js';
import { SessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ModelPickerActionItem } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import { nullExtensionDescription } from '../../../../workbench/services/extensions/common/extensions.js';

/** A label only: unavailable and provider-default selections never enter the selectable catalog. */
function modelLabelPlaceholder(selection?: ModelSelection): ILanguageModelChatMetadataAndIdentifier {
	const id = selection?.id ?? '$default';
	return {
		identifier: `${SessionType.AgentHostCopilot}:${id}`,
		metadata: {
			extension: nullExtensionDescription.identifier,
			id, vendor: SessionType.AgentHostCopilot, family: id, version: '',
			name: selection
				? localize('room.unavailableModelLabel', "{0} (Unavailable)", selection.id)
				: localize('room.providerDefaultLabel', "Provider Default"),
			maxInputTokens: 0, maxOutputTokens: 0, isDefaultForLocation: {}, isUserSelectable: false,
			targetChatSessionType: SessionType.AgentHostCopilot,
		},
	};
}

/** Uses the regular host catalog conversion without registering another inference provider. */
export class CollaborationModelCatalog extends Disposable {
	readonly models = observableValue<readonly ILanguageModelChatMetadataAndIdentifier[]>(this, []);
	private generation = 0;

	constructor(
		models: IObservable<readonly SessionModelInfo[]>,
		onError: (error: unknown) => void,
		@ILanguageModelsService languageModels: ILanguageModelsService,
	) {
		super();
		const provider = this._register(new AgentHostLanguageModelProvider(SessionType.AgentHostCopilot, SessionType.AgentHostCopilot, languageModels));
		this._register(provider.onDidChange(() => {
			const generation = ++this.generation;
			provider.provideLanguageModelChatInfo(undefined, CancellationToken.None).then(models => {
				if (!this._store.isDisposed && generation === this.generation) {
					// Model configuration has its own persistence contract; do not expose the global settings writer.
					this.models.set(models.map(model => ({ ...model, metadata: { ...model.metadata, configurationSchema: undefined } })), undefined);
				}
			}, error => {
				if (!this._store.isDisposed && generation === this.generation) {
					onError(error);
				}
			});
		}));
		this._register(autorun(reader => provider.updateModels(models.read(reader))));
	}
}

export interface ICollaborationModelPickerState {
	readonly selection: ModelSelection | undefined;
	readonly enabled: boolean;
	readonly detail?: string;
	readonly error?: string;
}

export function getCollaborationMemberModelState(member: IAgentHostRoomMember, models: readonly SessionModelInfo[], enabled: boolean): ICollaborationModelPickerState {
	const selection = member.pendingModel === null ? { id: 'auto' }
		: member.pendingModel ?? member.modelSelection ?? (member.model ? { id: member.model } : undefined);
	const current = member.modelSelection ? models.find(model => model.id === member.modelSelection?.id)?.name ?? member.modelSelection.id : undefined;
	// A peer that has taken a turn is already running on something, so reporting its
	// model as unconfirmed reads as a fault next to a working peer. Only a peer that
	// has never run is genuinely waiting for its first model.
	const started = member.turns > 0;
	const detail = member.pendingModel !== undefined
		? current
			? localize('room.modelNextTurn', "Applies on the next turn. Currently using {0}.", current)
			: started
				? localize('room.modelNextTurnUnknown', "Applies on this peer's next turn.")
				: localize('room.modelBeforeStart', "Applies when this peer starts.")
		: !current && !started ? localize('room.modelUnconfirmed', "Applies when this peer starts.") : undefined;
	return { selection, enabled, detail, error: member.modelError };
}

export function getCollaborationCoordinatorModelState(coordinator: IAgentHostRoomCoordinator, models: readonly SessionModelInfo[], enabled: boolean): ICollaborationModelPickerState {
	const selection = coordinator.pendingModel ?? coordinator.appliedModel ?? coordinator.desiredModel;
	const current = coordinator.appliedModel
		? models.find(model => model.id === coordinator.appliedModel?.id)?.name ?? coordinator.appliedModel.id
		: undefined;
	const detail = coordinator.pendingModel
		? current
			? localize('room.coordinatorModelNextTurn', "Applies on the next coordinator turn. Currently using {0}.", current)
			: localize('room.coordinatorModelBeforeStart', "Applies when the coordinator starts.")
		: !current && !coordinator.initialized ? localize('room.coordinatorModelBeforeStart', "Applies when the coordinator starts.") : undefined;
	return { selection, enabled, detail, error: coordinator.modelError };
}

/** One delegate per worker: selecting a peer never changes the active chat's model. */
export class CollaborationModelPicker extends Disposable {
	readonly state = observableValue<ICollaborationModelPickerState>(this, { selection: undefined, enabled: true });
	readonly element = $('.room-member-model');
	private readonly picker: ModelPickerActionItem;
	private readonly requestedModel = observableValue<ModelSelection | undefined>(this, undefined);
	private readonly selectionError = observableValue<string | undefined>(this, undefined);

	constructor(
		parent: HTMLElement,
		label: string,
		catalog: CollaborationModelCatalog,
		private readonly select: (model: ModelSelection) => void | Promise<void>,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		parent.appendChild(this.element);
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', localize('room.peerModel', "Model for {0}", label));
		this.element.tabIndex = -1;
		const host = this.element.appendChild($('.room-model-picker'));
		const detail = this.element.appendChild($('.room-model-detail'));
		const selectedModelId = derived(this, reader => (this.requestedModel.read(reader) ?? this.state.read(reader).selection)?.id);
		const currentModel = derived(this, reader => {
			const id = selectedModelId.read(reader);
			const models = catalog.models.read(reader);
			return id ? models.find(model => model.metadata.id === id) ?? modelLabelPlaceholder({ id }) : modelLabelPlaceholder();
		});
		this.picker = this._register(instantiation.createInstance(ModelPickerActionItem,
			{ id: 'collaboration.peerModel', label: '', enabled: true, tooltip: '', class: undefined, run: () => { } },
			{
				currentModel,
				setModel: model => {
					void this.selectModel({ id: model.metadata.id, ...(model.metadata.id === this.state.get().selection?.id ? { config: this.state.get().selection?.config } : {}) });
				},
				getModels: () => [...catalog.models.get()],
				getPresentationOptions: () => ({
					useGroupedModelPicker: true, showManageModelsAction: true, showUnavailableFeatured: false, showFeatured: false,
					showAutoModel: catalog.models.get().some(model => model.metadata.id === 'auto'), showModelIcon: true,
				}),
			},
			{ compact: constObservable(false) },
		));
		this.picker.render(host);
		this._register(autorun(reader => {
			const state = this.state.read(reader);
			const models = catalog.models.read(reader);
			const saving = !!this.requestedModel.read(reader);
			const error = this.selectionError.read(reader) ?? (saving ? undefined : state.error);
			const selected = state.selection?.id;
			const unavailable = selected && !models.some(model => model.metadata.id === selected);
			const availability = unavailable
				? localize('room.modelUnavailable', "{0} is unavailable. Choose another model.", selected)
				: !models.length ? localize('room.modelCatalogUnavailable', "No models available. Reconnect or sign in to Copilot.") : undefined;
			const message = error ? [error, state.detail].filter(Boolean).join(' ')
				: saving ? localize('room.savingModel', "Saving model...")
					: [availability, state.detail].filter(Boolean).join(' ');
			if (detail.textContent !== message) {
				detail.textContent = message;
			}
			detail.hidden = !message;
			detail.classList.toggle('error', !!error);
			const role = error ? 'alert' : 'status';
			if (detail.getAttribute('role') !== role) {
				detail.setAttribute('role', role);
			}
			this.picker.setEnabled(state.enabled && !saving);
		}));
	}

	private async selectModel(model: ModelSelection): Promise<void> {
		if (this.requestedModel.get()) {
			return;
		}
		transaction(tx => {
			this.requestedModel.set(model, tx);
			this.selectionError.set(undefined, tx);
		});
		try {
			await this.select(model);
			if (!this._store.isDisposed) {
				this.state.set({ ...this.state.get(), selection: model }, undefined);
			}
		} catch (error) {
			if (!this._store.isDisposed && !isCancellationError(error)) {
				this.selectionError.set(toErrorMessage(error), undefined);
			}
		} finally {
			if (!this._store.isDisposed) {
				this.requestedModel.set(undefined, undefined);
			}
		}
	}
}
