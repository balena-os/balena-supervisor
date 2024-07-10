export async function up(knex) {
	// Drop the container logs table
	if (await knex.schema.hasTable('containerLogs')) {
		await knex.schema.dropTable('containerLogs');
	}
}

export function down() {
	throw new Error('Not implemented');
}
