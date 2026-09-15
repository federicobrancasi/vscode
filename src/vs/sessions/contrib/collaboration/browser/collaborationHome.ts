/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { generateAgentHostRoomMemberName } from '../../../../platform/agentHost/common/agentHostRoomNames.js';
import { IAgentHostRoomCreateOptions, MAX_ROOM_WORKERS } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { ModelSelection } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { CollaborationModelCatalog, CollaborationModelPicker } from './collaborationModelPicker.js';

export interface ICollaborationHomeDraft {
	readonly goal: string;
	readonly folder: string;
	readonly count: string;
	readonly instructions: string;
	readonly baseRevision: string;
	readonly coordinatorModel?: ModelSelection;
	readonly memberNames?: readonly string[];
	readonly memberModels: readonly (ModelSelection | undefined)[];
}

export interface ICollaborationHomeDelegate {
	/** Ask the host whether the folder can already back a room. */
	isRepository(folderUri: string): Promise<boolean>;
	/** Confirm preparing a plain folder. The exact path is always shown. */
	confirmInitialize(path: string): Promise<boolean>;
	browseForFolder(current: URI | undefined): Promise<URI | undefined>;
	create(options: IAgentHostRoomCreateOptions): Promise<void>;
	open(roomId: string): Promise<void>;
	readDraft(): ICollaborationHomeDraft | undefined;
	saveDraft(draft: ICollaborationHomeDraft | undefined): void;
}

const EMPTY_DRAFT: ICollaborationHomeDraft = { goal: '', folder: '', count: '3', instructions: '', baseRevision: '', memberNames: [], memberModels: [] };

/**
 * The room's landing surface: one card that asks only for a goal, a folder and
 * the peers, plus the rooms that already exist. Everything else is advanced.
 */
export class CollaborationHome extends Disposable {
	readonly element: HTMLElement;
	readonly busy = observableValue(this, false);
	private readonly goalInput: InputBox;
	private readonly folderInput: InputBox;
	private readonly instructionsInput: InputBox;
	private readonly baseInput: InputBox;
	private readonly countSelect: SelectBox;
	private readonly createButton: Button;
	private readonly coordinatorPicker: CollaborationModelPicker;
	private readonly modelsContainer: HTMLElement;
	private readonly errorElement: HTMLElement;
	private readonly pickers = this._register(new DisposableMap<number, CollaborationModelPicker>());
	private folder: URI | undefined;
	private memberNames: string[] = [];
	private memberModels: (ModelSelection | undefined)[] = [];
	private coordinatorModel: ModelSelection | undefined;

	constructor(
		parent: HTMLElement,
		private readonly catalog: CollaborationModelCatalog,
		private readonly delegate: ICollaborationHomeDelegate,
		@IContextViewService contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.element = parent.appendChild($('.room-home'));
		const card = this.element.appendChild($('.room-home-card'));
		card.appendChild($('h1.room-home-title')).textContent = localize('room.homeTitle', "Agent Collab");

		this.goalInput = this._register(new InputBox(this.field(card, localize('room.homeGoal', "Goal")), contextViewService, {
			inputBoxStyles: defaultInputBoxStyles, flexibleHeight: true, flexibleMaxHeight: 140,
			placeholder: localize('room.homeGoalPlaceholder', "What should the agents work on?"),
			ariaLabel: localize('room.homeGoal', "Goal"),
		}));

		const folderField = this.field(card, localize('room.homeFolder', "Folder"));
		const folderRow = folderField.appendChild($('.room-home-row'));
		this.folderInput = this._register(new InputBox(folderRow.appendChild($('.room-home-grow')), contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			placeholder: localize('room.homeFolderPlaceholder', "Choose a folder"),
			ariaLabel: localize('room.homeFolder', "Folder"),
		}));
		this.folderInput.inputElement.readOnly = true;
		const browse = this._register(new Button(folderRow, { ...defaultButtonStyles, secondary: true, title: localize('room.homeBrowse', "Browse") }));
		browse.label = localize('room.homeBrowse', "Browse");
		this._register(browse.onDidClick(() => void this.browse()));

		const coordinatorField = this.field(card, localize('room.homeCoordinator', "Coordinator"));
		this.coordinatorPicker = this._register(this.instantiationService.createInstance(
			CollaborationModelPicker,
			coordinatorField,
			localize('room.homeCoordinator', "Coordinator"),
			this.catalog,
			model => {
				this.coordinatorModel = model;
				this.save();
			},
		));

		const agentsField = this.field(card, localize('room.homeAgents', "Agents"));
		this.countSelect = this._register(new SelectBox(
			Array.from({ length: MAX_ROOM_WORKERS }, (_, index) => ({ text: String(index + 1) })), 2,
			contextViewService, defaultSelectBoxStyles, { ariaLabel: localize('room.homeAgents', "Agents") }));
		this.countSelect.render(agentsField.appendChild($('.room-home-count')));
		this._register(this.countSelect.onDidSelect(event => {
			this.selectedCount = event.index + 1;
			this.renderModelPickers();
			this.save();
		}));
		this.modelsContainer = agentsField.appendChild($('.room-home-models'));

		const advanced = card.appendChild($('details.room-home-advanced')) as HTMLDetailsElement;
		advanced.appendChild($('summary')).textContent = localize('room.homeAdvanced', "Advanced");
		this.instructionsInput = this._register(new InputBox(this.field(advanced, localize('room.homeRules', "Rules")), contextViewService, {
			inputBoxStyles: defaultInputBoxStyles, flexibleHeight: true, flexibleMaxHeight: 120,
			placeholder: localize('room.homeRulesPlaceholder', "How should the agents work together?"),
			ariaLabel: localize('room.homeRules', "Rules"),
		}));
		this.baseInput = this._register(new InputBox(this.field(advanced, localize('room.homeBase', "Branch, tag, or commit")), contextViewService, {
			inputBoxStyles: defaultInputBoxStyles, placeholder: 'HEAD', ariaLabel: localize('room.homeBase', "Branch, tag, or commit"),
		}));

		this.errorElement = card.appendChild($('.room-home-error'));
		this.errorElement.setAttribute('role', 'alert');
		this.errorElement.hidden = true;

		this.createButton = this._register(new Button(card.appendChild($('.room-home-actions')), { ...defaultButtonStyles, title: localize('room.homeCreate', "Create and Start") }));
		this.createButton.label = localize('room.homeCreate', "Create and Start");
		this._register(this.createButton.onDidClick(() => void this.create()));


		for (const input of [this.goalInput, this.instructionsInput, this.baseInput]) {
			this._register(input.onDidChange(() => this.save()));
		}
		this._register(autorun(reader => this.createButton.enabled = !this.busy.read(reader)));
		this.restore();
	}

	private field(parent: HTMLElement, label: string): HTMLElement {
		const field = parent.appendChild($('.room-home-field'));
		field.appendChild($('label.room-home-label')).textContent = label;
		return field;
	}

	private selectedCount = 3;

	private get count(): number {
		return this.selectedCount;
	}

	private restore(): void {
		const draft = this.delegate.readDraft() ?? EMPTY_DRAFT;
		this.goalInput.value = draft.goal;
		this.instructionsInput.value = draft.instructions;
		this.baseInput.value = draft.baseRevision;
		this.folderInput.value = draft.folder;
		this.folder = draft.folder ? URI.file(draft.folder) : undefined;
		this.memberNames = [...(draft.memberNames ?? [])];
		this.memberModels = [...draft.memberModels];
		this.coordinatorModel = draft.coordinatorModel;
		this.coordinatorPicker.state.set({ selection: this.coordinatorModel, enabled: true }, undefined);
		const count = Number(draft.count);
		this.selectedCount = Number.isInteger(count) && count >= 1 && count <= MAX_ROOM_WORKERS ? count : 3;
		this.countSelect.select(this.selectedCount - 1);
		this.renderModelPickers();
		this.save();
	}

	private save(): void {
		this.delegate.saveDraft({
			goal: this.goalInput.value, folder: this.folder?.fsPath ?? '', count: String(this.count),
			instructions: this.instructionsInput.value, baseRevision: this.baseInput.value,
			coordinatorModel: this.coordinatorModel,
			memberNames: [...this.memberNames],
			memberModels: [...this.memberModels],
		});
	}

	private ensureMemberNames(): void {
		const taken = new Set(this.memberNames);
		for (let index = 0; index < this.count; index++) {
			if (!this.memberNames[index]) {
				const name = generateAgentHostRoomMemberName(taken);
				this.memberNames[index] = name;
				taken.add(name);
			}
		}
	}

	/** Draft identities and model choices stay with their slot when the agent count changes. */
	private renderModelPickers(): void {
		const count = this.count;
		this.ensureMemberNames();
		for (const [index] of [...this.pickers.keys()].map(index => [index] as const)) {
			if (index >= count) {
				this.pickers.deleteAndDispose(index);
			}
		}
		this.modelsContainer.textContent = '';
		for (let index = 0; index < count; index++) {
			const memberName = this.memberNames[index];
			const row = this.modelsContainer.appendChild($('.room-home-model'));
			row.appendChild($('span.room-home-model-name')).textContent = memberName;
			const picker = this.instantiationService.createInstance(CollaborationModelPicker, row,
				memberName, this.catalog, model => {
					this.memberModels[index] = model;
					this.save();
				});
			picker.state.set({ selection: this.memberModels[index], enabled: true }, undefined);
			this.pickers.set(index, picker);
		}
	}

	setError(error: string | undefined): void {
		this.errorElement.textContent = error ?? '';
		this.errorElement.hidden = !error;
	}

	/** Reflects host availability and whether per-peer model choice is supported. */
	setDisabled(disabled: boolean, modelDetail?: string): void {
		this.createButton.enabled = !disabled && !this.busy.get();
		for (const picker of this.pickers.values()) {
			picker.state.set({ ...picker.state.get(), enabled: !disabled && !modelDetail, detail: modelDetail }, undefined);
		}
		this.coordinatorPicker.state.set({ ...this.coordinatorPicker.state.get(), enabled: !disabled && !modelDetail, detail: modelDetail }, undefined);
	}

	focus(): void {
		this.goalInput.focus();
	}

	private async browse(): Promise<void> {
		const selected = await this.delegate.browseForFolder(this.folder);
		if (selected && !this._store.isDisposed) {
			this.folder = selected;
			this.folderInput.value = selected.fsPath;
			this.setError(undefined);
			this.save();
		}
	}

	private async create(): Promise<void> {
		if (this.busy.get()) {
			return;
		}
		const goal = this.goalInput.value.trim();
		if (!goal) {
			this.setError(localize('room.homeGoalRequired', "Describe what the agents should work on."));
			this.goalInput.focus();
			return;
		}
		if (!this.folder) {
			this.setError(localize('room.homeFolderRequired', "Choose a folder for the agents to work in."));
			return;
		}
		const base = this.baseInput.value.trim();
		if (base.startsWith('-') || /[\r\n]/.test(base)) {
			this.setError(localize('room.homeInvalidBase', "Enter a valid Git branch, tag, or commit."));
			return;
		}
		this.setError(undefined);
		this.busy.set(true, undefined);
		try {
			const folderUri = this.folder.toString();
			let initializeRepository = false;
			if (!(await this.delegate.isRepository(folderUri))) {
				if (this._store.isDisposed || !(await this.delegate.confirmInitialize(this.folder.fsPath))) {
					return;
				}
				initializeRepository = true;
			}
			if (this._store.isDisposed) {
				return;
			}
			await this.delegate.create({
				title: goal.split('\n')[0].slice(0, 80), goal,
				instructions: this.instructionsInput.value.trim(),
				repositoryUri: folderUri, workerCount: this.count,
				...(base ? { baseRevision: base } : {}),
				initializeRepository,
				...(this.coordinatorModel ? { coordinatorModel: this.coordinatorModel } : {}),
				memberNames: this.memberNames.slice(0, this.count),
				memberModels: Array.from({ length: this.count }, (_, index) => this.memberModels[index]),
			});
		} finally {
			if (!this._store.isDisposed) {
				this.busy.set(false, undefined);
			}
		}
	}
}
