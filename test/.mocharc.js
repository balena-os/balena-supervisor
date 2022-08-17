module.exports = {
	bail: true, // Exit test script on first error
	exit: true, // Force Mocha to exit after tests complete
	recursive: true, // Look for tests in subdirectories
	require: [
		// Files to execute before running suites
		'ts-node/register/transpile-only',
		'test/config/fixtures.ts',
	],
	spec: ['test/**/*.spec.ts'],
	timeout: '30000',
};
