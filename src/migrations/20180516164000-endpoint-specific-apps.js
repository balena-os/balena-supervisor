import * as fs from 'fs';
const configJsonPath = process.env.CONFIG_MOUNT_POINT;

exports.up = function (knex) {
	return new Promise((resolve) => {
		if (!configJsonPath) {
			console.log(
				'Unable to locate config.json! Things may fail unexpectedly!',
			);
			return resolve({});
		}
		fs.readFile(configJsonPath, (err, data) => {
			if (err) {
				console.log(
					'Failed to read config.json! Things may fail unexpectedly!',
				);
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(data.toString());
				resolve(parsed);
			} catch (e) {
				console.log(
					'Failed to parse config.json! Things may fail unexpectedly!',
				);
				resolve({});
			}
		});
	}).then((config) => {
		return knex.schema
			.table('app', (t) => {
				// Create a new column on the table and add the apiEndpoint config json
				// field if it exists
				t.string('source');
			})
			.then(() => {
				return knex('app').update({ source: config.apiEndpoint || '' });
			});
	});
};

exports.down = function () {
	return Promise.reject(new Error('Not Implemented'));
};
