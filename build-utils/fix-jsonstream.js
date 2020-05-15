// JSONStream is a hybrid executable-library
// and has a #! /usr/bin/env node at the beginning of the file.
// This webpack loader removes it so that we have valid javascript for webpack to load.
// Also, JSONStream starts a pipe between stdin and stdout if module.parent is undefined.
// This pipe can fail throwing an uncaught exception, so we fake a module.parent to prevent this.
// See https://github.com/dominictarr/JSONStream/issues/129
module.exports = function (source) {
	return 'module.parent = {};\n' + source.toString().replace(/^#! .*\n/, '');
};
