m = require 'mochainon'
{ expect } = m.chai
appConversions = require '../src/lib/app-conversions'

dbFormat = {
	appId: '1234' 
	imageId: 'foo/bar'
	commit: 'bar'
	name: 'app'
	config: JSON.stringify({ RESIN_FOO: 'var' })
	env: JSON.stringify({ FOO: 'var2' })
}
stateFormat = {
	image: 'foo/bar'
	commit: 'bar'
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
}
appId = '1234'
stateFormatWithAppId = {
	appId: appId
	image: 'foo/bar'
	commit: 'bar'
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
}

dependentStateFormat = {
	image: 'foo/bar'
	commit: 'bar'
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
	parentApp: '256'
}

dependentStateFormatWithAppId = {
	appId: appId
	image: 'foo/bar'
	commit: 'bar'
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
	parentApp: '256'
}

dependentDBFormat = {
	appId: '1234' 
	imageId: 'foo/bar'
	commit: 'bar'
	name: 'app'
	config: JSON.stringify({ RESIN_FOO: 'var' })
	environment: JSON.stringify({ FOO: 'var2' })
	parentAppId: '256'
}

describe 'appConversions', ->
	describe 'stateToDB', ->
		it 'converts an app from a state format to a db format', ->
			app = appConversions.stateToDB(stateFormat, appId)
			expect(app).to.deep.equal(dbFormat)

		it 'converts a dependent app from a state format to a db format', ->
			app = appConversions.stateToDB(dependentStateFormat, appId)
			expect(app).to.deep.equal(dependentDBFormat)

	describe 'dbToState', ->
		it 'converts an app in DB format into state format', ->
			app = appConversions.dbToState(dbFormat)
			expect(app).to.deep.equal(stateFormatWithAppId)

		it 'converts a dependent app in DB format into state format', ->
			app = appConversions.dbToState(dependentDBFormat)
			expect(app).to.deep.equal(dependentStateFormatWithAppId)

	describe 'keyByAndOmit', ->
		it 'takes a state app array and returns an object where the key is the appId and the body is the app without the appId', ->
			apps = [ stateFormatWithAppId ]
			expect(appConversions.keyByAndOmit(apps, 'appId')).to.deep.equal({
				'1234': stateFormat
			})