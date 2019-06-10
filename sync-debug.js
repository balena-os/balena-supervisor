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

require('ts-node/register');
const { ContainerLogs } = require('./src/logging/container');

const setupLogs = (containerId, docker) => {
	console.log('Setting up logs');
	const logs = new ContainerLogs(containerId, docker);
	logs.on('log', ({ message }) => {
		if (message.trim().length !== 0) {
			console.log(message);
		}
	});
	logs.attach(Date.now());
};

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

let changedFiles = [];
let deletedFiles = [];

const performLivepush = _.debounce(async (livepush, containerId, docker) => {
	await livepush.performLivepush(changedFiles, deletedFiles);
	changedFiles = [];
	deletedFiles = [];
	setupLogs(containerId, docker);
}, 1000);

(async () => {
	console.log('Starting up...');
	// Get the supervisor container id
	const container = await docker.getContainer('resin_supervisor').inspect();
	console.log('Supervisor container id: ', container.Id);
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

	chokidar
		.watch('.', {
			ignored: /((^|[\/\\])\..|node_modules.*)/,
			ignoreInitial: false,
		})
		.on('add', path => {
			changedFiles.push(path);
			performLivepush(livepush, containerId, docker);
		})
		.on('change', path => {
			changedFiles.push(path);
			performLivepush(livepush, containerId, docker);
		})
		.on('unlink', path => {
			deletedFiles.push(path);
			performLivepush(livepush, containerId, docker);
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
