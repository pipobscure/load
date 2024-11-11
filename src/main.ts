import { isSea, getRawAsset } from 'node:sea';
import { extname, basename, dirname, resolve, join } from 'node:path';
import { Loader } from './loader.js';

async function main() {
	if (isSea()) {
		const baseName = `${basename(process.argv[1], '.exe')}.zip`;
		if (getRawAsset(baseName)) {
			return Loader.fromSEA(baseName).run();
		}
		const zipName = join(dirname(process.argv[1]), baseName);
		return Loader.fromZIP(zipName).run();
	}
	if ('.zip' === extname(process.argv[1]).toLowerCase()) {
		return Loader.fromZIP(process.argv[1]).run();
	}
	const basePath = resolve(process.argv[1]);
	const loader = Loader.fromPath(basePath);

	if (process.env.NODE_PACKAGE) {
		const baseName =
			process.env.NODE_PACKAGE.toLowerCase() === 'true' ? `${basename(basePath)}.zip` : process.env.NODE_PACKAGE;
		const pkgfile = resolve(baseName, basePath);
		process.on('beforeExit', () => {
			if (process.exitCode) return;
			loader.package(pkgfile);
		});
	}

	return loader.run();
}

Promise.resolve(main()).then(
	(code: number) => {
		process.exit(code);
	},
	(err) => {
		console.error(err);
		process.exit(process.exitCode ?? -1);
	},
);
