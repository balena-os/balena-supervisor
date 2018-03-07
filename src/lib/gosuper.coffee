Promise = require 'bluebird'
_ = require 'lodash'
{ request } = require './request'
constants = require './constants'

emptyHostRequest = request.defaults({ headers: Host: '' })
gosuperRequest = (method, endpoint, options = {}, callback) ->
	if _.isFunction(options)
		callback = options
		options = {}
	options.method = method
	options.url = constants.gosuperAddress + endpoint
	emptyHostRequest(options, callback)

gosuperPost = _.partial(gosuperRequest, 'POST')
gosuperGet = _.partial(gosuperRequest, 'GET')

module.exports =
	post: Promise.promisify(gosuperPost, multiArgs: true)
	get: Promise.promisify(gosuperGet, multiArgs: true)
