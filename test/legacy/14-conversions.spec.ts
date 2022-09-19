import { expect } from 'chai';
import * as conversion from '~/lib/conversions';

describe('conversions', function () {
	describe('envArrayToObject', function () {
		it('should convert an env array to an object', () =>
			expect(
				conversion.envArrayToObject([
					'key=value',
					'test1=test2',
					'k=v',
					'equalsvalue=thisvaluehasan=char',
					'asd=',
					'number=123',
				]),
			).to.deep.equal({
				key: 'value',
				test1: 'test2',
				k: 'v',
				equalsvalue: 'thisvaluehasan=char',
				asd: '',
				number: '123',
			}));

		it('should ignore invalid env array entries', () =>
			expect(
				conversion.envArrayToObject(['key1', 'key1=value1']),
			).to.deep.equal({
				key1: 'value1',
			}));

		it('should return an empty object with an empty input', function () {
			// @ts-expect-error passing invalid value to test
			expect(conversion.envArrayToObject(null)).to.deep.equal({});
			// @ts-expect-error passing invalid value to test
			expect(conversion.envArrayToObject('')).to.deep.equal({});
			expect(conversion.envArrayToObject([])).to.deep.equal({});
			// @ts-expect-error passing invalid value to test
			expect(conversion.envArrayToObject(1)).to.deep.equal({});
		});
	});

	it('should correctly handle whitespace', () =>
		expect(
			conversion.envArrayToObject([
				'key1= test',
				'key2=test\ntest',
				'key3=test ',
				'key4= test ',
				'key5=test\r\ntest',
			]),
		).to.deep.equal({
			key1: ' test',
			key2: 'test\ntest',
			key3: 'test ',
			key4: ' test ',
			key5: 'test\r\ntest',
		}));
});
