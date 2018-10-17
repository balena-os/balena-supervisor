m = require 'mochainon'
{ expect } = m.chai
{ stub } = m.sinon

{ fs } = require 'mz'

configUtils = require '../src/config/utils'
{ ExtlinuxConfigBackend, RPiConfigBackend } = require '../src/config/backend'

extlinuxBackend = new ExtlinuxConfigBackend()
rpiBackend = new RPiConfigBackend()

describe 'Config Utilities', ->

	describe 'Boot config utilities', ->

		describe 'Env <-> Config', ->

			it 'correctly transforms environments to boot config objects', ->
				bootConfig = configUtils.envToBootConfig(rpiBackend, {
					HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
					HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
					HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
					HOST_CONFIG_foobar: 'baz'
				})
				expect(bootConfig).to.deep.equal({
					initramfs: 'initramf.gz 0x00800000'
					dtparam: [ 'i2c=on', 'audio=on' ]
					dtoverlay: [ 'ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13' ]
					foobar: 'baz'
				})

		describe 'TX2 boot config utilities', ->

			it 'should parse a extlinux.conf file', ->
				text = '''
				DEFAULT primary
				# Comment
				TIMEOUT 30

				MENU TITLE Boot Options
				LABEL primary
					MENU LABEL primary Image
					LINUX /Image
					APPEND ${cbootargs} ${resin_kernel_root} ro rootwait
				'''

				parsed = ExtlinuxConfigBackend.parseExtlinuxFile(text)
				expect(parsed.globals).to.have.property('DEFAULT').that.equals('primary')
				expect(parsed.globals).to.have.property('TIMEOUT').that.equals('30')
				expect(parsed.globals).to.have.property('MENU TITLE').that.equals('Boot Options')

				expect(parsed.labels).to.have.property('primary')
				primary = parsed.labels.primary
				expect(primary).to.have.property('MENU LABEL').that.equals('primary Image')
				expect(primary).to.have.property('LINUX').that.equals('/Image')
				expect(primary).to.have.property('APPEND').that.equals('${cbootargs} ${resin_kernel_root} ro rootwait')

			it 'should parse multiple service entries', ->
				text = '''
				DEFAULT primary
				# Comment
				TIMEOUT 30

				MENU TITLE Boot Options
				LABEL primary
					LINUX test1
					APPEND test2
				LABEL secondary
				  LINUX test3
					APPEND test4
				'''

				parsed = ExtlinuxConfigBackend.parseExtlinuxFile(text)
				expect(parsed.labels).to.have.property('primary').that.deep.equals({
					LINUX: 'test1'
					APPEND: 'test2'
				})
				expect(parsed.labels).to.have.property('secondary').that.deep.equals({
					LINUX: 'test3'
					APPEND: 'test4'
				})

			it 'should parse configuration options from an extlinux.conf file', ->
				text = '''
				DEFAULT primary
				# Comment
				TIMEOUT 30

				MENU TITLE Boot Options
				LABEL primary
					MENU LABEL primary Image
					LINUX /Image
					APPEND ${cbootargs} ${resin_kernel_root} ro rootwait isolcpus=3
				'''

				stub(fs, 'readFile').resolves(text)
				parsed = extlinuxBackend.getBootConfig()

				expect(parsed).to.eventually.have.property('isolcpus').that.equals('3')
				fs.readFile.restore()


				text = '''
				DEFAULT primary
				# Comment
				TIMEOUT 30

				MENU TITLE Boot Options
				LABEL primary
					MENU LABEL primary Image
					LINUX /Image
					APPEND ${cbootargs} ${resin_kernel_root} ro rootwait isolcpus=3,4,5
				'''
				stub(fs, 'readFile').resolves(text)

				parsed = extlinuxBackend.getBootConfig()

				fs.readFile.restore()

				expect(parsed).to.eventually.have.property('isolcpus').that.equals('3,4,5')
