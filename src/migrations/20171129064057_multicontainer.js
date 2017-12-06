
var defaultLegacyVolume = function (appId) {
	return `resin-data-${appId}`
}

var singleToMulticontainerApp = function (app, appId) {
	let tryParse = (obj) ->
		try
			JSON.parse(obj)
		catch
			{}
	let conf = tryParse(app.config)
	let env = tryParse(app.env)
	let environment = {}
	for (key in env) {
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
	newApp.services = {
		'1': {
			serviceName: 'main',
			imageId: 1,
			commit: app.commit
			releaseId: 1
			image: app.imageId
			privileged: true
			network_mode: 'host'
			volumes: [
				`${defaultVolume}:/data`
			]
			labels: {
				'io.resin.features.kernel_modules': '1'
				'io.resin.features.firmware': '1'
				'io.resin.features.dbus': '1'
				'io.resin.features.supervisor_api': '1'
				'io.resin.features.resin_api': '1'
				'io.resin.update.strategy': updateStrategy
				'io.resin.update.handover_timeout': handoverTimeout
			}
			environment: environment
			restart: restartPolicy
			running: true
		}
	}
	return newApp
}

// TODO: this whole thing is WIP
exports.up = function (knex, Promise) {
	let addColumn = (table, type, column) => {
		return knex.schema.table(table, (t) => { return t[type](column) })
	}
	let dropColumn = (table, column) => {
		return knex.schema.table(table, (t) => { return t.dropColumn(column) })
	}

	return knex('app').select().whereNot({ markedForDeletion: true }).orWhereNull('markedForDeletion')
		.tap((apps) => {
			if (apps.length > 0) {
				return knex('config').insert({ key: 'legacyAppsPresent', value: 'true' })
			}
		})
		.then((apps) => {
			knex.schema.createTable('image', (t) => {
				t.increments('id').primary()
				t.string('name')
				t.integer('appId')
				t.integer('serviceId')
				t.string('serviceName')
				t.integer('imageId')
				t.integer('releaseId')
				t.boolean('dependent')
			})
			.then(() => {
				knex.schema.dropTable('app')
			})
			.then(() => {
				knex.schema.createTable('app', (t) => {
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
		.then(() => {
			dropColumn('deviceConfig', 'values')
		})
}

exports.down = function(knex, Promise) {
	return Promise.try(() => { throw new Error('Not implemented') })
}