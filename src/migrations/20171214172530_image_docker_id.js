// Adds a dockerImageId column to the image table to identify images downloaded with deltas
export async function up(knex) {
	await knex.schema.table('image', (t) => {
		t.string('dockerImageId');
	});
}

export function down() {
	throw new Error('Not implemented');
}
