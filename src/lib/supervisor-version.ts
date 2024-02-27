import { version as packageJsonVersion } from '../../package.json';
let supervisorVersion = packageJsonVersion;

const tagExtra = process.env.SUPERVISOR_TAG_EXTRA;
if (tagExtra != null) {
	supervisorVersion += '+' + tagExtra;
}

export { supervisorVersion };
