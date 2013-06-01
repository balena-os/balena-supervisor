fs = require("fs")
chokidar = require("chokidar")
#request = require("request")

_eol = require('os').EOL

getProcInfo = (callback) ->
	lines = fs.readFileSync("/proc/cpuinfo", "utf8").split(_eol)

	cpuinfo = []
	cpuinfo.push({})
	for line in lines
		if line == ""
			cpuinfo.push({})
		else
			[key, value] = line.split(/\s+:\s/, 2)
			key = key.trim()
			value = value?.trim() ? ""

			if value.match(/^\d+\.\d+$/)
				value = parseFloat(value)

			cpuinfo[cpuinfo.length-1][key] = value

	callback(cpuinfo)


