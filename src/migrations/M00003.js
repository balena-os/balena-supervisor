export async function up(knex) {
	const [target] = await knex('deviceConfig').select('targetValues');

	const targetValues = target.targetValues;
	const jsonValues = JSON.parse(targetValues);

	if (jsonValues['SUPERVISOR_DELTA_APPLY_TIMEOUT'] === '') {
		jsonValues['SUPERVISOR_DELTA_APPLY_TIMEOUT'] = '0';

		// Only update the database if we need to
		await knex('deviceConfig').update({
			targetValues: JSON.stringify(jsonValues),
		});
	}
}

export function down() {
	throw new Error('Not implemented');
}
