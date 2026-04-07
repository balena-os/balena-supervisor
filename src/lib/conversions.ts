import type { EnvVarObject } from '../types';

import log from '../lib/supervisor-console';

export function envArrayToObject(env: string[] | undefined): EnvVarObject {
	if (!Array.isArray(env)) {
		return {};
	}
	const toPair = (keyVal: string) => {
		const m = keyVal.match(/^([^=]+)=([^]*)$/);
		if (m == null) {
			log.warn(
				`Could not correctly parse env var ${keyVal}. ` +
					'Please fix this var and recreate the container.',
			);
			return [null, null];
		}
		return m.slice(1);
	};

	return Object.fromEntries(env.map(toPair).filter(([_k, v]) => v != null));
}

export function envObjectToArray(env: EnvVarObject): string[] {
	return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
