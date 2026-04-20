import fs from 'fs';
const configJsonPath = process.env.CONFIG_MOUNT_POINT;

import { checkTruthy } from '../lib/validation';

export async function up(knex) {
	const results = await knex('config')
		.where({ key: 'localMode' })
		.select('value');
	if (results.length === 0) {
		// We don't need to do anything
		return;
	}

	let value = checkTruthy(results[0].value);
	value = value ?? false;

	await new Promise((resolve) => {
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
				// Assign the local mode value
				parsed.localMode = value;

				fs.writeFile(configJsonPath, JSON.stringify(parsed), (err2) => {
					if (err2) {
						console.log(
							'Failed to write config.json! Things may fail unexpectedly!',
						);
						return;
					}
					resolve(false);
				});
			} catch {
				console.log(
					'Failed to parse config.json! Things may fail unexpectedly!',
				);
				resolve(false);
			}
		});
	});
	await knex('config').where('key', 'localMode').del();
}

export function down() {
	throw new Error('Not implemented');
}
