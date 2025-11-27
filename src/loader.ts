import { registerHooks, type ModuleSource, createRequire } from 'node:module';
import * as SEA from 'node:sea';
import * as ZIP from '@pipobscure/zip';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as Path from 'node:path';
import * as Asset from './asset.ts';
import * as REPL from 'node:repl';

try {
	Object.assign(globalThis, { Asset });
} catch {
	process.emitWarning('global Asset access unavailable');
}

export type ResolveContext = {
	conditions: string[];
	importAttributes: Record<string, string | undefined>;
	parentURL?: string;
};
export type ResolveResult = {
	format?: string | null | undefined;
	importAttributes?: Record<string, string | undefined>;
	shortCircuit?: boolean;
	url: string;
};
let main: string | undefined;
export type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;
export function resolve(specifier: string, context: ResolveContext, next: NextResolve): ResolveResult {
	context.parentURL = cleanParentURL(context.parentURL);
	try {
		const url = new URL(specifier);
		if (['file:', 'asset:'].includes(url.protocol)) {
			if (Asset.isArchive(`${url}`)) {
				const url = findArchiveEntry(specifier);
				if (!url) return next(specifier, context);
				main = main ?? url;
				return { format: 'unknown', url, shortCircuit: true };
			}
			main = main ?? `${url}`;
			return { format: 'unknown', url: `${url}`, shortCircuit: true };
		}
	} catch {}
	if (specifier.startsWith('node:')) {
		const url = specifier;
		const format = 'builtin';
		return { format, url, shortCircuit: true };
	}
	if (process.getBuiltinModule(specifier)) {
		const url = `node:${specifier}`;
		const format = 'builtin';
		return { format, url, shortCircuit: true };
	}
	if (specifier.startsWith('#/') && context.parentURL) {
		const pkg = findPackage(context.parentURL);
		const url = Asset.resolve(`.${specifier.slice(1)}`, pkg);
		if (!url) return next(specifier, context);
		const format = Asset.isArchive(url) ? 'bundle' : 'unknown';
		return { format, url, shortCircuit: true };
	}
	if (specifier.startsWith('./') || specifier.startsWith('/')) {
		const url = Asset.resolve(specifier, context.parentURL ?? `${pathToFileURL(process.cwd())}`);
		if (!url) return next(specifier, context);
		if (Asset.isArchive(`${url}`)) {
			const entryurl = findArchiveEntry(url);
			if (!entryurl) return next(specifier, context);
			main = main ?? entryurl;
			return { format: 'unknown', url: entryurl, shortCircuit: true };
		}
		main = main ?? url;
		return { format: 'unknown', url, shortCircuit: true };
	}

	const parts = specifier.split('/');
	const basename = (parts[0][0] === '@' ? parts.splice(0, 2) : parts.splice(0, 1)).join('/');
	const entry = parts.length ? parts.join('/') : undefined;
	let item = Asset.resolve(`./node_modules/${basename}/package.json`, context.parentURL);
	let level = 1;
	const prev = item;
	while (item && !Asset.exists(item)) {
		item = Asset.resolve(`${new Array(level).fill('..', 0, level).join('/')}/node_modules/${basename}/package.json`, context.parentURL);
		level++;
		if (prev === item) return next(specifier, context);
	}
	if (!item) return next(specifier, context);
	const importAttributes = Object.fromEntries(Object.entries(context.importAttributes));
	importAttributes.entry = entry;
	main = main ?? item;
	return { format: 'package', url: item, importAttributes, shortCircuit: true };
}
function cleanParentURL(parent: string | undefined) {
	if (!parent) return undefined;
	if (parent.startsWith('/')) parent = pathToFileURL(parent).toString();
	if (!parent.startsWith('file://')) {
		const url = new URL(parent);
		if (!url.hash && url.pathname.match(/\/asset:.+%23/)) {
			parent = new URL(url.pathname.replace(/^.*\/asset:/, 'asset:').replace('%23', '#')).toString();
		}
	}
	return parent;
}
function findPackage(uri: string) {
	let url = Asset.resolve('./package.json', uri);
	while (url && !Asset.exists(url)) {
		const next = Asset.resolve('../package.json');
		url = url === next ? undefined : next;
	}
	return url;
}
function findArchiveEntry(archive: string) {
	const zipurl = Asset.resolve('#/!', archive);
	if (!zipurl) return undefined;
	const content = getSource(zipurl);
	if (!content) return undefined;
	const bdl = JSON.parse(content.toString('utf-8'));
	if (!bdl.entry) return undefined;
	const uri = Asset.resolve(bdl.entry, zipurl);
	return uri;
}

export type LoadContext = {
	conditions: string[];
	format?: string | null;
	importAttributes: Record<string, string | undefined>;
};
export type LoadResult = {
	format: string | null | undefined;
	shortCircuit?: boolean;
	source?: ModuleSource;
};
export type NextLoad = (url: string, context: LoadContext) => LoadResult;
const archive = process.env.MODULE_ARCHIVE;
const loadCache = archive ? new Map<string, Buffer>() : { set(_value: string, _content: any) {} };

function getSource(uri: string) {
	const content = Asset.get(uri);
	if (content) loadCache.set(uri, content);
	return content;
}
export function load(url: string, context: LoadContext, next: NextLoad): LoadResult {
	switch (context.format) {
		case 'builtin': {
			return {
				format: 'builtin',
				shortCircuit: true,
			};
		}
		case 'native': {
			const content = getSource(url);
			if (!content) throw new Error(`failed to load: ${url}`);
			const tmp = Path.join(tmpdir(), `${process.pid}-${hash(content)}.node`);
			writeFileSync(tmp, content);
			return next(`${pathToFileURL(tmp)}`, { format: 'addon', importAttributes: context.importAttributes, conditions: context.conditions });
		}
		case 'package': {
			const content = getSource(url)?.toString('utf-8');
			if (!content) throw new Error(`failed to load: ${url}`);
			if (context.importAttributes.type === 'json') return { format: 'json', source: content, shortCircuit: true };
			const pkg = JSON.parse(content);
			const entry = findExport(url, pkg, context.importAttributes.entry);
			if (!entry) throw new Error(`failed to load: ${url}`);
			const target = getSource(entry);
			if (!target) throw new Error(`failed to load: ${url}`);
			loadCache.set(entry, target);
			const source = pkgModule(entry, !!target.toString('utf-8').match(/\bexport\s+default\b/));
			return { format: 'module', source, shortCircuit: true };
		}
		case 'unknown': {
			if (context.importAttributes?.type === 'json') {
				const source = getSource(url)?.toString('utf-8');
				return { format: 'json', source, shortCircuit: true };
			}
			break;
		}
	}
	const source = getSource(url)?.toString('utf-8');
	if (!source) throw new Error(`failed to load: ${url}`);
	let format = 'module';
	switch (Asset.extension(url)) {
		case 'cts':
			format = 'commonjs-typescript';
			break;
		case 'mts': // fall-through
		case 'ts':
			format = 'module-typescript';
			break;
		case 'cjs':
			format = 'commonjs';
			break;
		case 'mjs':
			format = 'module';
			break;
		case 'js':
			format = source.match(/\bexport\b/) || source.match(/\bimport\b/) ? 'module' : 'commonjs';
			break;
		default:
			return next(url, context);
	}
	return { format, source, shortCircuit: true };
}

registerHooks({ resolve, load });

if (SEA.isSea()) {
	const entry = SEA.getAssetKeys().shift();
	process.argv[1] = entry ? `asset:${entry}` : '';
} else if (archive) {
	process.on('beforeExit', () => {
		if (!main) {
			console.error('nothing to archive');
			return;
		}
		writeArchive(archive as string, main, loadCache as Map<string, Buffer>);
	});
}

if ('function' === typeof require) {
	if (process.argv[1]) {
		createRequire(pathToFileURL(process.cwd()))(process.argv[1]);
	} else {
		REPL.start();
	}
}

function findExport(base: string, pkg: { main?: string; exports?: string | Record<string, string> }, entry?: string) {
	if (pkg.main) {
		return Asset.resolve(entry ?? pkg.main, base);
	}
	if (pkg.exports) {
		if ('string' === typeof pkg.exports || entry) {
			return Asset.resolve(entry ?? `${pkg.exports}`, base);
		}
		return Asset.resolve(pkg.exports[entry ?? '.'], base);
	}
	return null;
}
function baseURL(urlstr: string) {
	const url = new URL(urlstr, 'file:///');
	url.protocol = 'file:';
	return new URL('./', url).toString().replace(/^\S+:/, 'file:');
}
function hash(buffer: Buffer) {
	return createHash('sha-1').update(buffer).digest('base64url');
}

function pkgModule(target: string, dflt: boolean) {
	const parts = [`// Synthetic Package Export`, `export * from '${target}';`];
	if (dflt) {
		parts.push(`import DFLT from '${target}`, `export default DFLT`);
	}
	parts.push('');
	return parts.join('\n');
}

function createEntry(name: string, content?: Buffer) {
	const central = ZIP.CentralFileHeader.create(name);
	const local = ZIP.LocalFileHeader.create(name);
	central.uncompressedSize = local.uncompressedSize = content?.byteLength ?? 0;
	const compressed = content ? deflateRawSync(content) : undefined;
	central.compressedSize = local.compressedSize = compressed?.byteLength ?? 0;
	local.lastModified = central.lastModified = new Date();
	central.mode = content ? 420 : 493;
	local.crc32 = central.crc32 = content ? crc32(content) : 0;
	return new ZIP.Entry(central, local, compressed ? compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) : new ArrayBuffer(0));
}
function* collect(cache: Map<string, Buffer>, base: string) {
	const names = Array.from(cache.keys()).sort((a, b) => a.length - b.length);
	const dirs = new Set<string>();
	for (const name of names) {
		for (const dir of Array.from(folders(name, base, dirs)).reverse()) {
			dirs.add(dir);
			yield createEntry(dir);
		}
		yield createEntry(name.slice(base.length), cache.get(name));
	}
}
function* folders(file: string, base: string, cache: Set<string>) {
	let dir = Asset.resolve('./', file);
	while (dir) {
		const name = dir.slice(base.length);
		if (cache.has(name) || !name) return;
		cache.add(name);
		yield name;
		const next = Asset.resolve('../', dir);
		if (next === dir) return;
		dir = next;
	}
}
function writeArchive(filename: string, main: string, cache: Map<string, Buffer>) {
	const base = common([main, ...cache.keys()]);
	let pos = 0;
	const dat = [];
	const end = [];
	const entry = `./${main.slice(base.length)}`;
	const manifest = createEntry('!', Buffer.from(JSON.stringify({ entry })));
	end.push(manifest.end(pos));
	for (const buf of manifest) {
		dat.push(Buffer.from(buf));
		pos += buf.byteLength;
	}
	for (const entry of collect(cache, base)) {
		end.push(entry.end(pos));
		for (const buf of entry) {
			dat.push(Buffer.from(buf));
			pos += buf.byteLength;
		}
	}
	const startofend = pos;
	for (const buf of end) {
		dat.push(Buffer.from(buf));
		pos += buf.byteLength;
	}
	const endhdr = ZIP.CentralEndHeader.create('module archive');
	endhdr.diskNumber = 0;
	endhdr.centralDirectoryDiskNumber = 0;
	endhdr.centralDirectoryDiskRecords = end.length;
	endhdr.centralDirectoryTotalRecords = end.length;
	endhdr.centralDirectoryOffset = startofend;
	endhdr.centralDirectorySize = pos - startofend;
	const endbuf = Buffer.from(endhdr.buffer);
	dat.push(endbuf);
	pos += endbuf.byteLength;
	const content = Buffer.concat(dat, pos);
	writeFileSync(filename, content);
}
function shared(a: string, b: string) {
	let aurl = new URL(a).pathname.split('/');
	let burl = new URL(b).pathname.split('/');
	aurl = aurl.slice(0, burl.length);
	burl = burl.slice(0, aurl.length);
	while (aurl.length && burl.length && aurl.join('/') !== burl.join('/')) {
		aurl.pop();
		burl.pop();
	}
	const res = new URL(a);
	res.pathname = [...aurl, ''].join('/');
	return res.toString();
}
function common(names: Iterable<string>) {
	let result: string | undefined;
	for (const item of names) {
		if (!result) {
			result = baseURL(item);
			continue;
		}
		const current = baseURL(item);
		if (current.startsWith(result)) continue;
		result = shared(result, item);
	}
	return result ?? 'file:///';
}
