let debugEnabled = false;
let nextDebugId = 1;
let debugIds = new WeakMap<object, string>();

export function setJotDebugEnabled(enabled: boolean): void {
	debugEnabled = enabled;
}

export function resetJotDebugStateForTests(): void {
	debugEnabled = false;
	nextDebugId = 1;
	debugIds = new WeakMap<object, string>();
}

export function jotDebugId(target: object, prefix = 'node'): string {
	const existing = debugIds.get(target);
	if (existing) return existing;
	const id = `${prefix}-${nextDebugId++}`;
	debugIds.set(target, id);
	return id;
}

export function jotDebug(event: string, details: Record<string, unknown> = {}): void {
	if (!debugEnabled) return;
	const suffix = Object.entries(details)
		.map(([key, value]) => `${key}=${formatDebugValue(value)}`)
		.join(' ');
	console.debug(`[JOT] ${event}${suffix ? ` ${suffix}` : ''}`);
}

function formatDebugValue(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}
