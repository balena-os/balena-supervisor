gosuper = require './gosuper'

gosuperAction = (action) ->
	gosuper.post("/v1/#{action}", { json: true })
	.spread (res, body) ->
		if res.statusCode != 202
			throw new Error(body.Error)
		return body

exports.reboot = ->
	gosuperAction('reboot')

exports.shutdown = ->
	gosuperAction('shutdown')
