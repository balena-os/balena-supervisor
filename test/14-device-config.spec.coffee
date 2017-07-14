prepare = require './lib/prepare'
m = require 'mochainon'
_ = require 'lodash'
PUBNUB = require 'pubnub'

{ expect } = m.chai
{ stub, spy } = m.sinon

fsUtils = require '../src/lib/fs-utils'

Logger = require '../src/logger'
DeviceConfig = require '../src/device-config'

childProcess = require 'child_process'

describe 'DeviceConfig', ->
	before ->
		prepare()
		@fakeDB = {}
		@fakeConfig = {}
		@fakeLogger = {
			logSystemMessage: spy()
		}
		@deviceConfig = new DeviceConfig({ logger: @fakeLogger, db: @fakeDB, config: @fakeConfig })


	# Test that the format for special values like initramfs and array variables is parsed correctly
	it 'allows getting boot config with getBootConfig', ->
		stub(@deviceConfig, 'readBootConfig').resolves("\
			initramfs initramf.gz 0x00800000\n\
			dtparam=i2c=on\n\
			dtparam=audio=on\n\
			dtoverlay=ads7846\n\
			dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13\n\
			foobar=baz\n\
		")
		@deviceConfig.getBootConfig('raspberry-pi')
		.then (conf) =>
			@deviceConfig.readBootConfig.restore()
			expect(conf).to.deep.equal({
				RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
				RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
				RESIN_HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
				RESIN_HOST_CONFIG_foobar: 'baz'
			})

	it 'correctly transforms environments to boot config objects', ->
		bootConfig = @deviceConfig.envToBootConfig({
			RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			RESIN_HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			RESIN_HOST_CONFIG_foobar: 'baz'
		})
		expect(bootConfig).to.deep.equal({
			initramfs: 'initramf.gz 0x00800000'
			dtparam: [ 'i2c=on','audio=on' ]
			dtoverlay: [ 'ads7846','lirc-rpi,gpio_out_pin=17,gpio_in_pin=13' ]
			foobar: 'baz'
		})
	# Test that the format for special values like initramfs and array variables is preserved
	it 'does not allow setting forbidden keys', ->
		stub(fsUtils, 'writeFileAtomic').resolves()
		current = {
			RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			RESIN_HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			RESIN_HOST_CONFIG_foobar: 'baz'
		}
		target = {
			RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00810000'
			RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			RESIN_HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			RESIN_HOST_CONFIG_foobar: 'baz'
		}
		promise = @deviceConfig.compareAndSetBootConfig('raspberry-pi', current, target)
		expect(promise).to.be.rejected
		promise.catch =>
			fsUtils.writeFileAtomic.restore()
			expect(@fakeLogger.logSystemMessage).to.be.calledOnce
			expect(@fakeLogger.logSystemMessage).to.be.calledWith("Attempt to change blacklisted config value initramfs", {
				error: "Attempt to change blacklisted config value initramfs"
			}, 'Apply boot config error')
			@fakeLogger.logSystemMessage.reset()

	it 'writes the target config.txt', ->
		stub(fsUtils, 'writeFileAtomic').resolves()
		stub(childProcess, 'execAsync').resolves()
		current = {
			RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			RESIN_HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			RESIN_HOST_CONFIG_foobar: 'baz'
		}
		target = {
			RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=off"'
			RESIN_HOST_CONFIG_dtoverlay: '"lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			RESIN_HOST_CONFIG_foobar: 'bat'
			RESIN_HOST_CONFIG_foobaz: 'bar'
		}
		promise = @deviceConfig.compareAndSetBootConfig('raspberry-pi', current, target)
		expect(promise).to.be.fulfilled
		promise.then =>
			expect(childProcess.execAsync).to.be.calledOnce
			expect(@fakeLogger.logSystemMessage).to.be.calledTwice
			expect(@fakeLogger.logSystemMessage.getCall(1).args[2]).to.equal('Apply boot config success')
			expect(fsUtils.writeFileAtomic).to.be.calledWith('./test/data/mnt/boot/config.txt', "\
				initramfs initramf.gz 0x00800000\n\
				dtparam=i2c=on\n\
				dtparam=audio=off\n\
				dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13\n\
				foobar=bat\n\
				foobaz=bar\n\
			")
			fsUtils.writeFileAtomic.restore()
			childProcess.execAsync.restore()
			@fakeLogger.logSystemMessage.reset()

	# This will require stubbing device.reboot, gosuper.post, config.get/set
	it 'applies the target state'
