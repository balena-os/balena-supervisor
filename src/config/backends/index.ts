import * as _ from 'lodash';

import { Extlinux } from './extlinux';
import { ExtraUEnv } from './extra-uEnv';
import { ConfigTxt } from './config-txt';
import { ConfigFs } from './config-fs';

export const allBackends = [
	new Extlinux(),
	new ExtraUEnv(),
	new ConfigTxt(),
	new ConfigFs(),
];

export function matchesAnyBootConfig(envVar: string): boolean {
	return allBackends.some((a) => a.isBootConfigVar(envVar));
}
