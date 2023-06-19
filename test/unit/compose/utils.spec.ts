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

	it('should return whether a date is valid and older than an interval of seconds', () => {
		const now = new Date(Date.now());
		expect(ComposeUtils.isValidDateAndOlderThan(now, 60)).to.equal(false);
		const time59SecondsAgo = new Date(Date.now() - 59 * 1000);
		expect(ComposeUtils.isValidDateAndOlderThan(time59SecondsAgo, 60)).to.equal(
			false,
		);
		const time61SecondsAgo = new Date(Date.now() - 61 * 1000);
		expect(ComposeUtils.isValidDateAndOlderThan(time61SecondsAgo, 60)).to.equal(
			true,
		);

		const notDates = [
			null,
			undefined,
			'',
			'test',
			123,
			0,
			-1,
			Infinity,
			NaN,
			{},
		];
		notDates.forEach((n) => {
			expect(ComposeUtils.isValidDateAndOlderThan(n, 0)).to.equal(false);
		});
	});
});
