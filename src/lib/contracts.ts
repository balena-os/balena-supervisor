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

const VALID_REQUIRE_TYPES = ['sw.os', 'sw.supervisor'];

export interface ServiceContracts {
	[serviceName: string]: { contract?: ContractObject; optional: boolean };
}

export async function containerContractsFulfilled(
	serviceContracts: ServiceContracts,
): Promise<{
	valid: boolean;
	unmetServices: string[];
	fulfilledServices: string[];
	unmetAndOptional: string[];
}> {
	const containers = _(serviceContracts)
		.map('contract')
		.compact()
		.value();

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

	universe.addChildren([
		osContract,
		supervisorContract,
		...containers.map(c => new Contract(c)),
	]);

	const solution = blueprint.reproduce(universe);

	if (solution.length > 1) {
		throw new InternalInconsistencyError(
			'More than one solution available for container contracts when only one is expected!',
		);
	}
	if (solution.length === 0) {
		return {
			valid: false,
			unmetServices: _.keys(serviceContracts),
			fulfilledServices: [],
			unmetAndOptional: [],
		};
	}

	// Detect how many containers are present in the resulting
	// solution
	const children = solution[0].getChildren({
		types: new Set(['sw.container']),
	});

	if (children.length === containers.length) {
		return {
			valid: true,
			unmetServices: [],
			fulfilledServices: _.keys(serviceContracts),
			unmetAndOptional: [],
		};
	} else {
		// If we got here, it means that at least one of the
		// container contracts was not fulfilled. If *all* of
		// those containers whose contract was not met are
		// marked as optional, the target state is still valid,
		// but we ignore the optional containers

		const [fulfilledServices, unfulfilledServices] = _.partition(
			_.keys(serviceContracts),
			serviceName => {
				const { contract } = serviceContracts[serviceName];
				if (!contract) {
					return true;
				}
				// Did we find the contract in the generated state?
				return _.some(children, child =>
					_.isEqual((child as any).raw, contract),
				);
			},
		);

		const [unmetAndRequired, unmetAndOptional] = _.partition(
			unfulfilledServices,
			serviceName => {
				return !serviceContracts[serviceName].optional;
			},
		);

		return {
			valid: unmetAndRequired.length === 0,
			unmetServices: unfulfilledServices,
			fulfilledServices,
			unmetAndOptional,
		};
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
	const contractObj = result.right;
	if (contractObj.requires != null) {
		for (const require of contractObj.requires) {
			if (!_.includes(VALID_REQUIRE_TYPES, require.type)) {
				throw new Error(
					`${require.type} is not a valid contract requirement target`,
				);
			}
		}
	}

	return true;
}
