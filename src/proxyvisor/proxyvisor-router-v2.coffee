Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
url = require 'url'
{
	isDefined,
	parseDeviceFields,
	validStringOrUndefined,
	validObjectOrUndefined,
	tarPath,
	getTarArchive,
} = require './utils'

module.exports = class ProxyvisorRouterV1
	constructor: (@proxyvisor) ->
		{ @config, @logger, @db, @docker, @reportCurrentState } = @proxyvisor
		@router = express.Router()
