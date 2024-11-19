import { Module, register } from 'node:module';

const runMain = Module.runMain as (entry: string) => void;
Module.runMain = function () {
	return runMain.call(this, `${__dirname}/main.js`);
};

register(import.meta.url);

type Context = {
	conditions: string[];
	importAttributes: any;
	parentURL?: string;
};
type Resolver = (specifier: string) => {
	format?: string;
	importAttributes?: any;
	shortCircuit?: boolean;
	url: string;
};
export function resolve(specifier: string, context: Context, nextResolve: Resolver) {
	if (!context.parentURL)
		return {
			format: 'module',
			shortCircuit: true,
			url: new URL('./main.js', import.meta.url).toString(),
		};
	return nextResolve(specifier);
}
