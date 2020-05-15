// TODO: This file was created by bulk-decaffeinate.
// Sanity-check the conversion and remove this comment.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import * as fs from 'fs';

export = function () {
	try {
		fs.unlinkSync(process.env.DATABASE_PATH!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.unlinkSync(process.env.DATABASE_PATH_2!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.unlinkSync(process.env.DATABASE_PATH_3!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.unlinkSync(process.env.LED_FILE!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.writeFileSync(
			'./test/data/config.json',
			fs.readFileSync('./test/data/testconfig.json'),
		);
		fs.writeFileSync(
			'./test/data/config-apibinder.json',
			fs.readFileSync('./test/data/testconfig-apibinder.json'),
		);

		fs.writeFileSync(
			'./test/data/config-apibinder-offline.json',
			fs.readFileSync('./test/data/testconfig-apibinder-offline.json'),
		);
		return fs.writeFileSync(
			'./test/data/config-apibinder-offline2.json',
			fs.readFileSync('./test/data/testconfig-apibinder-offline2.json'),
		);
	} catch (e) {
		/* ignore /*/
	}
};
