require('coffee-script/register')
var fs = require('fs')

process.env.ROOT_MOUNTPOINT = './test/data'
process.env.CONFIG_JSON_PATH = '/config.json'
process.env.DATABASE_PATH = './test/data/database.sqlite'
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite'
try {
	fs.unlinkSync(process.env.DATABASE_PATH)
} catch(err){}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_2)
} catch(err){}
try {
	fs.unlinkSync(process.env.ROOT_MOUNTPOINT + process.env.CONFIG_JSON_PATH)
} catch(err){}

require('./constants.spec')
require('./db.spec')
require('./config.spec')
require('./iptables.spec')
require('./container-config.spec')
