
var defaultLegacyVolume = function (appId) {
	return `resin-data-${appId}`
}

var tryParse = function (obj) {
	try {
		return JSON.parse(obj)
	}
	catch(e) {
		return {}
	}
}

var singleToMulticontainerApp = function (app, appId) {
	// From *very* old supervisors, env or config may be null
	// so we ignore errors parsing them
	let conf = tryParse(app.config)
	let env = tryParse(app.env)
	let environment = {}
	for (let key in env) {
		if (!/^RESIN_/.test(key)) {
			environment[key] = env[key]
		}
	}
	let newApp = {
		appId: appId,
		commit: app.commit,
		name: app.name,
		releaseId: 1,
		networks: {},
		volumes: {}
	}
	let defaultVolume = defaultLegacyVolume(appId)
	newApp.volumes[defaultVolume] = {}
	let updateStrategy = conf['RESIN_SUPERVISOR_UPDATE_STRATEGY']
	if (updateStrategy == null) {
		updateStrategy = 'download-then-kill'
	}
	let handoverTimeout = conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT']
	if (handoverTimeout == null) {
		handoverTimeout = ''
	}
	let restartPolicy = conf['RESIN_APP_RESTART_POLICY']
	if (restartPolicy == null) {
		restartPolicy = 'unless-stopped'
	}
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
			network_mode: 'host',
			volumes: [
				`${defaultVolume}:/data`
			],
			labels: {
				'io.resin.features.kernel_modules': '1',
				'io.resin.features.firmware': '1',
				'io.resin.features.dbus': '1',
				'io.resin.features.supervisor_api': '1',
				'io.resin.features.resin_api': '1',
				'io.resin.update.strategy': updateStrategy,
				'io.resin.update.handover_timeout': handoverTimeout
			},
			environment: environment,
			restart: restartPolicy,
			running: true
		}
	]
	return newApp
}

var jsonifyAppFields = function (app) {
	let newApp = Object.assign({}, app)
	newApp.services = JSON.stringify(app.services)
	newApp.networks = JSON.stringify(app.networks)
	newApp.volumes = JSON.stringify(app.volumes)
	return newApp
}

var imageForApp = function (app) {
	let service = app.services[0]
	return {
		name: service.image,
		appId: service.appId,
		serviceId: service.serviceId,
		serviceName: service.serviceName,
		imageId: service.imageId,
		releaseId: service.releaseId,
		dependent: 0
	}
}

var imageForDependentApp = function (app) {
	return {
		name: app.image,
		appId: app.appId,
		serviceId: null,
		serviceName: null,
		imageId: app.imageId,
		releaseId: null,
		dependent: 1
	}
}

// TODO: this whole thing is WIP
exports.up = function (knex, Promise) {
	return knex.schema.createTable('image', (t) => {
			t.increments('id').primary()
			t.string('name')
			t.integer('appId')
			t.integer('serviceId')
			t.string('serviceName')
			t.integer('imageId')
			t.integer('releaseId')
			t.boolean('dependent')
		})
		.then(() => knex('app').select().whereNot({ markedForDeletion: true }).orWhereNull('markedForDeletion'))
		.tap((apps) => {
			if (apps.length > 0) {
				return knex('config').insert({ key: 'legacyAppsPresent', value: 'true' })
			}
		})
		.tap(() => {
			// We're in a transaction, and it's easier to drop and recreate
			// than to migrate each field...
			return knex.schema.dropTable('app')
				.then(() => {
					return knex.schema.createTable('app', (t) => {
						t.increments('id').primary()
						t.string('name')
						t.integer('releaseId')
						t.string('commit')
						t.integer('appId')
						t.json('services')
						t.json('networks')
						t.json('volumes')
					})
				})
		})
		.map((app) => {
			let migratedApp = singleToMulticontainerApp(app)
			return knex('app').insert(jsonifyAppFields(migratedApp))
				.then(() => knex('image').insert(imageForApp(migratedApp)))
		})
		.then(() => {
			// For some reason dropping a column in this table doesn't work. Anyways, we don't want to store old targetValues.
			// Instead, on first run the supervisor will store current device config values as targets - so we want to
			// make the old values that refer to supervisor config be the *current* values, and we do that by inserting
			// to the config table.
			return knex('deviceConfig').select()
				.then((deviceConf) => {
					return knex.schema.dropTable('deviceConfig')
						.then(() => {
							let values = JSON.parse(deviceConf[0].values)
							let promises = []
							let configKeys = {
								'RESIN_SUPERVISOR_POLL_INTERVAL': 'appUpdatePollInterval',
								'RESIN_SUPERVISOR_LOCAL_MODE': 'localMode',
								'RESIN_SUPERVISOR_CONNECTIVITY_CHECK': 'connectivityCheckEnabled',
								'RESIN_SUPERVISOR_LOG_CONTROL': 'loggingEnabled',
								'RESIN_SUPERVISOR_DELTA': 'delta',
								'RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT': 'deltaRequestTimeout',
								'RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT': 'deltaApplyTimeout',
								'RESIN_SUPERVISOR_DELTA_RETRY_COUNT': 'deltaRetryCount',
								'RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL': 'deltaRequestTimeout',
								'RESIN_SUPERVISOR_OVERRIDE_LOCK': 'lockOverride'
							}
							for (let envVarName in values) {
								if (configKeys[envVarName] != null) {
									promises.push(knex('config').insert({ key: configKeys[envVarName], value: values[envVarName]}))
								}
							}
							return Promise.all(promises)
						})
				})
				.then(() => {
					return knex.schema.createTable('deviceConfig', (t) => {
						t.json('targetValues')
					})
				})
				.then(() => knex('deviceConfig').insert({ targetValues: '{}' }))
		})
		.then(() => knex('dependentApp').select())
		.then((dependentApps) => {
			return knex.schema.dropTable('dependentApp')
				.then(() => {
					return knex.schema.createTable('dependentApp', (t) => {
						t.increments('id').primary()
						t.integer('appId')
						t.integer('parentApp')
						t.string('name')
						t.string('commit')
						t.integer('releaseId')
						t.integer('imageId')
						t.string('image')
						t.json('environment')
						t.json('config')
					})
				})
				.then(() => {
					return knex.schema.createTable('dependentAppTarget', (t) => {
						t.increments('id').primary()
						t.integer('appId')
						t.integer('parentApp')
						t.string('name')
						t.string('commit')
						t.integer('releaseId')
						t.integer('imageId')
						t.string('image')
						t.json('environment')
						t.json('config')
					})
				})
				.then(() => {
					return Promise.map(dependentApps, (app) => {
						let newApp = {
							appId: parseInt(app.appId),
							parentApp: parseInt(app.parentAppId),
							image: app.imageId,
							releaseId: null,
							commit: app.commit,
							name: app.name,
							config: JSON.stringify(tryParse(app.config)),
							environment: JSON.stringify(tryParse(app.environment))
						}
						let image = imageForDependentApp(newApp)
						return knex('image').insert(image)
							.then(() => knex('dependentApp').insert(newApp))
							.then(() => knex('dependentAppTarget').insert(newApp))
					})
				})
		})
		.then(() => knex('dependentDevice').select())
		.then((dependentDevices) => {
			return knex.schema.dropTable('dependentDevice')
				.then(() => {
					return knex.schema.createTable('dependentDevice', (t) => {
						t.increments('id').primary()
						t.string('uuid')
						t.integer('appId')
						t.string('localId')
						t.string('device_type')
						t.string('logs_channel')
						t.integer('deviceId')
						t.boolean('is_online')
						t.string('name')
						t.string('status')
						t.string('download_progress')
						t.integer('is_managed_by')
						t.dateTime('lock_expiry_date')
						t.string('commit')
						t.string('targetCommit')
						t.json('environment')
						t.json('targetEnvironment')
						t.json('config')
						t.json('targetConfig')
						t.boolean('markedForDeletion')
					})
				})
				.then(() => {
					return knex.schema.createTable('dependentDeviceTarget', (t) => {
						t.increments('id').primary()
						t.string('uuid')
						t.string('name')
						t.json('apps')
					})
				})
				.then(() => {
					return Promise.map(dependentDevices, (device) => {
						let newDevice = Object.assign({}, device)
						newDevice.appId = parseInt(device.appId)
						newDevice.deviceId = parseInt(device.deviceId)
						if (device.is_managed_by != null) {
							newDevice.is_managed_by = parseInt(device.is_managed_by)
						}
						newDevice.config = JSON.stringify(tryParse(device.config))
						newDevice.environment = JSON.stringify(tryParse(device.environment))
						newDevice.targetConfig = JSON.stringify(tryParse(device.targetConfig))
						newDevice.targetEnvironment = JSON.stringify(tryParse(device.targetEnvironment))
						if (newDevice.markedForDeletion == null) {
							newDevice.markedForDeletion = false
						}
						let deviceTarget = {
							uuid: device.uuid,
							name: device.name,
							apps: {}
						}
						deviceTarget.apps[device.appId] = {
							commit: newDevice.targetCommit,
							config: newDevice.targetConfig,
							environment: newDevice.targetEnvironment
						}
						return knex('dependentDevice').insert(newDevice)
							.then(() => knex('dependentDeviceTarget').insert(deviceTarget))
					})
				})
		})
}

exports.down = function(knex, Promise) {
	return Promise.try(() => { throw new Error('Not implemented') })
}