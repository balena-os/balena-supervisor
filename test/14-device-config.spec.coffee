m = require 'mochainon'
_ = require 'lodash'
PUBNUB = require 'pubnub'

{ expect } = m.chai
{ stub, spy } = m.sinon

DeviceConfig = require '../src/device-config'

describe 'DeviceConfig', ->
	before ->
		@fakeDB = {}
		@fakeConfig = {}
		@fakeEventTracker = {
			track: spy()
		}
		@fakePubnub = {
			publish: spy()
		}
		stub(PUBNUB, 'init').returns(@fakePubnub)
		@logger = new Logger({ eventTracker: @fakeEventTracker })
		@deviceConfig = new DeviceConfig({ logger: @logger, db: @fakeDB, config: @fakeConfig })
		@logger.init({ pubnub: {}, channel: 'foo', offlineMode: 'false', enable: 'true' })

	# Test that the format for special values like initramfs and array variables is parsed correctly
	it 'allows getting boot config with getBootConfig'

	# Test that the format for special values like initramfs and array variables is preserved
	it 'allows setting boot config with setBootConfig'

	# This will require stubbing device.reboot, gosuper.post, config.get/set
	it 'applies the target state'
