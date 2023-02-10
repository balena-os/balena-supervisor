// This migration removes references to dependent devices from
// the database, as we are no longer pursuing dependent devices.
export async function up(knex) {
	// Remove dependent key from each image
	if (await knex.schema.hasColumn('image', 'dependent')) {
		await knex.schema.table('image', (t) => {
			return t.dropColumn('dependent');
		});
	}

	// Delete dependent device/app tables
	const dropTable = async (table) => {
		const exists = await knex.schema.hasTable(table);
		if (exists) {
			await knex.schema.dropTable(table);
		}
	};
	await dropTable('dependentDeviceTarget');
	await dropTable('dependentDevice');
	await dropTable('dependentAppTarget');
	await dropTable('dependentApp');
}

export function down() {
	throw new Error('Not Implemented');
}
