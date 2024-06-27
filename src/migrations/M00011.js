export async function up(knex) {
	// Add a `rejected` field to the target app
	await knex.schema.table('app', (table) => {
		table.boolean('rejected').defaultTo(false);
	});
}

export function down() {
	throw new Error('Not implemented');
}
