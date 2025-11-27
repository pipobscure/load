import * as SEA from 'node:sea';
import * as FS from 'node:fs';
import * as Path from 'node:path';
import * as ZLib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ZipBuffer } from '@pipobscure/zip/buffer';

function resolveArchive(relative: string, base: URL) {
	const inter = new URL(relative, `sea:${base.hash.slice(1)}`);
	return `${new URL(`#${inter.pathname}`, base)}`;
}
function tryAbsolute(poss: string) {
	try {
		return new URL(poss);
	} catch {
		return undefined;
	}
}
export function resolve(uri: string, base?: string) {
	const absolute = tryAbsolute(uri);
	if (absolute) return `${absolute}`;
	if (!base) return undefined;
	const baseURL = tryAbsolute(base);
	if (!baseURL) return undefined;
	if (baseURL.hash.startsWith('#/') && baseURL.pathname.endsWith('.zip')) {
		return resolveArchive(uri, baseURL);
	} else {
		return `${new URL(uri, baseURL)}`;
	}
}

const seadir = Path.resolve(process.env.ASSETS ?? './', process.cwd());
function getFileAsset(name: string) {
	const buffer = FS.readFileSync(Path.join(seadir, name));
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
function existsFileAsset(name: string) {
	try {
		const stat = FS.statSync(Path.join(seadir, name));
		return stat?.isFile() ?? false;
	} catch {
		return false;
	}
}
function getBaseAsset(url: URL) {
	const baseName = url.pathname.replace(/^\/*/g, '');
	return SEA.isSea() ? SEA.getRawAsset(baseName) : getFileAsset(baseName);
}
function exitstBaseAsset(url: URL) {
	const baseName = url.pathname.slice(url.pathname[0] === '/' ? 1 : 0);
	return SEA.isSea() ? SEA.getAssetKeys().includes(baseName) : existsFileAsset(baseName);
}
const ArchiveCache: Record<string, ZipBuffer> = {};
function getArchive(url: URL) {
	const baseName = url.pathname.slice(url.pathname[0] === '/' ? 1 : 0);
	const result = (ArchiveCache[baseName] = ArchiveCache[baseName] ?? new ZipBuffer(Buffer.from(getBaseAsset(url))));
	return result;
}
export function get(uri: string) {
	const url = new URL(uri);
	switch (url.protocol) {
		case 'asset:': {
			if (!url.pathname.endsWith('.zip') || !url.hash.startsWith('#/')) return Buffer.from(getBaseAsset(url));
			const archive = getArchive(url);
			const entry = archive.get(url.hash.slice(2));
			if (!entry) return undefined;
			return entry.compressed ? ZLib.inflateRawSync(Buffer.from(entry.rawcontent)) : Buffer.from(entry.rawcontent);
		}
		case 'file:': {
			if (url.pathname.endsWith('.zip') && url.hash.startsWith('#/')) {
				const archive = (ArchiveCache[url.pathname] = ArchiveCache[url.pathname] || new ZipBuffer(FS.readFileSync(fileURLToPath(url))));
				const entry = archive.get(url.hash.slice(2));
				if (!entry) return undefined;
				return entry.compressed ? ZLib.inflateRawSync(Buffer.from(entry.rawcontent)) : Buffer.from(entry.rawcontent);
			}
			return FS.readFileSync(fileURLToPath(url));
		}
		default: {
			throw new Error(`unsupported protocol: ${url.protocol}`);
		}
	}
}
export function exists(uri: string) {
	if (!uri) return false;
	const url = new URL(uri);
	switch (url.protocol) {
		case 'asset:': {
			if (!url.pathname.endsWith('.zip') || !url.hash.startsWith('#/')) return exitstBaseAsset(url);
			const archive = getArchive(url);
			return archive.has(url.hash.slice(2));
		}
		case 'file:': {
			if (url.pathname.endsWith('.zip') && url.hash.startsWith('#/')) {
				const archive = (ArchiveCache[url.pathname] = ArchiveCache[url.pathname] || new ZipBuffer(FS.readFileSync(fileURLToPath(url))));
				return archive.has(url.hash.slice(2));
			}
			try {
				const stat = FS.statSync(fileURLToPath(url));
				return stat?.isFile();
			} catch {
				return false;
			}
		}
		default: {
			return false;
		}
	}
}
export function isArchive(uri: string) {
	const url = new URL(uri);
	return url.pathname.endsWith('.zip') && !url.hash.startsWith('#/');
}
export function filename(uri: string) {
	const url = new URL(uri);
	if (url.pathname.endsWith('.zip') && url.hash.startsWith('#/')) {
		return url.hash.slice(2);
	}
	return url.pathname;
}
export function basename(uri: string) {
	return filename(uri).split('/').pop();
}
export function extension(uri: string) {
	const name = basename(uri);
	return name?.split('.').slice(1).join('.') ?? '';
}
