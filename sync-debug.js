#!/usr/bin/env node

const helpText = `Sync changes in the javascript code to a running local mode supervisor on a device on the local network

Usage:
  ./sync-debug.js <device IP>

Note that the device should be running a debug image.`;

const argv = require('yargs')
	.command(
		'$0 <device IP>',
		'Sync changes in code to a running debug mode supervisor on a local device',
		yargs =>
			yargs.positional('device IP', {
				type: 'string',
				describe: 'The address of a local device',
			}),
	)
	.usage(helpText)
	.version(false)
	.option('noinit', {
		boolean: true,
		describe: "Don't do an initial sync of files",
		default: false,
	})
	.alias('h', 'help').argv;

const ip = argv.deviceIP;

const { Livepush } = require('livepush');
const { fs } = require('mz');
const dockerode = require('dockerode');
const chokidar = require('chokidar');
const _ = require('lodash');

let lastReadTimestamp = null;
const setupLogs = async (containerId, docker) => {
	const container = docker.getContainer(containerId);
	const stream = await container.logs({
		stdout: true,
		stderr: true,
		follow: true,
		timestamps: true,
		// We start from 0, as we risk not getting any logs to
		// properly seed the value if the host and remote times differ
		since: lastReadTimestamp != null ? lastReadTimestamp : 0,
	});
	stream.on('data', chunk => {
		const { message, timestamp } = extractMessage(chunk);
		lastReadTimestamp = Math.floor(timestamp.getTime() / 1000);
		process.stdout.write(message);
	});
	stream.on('end', () => {
		setupLogs(containerId, docker);
	});
};

function extractMessage(msgBuf) {
	// Non-tty message format from:
	// https://docs.docker.com/engine/api/v1.30/#operation/ContainerAttach
	if (_.includes([0, 1, 2], msgBuf[0])) {
		// Take the header from this message, and parse it as normal
		msgBuf = msgBuf.slice(8);
	}
	const str = msgBuf.toString();
	const space = str.indexOf(' ');
	return {
		timestamp: new Date(str.slice(0, space)),
		message: str.slice(space + 1),
	};
}

const docker = new dockerode({
	host: ip,
	port: 2375,
});

let changedFiles = [];
let deletedFiles = [];

const performLivepush = _.debounce(async livepush => {
	await livepush.performLivepush(changedFiles, deletedFiles);
	changedFiles = [];
	deletedFiles = [];
}, 1000);

(async () => {
	console.log('Starting up...');
	// Get the supervisor container id
	const container = await docker.getContainer('resin_supervisor').inspect();
	console.log('Supervisor container id: ', container.Id);
	const containerId = container.Id;
	const image = container.Image;

	setupLogs(containerId, docker);

	const livepush = await Livepush.init({
		dockerfileContent: await fs.readFile('Dockerfile.debug'),
		context: '.',
		containerId,
		// a bit of a hack, as the multistage images aren't
		// present, but it shouldn't make a difference as these
		// will never change
		stageImages: _.times(6, () => image),
		docker,
	});

	chokidar
		.watch('.', {
			ignored: /((^|[\/\\])\..|node_modules.*)/,
			ignoreInitial: argv.noinit,
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
		const message = output.data.toString();
		if (message.trim().length !== 0) {
			process.stdout.write(`\t${message}`);
		}
	});
	livepush.on('commandReturn', ({ returnCode }) => {
		if (returnCode !== 0) {
			console.log(`\tSYNC: Command return non zero exit status: ${returnCode}`);
		}
	});
	livepush.on('containerRestart', () => {
		console.log('SYNC: Restarting container...');
	});
})();
