export async function up(knex) {
	await knex.schema.createTable('currentCommit', (table) => {
		table.integer('id').primary();
		table.integer('appId').notNullable();
		table.string('commit').notNullable();
		table.unique(['appId']);
	});

	const currentCommit = await knex('config')
		.where({ key: 'currentCommit' })
		.select('value');
	if (currentCommit[0]?.value != null) {
		const apps = await knex('app').select(['appId']);

		for (const app of apps) {
			await knex('currentCommit').insert({
				appId: app.appId,
				commit: currentCommit[0].value,
			});
		}

		await knex('config').where({ key: 'currentCommit' }).delete();
	}
}

export function down() {
	throw new Error('Not implemented');
}
