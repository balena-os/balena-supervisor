const webpack = require('webpack');
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const TerserWebpackPlugin = require('terser-webpack-plugin');

const externalModules = [
	'async_hooks',
	'sqlite3',
	'mysql2',
	'pg',
	'mariasql',
	'mssql',
	'mysql',
	'strong-oracle',
	'oracle',
	'oracledb',
	'pg-query-stream',
	'tedious',
	'better-sqlite3',
	/mssql\/.*/,
	'osx-temperature-sensor',
	'@balena/systemd',
];

let requiredModules = [];
let maybeOptionalModules = [];
const lookForOptionalDeps = function (sourceDir) {
	// We iterate over the node modules and mark all optional dependencies as external
	const dirs = fs.readdirSync(sourceDir);
	for (const dir of dirs) {
		let packageJson = {};
		const internalNodeModules = path.join(sourceDir, dir, 'node_modules');
		if (fs.existsSync(internalNodeModules)) {
			lookForOptionalDeps(internalNodeModules);
		}
		try {
			packageJson = JSON.parse(
				fs.readFileSync(path.join(sourceDir, dir, '/package.json'), 'utf8'),
			);
		} catch {
			continue;
		}
		if (packageJson.optionalDependencies != null) {
			maybeOptionalModules = maybeOptionalModules.concat(
				_.keys(packageJson.optionalDependencies),
			);
		}
		if (packageJson.dependencies != null) {
			requiredModules = requiredModules.concat(
				_.keys(packageJson.dependencies),
			);
		}
	}
};

lookForOptionalDeps('./node_modules');
externalModules.push(
	new RegExp(
		'^(' +
			_.reject(maybeOptionalModules, requiredModules)
				.map(_.escapeRegExp)
				.join('|') +
			')(/.*)?$',
	),
);

console.log('Using the following dependencies as external:', externalModules);

module.exports = function (env) {
	return {
		mode: env == null || !env.noOptimize ? 'production' : 'development',
		entry: './src/app.ts',
		output: {
			filename: 'app.js',
			path: path.resolve(__dirname, 'dist'),
		},
		resolve: {
			extensions: ['.js', '.ts', '.json'],
			alias: {
				// Use the es2018 build instead of the default es2015 build
				'pinejs-client-core': 'pinejs-client-core/es2018',
			},
		},
		target: 'node',
		node: {
			__dirname: false,
		},
		optimization: {
			minimize: true,
			minimizer: [
				new TerserWebpackPlugin({
					terserOptions: {
						mangle: false,
						keep_classnames: true,
					},
				}),
			],
		},
		module: {
			rules: [
				{
					include: [
						new RegExp(
							_.escapeRegExp(
								// this is the path as of knex@2.5.1
								path.join('knex', 'lib', 'migrations', 'common'),
							),
						),
					],
					use: require.resolve('./build-utils/hardcode-migrations'),
				},
				{
					test: new RegExp(
						_.escapeRegExp(path.join('JSONStream', 'index.js')) + '$',
					),
					use: require.resolve('./build-utils/fix-jsonstream'),
				},
				{
					test: /\.ts$|\.js$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'ts-loader',
							options: {
								transpileOnly: true,
								configFile: 'tsconfig.release.json',
							},
						},
					],
				},
				{
					test: /\.node$/,
					loader: 'node-loader',
				},
			],
		},
		externals: (_context, request, callback) => {
			for (const m of externalModules) {
				if (
					(typeof m === 'string' && m === request) ||
					(m instanceof RegExp && m.test(request))
				) {
					return callback(null, 'commonjs ' + request);
				} else if (typeof m !== 'string' && !(m instanceof RegExp)) {
					throw new Error('Invalid entry in external modules: ' + m);
				}
			}
			return callback();
		},
		plugins: [
			new ForkTsCheckerWebpackPlugin({
				async: false,
			}),
			new CopyWebpackPlugin({
				patterns: [
					{
						from: './build/migrations',
						to: 'migrations',
					},
				],
			}),
			new webpack.ContextReplacementPlugin(
				/\.\/migrations/,
				path.resolve(__dirname, 'build/migrations'),
			),
		],
	};
};
