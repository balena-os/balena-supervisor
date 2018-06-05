m = require 'mochainon'
{ expect } = m.chai

configUtils = require '../src/lib/config-utils'

describe 'Config Utilities', ->

	describe 'Boot config utilities', ->

		describe 'Env <-> Config', ->

			it 'correctly transforms environments to boot config objects', ->
				bootConfig = configUtils.envToBootConfig('raspberry-pi', {
					RESIN_HOST_CONFIG_initramfs: 'initramf.gz 0x00800000'
					RESIN_HOST_CONFIG_dtparam: '"i2c=on","audio=on"'
					RESIN_HOST_CONFIG_dtoverlay: '"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"'
					RESIN_HOST_CONFIG_foobar: 'baz'
				})
				expect(bootConfig).to.deep.equal({
					initramfs: 'initramf.gz 0x00800000'
					dtparam: [ 'i2c=on', 'audio=on' ]
					dtoverlay: [ 'ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13' ]
					foobar: 'baz'
				})
