import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import Reporter from 'io-ts-reporters';
import * as _ from 'lodash';

import { Blueprint, Contract, ContractObject } from '@balena/contrato';

import { ContractValidationError, InternalInconsistencyError } from './errors';
import { checkTruthy } from './validation';
import { TargetApps } from '../types';

export { ContractObject };

export interface ApplicationContractResult {
	valid: boolean;
	unmetServices: string[];
	fulfilledServices: string[];
	unmetAndOptional: string[];
}

export interface ServiceContracts {
	[serviceName: string]: { contract?: ContractObject; optional: boolean };
}

type PotentialContractRequirements =
	| 'sw.supervisor'
	| 'sw.l4t'
	| 'hw.device-type';
type ContractRequirements = {
	[key in PotentialContractRequirements]?: string;
};

const contractRequirementVersions: ContractRequirements = {};

export function initializeContractRequirements(opts: {
	supervisorVersion: string;
	deviceType: string;
	l4tVersion?: string;
}) {
	contractRequirementVersions['sw.supervisor'] = opts.supervisorVersion;
	contractRequirementVersions['sw.l4t'] = opts.l4tVersion;
	contractRequirementVersions['hw.device-type'] = opts.deviceType;
}

function isValidRequirementType(
	requirementVersions: ContractRequirements,
	requirement: string,
) {
	return requirement in requirementVersions;
}

export function containerContractsFulfilled(
	serviceContracts: ServiceContracts,
): ApplicationContractResult {
	const containers = _(serviceContracts).map('contract').compact().value();

	const blueprintMembership: Dictionary<number> = {};
	for (const component of _.keys(contractRequirementVersions)) {
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
		[
			...getContractsFromVersions(contractRequirementVersions),
			...containers,
		].map((c) => new Contract(c)),
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
			(serviceName) => {
				const { contract } = serviceContracts[serviceName];
				if (!contract) {
					return true;
				}
				// Did we find the contract in the generated state?
				return _.some(children, (child) =>
					_.isEqual((child as any).raw, contract),
				);
			},
		);

		const [unmetAndRequired, unmetAndOptional] = _.partition(
			unfulfilledServices,
			(serviceName) => {
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

function getContractsFromVersions(components: ContractRequirements) {
	return _.map(components, (value, component) => {
		if (component === 'hw.device-type') {
			return {
				type: component,
				slug: value,

				name: value,
			};
		} else {
			return {
				type: component,
				slug: component,
				name: component,
				version: value,
			};
		}
	});
}

export function validateContract(contract: unknown): boolean {
	const result = contractObjectValidator.decode(contract);

	if (isLeft(result)) {
		throw new Error(Reporter.report(result).join('\n'));
	}

	const requirementVersions = contractRequirementVersions;

	for (const { type } of result.right.requires || []) {
		if (!isValidRequirementType(requirementVersions, type)) {
			throw new Error(`${type} is not a valid contract requirement type`);
		}
	}

	return true;
}
export function validateTargetContracts(
	apps: TargetApps,
): Dictionary<ApplicationContractResult> {
	return Object.keys(apps)
		.map((appUuid): [string, ApplicationContractResult] => {
			const app = apps[appUuid];
			const [release] = Object.values(app.releases);
			const serviceContracts = Object.keys(release?.services ?? [])
				.map((serviceName) => {
					const service = release.services[serviceName];
					const { contract } = service;
					if (contract) {
						try {
							// Validate the contract syntax
							validateContract(contract);

							return {
								serviceName,
								contract,
								optional: checkTruthy(
									service.labels?.['io.balena.features.optional'],
								),
							};
						} catch (e: any) {
							throw new ContractValidationError(serviceName, e.message);
						}
					}

					// Return a default contract for the service if no contract is defined
					return { serviceName, contract: undefined, optional: false };
				})
				// map by serviceName
				.reduce(
					(contracts, { serviceName, ...serviceContract }) => ({
						...contracts,
						[serviceName]: serviceContract,
					}),
					{} as ServiceContracts,
				);

			if (Object.keys(serviceContracts).length > 0) {
				// Validate service contracts if any
				return [appUuid, containerContractsFulfilled(serviceContracts)];
			}

			// Return success if no services are found
			return [
				appUuid,
				{
					valid: true,
					fulfilledServices: Object.keys(release?.services ?? []),
					unmetAndOptional: [],
					unmetServices: [],
				},
			];
		})
		.reduce(
			(result, [appUuid, contractFulfilled]) => ({
				...result,
				[appUuid]: contractFulfilled,
			}),
			{} as Dictionary<ApplicationContractResult>,
		);
}
