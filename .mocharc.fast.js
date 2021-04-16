const path = require('path');

module.exports = {
	'allow-uncaught': false,
	bail: true,
	exit: true,
	recursive: true,
	require: [
		'ts-node/register/transpile-only',
		path.resolve(__dirname, 'test', 'config', 'fixtures.ts'),
		path.resolve(__dirname, 'test', 'config', 'setup.ts'),
	],
	spec: ['test/**/*.spec.ts'],
	timeout: '30000',
};
