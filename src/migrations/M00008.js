export async function up(knex) {
	await knex.schema.table('app', (table) => {
		table.string('uuid');
		table.unique('uuid');
		table.string('class').defaultTo('fleet');
		table.boolean('isHost').defaultTo(false);
	});

	await knex.schema.table('image', (table) => {
		table.string('appUuid');
		table.string('commit');
	});
}

export function down() {
	throw new Error('Not Implemented');
}
