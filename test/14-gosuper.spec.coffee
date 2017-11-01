m = require 'mochainon'
_ = require 'lodash'

{ expect } = m.chai
{ stub, spy } = m.sinon

gosuperAPI = require './lib/mocked-gosuper'
constants = require '../src/lib/constants'
gosuper = require '../src/lib/gosuper'

describe 'gosuper', ->
	before ->
		@oldAddress = constants.gosuperAddress
		constants.gosuperAddress = 'http://localhost:3000'
		spy(gosuperAPI.gosuperBackend, 'vpnControlHandler')
		@server = gosuperAPI.listen(3000)
	after ->
		constants.gosuperAddress = @oldAddress
		gosuperAPI.gosuperBackend.vpnControlHandler.restore()
		try
			@server.close()

	it 'performs requests to the gosuper socket with options', ->
		gosuper.post('/v1/vpncontrol', { json: true, body: Enable: true })
		.spread (res, body) =>
			expect(res.statusCode).to.equal(202)
			expect(body).to.deep.equal({ Data: 'OK', Error: '' })
			expect(gosuperAPI.gosuperBackend.vpnControlHandler).to.be.calledOnce
			call = gosuperAPI.gosuperBackend.vpnControlHandler.getCall(0)
			req = call.args[0]
			expect(req.body).to.deep.equal({ Enable: true })
			expect(req.get('Host')).to.equal('')
			gosuperAPI.gosuperBackend.vpnControlHandler.reset()

	it 'performs requests to the gosuper socket without options', ->
		gosuper.get('/v1/vpncontrol')
		.spread (res, body) =>
			expect(res.statusCode).to.equal(202)
			expect(body).to.deep.equal(JSON.stringify({ Data: 'OK', Error: '' }))
			expect(gosuperAPI.gosuperBackend.vpnControlHandler).to.be.calledOnce
			call = gosuperAPI.gosuperBackend.vpnControlHandler.getCall(0)
			req = call.args[0]
			expect(req.body).to.deep.equal({})
			expect(req.get('Host')).to.equal('')
			gosuperAPI.gosuperBackend.vpnControlHandler.reset()
