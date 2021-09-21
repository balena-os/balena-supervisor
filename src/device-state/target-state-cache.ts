import * as _ from 'lodash';

import * as config from '../config';
import * as db from '../db';
import { TargetAppClass } from '../types';

// We omit the id (which does appear in the db) in this type, as we don't use it
// at all, and we can use the below type for both insertion and retrieval.
export interface DatabaseApp {
	name: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	releaseId?: number;
	commit?: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	appId: number;
	uuid: string;
	services: string;
	networks: string;
	volumes: string;
	source: string;
	class: TargetAppClass;
	isHost: boolean;
}

export type DatabaseService = {
	appId: string;
	appUuid: string;
	releaseId: number;
	commit: string;
	serviceName: string;
	serviceId: number;
	imageId: number;
	image: string;

	labels: { [key: string]: string };
	environment: { [key: string]: string };
	composition?: { [key: string]: any };
};

/*
 * This module is a wrapper around the database fetching and retrieving of
 * target state. Because the target state can only be set only be set from a
 * single place, but several workflows rely on getting the target state at one
 * point or another, we cache the values using this class. Accessing the
 * database is inherently expensive, and for example the local log backend
 * accesses the target state for every log line. This can very quickly cause
 * serious memory problems and database connection timeouts.
 */
let targetState: DatabaseApp[] | undefined;

export const initialized = (async () => {
	await db.initialized;
	await config.initialized;
	// If we switch backend, the target state also needs to
	// be invalidated (this includes switching to and from
	// local mode)
	config.on('change', (conf) => {
		if (conf.apiEndpoint != null || conf.localMode != null) {
			targetState = undefined;
		}
	});
})();

export async function getTargetApp(
	appId: number,
): Promise<DatabaseApp | undefined> {
	if (targetState == null) {
		// TODO: Perhaps only fetch a single application from
		// the DB, at the expense of repeating code
		await getTargetApps();
	}

	return _.find(targetState, (app) => app.appId === appId);
}

export async function getTargetApps(): Promise<DatabaseApp[]> {
	if (targetState == null) {
		const { apiEndpoint, localMode } = await config.getMany([
			'apiEndpoint',
			'localMode',
		]);

		const source = localMode ? 'local' : apiEndpoint;
		targetState = await db
			.models('app')
			.where({ source })
			// Local mode only applies for fleet "applications"
			// this prevents the supervisor trying to uninstall
			// the supervisor or host app for tri-app
			.orWhereNot({ class: 'fleet' });
	}
	return targetState!;
}

export async function setTargetApps(
	apps: DatabaseApp[],
	trx?: db.Transaction,
): Promise<void> {
	// We can't cache the value here, as it could be for a
	// different source
	targetState = undefined;

	await Promise.all(
		apps.map((app) => db.upsertModel('app', app, { uuid: app.uuid }, trx)),
	);
}
