import { expect } from 'chai';
import { isRight, isLeft } from 'fp-ts/lib/Either';

import { schemaTypes } from '~/src/config/schema-type';

describe('SchemaType', () => {
	describe('os.power.mode / os.fan.profile', () => {
		it('should decode to right if managed configs are present', () => {
			const managedOsConfig = {
				power: {
					mode: 'low',
				},
				fan: {
					profile: 'quiet',
				},
			};
			const decoded = schemaTypes.os.type.decode(managedOsConfig);

			expect(isRight(decoded)).to.be.true;
			expect((decoded as any).right).to.deep.equal({
				power: { mode: 'low' },
				fan: { profile: 'quiet' },
			});
		});

		it('should decode to right if managed configs are partially present', () => {
			const powerMode = {
				power: {
					mode: 'high',
				},
			};
			const decoded = schemaTypes.os.type.decode(powerMode);

			expect(isRight(decoded)).to.be.true;
			expect((decoded as any).right).to.deep.equal({
				power: { mode: 'high' },
			});

			const fanProfile = {
				fan: {
					profile: 'cool',
				},
			};
			const decodedFanProfile = schemaTypes.os.type.decode(fanProfile);

			expect(isRight(decodedFanProfile)).to.be.true;
			expect((decodedFanProfile as any).right).to.deep.equal({
				fan: { profile: 'cool' },
			});
		});

		it('should decode to right while filtering out unrelated keys', () => {
			const configWithExtras = {
				power: {
					mode: 'high',
					someKey: 'someValue',
				},
				fan: {
					otherKey: 'otherValue',
				},
			};
			const decoded = schemaTypes.os.type.decode(configWithExtras);

			expect(isRight(decoded)).to.be.true;
			expect((decoded as any).right).to.deep.equal({
				power: { mode: 'high' },
				fan: {},
			});
		});

		it('should decode to right as empty object if no managed configs are present', () => {
			const decoded = schemaTypes.os.type.decode({});

			expect(isRight(decoded)).to.be.true;
			expect((decoded as any).right).to.deep.equal({});
		});

		it('should decode to left if managed configs are not the right type', () => {
			const decoded = schemaTypes.os.type.decode({
				power: 'high',
				fan: {
					profile: 123,
				},
			});

			expect(isLeft(decoded)).to.be.true;
		});

		it('should filter out unmanaged fields', () => {
			const withUnmanagedFields = {
				power: {
					mode: 'high',
					someKey: 'someValue',
				},
				fan: {
					profile: 'cool',
					otherKey: 'otherValue',
				},
				network: {
					connectivity: {
						uri: 'https://api.balena-cloud.com/connectivity-check',
						interval: '300',
						response: 'optional value in the response',
					},
					wifi: {
						randomMacAddressScan: false,
					},
				},
			};
			const decoded = schemaTypes.os.type.decode(withUnmanagedFields);

			expect(isRight(decoded)).to.be.true;
			expect((decoded as any).right).to.deep.equal({
				power: { mode: 'high' },
				fan: { profile: 'cool' },
			});
		});
	});
});
