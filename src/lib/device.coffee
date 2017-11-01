gosuper = require './gosuper'

exports.reboot = ->
	gosuper.post('/v1/reboot', { json: true })
	.spread (res, body) ->
		if res.statusCode != 202
			throw new Error(body.Error)
		return body

exports.shutdown = ->
	gosuper.post('/v1/shutdown', { json: true })
	.spread (res, body) ->
		if res.statusCode != 202
			throw new Error(body.Error)
		return body
