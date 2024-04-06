import { expect } from 'chai';
import * as t from 'io-ts';

import { withDefault, DockerName } from '~/src/types';

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

	describe('DockerName', () => {
		// Should match /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
		it('decodes valid Docker names', () => {
			const validDockerNames = [
				'a',
				'A',
				'0',
				'a0',
				'A0',
				'a.',
				'A.',
				'a-',
				'A-',
				'a_',
				'A_',
				'a.a',
				'A.A',
				'a-a',
				'A-A',
				'a_a',
				'A_A',
			];
			for (const name of validDockerNames) {
				expect(DockerName.is(name)).to.be.true;
			}
		});
	});
});
