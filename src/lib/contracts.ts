import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import { reporter } from 'io-ts-reporters';
import * as _ from 'lodash';

import { Blueprint, Contract, ContractObject } from '@balena/contrato';

import constants = require('./constants');
import { InternalInconsistencyError } from './errors';
import * as osRelease from './os-release';
import supervisorVersion = require('./supervisor-version');

export { ContractObject };

export interface ServiceContracts {
	[serviceName: string]: ContractObject;
}

export async function containerContractsFulfilled(
	serviceContracts: ServiceContracts,
): Promise<{ valid: boolean; unmetServices: string[] }> {
	const containers = _.values(serviceContracts);

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
		return { valid: false, unmetServices: _.keys(serviceContracts) };
	}

	// Detect how many containers are present in the resulting
	// solution
	const children = solution[0].getChildren({
		types: new Set(['sw.container']),
	});

	if (children.length === containers.length) {
		return { valid: true, unmetServices: [] };
	} else {
		// Work out which service violated the contracts they
		// provided
		const unmetServices = _(serviceContracts)
			.map((contract, serviceName) => {
				const found = _.find(children, child => {
					return _.isEqual((child as any).raw, contract);
				});
				if (found == null) {
					return serviceName;
				}
				return;
			})
			.filter(n => n != null)
			.value() as string[];
		return { valid: false, unmetServices };
	}
}

const contractObjectValidator = t.type({
	slug: t.string,
	requires: t.union([
		t.null,
		t.undefined,
		t.array(
			t.type({
				type: t.string,
				version: t.union([t.null, t.undefined, t.string]),
			}),
		),
	]),
});

export function validateContract(
	contract: unknown,
): contract is ContractObject {
	const result = contractObjectValidator.decode(contract);

	if (isLeft(result)) {
		throw new Error(reporter(result).join('\n'));
	}

	return true;
}
