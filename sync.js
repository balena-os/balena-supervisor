#!/usr/bin/env node

// Sync changes in the javascript code to a running supervisor on a device  in the local network
//
// Usage:
//   ./sync.js <device IP>
//
// The script will first build a non-optimized version of the js code and sync the resulting app.js
// onto the supervisor container at the specified IP. It will also restart the supervisor container.
// The device must be a development variant of Resin OS and the supervisor must be running.

doSync = require('resin-sync').sync('local-resin-os-device').sync;

opts = {
	deviceIp: process.argv[2],
	baseDir: __dirname + '/dist',
	destination: '/usr/src/app/dist',
	appName: 'resin_supervisor',
	skipGitignore: true,
	before: 'npm install && npm run build-no-optimize'
};

doSync(opts);
