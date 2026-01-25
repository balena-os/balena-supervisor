export async function up(knex) {
	await knex.schema.createTable('extensionState', (table) => {
		table.string('serviceName').primary();
		table.string('image').notNullable();
		table.string('imageDigest');
		table.string('deployedAt').notNullable();
	});
}

export function down() {
	throw new Error('Not implemented');
}
