import { Extlinux } from './extlinux';
import { ExtraUEnv } from './extra-uEnv';
import { ConfigTxt } from './config-txt';
import { ConfigFs } from './config-fs';

export default [
	new Extlinux(),
	new ExtraUEnv(),
	new ConfigTxt(),
	new ConfigFs(),
];
