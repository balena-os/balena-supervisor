process.env.ROOT_MOUNTPOINT = './test/data'
process.env.BOOT_MOUNTPOINT = '/mnt/boot'
process.env.CONFIG_JSON_PATH = '/config.json'
process.env.DATABASE_PATH = './test/data/database.sqlite'
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite'
process.env.DATABASE_PATH_3 = './test/data/database3.sqlite'
process.env.LED_FILE = './test/data/led_file'

{ stub } = require 'sinon'

dbus = require 'dbus-native'

before ->
	stub(dbus, 'systemBus').returns({
		invoke: (obj, cb) ->
			console.log(obj)
			cb()
	})
after ->
	dbus.systemBus.restore()
