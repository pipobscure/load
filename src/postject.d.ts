declare module 'postject' {
	type InjectOptions = {
		sentinelFuse: string;
		machoSegmentName?: string;
	};
	function inject(execFile: string, name: string, content: Buffer, options: InjectOptions): void;
}
