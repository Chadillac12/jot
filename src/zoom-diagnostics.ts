const MAX_EVENTS = 120;

let enabled = false;
let startedAtMs = 0;
let nextId = 1;
let ids = new WeakMap<object, string>();
let events: string[] = [];
let counters = new Map<string, number>();

export function startZoomDiagnostics(): void {
	enabled = true;
	startedAtMs = Date.now();
	nextId = 1;
	ids = new WeakMap<object, string>();
	events = [];
	counters = new Map<string, number>();
	recordZoomDiagnosticEvent('capture started');
}

export function stopZoomDiagnostics(): void {
	enabled = false;
}

export function isZoomDiagnosticsEnabled(): boolean {
	return enabled;
}

export function countZoomDiagnostic(name: string, amount = 1): void {
	if (!enabled) return;
	counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function zoomDiagnosticId(target: object, prefix: string): string {
	if (!enabled) return 'disabled';
	const existing = ids.get(target);
	if (existing) return existing;
	const id = `${prefix}-${nextId++}`;
	ids.set(target, id);
	return id;
}

export function recordZoomDiagnosticEvent(event: string): void {
	if (!enabled) return;
	const elapsed = Date.now() - startedAtMs;
	events.push(`+${elapsed}ms ${event}`);
	if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function buildZoomDiagnosticsReport(snapshotLines: string[]): string {
	const counterLines = [...counters.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${value}`);

	return [
		'Jot iPad zoom diagnostics',
		`captureEnabled=${enabled ? 1 : 0}`,
		`captureAgeMs=${startedAtMs > 0 ? Date.now() - startedAtMs : 0}`,
		'',
		'[counters]',
		...(counterLines.length > 0 ? counterLines : ['(none)']),
		'',
		'[snapshot]',
		...snapshotLines,
		'',
		'[recent events]',
		...(events.length > 0 ? events : ['(none)']),
	].join('\n');
}

export function resetZoomDiagnosticsForTests(): void {
	enabled = false;
	startedAtMs = 0;
	nextId = 1;
	ids = new WeakMap<object, string>();
	events = [];
	counters = new Map<string, number>();
}
