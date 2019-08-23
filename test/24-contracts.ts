import { assert, expect } from 'chai';

import * as semver from 'balena-semver';

import * as constants from '../src/lib/constants';
import { containerContractsFulfilled } from '../src/lib/contracts';
import * as osRelease from '../src/lib/os-release';
import supervisorVersion = require('../src/lib/supervisor-version');

describe('Container contracts', () => {
	// Because the supervisor version will change whenever the
	// package.json will, we generate values which are above
	// and below the current value, and use these to reason
	// about the contract engine results
	const supervisorVersionGreater = `${semver.major(supervisorVersion)! +
		1}.0.0`;
	const supervisorVersionLesser = `${semver.major(supervisorVersion)! - 1}.0.0`;

	before(async () => {
		// We ensure that the versions we're using for testing
		// are the same as the time of implementation, otherwise
		// these tests could fail or succeed when they shouldn't
		expect(await osRelease.getOSSemver(constants.hostOSVersionPath)).to.equal(
			'2.0.6',
		);
		assert(semver.gt(supervisorVersionGreater, supervisorVersion));
		assert(semver.lt(supervisorVersionLesser, supervisorVersion));
	});

	it('Should correctly run containers with no requirements', async () => {
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container',
				},
			]),
		).to.equal(true);
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container1',
				},
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container2',
				},
			]),
		).to.equal(true);
	});

	it('should correctly run containers whose requirements are satisfied', async () => {
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container',
					requires: [
						{
							type: 'sw.os',
							version: '>2.0.0',
						},
					],
				},
			]),
		).to.equal(true);

		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container',
					requires: [
						{
							type: 'sw.supervisor',
							version: `<${supervisorVersionGreater}`,
						},
					],
				},
			]),
		).to.equal(true);
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container',
					requires: [
						{
							type: 'sw.supervisor',
							version: `>${supervisorVersionLesser}`,
						},
					],
				},
			]),
		).to.equal(true);
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container',
					requires: [
						{
							type: 'sw.supervisor',
							version: `>${supervisorVersionLesser}`,
						},
						{
							type: 'sw.os',
							version: '<3.0.0',
						},
					],
				},
			]),
		).to.equal(true);
		expect(
			await containerContractsFulfilled([
				{
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
				{
					type: 'sw.container',
					name: 'user-container1',
					slug: 'user-container1',
					requires: [
						{
							type: 'sw.os',
							version: '<3.0.0',
						},
					],
				},
			]),
		).to.equal(true);
	});

	it('Should refuse to run containers whose requirements are not satisfied', async () => {
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container',
					slug: 'user-container',
					requires: [
						{
							type: 'sw.os',
							version: '>=3.0.0',
						},
					],
				},
			]),
		).to.equal(false);
		expect(
			await containerContractsFulfilled([
				{
					type: 'sw.container',
					name: 'user-container2',
					slug: 'user-container2',
					requires: [
						{
							type: 'sw.supervisor',
							version: `>=${supervisorVersionLesser}`,
						},
						{
							type: 'sw.os',
							version: '>3.0.0',
						},
					],
				},
			]),
		).to.equal(false);
		expect(
			await containerContractsFulfilled([
				{
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
				{
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
			]),
		).to.equal(false);
	});
});
