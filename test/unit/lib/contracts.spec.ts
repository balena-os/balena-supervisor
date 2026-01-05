import { expect } from 'chai';
import * as semver from 'semver';

import supervisorVersion from '~/lib/supervisor-version';

describe('lib/contracts', () => {
	type Contracts = typeof import('~/src/lib/contracts');
	const contracts = require('~/src/lib/contracts') as Contracts; // eslint-disable-line
	const OS_VERSION = '5.5.5+rev3';
	before(() => {
		contracts.initializeContractRequirements({
			supervisorVersion,
			deviceType: 'intel-nuc',
			deviceArch: 'amd64',
			l4tVersion: '32.2',
			osVersion: OS_VERSION,
			osSlug: 'balena-os',
		});
	});

	describe('Contract validation', () => {
		it('should correctly validate a contract with no requirements', () =>
			expect(() =>
				contracts.parseContract({
					slug: 'user-container',
				}),
			).to.be.not.throw());

		it('should correctly validate a contract with extra fields', () =>
			expect(() =>
				contracts.parseContract({
					slug: 'user-container',
					name: 'user-container',
					version: '3.0.0',
				}),
			).to.be.not.throw());

		it('should not validate a contract with fields of invalid type', () => {
			expect(() => contracts.parseContract({ type: 1234 })).to.throw();
			expect(() =>
				contracts.parseContract({ slug: true, name: 'test' }),
			).to.throw();
			expect(() =>
				contracts.parseContract({ requires: 'my-requirement' }),
			).to.throw();
		});

		it('should correctly validate a contract with requirements', () => {
			expect(() =>
				contracts.parseContract({
					slug: 'user-container',
					requires: [
						{
							type: 'sw.l4t',
							version: '32.2',
						},
						{
							type: 'sw.supervisor',
						},
						{ type: 'hw.device-type', slug: 'raspberrypi3' },
						{ type: 'arch.sw', slug: 'aarch64' },
						{ type: 'sw.os' },
					],
				}),
			).to.not.throw();
		});

		it('should not validate a contract with requirements without the minimum required fields', () => {
			return expect(() =>
				contracts.parseContract({
					slug: 'user-container',
					requires: [
						{
							version: '>3.0.0',
						},
					],
				}),
			).to.throw();
		});

		it('should ignore unsupported requirement properties', () => {
			expect(
				contracts.parseContract({
					slug: 'user-container',
					requires: [
						{
							type: 'sw.l4t',
							version: '32.2',
							name: 'l4t-version',
							unsupported: 'something',
						},
						{
							type: 'hw.device-type',
							slug: 'raspberrypi3',
							name: 'raspberrypi3',
						},
					],
				}),
			).to.deep.equal({
				type: 'sw.container',
				slug: 'user-container',
				requires: [
					{
						type: 'sw.l4t',
						version: '32.2',
					},
					{
						type: 'hw.device-type',
						slug: 'raspberrypi3',
					},
				],
			});
		});

		it('should parse a contract with multiple children listed in "or" requirements', () => {
			expect(() =>
				contracts.parseContract({
					slug: 'user-container',
					requires: [
						{
							or: [
								{ type: 'sw.os', slug: 'balena-os', version: OS_VERSION },
								{ type: 'sw.os', slug: 'ubuntu', version: '20.04' },
							],
						},
					],
				}),
			).to.not.throw();
		});

		it('should reject if a contract has an unsupported type', () => {
			expect(() =>
				contracts.parseContract({
					slug: 'user-container',
					requires: [{ type: 'sw.unsupported' }],
				}),
			).to.throw(
				contracts.InvalidContractTypeError,
				'sw.unsupported is not a valid contract requirement type',
			);
		});

		it('should reject if a contract has an "or" clause with an unsupported type', () => {
			expect(() =>
				contracts.parseContract({
					slug: 'user-container',
					requires: [
						{ or: [{ type: 'sw.unsupported' }, { type: 'sw.supervisor' }] },
					],
				}),
			).to.throw(
				contracts.InvalidContractTypeError,
				'sw.unsupported is not a valid contract requirement type',
			);
		});
	});

	describe('Requirement resolution', () => {
		// Because the supervisor version will change whenever the
		// package.json will, we generate values which are above
		// and below the current value, and use these to reason
		// about the contract engine results
		const supervisorVersionGreater = `${
			semver.major(supervisorVersion) + 1
		}.0.0`;
		const supervisorVersionLesser = `${
			semver.major(supervisorVersion) - 1
		}.0.0`;

		before(() => {
			// We ensure that the versions we're using for testing
			// are the same as the time of implementation, otherwise
			// these tests could fail or succeed when they shouldn't
			// expect(await osRelease.getOSSemver(constants.hostOSVersionPath)).to.equal(
			// 	'2.0.6',
			// );
			expect(semver.gt(supervisorVersionGreater, supervisorVersion)).to.be.true;
			expect(semver.lt(supervisorVersionLesser, supervisorVersion)).to.be.true;
		});

		it('Should correctly run containers with no requirements', () => {
			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							slug: 'user-container',
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);
			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							slug: 'user-container1',
						},
						optional: false,
					},
					{
						commit: 'd0',
						serviceName: 'service2',
						contract: {
							type: 'sw.container',
							slug: 'user-container2',
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);
		});

		it('should correctly run containers whose requirements are satisfied', () => {
			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.supervisor',
									version: `>${supervisorVersionLesser}`,
								},
								{ type: 'hw.device-type', slug: 'intel-nuc' },
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);

			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.supervisor',
									version: `<${supervisorVersionGreater}`,
								},
								{ type: 'arch.sw', slug: 'amd64' },
								{ type: 'hw.device-type', slug: 'intel-nuc' },
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);

			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.supervisor',
									version: `>${supervisorVersionLesser}`,
								},
								{ type: 'arch.sw', slug: 'amd64' },
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);

			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.supervisor',
									version: `>${supervisorVersionLesser}`,
								},
								{
									type: 'sw.l4t',
									version: '32.2',
								},
								{ type: 'hw.device-type', slug: 'intel-nuc' },
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);

			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container1',
							slug: 'user-container1',
							requires: [
								{
									type: 'sw.supervisor',
									version: `>${supervisorVersionLesser}`,
								},
							],
						},
						optional: false,
					},
					{
						commit: 'd0',
						serviceName: 'service2',
						contract: {
							type: 'sw.container',
							name: 'user-container1',
							slug: 'user-container1',
							requires: [
								// sw.blah is not provided by the device contract so it shouldn't be validated
								{
									type: 'sw.blah',
									version: '<3.0.0',
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(false);

			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							// This obvious contract should be valid
							requires: [{ type: 'hw.device-type' }],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);
		});

		it('should refuse to run containers whose requirements are not satisfied', () => {
			let fulfilled = contracts.containerContractsFulfilled([
				{
					commit: 'd0',
					serviceName: 'service',
					contract: {
						type: 'sw.container',
						slug: 'user-container',
						requires: [
							{
								type: 'sw.supervisor',
								version: `>=${supervisorVersionGreater}`,
							},
						],
					},
					optional: false,
				},
			]);
			expect(fulfilled).to.have.property('valid').that.equals(false);
			expect(fulfilled).to.have.property('unmetServices').with.lengthOf(1);
			expect(fulfilled.unmetServices[0]).to.deep.include({
				serviceName: 'service',
				commit: 'd0',
			});

			fulfilled = contracts.containerContractsFulfilled([
				{
					commit: 'd0',
					serviceName: 'service',
					contract: {
						type: 'sw.container',
						name: 'user-container',
						slug: 'user-container',
						requires: [
							{
								type: 'hw.device-type',
								slug: 'raspberrypi3',
							},
						],
					},
					optional: false,
				},
			]);
			expect(fulfilled).to.have.property('valid').that.equals(false);
			expect(fulfilled).to.have.property('unmetServices').with.lengthOf(1);
			expect(fulfilled.unmetServices[0]).to.deep.include({
				serviceName: 'service',
				commit: 'd0',
			});

			fulfilled = contracts.containerContractsFulfilled([
				{
					commit: 'd0',
					serviceName: 'service',
					contract: {
						type: 'sw.container',
						name: 'user-container',
						slug: 'user-container',
						requires: [
							{
								type: 'arch.sw',
								slug: 'armv7hf',
							},
						],
					},
					optional: false,
				},
			]);
			expect(fulfilled).to.have.property('valid').that.equals(false);
			expect(fulfilled).to.have.property('unmetServices').with.lengthOf(1);
			expect(fulfilled.unmetServices[0]).to.deep.include({
				serviceName: 'service',
				commit: 'd0',
			});

			fulfilled = contracts.containerContractsFulfilled([
				{
					commit: 'd0',
					serviceName: 'service',
					contract: {
						type: 'sw.container',
						name: 'user-container',
						slug: 'user-container',
						requires: [
							{
								type: 'hw.device-type',
								name: 'raspberrypi3',
							},
						],
					},
					optional: false,
				},
			]);
			expect(fulfilled).to.have.property('valid').that.equals(false);
			expect(fulfilled).to.have.property('unmetServices').with.lengthOf(1);
			expect(fulfilled.unmetServices[0]).to.deep.include({
				serviceName: 'service',
				commit: 'd0',
			});

			fulfilled = contracts.containerContractsFulfilled([
				{
					commit: 'd0',
					serviceName: 'service2',
					contract: {
						type: 'sw.container',
						name: 'user-container2',
						slug: 'user-container2',
						requires: [
							{
								type: 'sw.l4t',
								version: '28.2',
							},
						],
					},
					optional: false,
				},
			]);
			expect(fulfilled).to.have.property('valid').that.equals(false);
			expect(fulfilled).to.have.property('unmetServices').with.lengthOf(1);
			expect(fulfilled.unmetServices[0]).to.deep.include({
				serviceName: 'service2',
				commit: 'd0',
			});

			fulfilled = contracts.containerContractsFulfilled([
				{
					commit: 'd0',
					serviceName: 'service',
					contract: {
						type: 'sw.container',
						name: 'user-container1',
						slug: 'user-container1',
						requires: [
							{
								type: 'sw.supervisor',
								version: `>=${supervisorVersionLesser}`,
							},
						],
					},
					optional: false,
				},
				{
					commit: 'd0',
					serviceName: 'service2',
					contract: {
						type: 'sw.container',
						name: 'user-container2',
						slug: 'user-container2',
						requires: [
							{
								type: 'sw.supervisor',
								version: `<=${supervisorVersionLesser}`,
							},
						],
					},
					optional: false,
				},
			]);
			expect(fulfilled).to.have.property('valid').that.equals(false);
			expect(fulfilled).to.have.property('unmetServices').with.lengthOf(1);
			expect(fulfilled.unmetServices[0]).to.deep.include({
				serviceName: 'service2',
				commit: 'd0',
			});
		});

		describe('Optional containers', () => {
			it('should correctly run passing optional containers', () => {
				const { valid, unmetServices, fulfilledServices } =
					contracts.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service1',
							contract: {
								type: 'sw.container',
								slug: 'service1',
								requires: [
									{
										type: 'sw.supervisor',
										version: `<${supervisorVersionGreater}`,
									},
								],
							},
							optional: true,
						},
					]);

				expect(valid).to.equal(true);
				expect(unmetServices).to.deep.equal([]);
				expect(fulfilledServices[0]).to.deep.include({
					serviceName: 'service1',
					commit: 'd0',
				});
			});

			it('should corrrectly omit failing optional containers', () => {
				const { valid, unmetServices, fulfilledServices } =
					contracts.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service1',
							contract: {
								type: 'sw.container',
								slug: 'service1',
								requires: [
									{
										type: 'sw.supervisor',
										version: `>${supervisorVersionGreater}`,
									},
								],
							},
							optional: true,
						},
						{
							commit: 'd0',
							serviceName: 'service2',
							contract: {
								type: 'sw.container',
								slug: 'service2',
							},
							optional: false,
						},
						{
							commit: 'd0',
							serviceName: 'service3',
							contract: {
								type: 'sw.container',
								slug: 'service3',
								requires: [
									{
										type: 'hw.device-type',
										slug: 'raspberrypi3',
									},
								],
							},
							optional: true,
						},
						{
							commit: 'd0',
							serviceName: 'service4',
							contract: {
								type: 'sw.container',
								slug: 'service4',
								requires: [
									{
										type: 'arch.sw',
										slug: 'armv7hf',
									},
								],
							},
							optional: true,
						},
					]);
				expect(valid).to.equal(true);
				expect(unmetServices.map((s) => s.serviceName)).to.deep.equal([
					'service1',
					'service3',
					'service4',
				]);
				expect(fulfilledServices).to.have.lengthOf(1);
				expect(fulfilledServices[0]).to.deep.include({
					serviceName: 'service2',
					commit: 'd0',
				});
			});
		});
	});

	describe('OS version and slug resolution', () => {
		const fulfillableVersionStrings = [
			`>=${OS_VERSION}`,
			`<=${OS_VERSION}`,
			`${semver.major(OS_VERSION)}`,
			`${semver.major(OS_VERSION)}.*`,
			`${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION)}`,
			`${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION)}.*`,
			`${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION)}.${semver.patch(OS_VERSION)}`,
			`${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION)}.${semver.patch(OS_VERSION)}+rev*`,
			`${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION)}.${semver.patch(OS_VERSION)}+rev420`,
			`>${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION) - 1}.${semver.patch(OS_VERSION)}`,
			`<${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION) + 1}.${semver.patch(OS_VERSION)}`,
		];
		const unfulfillableVersionStrings = [
			`<=2.0.0`,
			`>=420.0.0`,
			`>${OS_VERSION}`,
			`<${OS_VERSION}`,
			`${semver.major(OS_VERSION) + 1}.*`,
			`${semver.major(OS_VERSION)}.${semver.minor(OS_VERSION)}.${semver.patch(OS_VERSION) + 1}`,
		];

		it('should fulfill OS version requirements', () => {
			for (const version of fulfillableVersionStrings) {
				expect(
					contracts.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								name: 'user-container',
								slug: 'user-container',
								requires: [{ type: 'sw.os', version, slug: 'balena-os' }],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(true);
			}
		});

		it('should reject OS version requirements which are not fulfillable', () => {
			for (const version of unfulfillableVersionStrings) {
				expect(
					contracts.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								name: 'user-container',
								slug: 'user-container',
								requires: [{ type: 'sw.os', version, slug: 'balena-os' }],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(false);
			}
		});

		const fulfillableSlugStrings = ['balena-os'];
		const unfulfillableSlugStrings = ['ubuntu'];

		it('should fulfill OS slug requirements', () => {
			for (const slug of fulfillableSlugStrings) {
				expect(
					contracts.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								name: 'user-container',
								slug: 'user-container',
								requires: [{ type: 'sw.os', slug, version: OS_VERSION }],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(true);
			}
		});

		it('should reject OS slug requirements which are not fulfillable', () => {
			for (const slug of unfulfillableSlugStrings) {
				expect(
					contracts.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								name: 'user-container',
								slug: 'user-container',
								requires: [{ type: 'sw.os', slug, version: OS_VERSION }],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(false);
			}
		});

		it('should fulfill one of multiple sw.os requirements given one of them is valid', () => {
			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							requires: [
								{
									or: [
										{ type: 'sw.os', slug: 'balena-os', version: OS_VERSION },
										{ type: 'sw.os', slug: 'ubuntu', version: '20.04' },
									],
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);
		});
	});

	describe('L4T version resolution', () => {
		const seedEngine = (version: string) => {
			const engine = require('~/src/lib/contracts') as Contracts; // eslint-disable-line
			engine.initializeContractRequirements({
				supervisorVersion,
				deviceType: 'intel-nuc',
				deviceArch: 'amd64',
				l4tVersion: version,
			});

			return engine;
		};

		it('should allow semver matching even when l4t does not fulfill semver', () => {
			const engine = seedEngine('31.0.0');
			expect(
				engine.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.l4t',
									version: '>=31.0.0',
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);

			expect(
				engine.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.l4t',
									version: '<31.0.0',
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(false);
		});

		it('should allow semver matching when l4t does fulfill semver', () => {
			const engine = seedEngine('31.0.1');

			expect(
				engine.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.l4t',
									version: '>=31.0.0',
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);

			expect(
				engine.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							slug: 'user-container',
							requires: [
								{
									type: 'sw.l4t',
									version: '<31.0.0',
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(false);
		});
	});

	describe('Kernel version and slug resolution', () => {
		const seedEngine = (version: string, slug: string) => {
			const engine = require('~/src/lib/contracts') as Contracts; // eslint-disable-line
			engine.initializeContractRequirements({
				supervisorVersion,
				deviceType: 'intel-nuc',
				deviceArch: 'amd64',
				kernelVersion: version,
				kernelSlug: slug,
			});
			return engine;
		};
		const KERNEL_VERSION = '5.15.150';
		const KERNEL_SLUG = 'linux';
		const engine = seedEngine(KERNEL_VERSION, KERNEL_SLUG);

		const fulfillableKernelVersionStrings = [
			`>=${KERNEL_VERSION}`,
			`<=${KERNEL_VERSION}`,
			`${semver.major(KERNEL_VERSION)}`,
			`${semver.major(KERNEL_VERSION)}.*`,
			`${semver.major(KERNEL_VERSION)}.${semver.minor(KERNEL_VERSION)}`,
			`${semver.major(KERNEL_VERSION)}.${semver.minor(KERNEL_VERSION)}.*`,
		];
		const unfulfillableKernelVersionStrings = [
			`<=2.0.0`,
			`>=420.0.0`,
			`>${KERNEL_VERSION}`,
			`<${KERNEL_VERSION}`,
			`${semver.major(KERNEL_VERSION) + 1}.*`,
			`${semver.major(KERNEL_VERSION)}.${semver.minor(KERNEL_VERSION)}.${semver.patch(KERNEL_VERSION) + 1}`,
			'invalid-version',
		];

		it('should fulfill kernel version requirements', () => {
			for (const version of fulfillableKernelVersionStrings) {
				expect(
					engine.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								slug: 'user-container',
								requires: [{ type: 'sw.kernel', version, slug: KERNEL_SLUG }],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(true);
			}
		});

		it('should reject kernel version requirements which are not fulfillable', () => {
			for (const version of unfulfillableKernelVersionStrings) {
				expect(
					engine.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								slug: 'user-container',
								requires: [{ type: 'sw.kernel', version, slug: KERNEL_SLUG }],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(false);
			}
		});

		const fulfillableSlugStrings = ['linux'];
		const unfulfillableSlugStrings = ['darwin', 'freebsd'];

		it('should fulfill kernel slug requirements', () => {
			for (const slug of fulfillableSlugStrings) {
				expect(
					engine.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								slug: 'user-container',
								requires: [
									{ type: 'sw.kernel', slug, version: KERNEL_VERSION },
								],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(true);
			}
		});

		it('should reject kernel slug requirements which are not fulfillable', () => {
			for (const slug of unfulfillableSlugStrings) {
				expect(
					engine.containerContractsFulfilled([
						{
							commit: 'd0',
							serviceName: 'service',
							contract: {
								type: 'sw.container',
								slug: 'user-container',
								requires: [
									{ type: 'sw.kernel', slug, version: KERNEL_VERSION },
								],
							},
							optional: false,
						},
					]),
				)
					.to.have.property('valid')
					.that.equals(false);
			}
		});

		it('should fulfill one of multiple sw.kernel requirements given one of them is valid', () => {
			expect(
				contracts.containerContractsFulfilled([
					{
						commit: 'd0',
						serviceName: 'service',
						contract: {
							type: 'sw.container',
							name: 'user-container',
							slug: 'user-container',
							requires: [
								{
									or: [
										{
											type: 'sw.kernel',
											slug: 'linux',
											version: KERNEL_VERSION,
										},
										{ type: 'sw.kernel', slug: 'darwin', version: '1.2.3' },
									],
								},
							],
						},
						optional: false,
					},
				]),
			)
				.to.have.property('valid')
				.that.equals(true);
		});
	});
});
