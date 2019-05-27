import * as Bluebird from 'bluebird';

import Config from '../config';
import Application from './application';

import { Network } from './network';
import { Service } from './service';
import { ComposeVolume } from './volumes';

import * as updateLock from '../lib/update-lock';

interface DefaultStepFields {
	force?: boolean;
	skipLock?: boolean;
	application: Application;
	config: Config;
}

interface Steps {
	stop: { wait: boolean; current: Service };
	kill: { current: Service; removeImage: boolean };
	remove: { current: Service };
	updateMetadata: { current: Service; target: Service };
	restart: { current: Service; target: Service };
	start: { target: Service };
	updateCommit: { commit: string };
	handover: { current: Service; target: Service };
	// TODO: Maybe switch serviceName to Service below to keep
	// things consistent
	fetch: { image: string; serviceName: string };
	removeImage: { image: string };
	saveImage: { image: string };
	createNetwork: { target: Network };
	createVolume: { target: ComposeVolume };
	removeNetwork: { current: Network };
	removeVolume: { current: ComposeVolume };
}

export type UpdateAction = keyof Steps;
export type UpdateStep<T extends UpdateAction> = { action: T } & Steps[T] &
	DefaultStepFields;

export function createUpdateAction<T extends UpdateAction>(
	action: T,
	options: Steps[T] & DefaultStepFields,
): UpdateStep<T> {
	return { action, ...options };
}

export async function executeUpdateSteps<T extends UpdateAction>(
	steps: Array<UpdateStep<T>>,
): Promise<void> {
	for (const step of steps) {
		await executeUpdateStep(step);
	}
}

async function executeUpdateStep<T extends UpdateAction>(
	step: UpdateStep<T>,
): Promise<void> {
	switch (step.action) {
		case 'stop':
			await runStopStep(step as UpdateStep<'stop'>);
			break;
		case 'kill':
			break;
		case 'remove':
			break;
		case 'updateMetadata':
			break;
		case 'restart':
			break;
		case 'stopAll':
			break;
		case 'start':
			break;
		case 'updateCommit':
			break;
		case 'handover':
			break;
		case 'fetch':
			break;
		case 'removeImage':
			break;
		case 'saveImage':
			break;
		case 'cleanup':
			break;
		case 'createNetwork':
			break;
		case 'createVolume':
			break;
		case 'removeNetwork':
			break;
		case 'removeVolume':
			break;
		case 'ensureSupervisorNetwork':
			break;
	}
}

async function runStopStep(step: UpdateStep<'stop'>) {
	await runLocked(step, async () => {
		Application.service;
	});
}

async function runLocked<T extends UpdateAction>(
	step: UpdateStep<T>,
	fn: () => PromiseLike<void>,
) {
	if (step.skipLock) {
		return Bluebird.try(fn);
	}

	let force = step.force;
	if (!force) {
		force = await step.config.get('lockOverride');
	}

	await updateLock.lock(step.application.appId, { force }, fn);
}
