import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import Reporter from 'io-ts-reporters';
import { TypedError } from 'typed-error';

import type { ContractObject } from '@balena/contrato';
import { Contract, Universe } from '@balena/contrato';

import { checkTruthy } from './validation';
import { withDefault, type TargetApps } from '../types';

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

const validRequirementTypes = [
	'sw.supervisor',
	'sw.l4t',
	'hw.device-type',
	'arch.sw',
];
const deviceContract: Universe = new Universe();

export function initializeContractRequirements(opts: {
	supervisorVersion: string;
	deviceType: string;
	deviceArch: string;
	l4tVersion?: string;
}) {
	deviceContract.addChildren([
		new Contract({
			type: 'sw.supervisor',
			version: opts.supervisorVersion,
		}),
		new Contract({
			type: 'sw.application',
			slug: 'balena-supervisor',
			version: opts.supervisorVersion,
		}),
		new Contract({
			type: 'hw.device-type',
			slug: opts.deviceType,
		}),
		new Contract({
			type: 'arch.sw',
			slug: opts.deviceArch,
		}),
	]);

	if (opts.l4tVersion) {
		deviceContract.addChild(
			new Contract({
				type: 'sw.l4t',
				version: opts.l4tVersion,
			}),
		);
	}
}

function isValidRequirementType(requirement: string) {
	return validRequirementTypes.includes(requirement);
}

// this is only exported for tests
export function containerContractsFulfilled(
	servicesWithContract: ServiceWithContract[],
): AppContractResult {
	const unmetServices: ServiceCtx[] = [];
	const unmetAndOptional: ServiceCtx[] = [];
	const fulfilledServices: ServiceCtx[] = [];
	for (const svc of servicesWithContract) {
		if (
			svc.contract != null &&
			!deviceContract.satisfiesChildContract(new Contract(svc.contract))
		) {
			unmetServices.push(svc);
			if (svc.optional) {
				unmetAndOptional.push(svc);
			}
		} else {
			fulfilledServices.push(svc);
		}
	}

	return {
		valid: unmetServices.length - unmetAndOptional.length === 0,
		unmetServices,
		fulfilledServices,
		unmetAndOptional,
	};
}

const ContainerContract = t.intersection([
	t.type({
		type: withDefault(t.string, 'sw.container'),
	}),
	t.partial({
		slug: t.union([t.null, t.undefined, t.string]),
		requires: t.union([
			t.null,
			t.undefined,
			t.array(
				t.intersection([
					t.type({
						type: t.string,
					}),
					t.partial({
						slug: t.union([t.null, t.undefined, t.string]),
						version: t.union([t.null, t.undefined, t.string]),
					}),
				]),
			),
		]),
	}),
]);

// Exported for tests only
export function parseContract(contract: unknown): ContractObject {
	const result = ContainerContract.decode(contract);

	if (isLeft(result)) {
		throw new Error(Reporter.report(result).join('\n'));
	}

	for (const { type } of result.right.requires || []) {
		if (!isValidRequirementType(type)) {
			throw new Error(`${type} is not a valid contract requirement type`);
		}
	}

	return result.right;
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
						contract = parseContract(contract);
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
