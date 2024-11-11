import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as URL from 'node:url';

export class FSMap {
	#path;
	constructor(path: string) {
		this.#path = PATH.resolve(path);
	}
	has(name: string) {
		return FS.existsSync(PATH.join(this.#path, name));
	}
	get(name: string) {
		const path = PATH.join(this.#path, name);
		try {
			return FS.readFileSync(path);
		} catch {
			return undefined;
		}
	}
	file(name: string) {
		return PATH.join(this.#path, name);
	}
	*keys() {
		const base = URL.pathToFileURL(this.#path).toString();
		for (const item of FS.readdirSync(this.#path, { recursive: true, withFileTypes: true })) {
			const url = URL.pathToFileURL(PATH.join(item.parentPath, item.name)).toString();
			if (!url.startsWith(base)) continue;
			const name = url.slice(base.length);
			if (item.isDirectory()) {
				yield `${name}/`;
			} else if (item.isFile()) {
				yield `${name}`;
			}
		}
	}
	*values() {
		for (const { 1: value } of this.entries()) {
			yield value as Buffer;
		}
	}
	*entries(): Generator<[string, Buffer]> {
		for (const file of this.keys()) {
			if (file[file.length - 1] === '/') {
				yield [file, Buffer.alloc(0)];
			} else {
				yield [file, FS.readFileSync(PATH.join(this.#path, file)) as Buffer];
			}
		}
	}
}
