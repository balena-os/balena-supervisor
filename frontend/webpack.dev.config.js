const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Add DOCKER_BUILD env in your CLI command if running ui-client & ui-server along with livepush Supervisor container
const isDocker = process.env.DOCKER_BUILD || true;

module.exports = {
	mode: 'development',
	entry: [path.resolve(__dirname, 'src', 'index.tsx')],
	module: {
		rules: [
			{
				test: /\.tsx?/,
				use: 'ts-loader',
				exclude: /node_modules/,
			},
		],
	},
	resolve: {
		extensions: ['.tsx', '.ts', '.js'],
	},
	output: {
		filename: 'bundle.js',
		path: path.resolve(__dirname, 'build'),
	},
	devServer: {
		host: isDocker ? '0.0.0.0' : 'localhost', // to accept connections from outside container
		disableHostCheck: true,
		port: 8080,
		contentBase: path.resolve(__dirname, 'build'),
		compress: true,
		hot: true,
		proxy: {
			'/': 'http://localhost:48485',
		},
		watchContentBase: true,
	},
	plugins: [
		new HtmlWebpackPlugin({
			template: path.resolve(__dirname, 'src', 'template.html'),
		}),
	],
};
