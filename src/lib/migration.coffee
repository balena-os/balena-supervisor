
exports.defaultLegacyVolume = -> 'resin-data'

exports.singleToMulticontainerApp = (app) ->
	environment = {}
	for key of app.env
		if !/^RESIN_/.test(key)
			environment[key] = app.env[key]

	appId = app.appId
	conf = app.config ? {}
	newApp = {
		appId: appId
		commit: app.commit
		name: app.name
		releaseId: 1
		networks: {}
		volumes: {}
	}
	defaultVolume = exports.defaultLegacyVolume()
	newApp.volumes[defaultVolume] = {}
	updateStrategy = conf['RESIN_SUPERVISOR_UPDATE_STRATEGY']
	if !updateStrategy?
		updateStrategy = 'download-then-kill'
	handoverTimeout = conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT']
	if !handoverTimeout?
		handoverTimeout = ''
	restartPolicy = conf['RESIN_APP_RESTART_POLICY']
	if !restartPolicy?
		restartPolicy = 'always'

	newApp.services = {
		'1': {
			appId: appId
			serviceName: 'main'
			imageId: 1
			commit: app.commit
			releaseId: 1
			image: app.imageId
			privileged: true
			networkMode: 'host'
			volumes: [
				"#{defaultVolume}:/data"
			],
			labels: {
				'io.resin.features.kernel-modules': '1'
				'io.resin.features.firmware': '1'
				'io.resin.features.dbus': '1',
				'io.resin.features.supervisor-api': '1'
				'io.resin.features.resin-api': '1'
				'io.resin.update.strategy': updateStrategy
				'io.resin.update.handover-timeout': handoverTimeout
				'io.resin.legacy-container': '1'
			},
			environment: environment
			restart: restartPolicy
			running: true
		}
	}
	return newApp
