const MAX_EVENTS = 120;
const STORAGE_KEY = 'jot-ipad-zoom-diagnostics-v1';
const MAX_CAPTURE_AGE_MS = 30 * 60 * 1000;

interface PersistedCapture {
	startedAtMs: number;
	reloadCount: number;
}

let enabled = false;
let startedAtMs = 0;
let persistedReloadCount = 0;
let nextId = 1;
let ids = new WeakMap<object, string>();
let events: string[] = [];
let counters = new Map<string, number>();

export function startZoomDiagnostics(): void {
	enabled = true;
	startedAtMs = Date.now();
	persistedReloadCount = 0;
	nextId = 1;
	ids = new WeakMap<object, string>();
	events = [];
	counters = new Map<string, number>();
	writePersistedCapture({ startedAtMs, reloadCount: 0 });
	recordZoomDiagnosticEvent('capture started');
}

export function resumeZoomDiagnosticsAfterReload(): boolean {
	const persisted = readPersistedCapture();
	if (!persisted) return false;

	enabled = true;
	startedAtMs = persisted.startedAtMs;
	persistedReloadCount = persisted.reloadCount + 1;
	nextId = 1;
	ids = new WeakMap<object, string>();
	events = [];
	counters = new Map<string, number>();
	writePersistedCapture({
		startedAtMs,
		reloadCount: persistedReloadCount,
	});
	countZoomDiagnostic('diagnosticReloadResumes');
	recordZoomDiagnosticEvent(
		`capture resumed after plugin reload count=${persistedReloadCount}`,
	);
	return true;
}

export function stopZoomDiagnostics(): void {
	enabled = false;
	removePersistedCapture();
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
		`captureReloads=${persistedReloadCount}`,
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
	persistedReloadCount = 0;
	nextId = 1;
	ids = new WeakMap<object, string>();
	events = [];
	counters = new Map<string, number>();
	removePersistedCapture();
}

function diagnosticsStorage(): Storage | null {
	try {
		if (typeof window === 'undefined') return null;
		return window.localStorage;
	} catch {
		return null;
	}
}

function readPersistedCapture(): PersistedCapture | null {
	const storage = diagnosticsStorage();
	if (!storage) return null;
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PersistedCapture>;
		if (
			typeof parsed.startedAtMs !== 'number' ||
			typeof parsed.reloadCount !== 'number'
		) {
			storage.removeItem(STORAGE_KEY);
			return null;
		}
		const age = Date.now() - parsed.startedAtMs;
		if (age < 0 || age > MAX_CAPTURE_AGE_MS) {
			storage.removeItem(STORAGE_KEY);
			return null;
		}
		return {
			startedAtMs: parsed.startedAtMs,
			reloadCount: parsed.reloadCount,
		};
	} catch {
		return null;
	}
}

function writePersistedCapture(capture: PersistedCapture): void {
	const storage = diagnosticsStorage();
	if (!storage) return;
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(capture));
	} catch {
		/* Diagnostics must never interfere with the PDF workflow. */
	}
}

function removePersistedCapture(): void {
	const storage = diagnosticsStorage();
	if (!storage) return;
	try {
		storage.removeItem(STORAGE_KEY);
	} catch {
		/* Diagnostics must never interfere with the PDF workflow. */
	}
}
