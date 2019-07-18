#!/usr/bin/env node

// This scripts iterates over files in /src directory and finds code that triggers events submission.
// Results have to be cross-validates - you cannot just run it and be sure about the results.
// This script depends on "npm run build" to be executed once.

const fs = require('fs');
const path = require('path');
const logTypes = require('../build/src/lib/log-types');
const _ = require('lodash');

const srcPath = 'src';

const fromLogType = (literal) => {
	let res = literal;
	if (literal.startsWith('LogType') || literal.startsWith('logType')) {
		const logTypeName = literal.split('.')[1];
		const logType = logTypes[logTypeName];
		if (logType) {
			res = logType.eventName;
		}
	}
	return res;
};

const allMethods = [
	'.logSystemMessage(',
	'.logConfigChange(',
	'.logSystemEvent(',
	'.track('
];

const patterns = [
	// Via Logger.
	[/\.log(SystemMessage|ConfigChange|SystemEvent)\((.+)\);?/g, (filePath, match) => {
		if (['src/logger.ts'].includes(filePath)) {
			return null;
		}

		let eventName = null;
		const type = match[1];
		const inputParams = match[2];
		switch (type) {
			case 'ConfigChange':
				eventName = 'Apply config change (success/failed/in progress)';
				break;

			case 'SystemMessage':
				const filteredParams = inputParams.replace(/\{.*\}/, '');
				const params = filteredParams
					.split(/\s*,\s*/)
					.map((s) => s.trim())
					.filter((s) => s.length > 0 && s !== 'obj');
				if (params.length === 3 && params[2] === 'false') {
					console.error(`${inputParams} is not tracked in ${filePath}`);
					return null;
				}
				eventName = params.length > 1 ? params[1] : params[0];
				break;

			case 'SystemEvent':
				const sysEventParams = inputParams.split(/\s*,\s*/);
				if (sysEventParams.length === 3 && sysEventParams[2].trim() === 'false') {
					console.error(`${inputParams} is not tracked in ${filePath}`);
					return null;
				}

				eventName = fromLogType(sysEventParams[0]);
				break;

			default:
				eventName = inputParams;
		}
		return [eventName, type];
	}],
	// Multiline logSystemMessage.
	[/logSystemMessage\(\n\s+(.+),\n\s+(.+),\n\s+(.+),\n\s+\);?/mg, (filePath, match) => {
		return [match[3], 'SystemMessage'];
	}],
	// Multiline logSystemEvent.
	[/logSystemEvent\(([\w.]+),?/g, (filePath, match) => {
		return [fromLogType(match[1]), 'SystemEvent'];
	}],
	// Via EventTracker.
	[/\.track\((.+)\);?/g, (filePath, match) => {
		if (['src/event-tracker.ts'].includes(filePath)) {
			return null;
		}
		const params = match[1].split(/\s*,\s*/);
		const eventName = params[0];
		return [eventName, 'EventTracker'];
	}],
	[/\.track\((.+?),\s*\n?/mg, (filePath, match) => {
		if (['src/event-tracker.ts'].includes(filePath)) {
			return null;
		}
		return [match[1], 'EventTracker'];
	}],
];

const iterateDirectory = (dir, func) => {
  const items = fs.readdirSync(dir, {withFileTypes: true});
  for (const item of items) {
  	const itemPath = path.join(dir, item.name);
  	if (item.isDirectory()) {
		iterateDirectory(itemPath, func);
	} else {
  		const content = fs.readFileSync(itemPath, {encoding: 'utf8'});
  		func(itemPath, content);
	}
  }
};

const csvRow = (record) => record.map((c) => c.replace(/^'/, '').replace(/'$/, '')).join('\t');

let summary = [];
const fileStats = [];
iterateDirectory(srcPath, (filePath, content) => {
	let rows = _.flatMap(patterns,([p, extractor]) => {
		let match;
		const res = [];
		while ((match = p.exec(content)) !== null) {
			const record = extractor(filePath, match);
			if (record) {
				record.push(filePath);
				res.push(record);
			}
		}
		return res;
	});
	rows = _.uniqBy(rows, (r) => r.toString());
	summary = _.concat(summary, rows);

	// Collect total number of invocations to compare with number of detected events.
	const invocations = content.split(/\n/)
		.filter((l) => allMethods.filter((m) => l.indexOf(m) >= 0).length > 0);
	if (invocations.length > 0) {
		// if (filePath.endsWith('device-state.coffee')) {
		// 	console.error(filePath);
		// 	console.error('      ', invocations);
		// }
		fileStats.push([filePath, invocations.length.toString(), rows.length.toString()]);
	}
});

_.uniqBy(summary, (r) => r.toString()).forEach((row) => console.log(csvRow(row)));

console.error("==== Cross-validation ====");

fileStats.forEach((s) => console.error(csvRow(s)));
