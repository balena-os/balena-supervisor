import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import { reporter } from 'io-ts-reporters';
import * as _ from 'lodash';

import { Blueprint, Contract, ContractObject } from '@balena/contrato';

import { ContractValidationError, InternalInconsistencyError } from './errors';
import * as osRelease from './os-release';
import supervisorVersion = require('./supervisor-version');
import { checkTruthy } from './validation';

export { ContractObject };

// TODO{type}: When target and current state are correctly
// defined, replace this
interface AppWithContracts {
	services: {
		[key: string]: {
			serviceName: string;
			contract?: ContractObject;
			labels?: Dictionary<string>;
		};
	};
}

export interface ApplicationContractResult {
	valid: boolean;
	unmetServices: string[];
	fulfilledServices: string[];
	unmetAndOptional: string[];
}

export interface ServiceContracts {
	[serviceName: string]: { contract?: ContractObject; optional: boolean };
}

type PotentialContractRequirements = 'sw.supervisor' | 'sw.l4t';
type ContractRequirementVersions = {
	[key in PotentialContractRequirements]?: string;
};

let contractRequirementVersions = async () => {
	const versions: ContractRequirementVersions = {
		'sw.supervisor': supervisorVersion,
	};
	const l4tVersion = await osRelease.getL4tVersion();
	if (l4tVersion != null) {
		versions['sw.l4t'] = l4tVersion;
	}

	return versions;
};

// When running in tests, we need this function to be
// repeatedly executed, but on-device, this should only be
// executed once per run
if (process.env.TEST !== '1') {
	contractRequirementVersions = _.once(contractRequirementVersions);
}

function isValidRequirementType(
	requirementVersions: ContractRequirementVersions,
	requirement: string,
) {
	return requirement in requirementVersions;
}

export async function containerContractsFulfilled(
	serviceContracts: ServiceContracts,
): Promise<ApplicationContractResult> {
	const containers = _(serviceContracts)
		.map('contract')
		.compact()
		.value();

	const versions = await contractRequirementVersions();

	const blueprintMembership: Dictionary<number> = {};
	for (const component of _.keys(versions)) {
		blueprintMembership[component] = 1;
	}
	const blueprint = new Blueprint(
		{
			...blueprintMembership,
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
		[...getContractsFromVersions(versions), ...containers].map(
			c => new Contract(c),
		),
	);

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

function getContractsFromVersions(versions: ContractRequirementVersions) {
	return _.map(versions, (version, component) => ({
		type: component,
		slug: component,
		name: component,
		version,
	}));
}

export async function validateContract(contract: unknown): Promise<boolean> {
	const result = contractObjectValidator.decode(contract);

	if (isLeft(result)) {
		throw new Error(reporter(result).join('\n'));
	}

	const requirementVersions = await contractRequirementVersions();

	for (const { type } of result.right.requires || []) {
		if (!isValidRequirementType(requirementVersions, type)) {
			throw new Error(`${type} is not a valid contract requirement type`);
		}
	}

	return true;
}
export async function validateTargetContracts(
	apps: Dictionary<AppWithContracts>,
): Promise<Dictionary<ApplicationContractResult>> {
	const appsFulfilled: Dictionary<ApplicationContractResult> = {};

	for (const appId of _.keys(apps)) {
		const app = apps[appId];
		const serviceContracts: ServiceContracts = {};

		for (const svcId of _.keys(app.services)) {
			const svc = app.services[svcId];

			if (svc.contract) {
				try {
					await validateContract(svc.contract);

					serviceContracts[svc.serviceName] = {
						contract: svc.contract,
						optional:
							checkTruthy(svc.labels?.['io.balena.features.optional']) || false,
					};
				} catch (e) {
					throw new ContractValidationError(svc.serviceName, e.message);
				}
			} else {
				serviceContracts[svc.serviceName] = {
					contract: undefined,
					optional: false,
				};
			}

			if (!_.isEmpty(serviceContracts)) {
				appsFulfilled[appId] = await containerContractsFulfilled(
					serviceContracts,
				);
			} else {
				appsFulfilled[appId] = {
					valid: true,
					fulfilledServices: _.map(app.services, 'serviceName'),
					unmetAndOptional: [],
					unmetServices: [],
				};
			}
		}
	}
	return appsFulfilled;
}
