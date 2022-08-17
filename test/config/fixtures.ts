import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as sinonChai from 'sinon-chai';
import * as chaiThings from 'chai-things';
import * as chaiLike from 'chai-like';

/**
 * Mocha runs this EXACTLY ONCE before all tests to set up globals that
 * are used among all test files, such as chai assertion plugins. See
 * https://mochajs.org/#test-fixture-decision-tree-wizard-thing
 *
 * IMPORTANT: The functionality in this global fixture hook should not break any
 * suite run in isolation, and it should be required by ALL test suites.
 * If unsure whether to add to global fixtures, refer to the chart above.
 * Also, avoid setting global mutable variables here.
 */
export const mochaGlobalSetup = function () {
	console.log('Setting up global fixtures for tests...');

	/* Setup chai assertion plugins */
	chai.use(chaiAsPromised);
	chai.use(sinonChai);
	chai.use(chaiLike);
	chai.use(chaiThings);
};

process.env.ROOT_MOUNTPOINT = './test/data';
process.env.BOOT_MOUNTPOINT = '/mnt/boot';
process.env.CONFIG_JSON_PATH = '/config.json';
process.env.CONFIG_MOUNT_POINT = './test/data/config.json';
process.env.DATABASE_PATH = './test/data/database.sqlite';
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite';
process.env.DATABASE_PATH_3 = './test/data/database3.sqlite';
process.env.LED_FILE = './test/data/led_file';

import * as fs from 'fs';

// Make sure they are no database files left over from
// previous runs
try {
	fs.unlinkSync(process.env.DATABASE_PATH);
} catch {
	/* noop */
}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_2);
} catch {
	/* noop */
}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_3);
} catch {
	/* noop */
}
fs.writeFileSync(
	'./test/data/config.json',
	fs.readFileSync('./test/data/testconfig.json'),
);

import '~/test-lib/mocked-dbus';
import '~/test-lib/mocked-dockerode';
import '~/test-lib/mocked-iptables';
