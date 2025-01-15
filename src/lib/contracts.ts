import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import Reporter from 'io-ts-reporters';
import _ from 'lodash';
import { TypedError } from 'typed-error';

import type { ContractObject } from '@balena/contrato';
import { Blueprint, Contract } from '@balena/contrato';

import { InternalInconsistencyError } from './errors';
import { checkTruthy } from './validation';
import type { TargetApps } from '../types';

/**
 * This error is thrown when a container contract does not
 * match the minimum we expect from it
 */
export class ContractValidationError extends TypedError {
	constructor(serviceName: string, error: string) {
		super(
			`The contract for service ${serviceName} failed validation, with error: ${error}`,
		);
	}
}

export interface ContractViolators {
	[appUuid: string]: { appName: string; appId: number; services: string[] };
}

/**
 * This error is thrown when one or releases cannot be ran
 * as one or more of their container have unmet requirements.
 * It accepts a map of app names to arrays of service names
 * which have unmet requirements.
 */
export class ContractViolationError extends TypedError {
	constructor(violators: ContractViolators) {
		const appStrings = Object.values(violators).map(
			({ appName, services }) =>
				`${appName}: Services with unmet requirements: ${services.join(', ')}`,
		);
		super(
			`Some releases were rejected due to having unmet requirements:\n  ${appStrings.join(
				'\n  ',
			)}`,
		);
	}
}

export interface ServiceCtx {
	serviceName: string;
	commit: string;
}

export interface AppContractResult {
	valid: boolean;
	unmetServices: ServiceCtx[];
	fulfilledServices: ServiceCtx[];
	unmetAndOptional: ServiceCtx[];
}

interface ServiceWithContract extends ServiceCtx {
	contract?: ContractObject;
	optional: boolean;
}

type PotentialContractRequirements =
	| 'sw.supervisor'
	| 'sw.l4t'
	| 'hw.device-type'
	| 'arch.sw';
type ContractRequirements = {
	[key in PotentialContractRequirements]?: string;
};

const contractRequirementVersions: ContractRequirements = {};

export function initializeContractRequirements(opts: {
	supervisorVersion: string;
	deviceType: string;
	deviceArch: string;
	l4tVersion?: string;
}) {
	contractRequirementVersions['sw.supervisor'] = opts.supervisorVersion;
	contractRequirementVersions['sw.l4t'] = opts.l4tVersion;
	contractRequirementVersions['hw.device-type'] = opts.deviceType;
	contractRequirementVersions['arch.sw'] = opts.deviceArch;
}

function isValidRequirementType(
	requirementVersions: ContractRequirements,
	requirement: string,
) {
	return requirement in requirementVersions;
}

export function containerContractsFulfilled(
	servicesWithContract: ServiceWithContract[],
): AppContractResult {
	const containers = servicesWithContract
		.map(({ contract }) => contract)
		.filter((c) => c != null) satisfies ContractObject[];
	const contractTypes = Object.keys(contractRequirementVersions);

	const blueprintMembership: Dictionary<number> = {};
	for (const component of contractTypes) {
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

	const solution = [...blueprint.reproduce(universe)];

	if (solution.length > 1) {
		throw new InternalInconsistencyError(
			'More than one solution available for container contracts when only one is expected!',
		);
	}

	if (solution.length === 0) {
		return {
			valid: false,
			unmetServices: servicesWithContract,
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
			fulfilledServices: servicesWithContract,
			unmetAndOptional: [],
		};
	} else {
		// If we got here, it means that at least one of the
		// container contracts was not fulfilled. If *all* of
		// those containers whose contract was not met are
		// marked as optional, the target state is still valid,
		// but we ignore the optional containers
		const [fulfilledServices, unfulfilledServices] = _.partition(
			servicesWithContract,
			({ contract }) => {
				if (!contract) {
					return true;
				}
				// Did we find the contract in the generated state?
				return children.some((child) =>
					_.isEqual((child as any).raw, contract),
				);
			},
		);

		const [unmetAndRequired, unmetAndOptional] = _.partition(
			unfulfilledServices,
			({ optional }) => !optional,
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
		if (component === 'hw.device-type' || component === 'arch.sw') {
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
): Dictionary<AppContractResult> {
	const result: Dictionary<AppContractResult> = {};

	for (const [appUuid, app] of Object.entries(apps)) {
		const releases = Object.entries(app.releases);
		if (releases.length === 0) {
			continue;
		}

		// While app.releases is an object, we expect a target to only
		// contain a single release per app so we use just the first element
		const [commit, release] = releases[0];

		const servicesWithContract = Object.entries(release.services ?? {}).map(
			([serviceName, { contract, labels = {} }]) => {
				if (contract) {
					try {
						validateContract(contract);
					} catch (e: any) {
						throw new ContractValidationError(serviceName, e.message);
					}
				}

				return {
					serviceName,
					commit,
					contract,
					optional: checkTruthy(labels['io.balena.features.optional']),
				};
			},
		);

		result[appUuid] = containerContractsFulfilled(servicesWithContract);
	}

	return result;
}
