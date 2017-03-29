# Parses package.json and returns resin-supervisor's version
_ = require 'lodash'
version = require('../../package.json').version
tagExtra = process.env.SUPERVISOR_TAG_EXTRA
version += '+' + tagExtra if !_.isEmpty(tagExtra)
module.exports = version
