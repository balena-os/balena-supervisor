import * as _ from 'lodash';
import { SinonStub, stub } from 'sinon';
import { QueryBuilder } from 'knex';

import * as db from '~/src/db';
import { Image } from '~/src/compose/images';

let modelStub: SinonStub | null = null;
// MOCKED MODELS
const MOCKED_MODELS: Dictionary<QueryBuilder> = {};
// MOCKED MODEL TYPES
let MOCKED_IMAGES: Image[] = [];

export function create(): SinonStub {
	if (modelStub === null) {
		modelStub = stub(db, 'models');
		// Stub model requests to return our stubbed models
		modelStub.callsFake((model: string) => {
			return MOCKED_MODELS[model];
		});
	}
	return modelStub;
}

export function restore(): void {
	if (modelStub !== null) {
		modelStub.restore();
	}
}

export function setImages(images: Image[]) {
	MOCKED_IMAGES = images;
	return {
		stub: stubImages,
	};
}

function stubImages() {
	// Set the functions for this model (add them as you need for your test cases)
	MOCKED_MODELS['image'] = {
		select: () => {
			return {
				where: async (condition: Partial<Image>) =>
					_(MOCKED_IMAGES).pickBy(condition).map().value(),
			};
		},
		where: (condition: Partial<Image>) => {
			return {
				select: async () => _(MOCKED_IMAGES).pickBy(condition).map().value(),
			};
		},
		del: () => {
			return {
				where: async (condition: Partial<Image>) => {
					return _(MOCKED_IMAGES)
						.pickBy(condition)
						.map()
						.value()
						.forEach((val) => {
							MOCKED_IMAGES = _.reject(MOCKED_IMAGES, {
								id: val.id,
							});
						});
				},
			};
		},
	} as unknown as QueryBuilder;
}
