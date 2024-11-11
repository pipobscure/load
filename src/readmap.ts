export interface ReadMap<T> {
	has(key: string): boolean;
	get(key: string): T | undefined;
}
