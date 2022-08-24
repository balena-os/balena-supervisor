import { expect } from 'chai';
import * as ComposeUtils from '~/src/compose/utils';

describe('Composition utilities', () =>
	it('Should correctly camel case the configuration', function () {
		const config = {
			networks: ['test', 'test2'],
		};

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			networks: ['test', 'test2'],
		});
	}));
