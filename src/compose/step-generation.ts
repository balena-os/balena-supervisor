import * as _ from 'lodash';

import { serviceAction } from '../device-api/common';
import { InternalInconsistencyError } from '../lib/errors';
import { checkTruthy } from '../lib/validation';
import { InstancedApp } from '../types/state';
import {
	CompositionStep,
	CompositionStepAction,
	generateStep,
} from './composition-steps';
import { Image } from './images';
import Network from './network';
import Service from './service';
import Volume from './volume';

const legacyContainerLabel = 'io.balena.legacy-container';
const serviceIdLabel = 'io.balena.service-id';

export interface ChangingPair<T> {
	current: T | null;
	target: T | null;
}

type ServiceChangingPair = ChangingPair<Service> & {
	serviceId: number;
};

type ApplicationCompositionStep = CompositionStep<CompositionStepAction>;

export function nextStepsForAppUpdate(
	currentApp: Nullable<Partial<InstancedApp>>,
	targetApp: Nullable<Partial<InstancedApp>>,
	localMode: boolean,
	containerIds: string[],
	availableImages: Image[] = [],
	// FIXME: I dont think this type is correct
	downloading: string[] = [],
): ApplicationCompositionStep[] {
	const emptyApp = {
		services: [],
		volumes: {},
		networks: {},
	};
	if (targetApp == null) {
		targetApp = emptyApp;
	} else {
		// Create a default network for the target application
		if (targetApp.networks == null) {
			targetApp.networks = {};
		}
		if (targetApp.networks['default'] == null) {
			targetApp.networks['default'] = Network.fromComposeObject(
				'default',
				targetApp.appId!,
				{},
				{
					/*FIXME: need a docker and logger*/
				},
			);

			createTargetNetwork('default', targetApp.appId, {});
		}
	}

	if (currentApp == null) {
		currentApp = emptyApp;
	}

	handleLegacyPreloaded(currentApp, targetApp);

	const appId = targetApp.appId ?? currentApp.appId;
	if (!appId) {
		// TODO: Is this actually an error?
		throw new InternalInconsistencyError('Missing appId!');
	}

	const current = currentApp as InstancedApp;
	const target = targetApp as InstancedApp;

	const networkPairs = compareResourceForUpdate(
		current.networks,
		target.networks,
	);
	const volumePairs = compareResourceForUpdate(current.volumes, target.volumes);

	const { removePairs, installPairs, updatePairs } = compareServicesForUpdate(
		current.services,
		target.services,
		containerIds,
	);

	const steps: ApplicationCompositionStep[] = [];
	for (const pair of removePairs) {
		if (pair.current?.status !== 'Stopping') {
			steps.push(
				generateStep('kill', {
					current: pair.current as Service,
				}),
			);
		}
	}
}

function compareServicesForUpdate(
	current: Service[],
	target: Service[],
	containerIds: any,
) {
	const removePairs: ServiceChangingPair[] = [];
	const installPairs: ServiceChangingPair[] = [];
	const updatePairs: ServiceChangingPair[] = [];

	// FIXME: Why is this allowed to be null? We assume it's
	// not null further down the function, so we should
	// tighten up the typings in service
	const targetServiceIds = _.map(target, 'serviceId') as number[];
	const currentServiceIds = _.map(current, 'serviceId') as number[];

	const toBeRemoved = _.difference(currentServiceIds, targetServiceIds);
	for (const serviceId of toBeRemoved) {
		const servicesToRemove = _.filter(current, { serviceId });
		for (const service of servicesToRemove) {
			removePairs.push({
				current: service,
				target: null,
				serviceId: serviceId!,
			});
		}
	}

	const toBeInstalled = _.difference(targetServiceIds, currentServiceIds);
	for (const serviceId of toBeInstalled) {
		const serviceToInstall = _.find(target, { serviceId });
		if (serviceToInstall != null) {
			installPairs.push({
				current: null,
				target: serviceToInstall,
				serviceId: serviceId!,
			});
		}
	}

	const toBeMaybeUpdated = _.intersection(targetServiceIds, currentServiceIds);
	const currentServicesPerId: { [id: number]: Service } = {};
	const targetServicesPerId = _.keyBy(target, 'serviceId');
	for (const serviceId of toBeMaybeUpdated) {
		const currentServiceContainers = _.filter(current, { serviceId });
		if (currentServiceContainers.length > 1) {
			// All but the latest container for this service are
			// spurious and should be removed
			currentServicesPerId[serviceId!] = _.maxBy(
				currentServiceContainers,
				'createdAt',
			)!;

			for (const service of _.without(
				currentServiceContainers,
				currentServicesPerId[serviceId!],
			)) {
				removePairs.push({
					current: service,
					target: null,
					serviceId: serviceId!,
				});
			}
		} else {
			currentServicesPerId[serviceId!] = currentServiceContainers[0];
		}
	}

	const alreadyStarted = (serviceId: number) =>
		currentServicesPerId[serviceId].isEqualExceptForRunningState(
			targetServicesPerId[serviceId],
			containerIds,
		) &&
		targetServicesPerId[serviceId].config.running &&
		containerStarted(serviceId);

	const needUpdate = _.filter(
		toBeMaybeUpdated,
		serviceId =>
			!currentServicesPerId[serviceId].isEqual(
				targetServicesPerId[serviceId],
				containerIds,
			) && !alreadyStarted(serviceId),
	);

	for (const serviceId of needUpdate) {
		updatePairs.push({
			current: currentServicesPerId[serviceId],
			target: targetServicesPerId[serviceId],
			serviceId,
		});
	}

	return { removePairs, installPairs, updatePairs };
}

// Modifies targetApp
function handleLegacyPreloaded(
	currentApp: Partial<InstancedApp>,
	targetApp: Partial<InstancedApp>,
) {
	if (
		currentApp.services?.length === 1 &&
		targetApp.services?.length === 1 &&
		targetApp.services[0].serviceName === currentApp.services[0].serviceName &&
		checkTruthy(currentApp.services[0].config.labels[legacyContainerLabel])
	) {
		// This is  alefacy preloaded app or container, so we
		// didn't have things like serviceId. We hack a few
		// things to avoid an unnecessary restart of the
		// preloaded app but ensuring it gets updated if it
		// actually changed
		targetApp.services[0].config.labels[legacyContainerLabel] =
			currentApp.services[0].config.labels[legacyContainerLabel];
		targetApp.services[0].config.labels[serviceIdLabel] =
			currentApp.services[0].config.labels[serviceIdLabel];
		targetApp.services[0].serviceId = currentApp.services[0].serviceId;
	}
}

function compareResourceForUpdate<T extends { isEqualConfig(t: T): boolean }>(
	current: Dictionary<T>,
	target: Dictionary<T>,
): Array<ChangingPair<T>> {
	const currentNames = _.keys(current);
	const targetNames = _.keys(target);

	const toBeRemoved = _.difference(currentNames, targetNames);
	const toBeInstalled = _.difference(targetNames, currentNames);
	const toBeUpdated = _.filter(
		_.intersection(targetNames, currentNames),
		name => !current[name].isEqualConfig(target[name]),
	);

	return _([] as Array<ChangingPair<T>>)
		.concat(toBeRemoved.map(name => ({ current: current[name], target: null })))
		.concat(
			toBeInstalled.map(name => ({ current: null, target: target[name] })),
		)
		.concat(
			toBeUpdated.map(name => ({
				current: current[name],
				target: target[name],
			})),
		)
		.value();
}

function containerStarted(serviceId: number): boolean {
	// FIXME: Create this function
	throw new Error('Unimplemented');
}
