import { expect } from 'chai';
import { equals, diff, prune, shallowDiff } from '~/lib/json';

describe('JSON utils', () => {
	describe('equals', () => {
		it('should compare non-objects', () => {
			expect(equals(0, 1)).to.be.false;
			expect(equals(1111, 'a' as any)).to.be.false;
			expect(equals(1111, 2222)).to.be.false;
			expect(equals('aaa', 'bbb')).to.be.false;
			expect(equals('aaa', 'aaa')).to.be.true;
			expect(equals(null, null)).to.be.true;
			expect(equals(null, undefined)).to.be.false;
			expect(equals([], [])).to.be.true;
			expect(equals([1, 2, 3], [1, 2, 3])).to.be.true;
			expect(equals([1, 2, 3], [1, 2])).to.be.false;
			expect(equals([], []), 'empty arrays').to.be.true;
		});

		it('should compare objects recursively', () => {
			expect(equals({}, {}), 'empty objects').to.be.true;
			expect(equals({ a: 1 }, { a: 1 }), 'single level objects').to.be.true;
			expect(equals({ a: 1 }, { a: 2 }), 'differing value single level objects')
				.to.be.false;
			expect(equals({ a: 1 }, { b: 1 }), 'differing keys single level objects');
			expect(
				equals({ a: 1 }, { b: 1, c: 2 }),
				'differing keys single level objects',
			).to.be.false;
			expect(equals({ a: { b: 1 } }, { a: { b: 1 } }), 'multiple level objects')
				.to.be.true;
			expect(
				equals({ a: { b: 1 } }, { a: { b: 1, c: 2 } }),
				'extra keys in multiple level objects',
			).to.be.false;
			expect(
				equals({ a: { b: 1 }, c: 2 }, { a: { b: 1 } }),
				'source object with extra keys',
			).to.be.false;
			expect(
				equals({ a: { b: 1 } }, { a: { b: 1 }, c: 2 }),
				'other object with extra keys',
			).to.be.false;
			expect(
				equals({ a: { b: 1 }, c: 2 }, { a: { b: 1 }, c: 2 }),
				'multiple level objects with extra keys',
			).to.be.true;
			expect(
				equals({ a: { b: 1 }, d: 2 }, { a: { b: 1 }, c: 2 }),
				'multiple level objects with same number of keys',
			).to.be.false;
		});
	});

	describe('diff', () => {
		it('when comparing non-objects or arrays, always returns the target value', () => {
			expect(diff(1, 2)).to.equal(2);
			expect(diff(1, 'a' as any)).to.equal('a');
			expect(diff(1.1, 2)).to.equal(2);
			expect(diff('aaa', 'bbb')).to.equal('bbb');
			expect(diff({}, 'bbb' as any)).to.equal('bbb');
			expect(diff([1, 2, 3], [3, 4, 5])).to.deep.equal([3, 4, 5]);
		});

		it('when comparing objects, calculates differences recursively', () => {
			// Reports all changes
			expect(diff({ a: 1 }, { b: 1 })).to.deep.equal({ a: undefined, b: 1 });

			// Only reports array changes if arrays are different
			expect(diff({ a: [1, 2] }, { a: [1, 2] })).to.deep.equal({});

			// Multiple key comparisons
			expect(diff({ a: 1, b: 1 }, { b: 2 })).to.deep.equal({
				a: undefined,
				b: 2,
			});

			// Multiple target keys
			expect(diff({ a: 1 }, { b: 2, c: 1 })).to.deep.equal({
				a: undefined,
				b: 2,
				c: 1,
			});

			// Removing a branch
			expect(diff({ a: 1, b: { c: 1 } }, { a: 1 })).to.deep.equal({
				b: undefined,
			});

			// If the arrays are different, return target array
			expect(diff({ a: [1, 2] }, { a: [2, 3] })).to.deep.equal({ a: [2, 3] });

			// Value to object
			expect(diff({ a: 1 }, { a: { c: 1 }, b: 2 })).to.deep.equal({
				a: { c: 1 },
				b: 2,
			});

			// Changes in nested object
			expect(diff({ a: { c: 1 } }, { a: { c: 1, d: 2 }, b: 3 })).to.deep.equal({
				a: { d: 2 },
				b: 3,
			});

			// Multiple level nested objects with value removal
			expect(
				diff({ a: { c: { f: 1, g: 2 } } }, { a: { c: { f: 2 }, d: 2 }, b: 3 }),
			).to.deep.equal({
				a: { c: { f: 2, g: undefined }, d: 2 },
				b: 3,
			});
		});
	});

	describe('shallowDiff', () => {
		it('compares objects only to the given depth', () => {
			expect(shallowDiff({ a: 1 }, { a: 1 }, 0)).to.deep.equal({ a: 1 });
			expect(shallowDiff({ a: 1 }, { a: 1 }, 1)).to.deep.equal({});
			expect(shallowDiff({ a: 1 }, { a: 1 }, 2)).to.deep.equal({});
			expect(shallowDiff({ a: 1, b: 1 }, { a: 1 }, 1)).to.deep.equal({
				b: undefined,
			});
			expect(
				shallowDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }, 1),
			).to.deep.equal({});
			expect(
				shallowDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2, d: 3 } }, 1),
			).to.deep.equal({ b: { c: 2, d: 3 } });
			expect(
				shallowDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2, d: 3 } }, 2),
			).to.deep.equal({ b: { d: 3 } });
		});
	});

	describe('prune', () => {
		it('does not remove empty arrays or other "empty values"', () => {
			expect(prune([])).to.deep.equal([]);
			expect(prune([0])).to.deep.equal([0]);
			expect(prune(0)).to.deep.equal(0);
			expect(prune({ a: 0 })).to.deep.equal({ a: 0 });
			expect(prune({ a: [] })).to.deep.equal({ a: [] });
			expect(prune({ a: [], b: 0 })).to.deep.equal({ a: [], b: 0 });
		});
		it('removes empty branches from a json object', () => {
			expect(prune({})).to.deep.equal({});
			expect(prune({ a: {} })).to.deep.equal({});
			expect(prune({ a: { b: {} } })).to.deep.equal({});
			expect(prune({ a: 1, b: {} })).to.deep.equal({ a: 1 });
			expect(prune({ a: 1, b: {}, c: { d: 2, e: {} } })).to.deep.equal({
				a: 1,
				c: { d: 2 },
			});
			expect(prune({ a: 1, b: {}, c: { d: 2, e: [] } })).to.deep.equal({
				a: 1,
				c: { d: 2, e: [] },
			});
		});
	});
});
