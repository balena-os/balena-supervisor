Promise = require 'bluebird'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'

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

exports.safeRename = (src, dest) ->
	fs.renameAsync(src, dest)
	.then ->
		fs.openAsync(path.dirname(dest))
	.tap(fs.fsyncAsync)
	.then(fs.closeAsync)
