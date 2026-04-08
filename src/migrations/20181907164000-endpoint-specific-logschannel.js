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
	// take the logsChannelSecret, and the apiEndpoint config field,
	// and store them in a new table
	const exists = await knex.schema.hasTable('logsChannelSecret');
	if (!exists) {
		await knex.schema.createTable('logsChannelSecret', (t) => {
			t.string('backend');
			t.string('secret');
		});
	}

	const results = await knex('config')
		.where({ key: 'logsChannelSecret' })
		.select('value');

	const secret = results.length === 0 ? null : results[0].value;

	await knex('logsChannelSecret').insert({
		backend: config.apiEndpoint ?? '',
		secret,
	});

	await knex('config').where('key', 'logsChannelSecret').del();
}

export function down() {
	throw new Error('Not implemented');
}
