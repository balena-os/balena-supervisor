const path = require('path');

module.exports = {
	'allow-uncaught': false, // Fail on uncaught errors
	bail: true, // Exit test suites on first error
	exit: true, // Force Mocha to exit after tests complete
	recursive: true, // Look for tests in subdirectories
	require: ['build/test/config/fixtures.js', 'build/test/config/setup.js'],
	spec: ['build/test/**/*.js'],
	timeout: '30000',
};
