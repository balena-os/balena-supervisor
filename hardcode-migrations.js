// knex migrations use dynamic requires which break with webpack.
// This hack makes the migrations directory a constant so that at least we can use webpack contexts for the
// require.
module.exports = function (source) {
  return source.toString().replace("require(directory + '/' + name);", "require('./migrations/' + name);")
  	.replace("require(_path2.default.join(this._absoluteConfigDir(), name));", "require('./migrations/' + name);")
}
