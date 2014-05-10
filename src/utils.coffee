Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'

# Parses package.json and returns resin-supervisor's version
exports.getSupervisorVersion = ->
	fs.readFileAsync(__dirname + '/../package.json', 'utf-8')
	.then (data) ->
		obj = JSON.parse data
		return obj.version
