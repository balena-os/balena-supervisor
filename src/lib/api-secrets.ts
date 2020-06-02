import * as express from 'express';
import * as _ from 'lodash';

import * as db from '../db';
import { InternalInconsistencyError } from './errors';
import { generateUniqueKey } from './register-device';
import { checkInt } from './validation';

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
	| { type: 'all-apps' };

const apiSecretMemoizer = (
	appId: number,
	serviceId: number,
	scopes: ApiSecretScope[],
) => `${appId}:${serviceId}:${JSON.stringify(scopes)}`;

export const getApiSecretForService = _.memoize(
	async (
		appId: number,
		serviceId: number,
		scopes: ApiSecretScope[],
	): Promise<ApiSecret> => {
		await db.initialized;

		const secrets = await db
			.models('apiSecret')
			.where({ appId, serviceId })
			.select();

		if (secrets.length === 0) {
			// This is the first time we have a request for a
			// service, so we generate the key
			const key = generateUniqueKey();
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
			const currentSecret = dbFormatToApiSecret(secrets[0]);
			if (_.xorWith(currentSecret.scopes, scopes, _.isEqual).length !== 0) {
				// Delete the current key, and regenerate with the
				// correct scope
				await db.models('apiSecret').where({ key: currentSecret.key }).del();
				// Clear this cache entry for this
				// appId+serviceId+scope combo, to force a refresh
				getApiSecretForService.cache.delete(
					apiSecretMemoizer(appId, serviceId, scopes),
				);
				return getApiSecretForService(appId, serviceId, scopes);
			}
			return currentSecret;
		}
	},
	apiSecretMemoizer,
);

export async function getCloudApiSecret(): Promise<string> {
	await db.initialized;

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
			scopes: stringifyScopes([{ type: 'all-apps' }]),
		});
		return key;
	} else if (secrets.length > 1) {
		throw new InternalInconsistencyError('Multiple cloud api secrets!');
	} else {
		return secrets[0].key;
	}
}

export async function lookupKey(key: string): Promise<ApiSecret | undefined> {
	await db.initialized;

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
	await db.initialized;

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

export type RequestWithScope = express.Request & {
	data: {
		serviceId?: number;
		appId?: number;
		scopes: ApiSecretScope[];
	};
};

export type Scope = ApiSecretScope['type'];

export function scopedApps(req: RequestWithScope): number[] | 'all' {
	if (_.some(req.data.scopes, (scope) => scope.type === 'all-apps')) {
		return 'all';
	}

	return req.data.scopes.reduce((acc, scope) => {
		if (scope.type === 'app') {
			acc.push(scope.appId);
		}
		return acc;
	}, new Array<number>());
}

export function requireAnyScope(
	types: Scope | Scope[],
): express.RequestHandler {
	return (req: RequestWithScope, res, next) => {
		for (const type of _.toArray(types)) {
			const scope = _.find(req.data.scopes, { type });
			if (scope) {
				return next();
			}
		}

		res.status(401).json({
			status: 'failed',
			message: `Secret is not correctly scoped for this request`,
		});
	};
}

export function requireAppScope(path: _.PropertyPath): express.RequestHandler {
	return (req: RequestWithScope, res, next) => {
		if (_.some(req.data.scopes, (scope) => scope.type === 'all-apps')) {
			return next();
		}

		path = _.toPath(path);
		let canAccess = false;
		const appId = checkInt(_.get(req, path, ''));
		if (appId) {
			canAccess = _.some(
				req.data.scopes,
				(scope) => scope.type === 'app' && scope.appId === appId,
			);
		}

		if (canAccess) {
			return next();
		}

		res.status(401).json({
			status: 'failed',
			message: `Invalid application ID: ${_.get(req, path, '')}`,
		});
	};
}
