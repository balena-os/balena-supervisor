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

const doSync = require('balena-sync').sync('local-balena-os-device').sync;

const syncOpts = {
	deviceIp: process.argv[2],
	baseDir: __dirname + '/dist',
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
		if (stats.hasErrors()) {
			console.error('Skipping sync due to errors');
			return;
		}
		doSync(syncOpts);
	},
);
