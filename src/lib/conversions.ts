import * as _ from 'lodash';

import type { EnvVarObject } from '../types';

import log from '../lib/supervisor-console';

export function envArrayToObject(env: string[]): EnvVarObject {
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

	return _(env)
		.map(toPair)
		.filter(([_k, v]) => v != null)
		.fromPairs()
		.value();
}

export function envObjectToArray(env: EnvVarObject): string[] {
	return _.map(env, (v, k) => `${k}=${v}`);
}
