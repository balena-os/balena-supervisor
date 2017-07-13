Docker = require './lib/docker-utils'

module.exports = class ApplicationManager
	constructor: ({ @logger, @config }) ->

	getCurrent: =>
