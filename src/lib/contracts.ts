import { TypedError } from 'typed-error';

import type { ContractObject } from '@balena/contrato';
import { Contract, Universe } from '@balena/contrato';

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

const deviceContract: Universe = new Universe();

export function initializeContractRequirements(opts: {
	supervisorVersion: string;
	deviceType: string;
	deviceArch: string;
	kernelVersion?: string;
	kernelSlug?: string;
	l4tVersion?: string;
	osVersion?: string;
	osSlug?: string;
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

	if (opts.osVersion && opts.osSlug) {
		deviceContract.addChild(
			new Contract({
				type: 'sw.os',
				slug: opts.osSlug,
				version: opts.osVersion,
			}),
		);
	}

	if (opts.kernelVersion && opts.kernelSlug) {
		deviceContract.addChild(
			new Contract({
				type: 'sw.kernel',
				version: opts.kernelVersion,
				slug: opts.kernelSlug,
			}),
		);
	}
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

// Exported for tests only
export function parseContract(contract: object): ContractObject {
	// assume `sw.container` as the type to avoid breaking existing contracts on the db
	const rawContract = { type: 'sw.container', requires: [], ...contract };

	function removeUnsupportedFields(req: Record<string, any>) {
		for (const key of Object.keys(req)) {
			if (key === 'or') {
				for (const r of req.or) {
					removeUnsupportedFields(r);
				}
				continue;
			}

			if (!['slug', 'type', 'version', 'data'].includes(key)) {
				delete req[key];
			}
		}
	}

	// contrato is strict about typing when it comes to requirements,
	// any extra fields on a requirement will result on a deserialization failure
	// this is an issue as it seems that at some point we accepted `name` as valid
	// requirement. When simplifying contract validation on
	// https://github.com/balena-os/balena-supervisor/pull/2416 we chose to filter
	// out `name`, which was probably an error since that means we are installing a
	// container that perhaps doesn't have its contract satisfied. The code below is
	// to maintain compatibility with that change
	if (Array.isArray(rawContract.requires)) {
		for (const req of rawContract.requires) {
			removeUnsupportedFields(req);
		}
	}

	return new Contract(rawContract).raw;
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
