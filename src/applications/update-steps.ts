import * as Bluebird from 'bluebird';

import Config from '../config';
import Application from './application';

import { Network } from '../compose/network';
import { Service } from '../compose/service';
import { ComposeVolume } from '../compose/volumes';

import * as updateLock from '../lib/update-lock';

export type StepAction =
	| 'stop'
	| 'kill'
	| 'remove'
	| 'updateMetadata'
	| 'restart'
	| 'stopAll'
	| 'start'
	| 'updateCommit'
	| 'handover'
	| 'fetch'
	| 'removeImage'
	| 'saveImage'
	| 'cleanup'
	| 'createNetwork'
	| 'createVolume'
	| 'removeNetwork'
	| 'removeVolume'
	| 'ensureSupervisorNetwork';

interface DefaultStepFields {
	force: boolean;
	skipLock: boolean;
	application: Application;
	config: Config;
}

interface StopStep {
	wait: boolean;
	current: Service;
}

interface KillStep {
	current: Service;
	removeImage: boolean;
}

interface RemoveStep {
	current: Service;
}

interface UpdateMetadataStep {
	current: Service;
	target: Service;
}

interface RestartStep {
	current: Service;
	target: Service;
}

interface StartStep {
	target: Service;
}

interface UpdateCommitStep {
	commit: string;
}

interface HandoverStep {
	current: Service;
	target: Service;
}

interface FetchStep {
	image: string;
	// TODO: Maybe switch this to the service to keep things
	// consistent
	serviceName: string;
}

interface RemoveImageStep {
	image: string;
}

interface SaveImageStep {
	image: string;
}

interface CreateNetworkStep {
	target: Network;
}

interface CreateVolumeStep {
	target: ComposeVolume;
}

interface RemoveNetworkStep {
	current: Network;
}

interface RemoveVolumeStep {
	current: ComposeVolume;
}

// We associate the interfaces here with their action name
// this allows us to get properly inferred types when
// dealing with UpdateSteps generally but also allows us to
// refer the type of the step spefically
export type UpdateStepType =
	| { action: 'stop' } & StopStep
	| { action: 'kill' } & KillStep
	| { action: 'remove' } & RemoveStep
	| { action: 'updateMetadata' } & UpdateMetadataStep
	| { action: 'restart' } & RestartStep
	| { action: 'stopAll' }
	| { action: 'start' } & StartStep
	| { action: 'updateCommit' } & UpdateCommitStep
	| { action: 'handover' } & HandoverStep
	| { action: 'fetch' } & FetchStep
	| { action: 'removeImage' } & RemoveImageStep
	| { action: 'saveImage' } & SaveImageStep
	| { action: 'cleanup' }
	| { action: 'createNetwork' } & CreateNetworkStep
	| { action: 'createVolume' } & CreateVolumeStep
	| { action: 'removeNetwork' } & RemoveNetworkStep
	| { action: 'removeVolume' } & RemoveVolumeStep
	// FIXME: This shouldn't be part of the state engine
	| { action: 'ensureSupervisorNetwork' };

export type UpdateStep = UpdateStepType & DefaultStepFields;

export async function executeUpdateSteps(steps: UpdateStep[]): Promise<void> {
	for (const step of steps) {
		await executeUpdateStep(step);
	}
}

async function executeUpdateStep(step: UpdateStep): Promise<void> {
	switch (step.action) {
		case 'stop':
			// FIXME: There should be a way to not have this
			// explicitly typed
			runStopStep(step);
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

async function runStopStep(step: StopStep) {
	await runLocked(step, async () => {
		Application.service;
	});
}

async function runLocked(step: UpdateStep, fn: () => PromiseLike<void>) {
	if (step.skipLock) {
		return Bluebird.try(fn);
	}

	let force = step.force;
	if (!force) {
		force = await step.config.get('lockOverride');
	}

	await updateLock.lock(step.application.appId, { force }, fn);
}
