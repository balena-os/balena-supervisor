Promise = require 'bluebird'
{ fs } = require 'mz'

m = require 'mochainon'
{ expect } = m.chai
{ stub, spy } = m.sinon

prepare = require './lib/prepare'
fsUtils = require '../src/lib/fs-utils'

DeviceConfig = require '../src/device-config'
{ ExtlinuxConfigBackend, RPiConfigBackend } = require '../src/config/backend'

extlinuxBackend = new ExtlinuxConfigBackend()
rpiConfigBackend = new RPiConfigBackend()

childProcess = require 'child_process'

describe 'DeviceConfig', ->
	before ->
		@timeout(5000)
		prepare()
		@fakeDB = {}
		@fakeConfig = {
			get: (key) ->
				Promise.try ->
					if key == 'deviceType'
						return 'raspberrypi3'
					else
						throw new Error('Unknown fake config key')
		}
		@fakeLogger = {
			logSystemMessage: spy()
		}
		@deviceConfig = new DeviceConfig({ logger: @fakeLogger, db: @fakeDB, config: @fakeConfig })


	# Test that the format for special values like initramfs and array variables is parsed correctly
	it 'allows getting boot config with getBootConfig', ->

		stub(fs, 'readFile').resolves('\
			initramfs initramf.gz 0x00800000\n\
			dtparam=i2c=on\n\
			dtparam=audio=on\n\
			dtoverlay=ads7846\n\
			dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13\n\
			foobar=baz\n\
		')
		@deviceConfig.getBootConfig(rpiConfigBackend)
		.then (conf) ->
			fs.readFile.restore()
			expect(conf).to.deep.equal({
				HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
				HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
				HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
				HOST_CONFIG_foobar: 'baz'
			})

	it 'properly reads a real config.txt file', ->
		@deviceConfig.getBootConfig(rpiConfigBackend)
		.then (conf) ->
			expect(conf).to.deep.equal({
				HOST_CONFIG_dtparam: '"i2c_arm=on","spi=on","audio=on"'
				HOST_CONFIG_enable_uart: '1'
				HOST_CONFIG_disable_splash: '1'
				HOST_CONFIG_avoid_warnings: '1'
				HOST_CONFIG_gpu_mem: '16'
			})

	# Test that the format for special values like initramfs and array variables is preserved
	it 'does not allow setting forbidden keys', ->
		current = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			HOST_CONFIG_foobar: 'baz'
		}
		target = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00810000'
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			HOST_CONFIG_foobar: 'baz'
		}
		promise = Promise.try =>
			@deviceConfig.bootConfigChangeRequired(rpiConfigBackend, current, target)
		expect(promise).to.be.rejected
		promise.catch (err) =>
			expect(@fakeLogger.logSystemMessage).to.be.calledOnce
			expect(@fakeLogger.logSystemMessage).to.be.calledWith('Attempt to change blacklisted config value initramfs', {
				error: 'Attempt to change blacklisted config value initramfs'
			}, 'Apply boot config error')
			@fakeLogger.logSystemMessage.reset()

	it 'does not try to change config.txt if it should not change', ->
		current = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			HOST_CONFIG_foobar: 'baz'
		}
		target = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			HOST_CONFIG_foobar: 'baz'
		}
		promise = Promise.try =>
			@deviceConfig.bootConfigChangeRequired(rpiConfigBackend, current, target)
		expect(promise).to.eventually.equal(false)
		promise.then =>
			expect(@fakeLogger.logSystemMessage).to.not.be.called
			@fakeLogger.logSystemMessage.reset()

	it 'writes the target config.txt', ->
		stub(fsUtils, 'writeFileAtomic').resolves()
		stub(childProcess, 'execAsync').resolves()
		current = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
			HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			HOST_CONFIG_foobar: 'baz'
		}
		target = {
			HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
			HOST_CONFIG_dtparam: '"i2c=on","audio=off"'
			HOST_CONFIG_dtoverlay: '"lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
			HOST_CONFIG_foobar: 'bat'
			HOST_CONFIG_foobaz: 'bar'
		}
		promise = Promise.try =>
			@deviceConfig.bootConfigChangeRequired(rpiConfigBackend, current, target)
		expect(promise).to.eventually.equal(true)
		promise.then =>
			@deviceConfig.setBootConfig(rpiConfigBackend, target)
			.then =>
				expect(childProcess.execAsync).to.be.calledOnce
				expect(@fakeLogger.logSystemMessage).to.be.calledTwice
				expect(@fakeLogger.logSystemMessage.getCall(1).args[2]).to.equal('Apply boot config success')
				expect(fsUtils.writeFileAtomic).to.be.calledWith('./test/data/mnt/boot/config.txt', '\
					initramfs initramf.gz 0x00800000\n\
					dtparam=i2c=on\n\
					dtparam=audio=off\n\
					dtoverlay=lirc-rpi,gpio_out_pin=17,gpio_in_pin=13\n\
					foobar=bat\n\
					foobaz=bar\n\
				')
				fsUtils.writeFileAtomic.restore()
				childProcess.execAsync.restore()
				@fakeLogger.logSystemMessage.reset()

	it 'accepts RESIN_ and BALENA_ variables', ->
		@deviceConfig.formatConfigKeys({
			FOO: 'bar',
			BAR: 'baz',
			RESIN_HOST_CONFIG_foo: 'foobaz',
			BALENA_HOST_CONFIG_foo: 'foobar',
			RESIN_HOST_CONFIG_other: 'val',
			BALENA_HOST_CONFIG_baz: 'bad',
			BALENA_SUPERVISOR_POLL_INTERVAL: '100',
		}).then (filteredConf) ->
			expect(filteredConf).to.deep.equal({
				HOST_CONFIG_foo: 'foobar',
				HOST_CONFIG_other: 'val',
				HOST_CONFIG_baz: 'bad',
				SUPERVISOR_POLL_INTERVAL: '100',
			})

	describe 'Extlinux files', ->

		it 'should correctly write to extlinux.conf files', ->
			stub(fsUtils, 'writeFileAtomic').resolves()
			stub(childProcess, 'execAsync').resolves()

			current = {
			}
			target = {
				HOST_EXTLINUX_isolcpus: '2'
			}

			promise = Promise.try =>
				@deviceConfig.bootConfigChangeRequired(extlinuxBackend, current, target)
			expect(promise).to.eventually.equal(true)
			promise.then =>
				@deviceConfig.setBootConfig(extlinuxBackend, target)
				.then =>
					expect(childProcess.execAsync).to.be.calledOnce
					expect(@fakeLogger.logSystemMessage).to.be.calledTwice
					expect(@fakeLogger.logSystemMessage.getCall(1).args[2]).to.equal('Apply boot config success')
					expect(fsUtils.writeFileAtomic).to.be.calledWith('./test/data/mnt/boot/extlinux/extlinux.conf', '\
						DEFAULT primary\n\
						TIMEOUT 30\n\
						MENU TITLE Boot Options\n\
						LABEL primary\n\
									MENU LABEL primary Image\n\
									LINUX /Image\n\
									APPEND ${cbootargs} ${resin_kernel_root} ro rootwait isolcpus=2\n\
					')
					fsUtils.writeFileAtomic.restore()
					childProcess.execAsync.restore()
					@fakeLogger.logSystemMessage.reset()

	# This will require stubbing device.reboot, gosuper.post, config.get/set
	it 'applies the target state'
