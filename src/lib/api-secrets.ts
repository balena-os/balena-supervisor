import * as _ from 'lodash';

import Database from '../db';
import { InternalInconsistencyError } from './errors';
import { generateUniqueKey } from './register-device';

const CLOUD_KEY_SELECTOR = { appId: 0, serviceId: 0 };

export interface ApiSecret {
	appId?: number;
	serviceId?: number;
	scopes: ApiSecretScope[];
	key: string;
}

interface DbApiSecret {
	id: number;
	appId: number;
	serviceId: number;
	scopes: string;
	key: string;
}

export type ApiSecretScope =
	| {
			type: 'app';
			appId: number;
	  }
	| { type: 'apps' };

// This does not change throughout the runtime, and storing
// it allows us to not have to provide it as a parameter to
// every function
let db: Database | undefined;

export function initApiSecrets(database: Database) {
	db = database;
}

function checkInit(
	database: Database | undefined,
): asserts database is Database {
	if (database == null) {
		throw new InternalInconsistencyError(
			'ApiSecrets used before initialization!',
		);
	}
}

export const getApiSecretForService = _.memoize(
	async (appId: number, serviceId: number): Promise<ApiSecret> => {
		checkInit(db);

		const secrets = await db
			.models('apiSecret')
			.where({ appId, serviceId })
			.select();

		if (secrets.length === 0) {
			// This is the first time we have a request for a
			// service, so we generate the key
			const key = generateUniqueKey();
			const scopes: ApiSecretScope[] = [{ type: 'app', appId }];
			await db.models('apiSecret').insert({
				appId,
				serviceId,
				scopes: stringifyScopes(scopes),
				key,
			});
			return {
				appId,
				serviceId,
				scopes,
				key,
			};
		} else if (secrets.length > 1) {
			throw new InternalInconsistencyError(
				`Multiple keys for service! appId: ${appId} serviceId: ${serviceId}`,
			);
		} else {
			return dbFormatToApiSecret(secrets[0]);
		}
	},
);

export async function getCloudApiSecret(): Promise<string> {
	checkInit(db);

	const secrets = await db
		.models('apiSecret')
		.where(CLOUD_KEY_SELECTOR)
		.select('key');
	if (secrets.length === 0) {
		// We need to generate the cloud key
		const key = generateUniqueKey();
		await db.models('apiSecret').insert({
			...CLOUD_KEY_SELECTOR,
			key,
			scopes: stringifyScopes([{ type: 'apps' }]),
		});
		return key;
	} else if (secrets.length > 1) {
		throw new InternalInconsistencyError('Multiple cloud api secrets!');
	} else {
		return secrets[0].key;
	}
}

export async function lookupKey(key: string): Promise<ApiSecret | undefined> {
	checkInit(db);
	const keys = await db
		.models('apiSecret')
		.where({ key })
		.select('appId', 'serviceId', 'scopes');

	if (keys.length === 0) {
		return undefined;
	} else if (keys.length > 1) {
		throw new InternalInconsistencyError('Multiple rows using an api secret');
	} else {
		return dbFormatToApiSecret(keys[0]);
	}
}

// Returns a list of keys which were changed
export async function regenerateKeys(appIds?: number[]): Promise<ApiSecret[]> {
	checkInit(db);
	const secrets = await (appIds != null
		? db.models('apiSecret').whereIn('appId', appIds).select()
		: db.models('apiSecret').select());

	// Change the key in each secret
	for (const secret of secrets) {
		secret.key = generateUniqueKey();
		await db
			.models('apiSecret')
			.where({ id: secret.id })
			.update({ key: secret.key });
	}

	getApiSecretForService.cache.clear?.();

	return secrets.map((s: DbApiSecret) => dbFormatToApiSecret(s));
}

function parseScopes(scopeStr: string): ApiSecretScope[] {
	// TODO: Use io-ts here to validate the scopes from the database
	try {
		return JSON.parse(scopeStr);
	} catch (e) {
		throw new InternalInconsistencyError(
			`Failed to parse secrets scopes from DB: ${e}`,
		);
	}
}

// We wrap stringify so we can have strong typings
function stringifyScopes(scopes: ApiSecretScope[]) {
	return JSON.stringify(scopes);
}

function dbFormatToApiSecret(row: DbApiSecret): ApiSecret {
	return {
		key: row.key,
		scopes: parseScopes(row.scopes),
		appId: row.appId !== CLOUD_KEY_SELECTOR.appId ? row.appId : undefined,
		serviceId:
			row.serviceId !== CLOUD_KEY_SELECTOR.serviceId
				? row.serviceId
				: undefined,
	};
}
