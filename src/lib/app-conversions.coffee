_ = require 'lodash'

exports.stateToDB = (app, appId) ->
	dbApp = {
		appId: appId
		imageId: app.image
		name: app.name
		commit: app.commit
		config: JSON.stringify(app.config)
	}
	if app.parentApp?
		dbApp.parentAppId = app.parentApp
		dbApp.environment = JSON.stringify(app.environment) if app.environment?
	else
		dbApp.env = JSON.stringify(app.environment) if app.environment?
	return dbApp

exports.dbToState = (app) ->
	outApp = {
		appId: app.appId
		image: app.imageId
		name: app.name
		commit: app.commit
		config: JSON.parse(app.config)
	}
	if app.parentAppId?
		outApp.environment = JSON.parse(app.environment) if app.environment?
		outApp.parentApp = app.parentAppId
	else
		outApp.environment = JSON.parse(app.env) if app.env?
	return outApp

exports.keyByAndOmit = (collection, key) ->
	_.mapValues(_.keyBy(collection, key), (el) -> _.omit(el, key))
