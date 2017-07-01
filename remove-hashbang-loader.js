// Some of the dependencies (e.g. JSONStream) are hybrid executable-library
// and have a #! /usr/bin/env node at the beginning of the file.
// This webpack loader removes it so that we have valid javascript for webpack to load.
module.exports = function (source) {
  return source.toString().replace(/^#! .*\n/, '')
}
