// knex migrations use dynamic requires which break with webpack.
// This hack makes the migrations directory a constant so that at least we can use webpack contexts for the
// require.
module.exports = function (source) {
	return source
		.toString()
		.replace(
			'path.join(absoluteDir, migration.file)',
			`'./migrations/'+migration.file`,
		);
};
