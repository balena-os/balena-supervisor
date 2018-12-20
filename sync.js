#!/usr/bin/env node

if (!process.argv[2] || ['help', '-h', '--help'].includes(process.argv[2])) {
	console.log(`
Sync changes in the javascript code to a running supervisor on a device  in the local network

Usage:
  ./sync.js <device IP>

The script will first build a non-optimized version of the js code and sync the resulting app.js
onto the supervisor container at the specified IP. It will also restart the supervisor container.
The device must be a development variant of balenaOS and the supervisor must be running.
	`);
	process.exit(1);
}

const childProcess = require('child_process');

const webpack = require('webpack');
const webpackConfig = require('./webpack.config');
const compiler = webpack(webpackConfig({ noOptimize: true }));
const Docker = require('dockerode');
const { Container, FileUpdates } = require('livepush');

// const doSync = require('balena-sync').sync('local-balena-os-device').sync;
const doSync = async syncOpts => {
	// Livepush doesn't support the type of Dockerfile that the supervisor uses
	// (Multistage, variables etc...) so we generate a fake Dockerfile that will
	// behave the same for our purposes
	const dockerfile = `
	FROM img
	WORKDIR /usr/src/app
	COPY ./dist ./
	`;

	const container = new Container(
		dockerfile,
		syncOpts.baseDir,
		syncOpts.appName,
		new Docker({ Host: syncOpts.deviceIp }),
	);

	const updates = new FileUpdates({
		// TODO: Also read all migration files
		updated: 'dist/app.js',
		added: [],
		deleted: [],
	});
	const actions = container.actionsNeeded(updates);
	await container.performActions(updates, actions);
};

const syncOpts = {
	deviceIp: process.argv[2],
	baseDir: __dirname,
	destination: '/usr/src/app/dist',
	appName: 'resin_supervisor',
	skipGitignore: true,
};

childProcess.execSync('npm install', { stdio: 'inherit' });

compiler.watch(
	{
		ignored: /node_modules/,
	},
	(err, stats) => {
		if (err) {
			console.error(err);
			return;
		}
		console.log(stats.toString({ colors: true }));
		doSync(syncOpts);
	},
);
