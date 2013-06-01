chokidar = require("chokidar")

watcher = chokidar.watch('/media/', {ignored: /^\./, persistent: true})
watcher.on('add', (path, stats) ->
	console.log('File', path, 'has been added')
)

# Only needed if watching is persistent.
#watcher.close()
