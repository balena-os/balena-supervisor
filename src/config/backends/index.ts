import _ from 'lodash';

import { Extlinux } from './extlinux';
import { ExtraUEnv } from './extra-uEnv';
import { ConfigTxt } from './config-txt';
import { ConfigFs } from './config-fs';
import { Odmdata } from './odmdata';
import { SplashImage } from './splash-image';

export const allBackends = [
	new Extlinux(),
	new ExtraUEnv(),
	new ConfigTxt(),
	new ConfigFs(),
	new Odmdata(),
	new SplashImage(),
];

export function matchesAnyBootConfig(envVar: string): boolean {
	return allBackends.some((a) => a.isBootConfigVar(envVar));
}
