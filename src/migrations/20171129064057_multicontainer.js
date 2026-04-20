const tryParse = function (obj) {
	try {
		return JSON.parse(obj);
	} catch {
		return {};
	}
};

const singleToMulticontainerApp = function (app) {
	// From *very* old supervisors, env or config may be null
	// so we ignore errors parsing them
	const conf = tryParse(app.config);
	const env = tryParse(app.env);
	const environment = {};
	const appId = parseInt(app.appId, 10);
	for (const key in env) {
		if (!key.startsWith('RESIN_')) {
			environment[key] = env[key];
		}
	}
	const newApp = {
		appId: appId,
		commit: app.commit,
		name: app.name,
		releaseId: 1,
		networks: {},
		volumes: {},
	};
	const defaultVolume = 'resin-data';
	newApp.volumes[defaultVolume] = {};
	const updateStrategy =
		conf.RESIN_SUPERVISOR_UPDATE_STRATEGY ?? 'download-then-kill';
	const handoverTimeout = conf.RESIN_SUPERVISOR_HANDOVER_TIMEOUT ?? '';
	const restartPolicy = conf.RESIN_APP_RESTART_POLICY ?? 'always';
	newApp.services = [
		{
			serviceId: 1,
			appId: appId,
			serviceName: 'main',
			imageId: 1,
			commit: app.commit,
			releaseId: 1,
			image: app.imageId,
			privileged: true,
			networkMode: 'host',
			volumes: [`${defaultVolume}:/data`],
			labels: {
				'io.resin.features.kernel-modules': '1',
				'io.resin.features.firmware': '1',
				'io.resin.features.dbus': '1',
				'io.resin.features.supervisor-api': '1',
				'io.resin.features.resin-api': '1',
				'io.resin.update.strategy': updateStrategy,
				'io.resin.update.handover-timeout': handoverTimeout,
				'io.resin.legacy-container': '1',
			},
			environment: environment,
			restart: restartPolicy,
			running: true,
		},
	];
	return newApp;
};

const jsonifyAppFields = function (app) {
	const newApp = { ...app };
	newApp.services = JSON.stringify(app.services);
	newApp.networks = JSON.stringify(app.networks);
	newApp.volumes = JSON.stringify(app.volumes);
	return newApp;
};

const imageForApp = function (app) {
	const service = app.services[0];
	return {
		name: service.image,
		appId: service.appId,
		serviceId: service.serviceId,
		serviceName: service.serviceName,
		imageId: service.imageId,
		releaseId: service.releaseId,
		dependent: 0,
	};
};

const imageForDependentApp = function (app) {
	return {
		name: app.image,
		appId: app.appId,
		serviceId: null,
		serviceName: null,
		imageId: app.imageId,
		releaseId: null,
		dependent: 1,
	};
};

export async function up(knex) {
	await knex.schema.createTable('image', (t) => {
		t.increments('id').primary();
		t.string('name');
		t.integer('appId');
		t.integer('serviceId');
		t.string('serviceName');
		t.integer('imageId');
		t.integer('releaseId');
		t.boolean('dependent');
	});

	const apps = await knex('app')
		.select()
		.whereNot({ markedForDeletion: true })
		.orWhereNull('markedForDeletion');

	if (apps.length > 0) {
		await knex('config').insert({
			key: 'legacyAppsPresent',
			value: 'true',
		});
	}

	// We're in a transaction, and it's easier to drop and recreate
	// than to migrate each field...
	await knex.schema.dropTable('app');
	await knex.schema.createTable('app', (t) => {
		t.increments('id').primary();
		t.string('name');
		t.integer('releaseId');
		t.string('commit');
		t.integer('appId');
		t.json('services');
		t.json('networks');
		t.json('volumes');
	});
	await Promise.all(
		apps.map(async (app) => {
			const migratedApp = singleToMulticontainerApp(app);
			await knex('app').insert(jsonifyAppFields(migratedApp));
			await knex('image').insert(imageForApp(migratedApp));
		}),
	);
	// For some reason dropping a column in this table doesn't work. Anyways, we don't want to store old targetValues.
	// Instead, on first run the supervisor will store current device config values as targets - so we want to
	// make the old values that refer to supervisor config be the *current* values, and we do that by inserting
	// to the config table.
	const deviceConf = await knex('deviceConfig').select();
	await knex.schema.dropTable('deviceConfig');
	const values = JSON.parse(deviceConf[0].values);
	const configKeys = {
		RESIN_SUPERVISOR_POLL_INTERVAL: 'appUpdatePollInterval',
		RESIN_SUPERVISOR_LOCAL_MODE: 'localMode',
		RESIN_SUPERVISOR_CONNECTIVITY_CHECK: 'connectivityCheckEnabled',
		RESIN_SUPERVISOR_LOG_CONTROL: 'loggingEnabled',
		RESIN_SUPERVISOR_DELTA: 'delta',
		RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT: 'deltaRequestTimeout',
		RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT: 'deltaApplyTimeout',
		RESIN_SUPERVISOR_DELTA_RETRY_COUNT: 'deltaRetryCount',
		RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL: 'deltaRequestTimeout',
		RESIN_SUPERVISOR_OVERRIDE_LOCK: 'lockOverride',
	};
	await Promise.all(
		Object.keys(values).map((envVarName) => {
			if (configKeys[envVarName] != null) {
				return knex('config').insert({
					key: configKeys[envVarName],
					value: values[envVarName],
				});
			}
		}),
	);
	await knex.schema.createTable('deviceConfig', (t) => {
		t.json('targetValues');
	});
	await knex('deviceConfig').insert({ targetValues: '{}' });
	const dependentApps = await knex('dependentApp').select();
	await knex.schema.dropTable('dependentApp');
	await knex.schema.createTable('dependentApp', (t) => {
		t.increments('id').primary();
		t.integer('appId');
		t.integer('parentApp');
		t.string('name');
		t.string('commit');
		t.integer('releaseId');
		t.integer('imageId');
		t.string('image');
		t.json('environment');
		t.json('config');
	});
	await knex.schema.createTable('dependentAppTarget', (t) => {
		t.increments('id').primary();
		t.integer('appId');
		t.integer('parentApp');
		t.string('name');
		t.string('commit');
		t.integer('releaseId');
		t.integer('imageId');
		t.string('image');
		t.json('environment');
		t.json('config');
	});
	await Promise.all(
		dependentApps.map(async (app) => {
			const newApp = {
				appId: parseInt(app.appId, 10),
				parentApp: parseInt(app.parentAppId, 10),
				image: app.imageId,
				releaseId: null,
				commit: app.commit,
				name: app.name,
				config: JSON.stringify(tryParse(app.config)),
				environment: JSON.stringify(tryParse(app.environment)),
			};
			const image = imageForDependentApp(newApp);
			await knex('image').insert(image);
			await knex('dependentApp').insert(newApp);
			await knex('dependentAppTarget').insert(newApp);
		}),
	);
	const dependentDevices = await knex('dependentDevice').select();
	await knex.schema.dropTable('dependentDevice');
	await knex.schema.createTable('dependentDevice', (t) => {
		t.increments('id').primary();
		t.string('uuid');
		t.integer('appId');
		t.string('localId');
		t.string('device_type');
		t.string('logs_channel');
		t.integer('deviceId');
		t.boolean('is_online');
		t.string('name');
		t.string('status');
		t.string('download_progress');
		t.integer('is_managed_by');
		t.dateTime('lock_expiry_date');
		t.string('commit');
		t.string('targetCommit');
		t.json('environment');
		t.json('targetEnvironment');
		t.json('config');
		t.json('targetConfig');
		t.boolean('markedForDeletion');
	});
	await knex.schema.createTable('dependentDeviceTarget', (t) => {
		t.increments('id').primary();
		t.string('uuid');
		t.string('name');
		t.json('apps');
	});
	await Promise.all(
		dependentDevices.map(async (device) => {
			const newDevice = { ...device };
			newDevice.appId = parseInt(device.appId, 10);
			newDevice.deviceId = parseInt(device.deviceId, 10);
			if (device.is_managed_by != null) {
				newDevice.is_managed_by = parseInt(device.is_managed_by, 10);
			}
			newDevice.config = JSON.stringify(tryParse(device.config));
			newDevice.environment = JSON.stringify(tryParse(device.environment));
			newDevice.targetConfig = JSON.stringify(tryParse(device.targetConfig));
			newDevice.targetEnvironment = JSON.stringify(
				tryParse(device.targetEnvironment),
			);
			newDevice.markedForDeletion ??= false;
			const deviceTarget = {
				uuid: device.uuid,
				name: device.name,
				apps: {},
			};
			deviceTarget.apps[device.appId] = {
				commit: newDevice.targetCommit,
				config: newDevice.targetConfig,
				environment: newDevice.targetEnvironment,
			};
			await knex('dependentDevice').insert(newDevice);
			await knex('dependentDeviceTarget').insert(deviceTarget);
		}),
	);
}

export function down() {
	throw new Error('Not implemented');
}
