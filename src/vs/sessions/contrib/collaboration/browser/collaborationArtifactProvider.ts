/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IAgentHostRoomArtifact } from '../../../../platform/agentHost/common/agentHostRooms.js';
import { ICollaborationService } from '../../../services/collaboration/common/collaboration.js';

/** Published patches open as virtual, read-only resources, never as live worktree files. */
export class CollaborationArtifactProvider extends Disposable implements ITextModelContentProvider {
	static readonly scheme = 'collaboration-artifact';

	static resource(roomId: string, artifact: IAgentHostRoomArtifact): URI {
		return URI.from({
			scheme: CollaborationArtifactProvider.scheme,
			authority: roomId,
			path: `/${artifact.title}.patch`,
			query: artifact.id,
		});
	}

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@ICollaborationService private readonly collaborationService: ICollaborationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(CollaborationArtifactProvider.scheme, this));
	}

	async provideTextContent(resource: URI): Promise<ITextModel> {
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const content = await this.collaborationService.getArtifact(resource.authority, resource.query);
		return this.modelService.getModel(resource) ?? this.modelService.createModel(
			content,
			this.languageService.createById('diff'),
			resource,
		);
	}
}
