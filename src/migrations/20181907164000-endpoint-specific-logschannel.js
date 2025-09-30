import Bluebird from 'bluebird';
import fs from 'fs';
const configJsonPath = process.env.CONFIG_MOUNT_POINT;

exports.up = function (knex) {
	return new Bluebird((resolve) => {
		if (!configJsonPath) {
			console.log(
				'Unable to locate config.json! Things may fail unexpectedly!',
			);
			resolve({});
			return;
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
			} catch {
				console.log(
					'Failed to parse config.json! Things may fail unexpectedly!',
				);
				resolve({});
			}
		});
	})
		.tap(() => {
			// take the logsChannelSecret, and the apiEndpoint config field,
			// and store them in a new table
			return knex.schema.hasTable('logsChannelSecret').then((exists) => {
				if (!exists) {
					return knex.schema.createTable('logsChannelSecret', (t) => {
						t.string('backend');
						t.string('secret');
					});
				}
			});
		})
		.then((config) => {
			return knex('config')
				.where({ key: 'logsChannelSecret' })
				.select('value')
				.then((results) => {
					if (results.length === 0) {
						return { config, secret: null };
					}
					return { config, secret: results[0].value };
				});
		})
		.then(({ config, secret }) => {
			return knex('logsChannelSecret').insert({
				backend: config.apiEndpoint ?? '',
				secret,
			});
		})
		.then(() => {
			return knex('config').where('key', 'logsChannelSecret').del();
		});
};

exports.down = function () {
	return Promise.reject(new Error('Not Implemented'));
};
