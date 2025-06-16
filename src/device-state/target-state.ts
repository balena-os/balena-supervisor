import Bluebird from 'bluebird';
import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import * as config from '../config';
import * as db from '../db';

import * as globalEventBus from '../event-bus';
import * as deviceConfig from './device-config';

import { TargetStateError } from '../lib/errors';
import { takeGlobalLockRO, takeGlobalLockRW } from '../lib/process-lock';
import * as dbFormat from './db-format';
import * as applicationManager from '../compose/application-manager';

import { TargetState } from '../types';
import * as fsUtils from '../lib/fs-utils';
import { pathOnRoot } from '../lib/host-utils';
import type { InstancedAppState } from '../compose/types';

const TARGET_STATE_CONFIG_DUMP = pathOnRoot(
	'/tmp/balena-supervisor/target-state-config',
);

export interface InstancedDeviceState {
	local: {
		name: string;
		config: Dictionary<string>;
		apps: InstancedAppState;
		hostApps?: InstancedAppState;
	};
}

function parseTargetState(state: unknown): TargetState {
	const res = TargetState.decode(state);

	if (isRight(res)) {
		return res.right;
	}

	const errors = ['Invalid target state.'].concat(Reporter.report(res));
	throw new TargetStateError(errors.join('\n'));
}

// TODO: avoid singletons
let failedUpdates: number = 0;
let intermediateTarget: InstancedDeviceState | null = null;

const readLockTarget = () =>
	takeGlobalLockRO('target').disposer((release) => release());
const writeLockTarget = () =>
	takeGlobalLockRW('target').disposer((release) => release());
function usingReadLockTarget<T extends () => any, U extends ReturnType<T>>(
	fn: T,
): Bluebird<UnwrappedPromise<U>> {
	return Bluebird.using(readLockTarget, () => fn());
}
function usingWriteLockTarget<T extends () => any, U extends ReturnType<T>>(
	fn: T,
): Bluebird<UnwrappedPromise<U>> {
	return Bluebird.using(writeLockTarget, () => fn());
}

export function resetFailedUpdates() {
	failedUpdates = 0;
}

export function increaseFailedUpdates() {
	failedUpdates += 1;
}

export function getFailedUpdates() {
	return failedUpdates;
}

export function setIntermediateTarget(tgt: InstancedDeviceState | null) {
	intermediateTarget = tgt;
}

export async function setTarget(target: TargetState, localSource?: boolean) {
	await db.initialized();
	await config.initialized();

	// When we get a new target state, clear any built up apply errors
	// This means that we can attempt to apply the new state instantly
	if (localSource == null) {
		localSource = false;
	}
	failedUpdates = 0;

	// This will throw if target state is invalid
	target = parseTargetState(target);

	globalEventBus.getInstance().emit('targetStateChanged', target);

	const { uuid, apiEndpoint } = await config.getMany(['uuid', 'apiEndpoint']);

	if (!uuid || !target[uuid]) {
		throw new Error(
			`Expected target state for local device with uuid '${uuid}'.`,
		);
	}

	const localTarget = target[uuid];

	await fsUtils.writeAndSyncFile(
		TARGET_STATE_CONFIG_DUMP,
		JSON.stringify(localTarget.config),
	);

	await usingWriteLockTarget(async () => {
		await db.transaction(async (trx) => {
			await config.set({ name: localTarget.name }, trx);
			await deviceConfig.setTarget(localTarget.config, trx);

			if (localSource || apiEndpoint == null || apiEndpoint === '') {
				await applicationManager.setTarget(localTarget.apps, 'local', trx);
			} else {
				await applicationManager.setTarget(localTarget.apps, apiEndpoint, trx);
			}
			await config.set({ targetStateSet: true }, trx);
		});
	});
}

export function getTarget({
	initial = false,
	intermediate = false,
}: {
	initial?: boolean;
	intermediate?: boolean;
} = {}): Bluebird<InstancedDeviceState> {
	return usingReadLockTarget(async () => {
		if (intermediate) {
			return intermediateTarget!;
		}
		// We probably don't need a separate hostApps. It's just to read the
		// services for the hostapp, which is not usually included. See
		// App.fromTargetState() to always include hostapp services.
		return {
			local: {
				name: await config.get('name'),
				config: await deviceConfig.getTarget({ initial }),
				apps: await dbFormat.getApps(),
				hostApps: await dbFormat.getApps(true),
			},
		};
	});
}
