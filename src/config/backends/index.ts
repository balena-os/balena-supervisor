import { Extlinux } from './extlinux';
import { ExtraUEnv } from './extra-uEnv';
import { ConfigTxt } from './config-txt';
import { ConfigFs } from './config-fs';
import { Odmdata } from './odmdata';
import { SplashImage } from './splash-image';
import { PowerFanConfig } from './power-fan';
import { configJsonBackend } from '..';

export const allBackends = [
	new Extlinux(),
	new ExtraUEnv(),
	new ConfigTxt(),
	new ConfigFs(),
	new Odmdata(),
	new SplashImage(),
	new PowerFanConfig(configJsonBackend),
];

export function matchesAnyBootConfig(envVar: string): boolean {
	return allBackends.some((a) => a.isBootConfigVar(envVar));
}
