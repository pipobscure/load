import * as process from 'node:process';
import * as VM from 'node:vm';
import * as PATH from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Module } from 'node:module';

import type { ReadMap } from './readmap.js';
import { FSMap } from './fsmap.js';
import { Compressor, FileArchive, MemArchive } from '@pipobscure/zip';
import { getRawAsset } from 'node:sea';

export class Loader {
	#name: string;
	#archive: ReadMap<Buffer> & { file(name: string): string };
	#mode: Record<string, boolean> = {};
	constructor(archive: ReadMap<Buffer> & { file(name: string): string }, name?: string) {
		this.#name = name || 'modules';
		this.#archive = archive;
		this.linker = this.linker.bind(this);
	}
	resolve(specifier: string, parent?: string): string {
		if (parent && specifier === '<archive>') {
			const url = new URL(parent);
			return `archive://${this.#name}#!${url.pathname}`;
		}
		if (specifier.startsWith(`archive://${this.#name}/`)) {
			return specifier;
		}
		if (process.getBuiltinModule(specifier)) {
			return /^node\:/.test(specifier) ? specifier : `node:${specifier}`;
		}
		if (specifier[0] === '.') {
			const url = new URL(specifier, parent);
			return url.toString();
		}
		if (specifier[0] === '#') {
			// this is resolved from package.json imports
			let url = new URL('package.json', parent ?? `archive://${this.#name}/`).toString();
			while (true) {
				const name = this.#archiveName(url);
				if (this.#archive.has(name)) {
					const pkgJson = JSON.parse(this.#archive.get(name)?.toString('utf-8') ?? '{}');
					const imp = pkgJson.imports?.[specifier];
					if (!imp) throw new Error(`could not find module: ${specifier}`);
					if ('string' === typeof imp) return this.resolve(imp, url);
					const fin = imp.module ?? imp.node ?? imp.default;
					if (!fin) throw new Error(`could not find module: ${specifier}`);
					return this.resolve(fin, url);
				}
				const next = new URL('../package.json', url).toString();
				if (url === next) throw new Error(`could not find module: ${specifier}`);
				url = next;
			}
		}

		if (!parent) throw new Error(`could not find module: ${specifier}`);
		const parts = specifier.split('/');
		const pkgname = parts.slice(0, parts[0][0] === '@' ? 2 : 1).join('/');
		const expname = parts.slice(parts[0][0] === '@' ? 2 : 1).join('/') || (/#(\S+)$/.exec(specifier)?.[1] ?? '');
		return findPKG(this.#archive, new URL(parent), pkgname, expname);
	}
	#archiveName(uri: string): string {
		const url = new URL(uri);
		if (url.protocol !== 'archive:') throw new Error(`outside the archive ${uri}`);
		return url.pathname.slice(1);
	}
	loadContent(uri: string): Buffer {
		const buffer = this.#archive.get(this.#archiveName(uri));
		if (!buffer) throw new Error(`could not find ${uri}`);
		return buffer;
	}
	#cache: Map<string, VM.Module> = new Map();
	create(identifier: string) {
		if (this.#cache.has(identifier)) return this.#cache.get(identifier) as VM.Module;
		if (identifier[identifier.length - 1] === '/') {
			// this is a package
			const module = this.#pkg(identifier);
			this.#cache.set(identifier, module);
			return module;
		}
		if (identifier.startsWith('node:')) {
			// this is a builtin
			const module = this.#builtin(identifier);
			this.#cache.set(identifier, module);
			return module;
		}
		if (identifier.startsWith(`archive://${this.#name}#!`)) {
			// this want the file map itself
			const module = this.#filemap(identifier);
			this.#cache.set(identifier, module);
			return module;
		}
		const ext = PATH.extname(identifier).toLowerCase();
		const wrap =
			{
				'.js': this.#js,
				'.cjs': this.#cjs,
				'.mjs': this.#mjs,
				'.json': this.#json,
				'.node': this.#node,
			}[ext] ?? this.#fail;
		const module = wrap.call(this, identifier);
		this.#cache.set(identifier, module);
		return module;
	}
	link(module: VM.Module) {
		const result = module.link(this.linker);
		return result;
	}
	linker(specifier: string, parent?: VM.Module): VM.Module {
		const identifier = this.resolve(specifier, parent?.identifier ?? `archive://${this.#name}/`);
		const module = this.create(identifier);
		return module;
	}
	#builtin(identifier: string): VM.Module {
		const exports = process.getBuiltinModule(identifier);
		const module = new VM.SyntheticModule(
			['default', ...Object.keys(exports as object)],
			function () {
				this.setExport('default', exports);
				for (const exp of Object.keys(exports as object)) {
					this.setExport(exp, (exports as Record<string, unknown>)[exp]);
				}
			},
			{ identifier },
		);
		return module;
	}
	#pkg(identifier: string): VM.Module {
		const pkgUrl = new URL(identifier);
		const pkgJsonUrl = new URL('package.json', pkgUrl).toString();
		const expName = pkgUrl.hash.replace(/^#/, '/');
		const jsonText = this.loadContent(pkgJsonUrl);
		const pkgJson = JSON.parse(jsonText.toString('utf-8'));
		this.#mode[identifier] = pkgJson.type === 'module';
		const source = findEntry(pkgJsonUrl, pkgJson, expName);
		if (!source) throw new Error(`failed to load ${identifier} no valid entry`);
		const entrymodule = this.create(this.resolve(source, identifier));
		entrymodule.link(this.linker);
		const lines = Object.keys(entrymodule.namespace).map((name) => {
			if (name === 'default') {
				return `import _ from '${source}'; export default _;`;
			}
			return `export ${name} from '${source}';`;
		});
		const module = new VM.SourceTextModule(lines.join('\n'), { identifier });
		this.#cache.set(identifier, module);
		return module;
	}
	#cjs(identifier: string, code: string = this.loadContent(identifier)?.toString('utf-8')): VM.Module {
		if (!code) throw new Error(`failed to laod ${identifier}`);
		//@ts-ignore
		const { exports = [], reexports = [] }: { exports: string[]; reexports: string[] } = Module.getCJSParser()(code);
		const module = new VM.SyntheticModule(
			['default', ...exports, ...reexports],
			() => {
				const func = VM.compileFunction(code, ['require', 'module', 'exports', '__dirname', '__filename']);
				const exports = {};
				const mod = { exports };
				const dirname = new URL('./', identifier).toString();
				func.call(
					null,
					(spec: string) => {
						const identifier = this.resolve(spec, module.identifier);
						const imp = this.#cache.get(identifier) ?? this.create(identifier);
						if ('unlinked' === imp.status) {
							const res = this.link(imp);
							if ('function' === typeof res?.then) {
								res.catch(() => {});
								throw new Error('module linking went asynchronous');
							}
						}
						if ('linking' === imp.status) {
							throw new Error('module linking went strangely cyclical');
						}
						if ('linked' === imp.status) {
							const res = imp.evaluate() as void | Promise<void>;
							if ('function' === typeof res?.then) {
								res.catch(() => {});
								throw new Error('module evaluation went asynchronous');
							}
						}
						if ('evaluated' !== imp.status) {
							throw new Error('module require failed to evaluate properly');
						}
						return imp.namespace;
					},
					mod,
					dirname,
					identifier,
				);
				module.setExport('default', mod.exports);
			},
			{ identifier },
		);
		return module;
	}
	#mjs(identifier: string, code: string = this.loadContent(identifier)?.toString('utf-8')): VM.Module {
		if (!code) throw new Error(`failed to laod ${identifier}`);
		const module = new VM.SourceTextModule(code, {
			identifier,
			importModuleDynamically: (specifier): VM.Module => {
				return this.linker(specifier, module);
			},
		});
		return module;
	}
	#js(identifier: string): VM.Module {
		const content = this.loadContent(identifier)?.toString();
		if (!content) throw new Error(`failed to laod ${identifier}`);
		//@ts-ignore
		const usesESM = Module.containsModuleSyntax(content, identifier);
		if (usesESM) {
			return this.#mjs(identifier, content);
		}
		return this.#cjs(identifier, content);
	}
	#json(identifier: string) {
		const code = this.loadContent(identifier);
		return new VM.SyntheticModule(
			['default'],
			function () {
				this.setExport('default', JSON.parse(code.toString('utf-8')));
			},
			{ identifier },
		);
	}
	#node(identifier: string) {
		const path = this.#archive.file(this.#archiveName(identifier));
		const mod = { exports: {} as Record<string, unknown> };
		process.dlopen(mod, path);
		const module = new VM.SyntheticModule(
			['default', ...Object.keys(mod.exports)],
			function () {
				this.setExport('default', mod.exports);
				for (const exp of Object.keys(mod.exports)) {
					this.setExport(exp, mod.exports[exp]);
				}
			},
			{ identifier },
		);
		return module;
	}
	#filemap(identifier: string) {
		const base = new URL(identifier);
		base.pathname = base.hash.slice(2);
		base.hash = '';
		const has = (specifier: string) => {
			const url = new URL(specifier, base);
			const name = this.#archiveName(url.toString());
			return this.#archive.has(name);
		};
		const get = (specifier: string) => {
			const url = new URL(specifier, base);
			const name = this.#archiveName(url.toString());
			return this.#archive.get(name);
		};
		const module = new VM.SyntheticModule(
			['has', 'get'],
			function () {
				this.setExport('has', has);
				this.setExport('get', get);
			},
			{ identifier },
		);
		return module;
	}
	#fail(identifier: string): VM.Module {
		throw new Error(`cannot load ${identifier}`);
	}
	run() {
		const main = this.linker(`archive://${this.#name}/`);
		const linked = call((module: VM.Module) => module.link(this.linker), [main]);
		const evaluated = call((module: VM.Module) => module.evaluate(), [main], [linked]);
		const done = call(
			(module: VM.Module) => {
				const ns = module.namespace;
				if ('default' in ns && 'function' === typeof ns.default) {
					try {
						return ns.default(process.argv) ?? 0;
					} catch (ex) {
						console.error(ex);
						return process.exitCode ?? -1;
					}
				}
			},
			[main],
			[evaluated],
		);
		return done;
	}
	package(file: string) {
		if (!('seen' in this.#archive)) return;
		const compressor = new Compressor();
		const names = [...(this.#archive.seen as () => SetIterator<string>)()].sort();
		const dirs: Record<string, boolean> = {};
		for (const name of names) {
			name
				.split('/')
				.slice(-1)
				.forEach((_, idx, all) => {
					const dir = `${all.slice(0, idx).join('/')}/`;
					if (dirs[dir]) return;
					dirs[dir] = true;
					compressor.add(dir);
				});
			const content = this.#archive.get(name);
			compressor.add(name, content);
		}
		writeFileSync(file, compressor.done());
	}
	static fromSEA(key: string) {
		return new Loader(
			addFileCapability(MemArchive.fromArrayBuffer(getRawAsset(key) as ArrayBuffer)),
			PATH.basename(key),
		);
	}
	static fromZIP(file: string) {
		return new Loader(addFileCapability(new FileArchive(file)), PATH.basename(file, '.zip'));
	}
	static fromPath(path: string) {
		return new Loader(addRecordingCapability(new FSMap(PATH.resolve(path))), PATH.basename(PATH.resolve(path)));
	}
}

function call<X, P extends X | Promise<X>, Y, Q extends Y | Promise<Y>, V>(
	fun: (...args: X[]) => V | Promise<V>,
	pargs: P[] = [],
	extra: Q[] = [],
): V | Promise<V> {
	const async = !!pargs.find((arg) => {
		if (!arg || 'object' !== typeof arg) return false;
		if (!('then' in arg)) return false;
		return 'function' === typeof arg.then;
	});
	if (async) {
		return Promise.all([...pargs, ...extra]).then((args) => fun.apply(null, args.slice(0, pargs.length) as X[]));
	}
	return fun.apply(null, pargs as X[]);
}

function findPKG(archive: ReadMap<any>, base: URL, pkgname: string, expname = ''): string {
	const url = new URL(`node_modules/${pkgname}/`, base);
	if (archive.has(url.pathname.slice(1))) {
		url.hash = expname;
		return url.toString();
	}
	const newBase = new URL('../', base);
	if (base.toString() === newBase.toString()) throw new Error(`could not resolve ${pkgname}`);
	return findPKG(archive, newBase, pkgname, expname);
}
function findEntry(base: string, pkg: any, exp: string): undefined | string {
	if (pkg.exports) {
		if ('string' === typeof pkg.exports) return exp === '' ? new URL(pkg.exports, base).toString() : undefined;
		if (Array.isArray(pkg.exports)) return pkg.exports.includes(exp) ? new URL(exp, base).toString() : undefined;
		if ('object' !== typeof pkg.exports) return undefined;
		if (!exp) {
			const result = pkg.exports.import ?? pkg.exports.node ?? pkg.exports.default;
			return result ? new URL(result, base).toString() : undefined;
		}
		const sub = pkg.exports[exp];
		if (!sub) return undefined;
		if ('string' === typeof sub) return new URL(sub, base).toString();
		const result = sub.import ?? sub.node ?? sub.default;
		return result ? new URL(result, base).toString() : undefined;
	}
	return new URL(exp === '' ? (pkg.main ?? './index.js') : `.${exp}`, base).toString();
}

function addFileCapability(archive: ReadMap<Buffer>): ReadMap<Buffer> & { file(name: string): string } {
	return Object.assign(archive, { file: makeTempFile });
}
function makeTempFile(this: ReadMap<Buffer>, name: string): string {
	const content = this.get(name);
	if (!content) throw new Error(`content not found ${name}`);
	const fname = createHash('SHA-1').end(content).digest('hex');
	const path = PATH.join(tmpdir(), `${fname}`);
	writeFileSync(path, content);
	return path;
}

function addRecordingCapability<T, M extends ReadMap<T>>(archive: M): M & { seen(): SetIterator<string> } {
	const get = archive.get;
	const seen = new Set<string>();
	return Object.assign(archive, {
		get(name: string): T | undefined {
			const result = get.call(this, name);
			if (result === undefined) return undefined;
			seen.add(name);
			return result;
		},
		seen() {
			return seen.values();
		},
	});
}
