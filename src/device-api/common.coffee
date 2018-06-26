_ = require('lodash')

{ appNotFoundMessage } = require('../lib/messages')

exports.doRestart = (applications, appId, force) ->
	{ _lockingIfNecessary, deviceState } = applications

	_lockingIfNecessary appId, { force }, ->
		deviceState.getCurrentForComparison()
		.then (currentState) ->
			app = currentState.local.apps[appId]
			imageIds = _.map(app.services, 'imageId')
			applications.clearTargetVolatileForServices(imageIds)
			stoppedApp = _.cloneDeep(app)
			stoppedApp.services = []
			currentState.local.apps[appId] = stoppedApp
			deviceState.pausingApply ->
				deviceState.applyIntermediateTarget(currentState, { skipLock: true })
				.then ->
					currentState.local.apps[appId] = app
					deviceState.applyIntermediateTarget(currentState, { skipLock: true })
			.finally ->
				deviceState.triggerApplyTarget()

exports.doPurge = (applications, appId, force) ->
	{ logger, _lockingIfNecessary, deviceState } = applications

	logger.logSystemMessage("Purging data for app #{appId}", { appId }, 'Purge data')
	_lockingIfNecessary appId, { force }, ->
		deviceState.getCurrentForComparison()
		.then (currentState) ->
			app = currentState.local.apps[appId]
			if !app?
				throw new Error(appNotFoundMessage)
			purgedApp = _.cloneDeep(app)
			purgedApp.services = []
			purgedApp.volumes = {}
			currentState.local.apps[appId] = purgedApp
			deviceState.pausingApply ->
				deviceState.applyIntermediateTarget(currentState, { skipLock: true })
				.then ->
					currentState.local.apps[appId] = app
					deviceState.applyIntermediateTarget(currentState, { skipLock: true })
			.finally ->
				deviceState.triggerApplyTarget()
	.tap ->
		logger.logSystemMessage('Purged data', { appId }, 'Purge data success')
	.tapCatch (err) ->
		logger.logSystemMessage("Error purging data: #{err}", { appId, error: err }, 'Purge data error')

exports.serviceAction = (action, serviceId, current, target, options = {}) ->
	return { action, serviceId, current, target, options }
