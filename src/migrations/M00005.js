import { generateScopedKey } from '../lib/api-keys';

export async function up(knex) {
	// Create a new table to hold the api keys
	await knex.schema.createTable('apiSecret', (table) => {
		table.increments('id').primary();
		table.integer('appId');
		table.integer('serviceId');
		table.string('key');
		table.string('scopes');
		table.unique(['appId', 'serviceId']);
	});

	// Delete any existing API secrets
	await knex('config').where({ key: 'apiSecret' }).del();

	// Add an api secret per service in the db
	const apps = await knex('app');

	for (const app of apps) {
		const appId = app.appId;
		const services = JSON.parse(app.services);
		for (const service of services) {
			const serviceId = service.id;
			await generateScopedKey(appId, serviceId);
		}
	}
}

export function down() {
	return Promise.reject(new Error('Not Implemented'));
}
