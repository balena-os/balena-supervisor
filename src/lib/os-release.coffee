Promise = require 'bluebird'
fs = require 'fs'
_ = require 'lodash'

exports.getOSReleaseField = (path, field) ->
	try
		releaseData = fs.readFileSync(path)
		lines = releaseData.toString().split('\n')
		releaseItems = {}
		for line in lines
			[ key, val ] = line.split('=')
			releaseItems[_.trim(key)] = _.trim(val)
		if !releaseItems[field]?
			throw new Error("Field #{field} not available in #{path}")
		# Remove enclosing quotes: http://stackoverflow.com/a/19156197/2549019
		return releaseItems[field].replace(/^"(.+(?="$))"$/, '$1')
	catch err
		console.log('Could not get OS release field: ', err.message)
		return undefined


exports.getOSVersionSync = (path) ->
	exports.getOSReleaseField(path, 'PRETTY_NAME')

exports.getOSVersion = (path) ->
	Promise.try ->
		exports.getOSVersionSync(path)

exports.getOSVariantSync = (path) ->
	exports.getOSReleaseField(path, 'VARIANT_ID')

exports.getOSVariant = (path) ->
	Promise.try ->
		exports.getOSVariantSync(path)
