#!/usr/bin/env node

import * as PostJect from 'postject';

import * as FS from 'node:fs/promises';
import * as Path from 'node:path';
import * as CP from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function makeBlob(tmpdir: string, assets: string[]) {
	const main = fileURLToPath(new URL('./sea-script.js', import.meta.url));
	const output = Path.join(tmpdir, 'sea.blob');
	const config = Path.join(tmpdir, 'sea-config.json');
	await FS.writeFile(
		config,
		JSON.stringify({
			main,
			output,
			execArgv: ['--no-warnings'],
			useCodeCache: true,
			assets: Object.fromEntries(
				assets.map((raw) => {
					const path = Path.resolve(raw);
					const name = Path.basename(path);
					return [name, path];
				}),
			),
		}),
	);
	await exec(process.argv0, '--experimental-sea-config', config);
	return output;
}
async function makeExecutable(tmpdir: string, blob: Buffer) {
	const executable = Path.join(tmpdir, Path.basename(process.execPath));
	await FS.copyFile(process.execPath, executable);
	if (process.platform === 'darwin') {
		await exec('codesign', '--remove-signature', executable);
	}
	await PostJect.inject(executable, 'NODE_SEA_BLOB', blob, {
		sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
		machoSegmentName: 'NODE_SEA',
	});
	if (process.platform === 'darwin') {
		await exec('codesign', '--sign', '-', executable);
	}
	return executable;
}

export async function sea(dest: string, ...assets: string[]) {
	await using tmp = await FS.mkdtempDisposable('sea');
	const blobfile = await makeBlob(tmp.path, assets);
	const blob = await FS.readFile(blobfile);
	const node = await makeExecutable(tmp.path, blob);
	await FS.copyFile(node, dest);
}

async function main() {
	const [dest, ...assets] = process.argv.slice(2);
	if (!dest) {
		console.error(`Usage: ${Path.basename(process.argv[1])} <sea-exec> [<asset...>]`);
		process.exit(1);
	}
	await sea(dest, ...assets);
}

if (import.meta.main) main();

async function exec(cmd: string, ...args: string[]) {
	const deferred = Promise.withResolvers<void>();
	const child = CP.spawn(cmd, args, {});
	child.on('error', deferred.reject);
	child.on('exit', deferred.resolve);
	child.stdin.end();
	await deferred;
	if (child.exitCode) {
		child.stderr.setEncoding('utf-8');
		const stderr = await Array.fromAsync(child.stderr);
		throw new Error(stderr.join(''));
	}
	child.stdout.setEncoding('utf-8');
	const stdout = await Array.fromAsync(child.stderr);
	return stdout.join('');
}
