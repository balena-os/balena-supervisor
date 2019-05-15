#!/usr/bin/env node

if (!process.argv[2] || ['help', '-h', '--help'].includes(process.argv[2])) {
	console.log(`
Sync changes in the javascript code to a running local mode supervisor on a device on the local network

Usage:
  ./sync-debug.js <device IP>

Note that the device should be running a debug image.
	`);
	process.exit(1);
}

const ip = process.argv[2];

const { Livepush } = require('livepush');
const { fs } = require('mz');
const dockerode = require('dockerode');
const chokidar = require('chokidar');
const _ = require('lodash');

const docker = new dockerode({
	host: ip,
	port: 2375,
});

function extractMessage(msgBuf) {
	// Non-tty message format from:
	// https://docs.docker.com/engine/api/v1.30/#operation/ContainerAttach
	if (
		_.includes([0, 1, 2], msgBuf[0]) &&
		_.every(msgBuf.slice(1, 7), c => c === 0)
	) {
		// Take the header from this message, and parse it as normal
		msgBuf = msgBuf.slice(8);
	}
	const logLine = msgBuf.toString();
	const space = logLine.indexOf(' ');
	if (space > 0) {
		let timestamp = new Date(logLine.substr(0, space)).getTime();
		if (_.isNaN(timestamp)) {
			timestamp = Date.now();
		}
		return {
			timestamp,
			message: logLine.substr(space + 1),
		};
	}
	return;
}

(async () => {
	// Get the supervisor container id
	const container = await docker.getContainer('resin_supervisor').inspect();
	const containerId = container.Id;
	const image = container.Image;

	const livepush = await Livepush.init(
		await fs.readFile('Dockerfile.debug'),
		'.',
		containerId,
		// a bit of a hack, as the multistage images aren't
		// present, but it shouldn't make a difference as these
		// will never change
		_.times(7, () => image),
		docker,
	);

	// TODO: Debounce these calls
	chokidar
		.watch('.', {
			ignored: /((^|[\/\\])\..|node_modules.*)/,
			ignoreInitial: true,
		})
		.on('add', path => {
			livepush.performLivepush([path], []);
		})
		.on('change', path => {
			livepush.performLivepush([path], []);
		})
		.on('unlink', path => {
			livepush.performLivepush([], [path]);
		});

	livepush.on('commandExecute', ({ command }) => {
		console.log('SYNC: executing:', command);
	});
	livepush.on('commandOutput', ({ output }) => {
		console.log(`\t${output.data.toString()}`);
	});
	livepush.on('containerRestart', () => {
		console.log('SYNC: Restarting container...');
	});
})();
