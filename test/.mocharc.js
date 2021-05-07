module.exports = {
	bail: true, // Exit test script on first error
	exit: true, // Force Mocha to exit after tests complete
	recursive: true, // Look for tests in subdirectories
	require: [
		// Files to execute before running suites
		'build/test/config/fixtures.js',
	],
	spec: ['build/test/**/*.spec.js'],
	timeout: '30000',
};
