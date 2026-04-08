export async function up(knex) {
	await knex.schema.createTable('containerLogs', (table) => {
		table.string('containerId');
		table.integer('lastSentTimestamp');
	});
}

export function down() {
	throw new Error('Not implemented');
}
