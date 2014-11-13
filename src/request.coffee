request = require 'request'
Promise = require 'bluebird'

request = request.defaults
	gzip: true

module.exports = Promise.promisifyAll(request)
