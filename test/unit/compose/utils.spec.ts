import { expect } from 'chai';
import * as ComposeUtils from '~/src/compose/utils';

describe('compose/utils', () => {
	it('should correctly camel case the configuration', () => {
		const config = {
			networks: ['test', 'test2'],
		};

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			networks: ['test', 'test2'],
		});
	});
});
