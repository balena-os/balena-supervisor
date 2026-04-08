export async function up(knex) {
	await knex.schema.createTable('engineSnapshot', (t) => {
		t.string('snapshot'); // Engine snapshot encoded as JSON.
		t.string('timestamp'); // When the snapshot was created.
	});
}

export function down() {
	throw new Error('Not implemented');
}
