// knex migrations use dynamic requires which break with webpack.
// This hack makes the migrations directory a constant so that at least we can use webpack contexts for the
// require.
module.exports = function (source) {
	return (
		source
			.toString()
			// IMPORTANT: this is known to work with knex v2.5.0. It will most likely break
			// if knex is upgraded. This is really a hack and should be replaced by a more sustainable
			// webpack configuration.
			.replace(
				'importFile(_path)',
				"require('./migrations/'+migrationsInfo.file)",
			)
	);
};
