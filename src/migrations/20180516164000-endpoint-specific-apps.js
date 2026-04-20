import fs from 'fs';
const configJsonPath = process.env.CONFIG_MOUNT_POINT;

export async function up(knex) {
	const config = await new Promise((resolve) => {
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
	});
	await knex.schema.table('app', (t) => {
		// Create a new column on the table and add the apiEndpoint config json
		// field if it exists
		t.string('source');
	});
	await knex('app').update({ source: config.apiEndpoint ?? '' });
}

export function down() {
	throw new Error('Not implemented');
}
