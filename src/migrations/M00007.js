export async function up(knex) {
	// Add serviceName to apiSecret schema
	await knex.schema.table('apiSecret', (table) => {
		table.string('serviceName');
		table.unique(['appId', 'serviceName']);
	});

	const targetServices = (await knex('app').select(['appId', 'services']))
		.map(({ appId, services }) => ({
			appId,
			// Extract service name and id per app
			services: JSON.parse(services).map(({ serviceId, serviceName }) => ({
				serviceId,
				serviceName,
			})),
		}))
		.reduce(
			// Convert to array of {appId, serviceId, serviceName}
			(apps, { appId, services }) =>
				apps.concat(services.map((svc) => ({ appId, ...svc }))),
			[],
		);

	// Update all API secret entries so services can still access the API after
	// the change
	await Promise.all(
		targetServices.map(({ appId, serviceId, serviceName }) =>
			knex('apiSecret').update({ serviceName }).where({ appId, serviceId }),
		),
	);

	// Update the table schema deleting the serviceId column
	await knex.schema.table('apiSecret', (table) => {
		table.dropUnique(['appId', 'serviceId']);
		table.dropColumn('serviceId');
	});
}

export function down() {
	return Promise.reject(new Error('Not Implemented'));
}
