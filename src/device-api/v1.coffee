Promise = require('bluebird')
_ = require('lodash')

constants = require('../lib/constants')
{ checkInt, checkTruthy } = require('../lib/validation')
{ doRestart, doPurge, serviceAction } = require('./common')

exports.createV1Api = (router, applications) ->

	{ eventTracker } = applications

	router.post '/v1/restart', (req, res, next) ->
		appId = checkInt(req.body.appId)
		force = checkTruthy(req.body.force)
		eventTracker.track('Restart container (v1)', { appId })
		if !appId?
			return res.status(400).send('Missing app id')
		doRestart(applications, appId, force)
		.then ->
			res.status(200).send('OK')
		.catch(next)

	v1StopOrStart = (req, res, next, action) ->
		appId = checkInt(req.params.appId)
		force = checkTruthy(req.body.force)
		if !appId?
			return res.status(400).send('Missing app id')
		applications.getCurrentApp(appId)
		.then (app) ->
			service = app?.services?[0]
			if !service?
				return res.status(400).send('App not found')
			if app.services.length > 1
				return res.status(400).send('Some v1 endpoints are only allowed on single-container apps')
			applications.setTargetVolatileForService(service.imageId, running: action != 'stop')
			applications.executeStepAction(serviceAction(action, service.serviceId, service, service, { wait: true }), { force })
			.then ->
				if action == 'stop'
					return service
				# We refresh the container id in case we were starting an app with no container yet
				applications.getCurrentApp(appId)
				.then (app) ->
					service = app?.services?[0]
					if !service?
						throw new Error('App not found after running action')
					return service
			.then (service) ->
				res.status(200).json({ containerId: service.containerId })
		.catch(next)

	createV1StopOrStartHandler = (action) -> _.partial(v1StopOrStart, _, _, _, action)

	router.post('/v1/apps/:appId/stop', createV1StopOrStartHandler('stop'))
	router.post('/v1/apps/:appId/start', createV1StopOrStartHandler('start'))

	router.get '/v1/apps/:appId', (req, res, next) ->
		appId = checkInt(req.params.appId)
		eventTracker.track('GET app (v1)', { appId })
		if !appId?
			return res.status(400).send('Missing app id')
		Promise.join(
			applications.getCurrentApp(appId)
			applications.getStatus()
			(app, status) ->
				service = app?.services?[0]
				if !service?
					return res.status(400).send('App not found')
				if app.services.length > 1
					return res.status(400).send('Some v1 endpoints are only allowed on single-container apps')
				# Don't return data that will be of no use to the user
				appToSend = {
					appId
					containerId: service.containerId
					env: _.omit(service.environment, constants.privateAppEnvVars)
					releaseId: service.releaseId
					imageId: service.image
				}
				if status.commit?
					appToSend.commit = status.commit
				res.json(appToSend)
		)
		.catch(next)

	router.post '/v1/purge', (req, res, next) ->
		appId = checkInt(req.body.appId)
		force = checkTruthy(req.body.force)
		if !appId?
			errMsg = 'Invalid or missing appId'
			return res.status(400).send(errMsg)
		doPurge(applications, appId, force)
		.then ->
			res.status(200).json(Data: 'OK', Error: '')
		.catch(next)
