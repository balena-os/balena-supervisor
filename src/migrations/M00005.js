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
}

export function down() {
	return Promise.reject(new Error('Not Implemented'));
}
