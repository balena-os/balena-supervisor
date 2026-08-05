// markAsSupervised() previously matched an existing `image` row using the
// entire new row (dockerImageId included), so a rebuild that only changed the
// built content could never find the row it should update and inserted a new
// one instead. That left stale duplicate rows behind indefinitely. This
// removes them, keeping only the most recently written row for each
// (name, appUuid, serviceName, commit) group.
// See balena-os/balena-supervisor#2538.
export async function up(knex) {
	const duplicateKeys = await knex('image')
		.select('name', 'appUuid', 'serviceName', 'commit')
		.groupBy('name', 'appUuid', 'serviceName', 'commit')
		.havingRaw('count(*) > 1');

	for (const key of duplicateKeys) {
		const rows = await knex('image')
			.where({
				name: key.name,
				appUuid: key.appUuid,
				serviceName: key.serviceName,
				commit: key.commit,
			})
			.orderBy('id', 'desc')
			.select('id');

		const idsToDelete = rows.slice(1).map((row) => row.id);
		if (idsToDelete.length > 0) {
			await knex('image').whereIn('id', idsToDelete).del();
		}
	}
}

export function down() {
	throw new Error('Not implemented');
}
