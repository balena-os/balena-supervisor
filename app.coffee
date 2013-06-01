wrench = require("wrench")

files = []

wrench.readdirRecursive('/media', (error, curFiles) ->
	if error?
		console.error error
	else
		console.log curFiles
)
