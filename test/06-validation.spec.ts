import * as _ from 'lodash';
import { expect } from 'chai';

import { isRight } from 'fp-ts/lib/Either';
import {
	StringIdentifier,
	ShortString,
	DeviceName,
	NumericIdentifier,
	TargetApps,
} from '~/src/types';

import * as validation from '~/lib/validation';

describe('validation', () => {
	describe('checkBooleanish', () => {
		it('returns true for a truthy or falsey value', () => {
			expect(validation.checkBooleanish(true)).to.equal(true);
			expect(validation.checkBooleanish('true')).to.equal(true);
			expect(validation.checkBooleanish('1')).to.equal(true);
			expect(validation.checkBooleanish(1)).to.equal(true);
			expect(validation.checkBooleanish('on')).to.equal(true);
			expect(validation.checkBooleanish(false)).to.equal(true);
			expect(validation.checkBooleanish('false')).to.equal(true);
			expect(validation.checkBooleanish('0')).to.equal(true);
			expect(validation.checkBooleanish(0)).to.equal(true);
			expect(validation.checkBooleanish('off')).to.equal(true);
		});

		it('returns false for invalid values', () => {
			expect(validation.checkBooleanish({})).to.equal(false);
			expect(validation.checkBooleanish(10)).to.equal(false);
			expect(validation.checkBooleanish('on1')).to.equal(false);
			expect(validation.checkBooleanish('foo')).to.equal(false);
			expect(validation.checkBooleanish(undefined)).to.equal(false);
			expect(validation.checkBooleanish(null)).to.equal(false);
			expect(validation.checkBooleanish('')).to.equal(false);
		});
	});

	describe('checkFalsey', () => {
		it('returns false for a truthy value', () => {
			expect(validation.checkFalsey(true)).to.equal(false);
			expect(validation.checkFalsey('true')).to.equal(false);
			expect(validation.checkFalsey('1')).to.equal(false);
			expect(validation.checkFalsey(1)).to.equal(false);
			expect(validation.checkFalsey('on')).to.equal(false);
		});

		it('returns true for a falsey value', () => {
			expect(validation.checkFalsey(false)).to.equal(true);
			expect(validation.checkFalsey('false')).to.equal(true);
			expect(validation.checkFalsey('0')).to.equal(true);
			expect(validation.checkFalsey(0)).to.equal(true);
			expect(validation.checkFalsey('off')).to.equal(true);
		});

		it('returns false for invalid values', () => {
			expect(validation.checkFalsey({})).to.equal(false);
			expect(validation.checkFalsey(10)).to.equal(false);
			expect(validation.checkFalsey('on1')).to.equal(false);
			expect(validation.checkFalsey('foo')).to.equal(false);
			expect(validation.checkFalsey(undefined)).to.equal(false);
			expect(validation.checkFalsey(null)).to.equal(false);
			expect(validation.checkFalsey('')).to.equal(false);
		});
	});

	describe('checkTruthy', () => {
		it('returns true for a truthy value', () => {
			expect(validation.checkTruthy(true)).to.equal(true);
			expect(validation.checkTruthy('true')).to.equal(true);
			expect(validation.checkTruthy('1')).to.equal(true);
			expect(validation.checkTruthy(1)).to.equal(true);
			expect(validation.checkTruthy('on')).to.equal(true);
		});

		it('returns false for a falsey value', () => {
			expect(validation.checkTruthy(false)).to.equal(false);
			expect(validation.checkTruthy('false')).to.equal(false);
			expect(validation.checkTruthy('0')).to.equal(false);
			expect(validation.checkTruthy(0)).to.equal(false);
			expect(validation.checkTruthy('off')).to.equal(false);
		});

		it('returns false for invalid values', () => {
			expect(validation.checkTruthy({})).to.equal(false);
			expect(validation.checkTruthy(10)).to.equal(false);
			expect(validation.checkTruthy('on1')).to.equal(false);
			expect(validation.checkTruthy('foo')).to.equal(false);
			expect(validation.checkTruthy(undefined)).to.equal(false);
			expect(validation.checkTruthy(null)).to.equal(false);
			expect(validation.checkTruthy('')).to.equal(false);
		});
	});

	describe('checkString', () => {
		it('validates a string', () => {
			expect(validation.checkString('foo')).to.equal('foo');
			expect(validation.checkString('bar')).to.equal('bar');
		});

		it('returns undefined for empty strings or strings that equal null or undefined', () => {
			expect(validation.checkString('')).to.be.undefined;
			expect(validation.checkString('null')).to.be.undefined;
			expect(validation.checkString('undefined')).to.be.undefined;
		});

		it('returns undefined for things that are not strings', () => {
			expect(validation.checkString({})).to.be.undefined;
			expect(validation.checkString([])).to.be.undefined;
			expect(validation.checkString(123)).to.be.undefined;
			expect(validation.checkString(0)).to.be.undefined;
			expect(validation.checkString(null)).to.be.undefined;
			expect(validation.checkString(undefined)).to.be.undefined;
		});
	});

	describe('checkInt', () => {
		it('returns an integer for a string that can be parsed as one', () => {
			expect(validation.checkInt('200')).to.equal(200);
			expect(validation.checkInt('200.00')).to.equal(200); // Allow since no data is being lost
			expect(validation.checkInt('0')).to.equal(0);
			expect(validation.checkInt('-3')).to.equal(-3);
		});

		it('returns the same integer when passed an integer', () => {
			expect(validation.checkInt(345)).to.equal(345);
			expect(validation.checkInt(-345)).to.equal(-345);
		});

		it("returns undefined when passed something that can't be parsed as int", () => {
			expect(validation.checkInt({})).to.be.undefined;
			expect(validation.checkInt([])).to.be.undefined;
			expect(validation.checkInt('foo')).to.be.undefined;
			expect(validation.checkInt('')).to.be.undefined;
			expect(validation.checkInt(null)).to.be.undefined;
			expect(validation.checkInt(undefined)).to.be.undefined;
			expect(validation.checkInt('45notanumber')).to.be.undefined;
			expect(validation.checkInt('000123.45notanumber')).to.be.undefined;
			expect(validation.checkInt(50.55)).to.be.undefined; // Fractional digits
			expect(validation.checkInt('50.55')).to.be.undefined; // Fractional digits
			expect(validation.checkInt('0x11')).to.be.undefined; // Hexadecimal
			expect(validation.checkInt('0b11')).to.be.undefined; // Binary
			expect(validation.checkInt('0o11')).to.be.undefined; // Octal
		});

		it('returns undefined when passed a negative or zero value and the positive option is set', () => {
			expect(validation.checkInt('-3', { positive: true })).to.be.undefined;
			expect(validation.checkInt('0', { positive: true })).to.be.undefined;
		});
	});

	describe('short string', () => {
		it('accepts strings below 255 chars', () => {
			expect(isRight(ShortString.decode('aaaa'))).to.be.true;
			expect(isRight(ShortString.decode('1234'))).to.be.true;
			expect(isRight(ShortString.decode('some longish alphanumeric text 1236')))
				.to.be.true;
			expect(isRight(ShortString.decode('a'.repeat(255)))).to.be.true;
		});

		it('rejects non strings or strings longer than 255 chars', () => {
			expect(isRight(ShortString.decode(null))).to.be.false;
			expect(isRight(ShortString.decode(undefined))).to.be.false;
			expect(isRight(ShortString.decode([]))).to.be.false;
			expect(isRight(ShortString.decode(1234))).to.be.false;
			expect(isRight(ShortString.decode('a'.repeat(256)))).to.be.false;
		});
	});

	describe('device name', () => {
		it('accepts strings below 255 chars', () => {
			expect(isRight(DeviceName.decode('aaaa'))).to.be.true;
			expect(isRight(DeviceName.decode('1234'))).to.be.true;
			expect(isRight(DeviceName.decode('some longish alphanumeric text 1236')))
				.to.be.true;
			expect(isRight(DeviceName.decode('a'.repeat(255)))).to.be.true;
		});

		it('rejects non strings or strings longer than 255 chars', () => {
			expect(isRight(DeviceName.decode(null))).to.be.false;
			expect(isRight(DeviceName.decode(undefined))).to.be.false;
			expect(isRight(DeviceName.decode([]))).to.be.false;
			expect(isRight(DeviceName.decode(1234))).to.be.false;
			expect(isRight(DeviceName.decode('a'.repeat(256)))).to.be.false;
		});

		it('rejects strings with new lines', () => {
			expect(isRight(DeviceName.decode('\n'))).to.be.false;
			expect(isRight(DeviceName.decode('aaaa\nbbbb'))).to.be.false;
			expect(isRight(DeviceName.decode('\n' + 'a'.repeat(254)))).to.be.false;
			expect(isRight(DeviceName.decode('\n' + 'a'.repeat(255)))).to.be.false;
		});
	});

	describe('string identifier', () => {
		it('accepts integer strings as input', () => {
			expect(isRight(StringIdentifier.decode('0'))).to.be.true;
			expect(isRight(StringIdentifier.decode('1234'))).to.be.true;
			expect(isRight(StringIdentifier.decode('51564189199'))).to.be.true;
		});

		it('rejects non strings or non numeric strings', () => {
			expect(isRight(StringIdentifier.decode(null))).to.be.false;
			expect(isRight(StringIdentifier.decode(undefined))).to.be.false;
			expect(isRight(StringIdentifier.decode([1]))).to.be.false;
			expect(isRight(StringIdentifier.decode('[1]'))).to.be.false;
			expect(isRight(StringIdentifier.decode(12345))).to.be.false;
			expect(isRight(StringIdentifier.decode(-12345))).to.be.false;
			expect(isRight(StringIdentifier.decode('aaaa'))).to.be.false;
			expect(isRight(StringIdentifier.decode('-125'))).to.be.false;
			expect(isRight(StringIdentifier.decode('0xffff'))).to.be.false;
			expect(isRight(StringIdentifier.decode('1544.333'))).to.be.false;
		});

		it('decodes to a string', () => {
			expect(StringIdentifier.decode('12345'))
				.to.have.property('right')
				.that.equals('12345');
		});
	});

	describe('numeric identifier', () => {
		it('accepts integers and integer strings as input', () => {
			expect(isRight(NumericIdentifier.decode('0'))).to.be.true;
			expect(isRight(NumericIdentifier.decode('1234'))).to.be.true;
			expect(isRight(NumericIdentifier.decode(1234))).to.be.true;
			expect(isRight(NumericIdentifier.decode(51564189199))).to.be.true;
			expect(isRight(NumericIdentifier.decode('51564189199'))).to.be.true;
		});

		it('rejects non strings or non numeric strings', () => {
			expect(isRight(NumericIdentifier.decode(null))).to.be.false;
			expect(isRight(NumericIdentifier.decode(undefined))).to.be.false;
			expect(isRight(NumericIdentifier.decode([1]))).to.be.false;
			expect(isRight(NumericIdentifier.decode('[1]'))).to.be.false;
			expect(isRight(NumericIdentifier.decode('aaaa'))).to.be.false;
			expect(isRight(NumericIdentifier.decode('-125'))).to.be.false;
			expect(isRight(NumericIdentifier.decode('0xffff'))).to.be.false;
			expect(isRight(NumericIdentifier.decode('1544.333'))).to.be.false;
			expect(isRight(NumericIdentifier.decode(1544.333))).to.be.false;
			expect(isRight(NumericIdentifier.decode(-1544.333))).to.be.false;
		});

		it('decodes to a number', () => {
			expect(NumericIdentifier.decode('12345'))
				.to.have.property('right')
				.that.equals(12345);
			expect(NumericIdentifier.decode(12345))
				.to.have.property('right')
				.that.equals(12345);
		});
	});

	describe('target apps', () => {
		it('accept valid target apps', () => {
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: 1234,
							name: 'something',
							class: 'fleet',
							releases: {},
						},
					}),
				),
				'accepts apps with no no release id or commit',
			).to.be.true;
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: 1234,
							name: 'something',
							releases: {
								bar: {
									id: 123,
									services: {},
								},
							},
						},
					}),
				),
				'accepts apps with no services',
			).to.be.true;

			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: 1234,
							name: 'something',
							releases: {
								bar: {
									id: 123,
									services: {
										bazbaz: {
											id: 45,
											image_id: 34,
											image: 'foo',
											environment: { MY_SERVICE_ENV_VAR: '123' },
											labels: { 'io.balena.features.supervisor-api': 'true' },
										},
									},
									volumes: {},
									networks: {},
								},
							},
						},
					}),
				),
				'accepts apps with a service',
			).to.be.true;
		});

		it('rejects app with invalid environment', () => {
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: 1234,
							name: 'something',
							releases: {
								bar: {
									id: 123,
									services: {
										bazbaz: {
											id: 45,
											image_id: 34,
											image: 'foo',
											environment: { 'bbb=aaa': '123' },
											labels: {},
										},
									},
									volumes: {},
									networks: {},
								},
							},
						},
					}),
				),
			).to.be.false;
		});

		it('rejects app with invalid labels', () => {
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: 1234,
							name: 'something',
							releases: {
								bar: {
									id: 123,
									services: {
										bazbaz: {
											id: 45,
											image_id: 34,
											image: 'foo',
											environment: {},
											labels: { ' not a valid #name': 'label value' },
										},
									},
									volumes: {},
									networks: {},
								},
							},
						},
					}),
				),
			).to.be.false;
		});

		it('rejects an invalid appId', () => {
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: 'booo',
							name: 'something',
							releases: {},
						},
					}),
				),
			).to.be.false;
		});

		it('rejects a release uuid that is too long', () => {
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: '123',
							name: 'something',
							releases: {
								['a'.repeat(256)]: {
									id: 1234,
									services: {
										bazbaz: {
											id: 45,
											image_id: 34,
											image: 'foo',
											environment: {},
											labels: {},
										},
									},
								},
							},
						},
					}),
				),
			).to.be.false;

			it('rejects a service with an invalid docker name', () => {
				expect(
					isRight(
						TargetApps.decode({
							abcd: {
								id: '123',
								name: 'something',
								releases: {
									aaaa: {
										id: 1234,
										services: {
											' not a valid name': {
												id: 45,
												image_id: 34,
												image: 'foo',
												environment: {},
												labels: {},
											},
										},
									},
								},
							},
						}),
					),
				).to.be.false;
			});
		});

		it('rejects app with an invalid releaseId', () => {
			expect(
				isRight(
					TargetApps.decode({
						abcd: {
							id: '123',
							name: 'something',
							releases: {
								aaaa: {
									id: 'boooo',
									services: {},
								},
							},
						},
					}),
				),
			).to.be.false;
		});
	});
});
