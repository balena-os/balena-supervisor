#!/usr/bin/env node

// This script checks if files in test directory don't contain describe.only or it.only statements
// to ensure that an accidental commit does not prevent all the tests to be run.

const fs = require('fs');
const path = require('path');

const testsDir = './test';
const srcFileExtensions = ['.ts', '.coffee', '.js'];

const checkPattern = /((describe)|(it))\.only/;

const checkDirRecursively = (dirPath, func) =>
	fs.readdirSync(dirPath, {withFileTypes: true}).forEach((file) => {
		const filePath = path.join(dirPath, file.name);
		if (file.isDirectory()) {
			checkDirRecursively(filePath, func);
			return;
		}
		for (let ext of srcFileExtensions) {
			if (file.name.endsWith(ext)) {
				const content = fs.readFileSync(filePath, {encoding: 'utf8'});
				func(filePath, content);
				break;
			}
		}
	});

let errorsFound = false;

checkDirRecursively(testsDir, (fileName, content) => {
	const lines = content.split('\n');
	for (let ln = 0; ln < lines.length; ln++) {
		const res = checkPattern.exec(lines[ln]);
		if (res) {
			errorsFound = true;
			console.error(`File ${fileName}, line ${ln}: found ${res[0]}`);
		}
	}
});

if (errorsFound) {
	process.exit(1);
}
