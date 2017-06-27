fs = require('fs')

process.env.ROOT_MOUNTPOINT = './test/data'
process.env.CONFIG_JSON_PATH = '/config.json'
process.env.DATABASE_PATH = './test/data/database.sqlite'
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite'

try
	fs.unlinkSync(process.env.DATABASE_PATH)

try
	fs.unlinkSync(process.env.DATABASE_PATH_2)

try
	fs.unlinkSync(process.env.ROOT_MOUNTPOINT + process.env.CONFIG_JSON_PATH)

