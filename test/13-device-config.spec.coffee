Promise = require 'bluebird'
{ fs, child_process } = require 'mz'

{ expect } = require './lib/chai-config'
{ stub, spy } = require 'sinon'

prepare = require './lib/prepare'
fsUtils = require '../src/lib/fs-utils'

{ DeviceConfig } = require '../src/device-config'
{ ExtlinuxConfigBackend, RPiConfigBackend } = require '../src/config/backend'

extlinuxBackend = new ExtlinuxConfigBackend()
rpiConfigBackend = new RPiConfigBackend()

describe 'DeviceConfig', ->
	before ->
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
			@fakeLogger.logSystemMessage.resetHistory()

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
			@fakeLogger.logSystemMessage.resetHistory()

	it 'writes the target config.txt', ->
		stub(fsUtils, 'writeFileAtomic').resolves()
		stub(child_process, 'exec').resolves()
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
				expect(child_process.exec).to.be.calledOnce
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
				child_process.exec.restore()
				@fakeLogger.logSystemMessage.resetHistory()

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

	it 'returns default configuration values', ->
		conf = @deviceConfig.getDefaults()
		expect(conf).to.deep.equal({
			SUPERVISOR_VPN_CONTROL: 'true'
			SUPERVISOR_POLL_INTERVAL: '60000',
			SUPERVISOR_LOCAL_MODE: 'false',
			SUPERVISOR_CONNECTIVITY_CHECK: 'true',
			SUPERVISOR_LOG_CONTROL: 'true',
			SUPERVISOR_DELTA: 'false',
			SUPERVISOR_DELTA_REQUEST_TIMEOUT: '30000',
			SUPERVISOR_DELTA_APPLY_TIMEOUT: '0',
			SUPERVISOR_DELTA_RETRY_COUNT: '30',
			SUPERVISOR_DELTA_RETRY_INTERVAL: '10000',
			SUPERVISOR_DELTA_VERSION: '2',
			SUPERVISOR_INSTANT_UPDATE_TRIGGER: 'true',
			SUPERVISOR_OVERRIDE_LOCK: 'false',
			SUPERVISOR_PERSISTENT_LOGGING: 'false',
		})

	describe 'Extlinux files', ->

		it 'should correctly write to extlinux.conf files', ->
			stub(fsUtils, 'writeFileAtomic').resolves()
			stub(child_process, 'exec').resolves()

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
					expect(child_process.exec).to.be.calledOnce
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
					child_process.exec.restore()
					@fakeLogger.logSystemMessage.resetHistory()

	describe 'Balena fin', ->
		it 'should always add the balena-fin dtoverlay', ->
			expect(DeviceConfig.ensureRequiredOverlay('fincm3', {})).to.deep.equal({ dtoverlay: ['balena-fin'] })
			expect(DeviceConfig.ensureRequiredOverlay('fincm3', { test: '123', test2: ['123'], test3: ['123', '234'] })).to
				.deep.equal({ test: '123', test2: ['123'], test3: ['123', '234'], dtoverlay: ['balena-fin'] })
			expect(DeviceConfig.ensureRequiredOverlay('fincm3', { dtoverlay: 'test' })).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] })
			expect(DeviceConfig.ensureRequiredOverlay('fincm3', { dtoverlay: ['test'] })).to.deep.equal({ dtoverlay: ['test', 'balena-fin'] })

		it 'should not cause a config change when the cloud does not specify the balena-fin overlay', ->
			expect(@deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
				{ HOST_CONFIG_dtoverlay: '"test"' },
				'fincm3'
			)).to.equal(false)

			expect(@deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				{ HOST_CONFIG_dtoverlay: '"test","balena-fin"' },
				{ HOST_CONFIG_dtoverlay: 'test' },
				'fincm3'
			)).to.equal(false)

			expect(@deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				{ HOST_CONFIG_dtoverlay: '"test","test2","balena-fin"' },
				{ HOST_CONFIG_dtoverlay: '"test","test2"' },
				'fincm3'
			)).to.equal(false)

	describe 'Raspberry pi4', ->
		it 'should always add the vc4-fkms-v3d dtoverlay', ->
			expect(DeviceConfig.ensureRequiredOverlay('raspberrypi4-64', {})).to.deep.equal({ dtoverlay: ['vc4-fkms-v3d'] })
			expect(DeviceConfig.ensureRequiredOverlay('raspberrypi4-64', { test: '123', test2: ['123'], test3: ['123', '234'] })).to
				.deep.equal({ test: '123', test2: ['123'], test3: ['123', '234'], dtoverlay: ['vc4-fkms-v3d'] })
			expect(DeviceConfig.ensureRequiredOverlay('raspberrypi4-64', { dtoverlay: 'test' })).to.deep.equal({ dtoverlay: ['test', 'vc4-fkms-v3d'] })
			expect(DeviceConfig.ensureRequiredOverlay('raspberrypi4-64', { dtoverlay: ['test'] })).to.deep.equal({ dtoverlay: ['test', 'vc4-fkms-v3d'] })

		it 'should not cause a config change when the cloud does not specify the pi4 overlay', ->
			expect(@deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				{ HOST_CONFIG_dtoverlay: '"test","vc4-fkms-v3d"' },
				{ HOST_CONFIG_dtoverlay: '"test"' },
				'raspberrypi4-64'
			)).to.equal(false)

			expect(@deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				{ HOST_CONFIG_dtoverlay: '"test","vc4-fkms-v3d"' },
				{ HOST_CONFIG_dtoverlay: 'test' },
				'raspberrypi4-64'
			)).to.equal(false)

			expect(@deviceConfig.bootConfigChangeRequired(
				rpiConfigBackend,
				{ HOST_CONFIG_dtoverlay: '"test","test2","vc4-fkms-v3d"' },
				{ HOST_CONFIG_dtoverlay: '"test","test2"' },
				'raspberrypi4-64'
			)).to.equal(false)

	describe 'ConfigFS', ->
		before ->
			fakeConfig = {
				get: (key) ->
					Promise.try ->
						return 'up-board' if key == 'deviceType'
						throw new Error('Unknown fake config key')
			}
			@upboardConfig = new DeviceConfig({ logger: @fakeLogger, db: @fakeDB, config: fakeConfig })

			stub(child_process, 'exec').resolves()
			stub(fs, 'exists').callsFake ->
				return true
			stub(fs, 'mkdir').resolves()
			stub(fs, 'readdir').callsFake ->
				return []
			stub(fs, 'readFile').callsFake (file) ->
				return JSON.stringify({
					ssdt: ['spidev1,1']
				}) if file == 'test/data/mnt/boot/configfs.json'

				return ''
			stub(fsUtils, 'writeFileAtomic').resolves()

			Promise.try =>
				@upboardConfig.getConfigBackend()
			.then (backend) =>
				@upboardConfigBackend = backend
				expect(@upboardConfigBackend).is.not.null
				expect(child_process.exec.callCount).to.equal(3, 'exec not called enough times')

		it 'should correctly load the configfs.json file', ->
			expect(child_process.exec).to.be.calledWith('modprobe acpi_configfs')
			expect(child_process.exec).to.be.calledWith('cat test/data/boot/acpi-tables/spidev1,1.aml > test/data/sys/kernel/config/acpi/table/spidev1,1/aml')

			expect(fs.exists.callCount).to.equal(2)
			expect(fs.readFile.callCount).to.equal(4)

		it 'should correctly write the configfs.json file', ->
			current = {
			}
			target = {
				HOST_CONFIGFS_ssdt: 'spidev1,1'
			}

			@fakeLogger.logSystemMessage.resetHistory()
			child_process.exec.resetHistory()
			fs.exists.resetHistory()
			fs.mkdir.resetHistory()
			fs.readdir.resetHistory()
			fs.readFile.resetHistory()

			Promise.try =>
				expect(@upboardConfigBackend).is.not.null
				@upboardConfig.bootConfigChangeRequired(@upboardConfigBackend, current, target)
			.then =>
				@upboardConfig.setBootConfig(@upboardConfigBackend, target)
			.then =>
				expect(child_process.exec).to.be.calledOnce
				expect(fsUtils.writeFileAtomic).to.be.calledWith('test/data/mnt/boot/configfs.json', JSON.stringify({
					ssdt: ['spidev1,1']
				}))
				expect(@fakeLogger.logSystemMessage).to.be.calledTwice
				expect(@fakeLogger.logSystemMessage.getCall(1).args[2]).to.equal('Apply boot config success')

		after ->
			child_process.exec.restore()
			fs.exists.restore()
			fs.mkdir.restore()
			fs.readdir.restore()
			fs.readFile.restore()
			fsUtils.writeFileAtomic.restore()
			@fakeLogger.logSystemMessage.resetHistory()


	# This will require stubbing device.reboot, gosuper.post, config.get/set
	it 'applies the target state'
