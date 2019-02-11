import * as _ from 'lodash';

import { EnvVarObject } from './types';

export function envArrayToObject(env: string[]): EnvVarObject {
	const toPair = (keyVal: string) => {
		const m = keyVal.match(/^([^=]+)=(.*)$/);
		if (m == null) {
			console.log(
				`WARNING: Could not correctly parse env var ${keyVal}. ` +
					'Please fix this var and recreate the container.',
			);
			return [null, null];
		}
		return m.slice(1);
	};

	return _(env)
		.map(toPair)
		.filter(([_, v]) => v != null)
		.fromPairs()
		.value();
}

export function envObjectToArray(env: EnvVarObject): string[] {
	return _.map(env, (v, k) => `${k}=${v}`);
}
