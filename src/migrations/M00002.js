import fs from 'fs';
const configJsonPath = process.env.CONFIG_MOUNT_POINT;

import { checkTruthy } from '../lib/validation';

exports.up = function (knex) {
	return new Promise((resolve) => {
		if (!configJsonPath) {
			console.log(
				'Unable to locate config.json! Things may fail unexpectedly!',
			);
			resolve(false);
			return;
		}

		fs.readFile(configJsonPath, (err, data) => {
			if (err) {
				console.log(
					'Failed to read config.json! Things may fail unexpectedly!',
				);
				resolve(false);
				return;
			}
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.localMode != null) {
					resolve(checkTruthy(parsed.localMode));
					return;
				}
				resolve(false);
				return;
			} catch {
				console.log(
					'Failed to parse config.json! Things may fail unexpectedly!',
				);
				resolve(false);
				return;
			}
		});
	}).then((localMode) => {
		// We can be sure that this does not already exist in the db because of the previous
		// migration
		return knex('config').insert({
			key: 'localMode',
			value: localMode.toString(),
		});
	});
};

exports.down = function () {
	return Promise.reject(new Error('Not Implemented'));
};
