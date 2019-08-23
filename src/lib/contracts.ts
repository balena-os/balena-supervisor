import * as _ from 'lodash';

import { Blueprint, Contract, ContractObject } from '@balena/contrato';

import constants = require('./constants');
import { InternalInconsistencyError } from './errors';
import * as osRelease from './os-release';
import supervisorVersion = require('./supervisor-version');

export async function containerContractsFulfilled(
	containers: ContractObject[],
): Promise<boolean> {
	const osContract = new Contract({
		slug: 'balenaOS',
		type: 'sw.os',
		name: 'balenaOS',
		version: await osRelease.getOSSemver(constants.hostOSVersionPath),
	});

	const supervisorContract = new Contract({
		slug: 'balena-supervisor',
		type: 'sw.supervisor',
		name: 'balena-supervisor',
		version: supervisorVersion,
	});

	const blueprint = new Blueprint(
		{
			'sw.os': 1,
			'sw.supervisor': 1,
			'sw.container': '1+',
		},
		{
			type: 'sw.runnable.configuration',
			slug: '{{children.sw.container.slug}}',
		},
	);

	const universe = new Contract({
		type: 'meta.universe',
	});

	universe.addChildren(
		[osContract, supervisorContract].concat(
			containers.map(c => new Contract(c)),
		),
	);

	const solution = blueprint.reproduce(universe);

	if (solution.length > 1) {
		throw new InternalInconsistencyError(
			'More than one solution available for container contracts when only one is expected!',
		);
	}
	if (solution.length === 0) {
		return false;
	}

	// Detect how many containers are present in the resulting
	// solution
	const children = solution[0].getChildren({
		types: new Set(['sw.container']),
	});
	return children.length === containers.length;
}
