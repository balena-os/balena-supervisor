import { expect } from 'chai';
import * as semver from 'semver';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import * as osRelease from '~/lib/os-release';
import supervisorVersion = require('~/lib/supervisor-version');
import * as fsUtils from '~/lib/fs-utils';

describe('lib/contracts', () => {
	type Contracts = typeof import('~/src/lib/contracts');
	const contracts = require('~/src/lib/contracts') as Contracts; // eslint-disable-line
	before(() => {
		contracts.initializeContractRequirements({
			supervisorVersion,
			deviceType: 'intel-nuc',
			deviceArch: 'amd64',
			l4tVersion: '32.2',
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
			return Promise.all([
				expect(() => contracts.parseContract({ type: 1234 })).to.throw(),
				expect(() =>
					contracts.parseContract({ slug: true, name: 'test' }),
				).to.throw(),
				expect(() =>
					contracts.parseContract({ requires: 'my-requirement' }),
				).to.throw(),
			]);
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
	});

	describe('Requirement resolution', () => {
		// Because the supervisor version will change whenever the
		// package.json will, we generate values which are above
		// and below the current value, and use these to reason
		// about the contract engine results
		const supervisorVersionGreater = `${
			semver.major(supervisorVersion)! + 1
		}.0.0`;
		const supervisorVersionLesser = `${
			semver.major(supervisorVersion)! - 1
		}.0.0`;

		before(async () => {
			// We ensure that the versions we're using for testing
			// are the same as the time of implementation, otherwise
			// these tests could fail or succeed when they shouldn't
			// expect(await osRelease.getOSSemver(constants.hostOSVersionPath)).to.equal(
			// 	'2.0.6',
			// );
			expect(semver.gt(supervisorVersionGreater, supervisorVersion)).to.be.true;
			expect(semver.lt(supervisorVersionLesser, supervisorVersion)).to.be.true;
		});

		it('Should correctly run containers with no requirements', async () => {
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

		it('should correctly run containers whose requirements are satisfied', async () => {
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
								// sw.os is not provided by the device contract so it should not be validated
								{
									type: 'sw.os',
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
		});

		it('should refuse to run containers whose requirements are not satisfied', async () => {
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
			it('should correctly run passing optional containers', async () => {
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

			it('should corrrectly omit failing optional containers', async () => {
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

	describe('L4T version detection', () => {
		let execStub: SinonStub;

		const seedExec = (version: string) => {
			execStub = stub(fsUtils, 'exec').resolves({
				stdout: Buffer.from(version),
				stderr: Buffer.from(''),
			});
		};

		afterEach(() => {
			execStub.restore();
		});

		it('should correctly parse L4T version strings', async () => {
			seedExec('4.9.140-l4t-r32.2+g3dcbed5');
			expect(await osRelease.getL4tVersion()).to.equal('32.2.0');
			expect(execStub.callCount).to.equal(1);
			execStub.restore();

			seedExec('4.4.38-l4t-r28.2+g174510d');
			expect(await osRelease.getL4tVersion()).to.equal('28.2.0');
			expect(execStub.callCount).to.equal(1);
		});

		it('should correctly handle l4t versions which contain three numbers', async () => {
			seedExec('4.4.38-l4t-r32.3.1+g174510d');
			expect(await osRelease.getL4tVersion()).to.equal('32.3.1');
			expect(execStub.callCount).to.equal(1);
		});

		it('should return undefined when there is no l4t string in uname', async () => {
			seedExec('4.18.14-yocto-standard');
			expect(await osRelease.getL4tVersion()).to.be.undefined;
		});

		describe('L4T comparison', () => {
			const seedEngine = async (version: string) => {
				const engine = require('~/src/lib/contracts') as Contracts; // eslint-disable-line

				seedExec(version);
				engine.initializeContractRequirements({
					supervisorVersion,
					deviceType: 'intel-nuc',
					deviceArch: 'amd64',
					l4tVersion: await osRelease.getL4tVersion(),
				});

				return engine;
			};

			it('should allow semver matching even when l4t does not fulfill semver', async () => {
				const engine = await seedEngine('4.4.38-l4t-r31.0');

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

			it('should allow semver matching when l4t does fulfill semver', async () => {
				const engine = await seedEngine('4.4.38-l4t-r31.0.1');

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
	});
});
