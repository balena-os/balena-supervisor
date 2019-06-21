{ expect } = require './lib/chai-config'

{ Supervisor } = require '../src/supervisor'

describe 'Startup', ->
	it 'should startup correctly', ->
		supervisor = new Supervisor()
		expect(supervisor.init()).to.not.throw
		expect(supervisor.db).to.not.be.null
		expect(supervisor.config).to.not.be.null
		expect(supervisor.logger).to.not.be.null
		expect(supervisor.deviceState).to.not.be.null
		expect(supervisor.apiBinder).to.not.be.null
