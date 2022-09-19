const Bluebird = require('bluebird');
const _ = require('lodash');

var tryParse = function (obj) {
	try {
		return JSON.parse(obj);
	} catch {
		return {};
	}
};

var singleToMulticontainerApp = function (app) {
	// From *very* old supervisors, env or config may be null
	// so we ignore errors parsing them
	const conf = tryParse(app.config);
	const env = tryParse(app.env);
	const environment = {};
	const appId = parseInt(app.appId, 10);
	for (let key in env) {
		if (!/^RESIN_/.test(key)) {
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
	const updateStrategy = _.get(
		conf,
		'RESIN_SUPERVISOR_UPDATE_STRATEGY',
		'download-then-kill',
	);
	const handoverTimeout = _.get(conf, 'RESIN_SUPERVISOR_HANDOVER_TIMEOUT', '');
	const restartPolicy = _.get(conf, 'RESIN_APP_RESTART_POLICY', 'always');
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

var jsonifyAppFields = function (app) {
	const newApp = _.clone(app);
	newApp.services = JSON.stringify(app.services);
	newApp.networks = JSON.stringify(app.networks);
	newApp.volumes = JSON.stringify(app.volumes);
	return newApp;
};

var imageForApp = function (app) {
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

var imageForDependentApp = function (app) {
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

exports.up = function (knex) {
	return Bluebird.resolve(
		knex.schema.createTable('image', (t) => {
			t.increments('id').primary();
			t.string('name');
			t.integer('appId');
			t.integer('serviceId');
			t.string('serviceName');
			t.integer('imageId');
			t.integer('releaseId');
			t.boolean('dependent');
		}),
	)
		.then(() =>
			knex('app')
				.select()
				.whereNot({ markedForDeletion: true })
				.orWhereNull('markedForDeletion'),
		)
		.tap((apps) => {
			if (apps.length > 0) {
				return knex('config').insert({
					key: 'legacyAppsPresent',
					value: 'true',
				});
			}
		})
		.tap(() => {
			// We're in a transaction, and it's easier to drop and recreate
			// than to migrate each field...
			return knex.schema.dropTable('app').then(() => {
				return knex.schema.createTable('app', (t) => {
					t.increments('id').primary();
					t.string('name');
					t.integer('releaseId');
					t.string('commit');
					t.integer('appId');
					t.json('services');
					t.json('networks');
					t.json('volumes');
				});
			});
		})
		.map((app) => {
			const migratedApp = singleToMulticontainerApp(app);
			return knex('app')
				.insert(jsonifyAppFields(migratedApp))
				.then(() => knex('image').insert(imageForApp(migratedApp)));
		})
		.then(() => {
			// For some reason dropping a column in this table doesn't work. Anyways, we don't want to store old targetValues.
			// Instead, on first run the supervisor will store current device config values as targets - so we want to
			// make the old values that refer to supervisor config be the *current* values, and we do that by inserting
			// to the config table.
			return knex('deviceConfig')
				.select()
				.then((deviceConf) => {
					return knex.schema.dropTable('deviceConfig').then(() => {
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
						return Bluebird.map(Object.keys(values), (envVarName) => {
							if (configKeys[envVarName] != null) {
								return knex('config').insert({
									key: configKeys[envVarName],
									value: values[envVarName],
								});
							}
						});
					});
				})
				.then(() => {
					return knex.schema.createTable('deviceConfig', (t) => {
						t.json('targetValues');
					});
				})
				.then(() => knex('deviceConfig').insert({ targetValues: '{}' }));
		})
		.then(() => knex('dependentApp').select())
		.then((dependentApps) => {
			return knex.schema
				.dropTable('dependentApp')
				.then(() => {
					return knex.schema.createTable('dependentApp', (t) => {
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
				})
				.then(() => {
					return knex.schema.createTable('dependentAppTarget', (t) => {
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
				})
				.then(() => {
					return Bluebird.map(dependentApps, (app) => {
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
						return knex('image')
							.insert(image)
							.then(() => knex('dependentApp').insert(newApp))
							.then(() => knex('dependentAppTarget').insert(newApp));
					});
				});
		})
		.then(() => knex('dependentDevice').select())
		.then((dependentDevices) => {
			return knex.schema
				.dropTable('dependentDevice')
				.then(() => {
					return knex.schema.createTable('dependentDevice', (t) => {
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
				})
				.then(() => {
					return knex.schema.createTable('dependentDeviceTarget', (t) => {
						t.increments('id').primary();
						t.string('uuid');
						t.string('name');
						t.json('apps');
					});
				})
				.then(() => {
					return Bluebird.map(dependentDevices, (device) => {
						const newDevice = _.clone(device);
						newDevice.appId = parseInt(device.appId, 10);
						newDevice.deviceId = parseInt(device.deviceId, 10);
						if (device.is_managed_by != null) {
							newDevice.is_managed_by = parseInt(device.is_managed_by, 10);
						}
						newDevice.config = JSON.stringify(tryParse(device.config));
						newDevice.environment = JSON.stringify(
							tryParse(device.environment),
						);
						newDevice.targetConfig = JSON.stringify(
							tryParse(device.targetConfig),
						);
						newDevice.targetEnvironment = JSON.stringify(
							tryParse(device.targetEnvironment),
						);
						if (newDevice.markedForDeletion == null) {
							newDevice.markedForDeletion = false;
						}
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
						return knex('dependentDevice')
							.insert(newDevice)
							.then(() => knex('dependentDeviceTarget').insert(deviceTarget));
					});
				});
		});
};

exports.down = function () {
	return Promise.reject(new Error('Not implemented'));
};
