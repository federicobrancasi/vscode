/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { combinedDisposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IListService, ListService, WorkbenchListWidget } from '../../../../../platform/list/browser/listService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IUpdateService, State } from '../../../../../platform/update/common/update.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { TestChatEntitlementService, TestProductService } from '../../../../../workbench/test/common/workbenchTestServices.js';

class CollaborationTestListService extends ListService {
	widget: WorkbenchListWidget | undefined;

	override register(...args: Parameters<ListService['register']>) {
		const [widget] = args;
		this.widget = widget;
		return combinedDisposable(super.register(...args), toDisposable(() => {
			if (this.widget === widget) {
				this.widget = undefined;
			}
		}));
	}
}

export function stubCollaborationTestServices(instantiation: TestInstantiationService, store: Pick<DisposableStore, 'add'>) {
	const lists = store.add(new CollaborationTestListService());
	instantiation.stub(IListService, lists);
	instantiation.stub(IProductService, TestProductService);
	instantiation.stub(ILanguageModelsService, new class extends mock<ILanguageModelsService>() {
		override readonly onDidChangeLanguageModels = Event.None;
		override readonly onDidChangeLanguageModelVendors = Event.None;
		override getLanguageModelIds() { return []; }
		override lookupLanguageModel() { return undefined; }
		override getModelConfiguration() { return undefined; }
		override getModelsControlManifest() { return { free: {}, paid: {} }; }
		override getRecentlyUsedModelIds() { return []; }
		override getPinnedModelIds() { return []; }
		override getVendors() { return []; }
		override getLanguageModelGroups() { return []; }
		override isModelHidden() { return false; }
	}());
	const entitlement = new TestChatEntitlementService();
	entitlement.entitlement = ChatEntitlement.Pro;
	entitlement.entitlementObs.set(ChatEntitlement.Pro, undefined);
	instantiation.stub(IChatEntitlementService, entitlement);
	instantiation.stub(IUpdateService, new class extends mock<IUpdateService>() {
		override readonly state = State.Uninitialized;
	}());
	instantiation.stub(IUriIdentityService, new class extends mock<IUriIdentityService>() {
		override readonly extUri = extUri;
	}());
	return lists;
}
