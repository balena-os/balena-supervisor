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

	const legacyAppsPresent = await knex('config')
		.where({ key: 'legacyAppsPresent' })
		.select('value');

	// If there are legacy apps we let the database normalization function
	// populate the correct values
	if (legacyAppsPresent && legacyAppsPresent.length > 0) {
		return;
	}

	// Otherwise delete cloud target apps and images in the database so they can get repopulated
	// with the uuid from the target state. Removing the `targetStateSet` configuration ensures that
	// the supervisor will maintain the current state and will only apply the new target once it gets
	// a new cloud copy, which should include the proper metadata
	await knex('image').del();
	await knex('app').whereNot({ source: 'local' }).del();
	await knex('config').where({ key: 'targetStateSet' }).del();

	const apps = await knex('app').select();

	// For remaining local apps, if any, the appUuid is not that relevant, so just
	// use appId to prevent the app from getting uninstalled. Adding the appUuid will restart
	// the app though
	await Promise.all(
		apps.map((app) => {
			const services = JSON.parse(app.services).map((svc) => ({
				...svc,
				appUuid: app.appId.toString(),
			}));

			return knex('app')
				.where({ id: app.id })
				.update({
					uuid: app.appId.toString(),
					services: JSON.stringify(services),
				});
		}),
	);
}

export function down() {
	throw new Error('Not Implemented');
}
