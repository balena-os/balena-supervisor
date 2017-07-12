Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))

exports.writeAndSyncFile = (path, data) ->
	fs.openAsync(path, 'w')
	.then (fd) ->
		fs.writeAsync(fd, data, 0, 'utf8')
		.then ->
			fs.fsyncAsync(fd)
		.then ->
			fs.closeAsync(fd)

exports.writeFileAtomic = (path, data) ->
	exports.writeAndSyncFile("#{path}.new", data)
	.then ->
		fs.renameAsync("#{path}.new", path)
