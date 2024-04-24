import * as livepush from 'livepush';
import { promises as fs } from 'fs';
import * as yargs from 'yargs';

import * as packageJson from '../package.json';
import * as device from './device';
import * as init from './init';
import { startLivepush } from './livepush';
import { setupLogs } from './logs';

const helpText = `Sync changes code to a running supervisor on a device on the local network

Usage:
  npm run sync <device IP>
`;

interface ArgV {
	'device-address': string;
	'device-arch': string;
	'image-name': string;
	'image-tag': string;
	nocache: boolean;
}

const argv =
	// TypeScript doesn't infer `device-address` to be part of argv so we cast it
	yargs
		.command(
			'$0 <device-address>',
			'Sync changes in code to a running debug mode supervisor on a local device',
			(y) =>
				y.positional('device-address', {
					type: 'string',
					describe: 'The address of a local device',
					demandOption: true,
				}),
		)
		.option('device-arch', {
			alias: 'a',
			type: 'string',
			description:
				'Specify the device architecture (use this when the automatic detection fails)',
			choices: ['amd64', 'i386', 'aarch64', 'armv7hf', 'rpi'],
			demandOption: true,
		})
		.options('image-name', {
			alias: 'i',
			type: 'string',
			description: 'Specify the name to use for the supervisor image on device',
			default: `livepush-supervisor-${packageJson.version}`,
		})
		.options('image-tag', {
			alias: 't',
			type: 'string',
			description:
				'Specify the tag to use for the supervisor image on device. It will not have any effect on balenaOS >= v2.89.0',
			default: 'latest',
			deprecated: true,
		})
		.options('nocache', {
			description: 'Run the intial build without cache',
			type: 'boolean',
			default: false,
		})
		.usage(helpText)
		.version(false)
		.scriptName('npm run sync --')
		.alias('h', 'help').argv as unknown as ArgV;

void (async () => {
	const address = argv['device-address']!;
	const dockerfile = new livepush.Dockerfile(
		await fs.readFile('Dockerfile.template'),
	);

	let cleanup = () => Promise.resolve();
	let sigint = () => {
		/** ignore empty */
	};

	try {
		const docker = device.getDocker(address);
		const { containerId, stageImages } = await init.initDevice({
			address,
			docker,
			dockerfile,
			arch: argv['device-arch'],
			nocache: argv['nocache'],
			imageName: argv['image-name'],
			imageTag: argv['image-tag'],
		});
		// Another newline to separate build and livepush output
		console.log(`Supervisor container: ${containerId}\n`);

		await setupLogs(docker, containerId);
		cleanup = await startLivepush({
			dockerfile,
			containerId,
			docker,
			noinit: true,
			stageImages,
		});

		await new Promise((_, reject) => {
			sigint = () => reject(new Error('User interrupt (Ctrl+C) received'));
			process.on('SIGINT', sigint);
		});
	} catch (e: any) {
		console.error('Error:', e.message);
	} finally {
		console.info('Cleaning up. Please wait ...');
		await cleanup();
		process.removeListener('SIGINT', sigint);
		process.exit(0);
	}
})();
