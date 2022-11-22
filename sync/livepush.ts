import * as chokidar from 'chokidar';
import Docker from 'dockerode';
import _ from 'lodash';
import * as Path from 'path';

import { Dockerfile, Livepush } from 'livepush';

// TODO: Pass build args to the livepush process
export async function startLivepush(opts: {
	dockerfile: Dockerfile;
	containerId: string;
	docker: Docker;
	noinit: boolean;
	stageImages?: string[];
}) {
	const livepush = await Livepush.init({
		stageImages: [],
		...opts,
		context: Path.join(__dirname, '..'),
	});

	livepush.addListener('commandExecute', ({ command }) => {
		console.log(`Executing command: ${command} `);
	});
	livepush.addListener('commandReturn', ({ returnCode }) => {
		if (returnCode !== 0) {
			console.log(`  Command executed with code ${returnCode}`);
		}
	});
	livepush.addListener('commandOutput', ({ output }) => {
		console.log(output.data.toString());
	});
	livepush.addListener('containerRestart', () => {
		console.log('Restarting container');
	});

	const livepushExecutor = getExecutor(livepush);
	const watcher = chokidar
		.watch('.', {
			ignored: /((^|[\/\\])\..|(node_modules|sync|test)\/.*)/,
			ignoreInitial: opts.noinit,
		})
		.on('add', (path) => livepushExecutor(path))
		.on('change', (path) => livepushExecutor(path))
		.on('unlink', (path) => livepushExecutor(undefined, path));

	return async () => {
		await watcher.close();
		await livepush.cleanupIntermediateContainers();
	};
}

const getExecutor = (livepush: Livepush) => {
	let changedFiles: string[] = [];
	let deletedFiles: string[] = [];
	const actualExecutor = _.debounce(async () => {
		await livepush.performLivepush(changedFiles, deletedFiles);
		changedFiles = [];
		deletedFiles = [];
	});
	return (changed?: string, deleted?: string) => {
		if (changed) {
			changedFiles.push(changed);
		}
		if (deleted) {
			deletedFiles.push(deleted);
		}
		actualExecutor();
	};
};
