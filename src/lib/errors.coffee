{ checkInt } = require './validation'

exports.NotFoundError = (err) -> checkInt(err.statusCode) is 404
exports.ENOENT = (err) -> err.code is 'ENOENT'
exports.EEXIST = (err) -> err.code is 'EEXIST'
