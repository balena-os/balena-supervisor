// import { promises as fs } from 'fs';

/**
 * Root level global hook to set up test files
 * and env vars that multiple test suites, but not all
 * test suites, might use.
 */
export function mochaHooks() {
	return {
		beforeAll() {
			console.log('Calling global Mocha beforeAll...');

			/* Set test env vars */
			// process.env.ROOT_MOUNTPOINT = './test/data';
			// process.env.BOOT_MOUNTPOINT = '/mnt/boot';
			// process.env.CONFIG_JSON_PATH = '/config.json';
			// process.env.CONFIG_MOUNT_POINT = `${process.env.ROOT_MOUNTPOINT}${process.env.CONFIG_JSON_PATH}`;
			// process.env.DATABASE_PATH = `${process.env.ROOT_MOUNTPOINT}/database.sqlite`;
			// process.env.DATABASE_PATH_2 = `${process.env.ROOT_MOUNTPOINT}/database2.sqlite`;
			// process.env.DATABASE_PATH_3 = `${process.env.ROOT_MOUNTPOINT}/database3.sqlite`;
			// process.env.LED_FILE = `${process.env.ROOT_MOUNTPOINT}/led_file`;

			// /* Cleanup possible previous files, setup test config.json for tests */
			// return Promise.all([
			//     fs.unlink(process.env.DATABASE_PATH as string),
			//     fs.unlink(process.env.DATABASE_PATH_2 as string),
			//     fs.unlink(process.env.DATABASE_PATH_3 as string),
			//     fs.readFile('./test/data/testconfig.json')
			//         .then(contents =>
			//             fs.writeFile(
			//                 (process.env.CONFIG_MOUNT_POINT as string),
			//                 contents
			//             )
			//         )
			// ]);
			// import './lib/mocked-dbus';
			// import './lib/mocked-dockerode';
			// import './lib/mocked-iptables';
			// import './lib/mocked-event-tracker';
		},
		afterAll() {
			console.log('Calling global Mocha afterAll...');
		},
	};
}
