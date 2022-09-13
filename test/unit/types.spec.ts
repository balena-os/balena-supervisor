import { expect } from 'chai';
import * as t from 'io-ts';

import { withDefault } from '~/src/types';

describe('types', () => {
	describe('withDefault', () => {
		it('decodes object values', () => {
			expect(withDefault(t.record(t.string, t.string), {}).decode(undefined))
				.to.have.property('right')
				.that.deep.equals({});

			expect(withDefault(t.record(t.string, t.string), {}).decode(null))
				.to.have.property('right')
				.that.deep.equals({});

			expect(withDefault(t.record(t.string, t.string), {}).decode({}))
				.to.have.property('right')
				.that.deep.equals({});

			expect(
				withDefault(t.record(t.string, t.string), {}).decode({ dummy: 'yes' }),
			)
				.to.have.property('right')
				.that.deep.equals({ dummy: 'yes' });
		});

		it('decodes boolean values', () => {
			expect(withDefault(t.boolean, true).decode(undefined))
				.to.have.property('right')
				.that.equals(true);

			expect(withDefault(t.boolean, true).decode(null))
				.to.have.property('right')
				.that.equals(true);

			expect(withDefault(t.boolean, true).decode(false))
				.to.have.property('right')
				.that.equals(false);
		});
	});
});
