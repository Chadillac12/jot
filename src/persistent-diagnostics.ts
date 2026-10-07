import type { DataAdapter } from 'obsidian';

export type DiagnosticValue = string | number | boolean | null | undefined;
export type DiagnosticFields = Record<string, DiagnosticValue>;

export interface DiagnosticSink {
	isEnabled(): boolean;
	record(event: string, fields?: DiagnosticFields): void;
}

export const NULL_DIAGNOSTICS: DiagnosticSink = {
	isEnabled: () => false,
	record: () => {},
};

interface DiagnosticState {
	schema: 1;
	enabled: boolean;
	cleanShutdown: boolean;
	activeSessionId: string | null;
	activeSessionPath: string | null;
	activeSessionStartedAt: string | null;
	lastCrashSessionId: string | null;
	lastCrashSessionPath: string | null;
	lastCompletedSessionId: string | null;
	lastCompletedSessionPath: string | null;
}

interface DiagnosticEvent {
	seq: number;
	ts: string;
	ms: number;
	event: string;
	fields?: DiagnosticFields;
}

export interface DiagnosticInitializeResult {
	recording: boolean;
	recoveredCrash: boolean;
}

const STATE_SCHEMA = 1;
const FLUSH_DELAY_MS = 120;
const FLUSH_BATCH_SIZE = 12;
const MAX_RETAINED_SESSION_FILES = 8;

function initialState(): DiagnosticState {
	return {
		schema: STATE_SCHEMA,
		enabled: false,
		cleanShutdown: true,
		activeSessionId: null,
		activeSessionPath: null,
		activeSessionStartedAt: null,
		lastCrashSessionId: null,
		lastCrashSessionPath: null,
		lastCompletedSessionId: null,
		lastCompletedSessionPath: null,
	};
}

function safeFilenameStamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function normalizeFields(fields?: DiagnosticFields): DiagnosticFields | undefined {
	if (!fields) return undefined;
	const normalized: DiagnosticFields = {};
	for (const [key, value] of Object.entries(fields)) {
		if (
			value === undefined ||
			value === null ||
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			normalized[key] = value;
		} else {
			normalized[key] = String(value);
		}
	}
	return normalized;
}

export class PersistentDiagnostics implements DiagnosticSink {
	private readonly diagnosticsDir: string;
	private readonly sessionsDir: string;
	private readonly statePath: string;
	private state: DiagnosticState = initialState();
	private pendingLines: string[] = [];
	private flushTimer: number | null = null;
	private writeChain: Promise<void> = Promise.resolve();
	private sequence = 0;
	private sessionStartedAtMs = 0;
	private storageReady = false;

	constructor(
		private adapter: DataAdapter,
		private pluginDir: string,
		private pluginVersion: string,
	) {
		this.diagnosticsDir = `${pluginDir}/diagnostics`;
		this.sessionsDir = `${this.diagnosticsDir}/sessions`;
		this.statePath = `${this.diagnosticsDir}/state.json`;
	}

	isEnabled(): boolean {
		return this.state.enabled && this.state.activeSessionPath !== null;
	}

	async initialize(): Promise<DiagnosticInitializeResult> {
		try {
			await this.ensureStorage();
			this.state = await this.readState();
			const recoveredCrash =
				this.state.enabled &&
				!this.state.cleanShutdown &&
				this.state.activeSessionId !== null &&
				this.state.activeSessionPath !== null;

			if (this.state.activeSessionId && this.state.activeSessionPath) {
				if (recoveredCrash) {
					this.state.lastCrashSessionId = this.state.activeSessionId;
					this.state.lastCrashSessionPath = this.state.activeSessionPath;
				} else if (this.state.cleanShutdown) {
					this.state.lastCompletedSessionId = this.state.activeSessionId;
					this.state.lastCompletedSessionPath = this.state.activeSessionPath;
				}
			}

			if (this.state.enabled) {
				const previousCrashId = recoveredCrash ? this.state.lastCrashSessionId : null;
				await this.startNewSession('auto-resume');
				if (previousCrashId) {
					this.record('diagnostics.previous-session-unclean', {
						previousSessionId: previousCrashId,
					});
					await this.flush();
				}
			} else {
				this.state.activeSessionId = null;
				this.state.activeSessionPath = null;
				this.state.activeSessionStartedAt = null;
				this.state.cleanShutdown = true;
				await this.writeState();
			}
			await this.pruneOldSessions();
			return { recording: this.isEnabled(), recoveredCrash };
		} catch (error) {
			console.error('[jot] diagnostics initialization failed', error);
			this.state = initialState();
			this.storageReady = false;
			return { recording: false, recoveredCrash: false };
		}
	}

	async start(): Promise<boolean> {
		if (this.isEnabled()) return false;
		try {
			await this.ensureStorage();
			this.state.enabled = true;
			await this.startNewSession('manual-start');
			await this.flush();
			return true;
		} catch (error) {
			console.error('[jot] diagnostics start failed', error);
			return false;
		}
	}

	async stop(): Promise<boolean> {
		if (!this.isEnabled()) {
			if (this.state.enabled) {
				this.state.enabled = false;
				await this.writeStateSafe();
			}
			return false;
		}
		this.record('diagnostics.stop');
		await this.flush();
		this.state.enabled = false;
		this.state.cleanShutdown = true;
		this.state.lastCompletedSessionId = this.state.activeSessionId;
		this.state.lastCompletedSessionPath = this.state.activeSessionPath;
		this.state.activeSessionId = null;
		this.state.activeSessionPath = null;
		this.state.activeSessionStartedAt = null;
		await this.writeStateSafe();
		return true;
	}

	record(event: string, fields?: DiagnosticFields): void {
		if (!this.isEnabled() || !this.state.activeSessionPath) return;
		const now = Date.now();
		const entry: DiagnosticEvent = {
			seq: ++this.sequence,
			ts: new Date(now).toISOString(),
			ms: Math.max(0, now - this.sessionStartedAtMs),
			event,
		};
		const normalized = normalizeFields(fields);
		if (normalized && Object.keys(normalized).length > 0) entry.fields = normalized;
		this.pendingLines.push(JSON.stringify(entry) + '\n');
		if (this.pendingLines.length >= FLUSH_BATCH_SIZE) {
			void this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	async flush(): Promise<void> {
		this.clearFlushTimer();
		const path = this.state.activeSessionPath;
		if (!path || this.pendingLines.length === 0) {
			await this.writeChain;
			return;
		}
		const lines = this.pendingLines.splice(0, this.pendingLines.length);
		const data = lines.join('');
		const operation = this.writeChain.then(async () => {
			try {
				await this.adapter.append(path, data);
			} catch (error) {
				this.pendingLines.unshift(...lines);
				console.error('[jot] diagnostics append failed', error);
			}
		});
		this.writeChain = operation;
		await operation;
	}

	async markCleanShutdown(): Promise<void> {
		if (!this.isEnabled()) return;
		this.record('plugin.clean-shutdown');
		await this.flush();
		this.state.cleanShutdown = true;
		this.state.lastCompletedSessionId = this.state.activeSessionId;
		this.state.lastCompletedSessionPath = this.state.activeSessionPath;
		await this.writeStateSafe();
	}

	async exportLast(): Promise<string | null> {
		try {
			await this.ensureStorage();
			if (this.isEnabled()) await this.flush();
			const source =
				this.state.lastCrashSessionPath ??
				this.state.activeSessionPath ??
				this.state.lastCompletedSessionPath;
			if (!source || !(await this.adapter.exists(source))) return null;

			const exportDir = 'Jot Diagnostics';
			if (!(await this.adapter.exists(exportDir))) await this.adapter.mkdir(exportDir);
			const base = source.split('/').pop() ?? `jot-diagnostics-${safeFilenameStamp(new Date())}.jsonl`;
			let target = `${exportDir}/${base}`;
			let suffix = 2;
			while (await this.adapter.exists(target)) {
				target = `${exportDir}/${base.replace(/\.jsonl$/, '')}-${suffix}.jsonl`;
				suffix += 1;
			}
			await this.adapter.copy(source, target);
			return target;
		} catch (error) {
			console.error('[jot] diagnostics export failed', error);
			return null;
		}
	}

	async clearRecordings(): Promise<boolean> {
		try {
			await this.ensureStorage();
			const wasEnabled = this.state.enabled;
			if (this.isEnabled()) await this.flush();
			this.clearFlushTimer();
			this.pendingLines = [];
			await this.writeChain;

			const listing = await this.adapter.list(this.sessionsDir);
			for (const file of listing.files) {
				await this.adapter.remove(file);
			}

			this.state.lastCrashSessionId = null;
			this.state.lastCrashSessionPath = null;
			this.state.lastCompletedSessionId = null;
			this.state.lastCompletedSessionPath = null;
			this.state.activeSessionId = null;
			this.state.activeSessionPath = null;
			this.state.activeSessionStartedAt = null;
			this.state.cleanShutdown = true;
			this.state.enabled = wasEnabled;
			await this.writeState();

			if (wasEnabled) {
				await this.startNewSession('clear-and-resume');
				await this.flush();
			}
			return true;
		} catch (error) {
			console.error('[jot] diagnostics clear failed', error);
			return false;
		}
	}

	status(): {
		enabled: boolean;
		activeSessionId: string | null;
		lastCrashSessionId: string | null;
	} {
		return {
			enabled: this.isEnabled(),
			activeSessionId: this.state.activeSessionId,
			lastCrashSessionId: this.state.lastCrashSessionId,
		};
	}

	private async startNewSession(reason: string): Promise<void> {
		await this.ensureStorage();
		this.clearFlushTimer();
		this.pendingLines = [];
		await this.writeChain;
		const now = new Date();
		const sessionId = `${safeFilenameStamp(now)}-${Math.random().toString(36).slice(2, 8)}`;
		const path = `${this.sessionsDir}/jot-diagnostics-${sessionId}.jsonl`;
		this.sequence = 0;
		this.sessionStartedAtMs = now.getTime();
		this.state.activeSessionId = sessionId;
		this.state.activeSessionPath = path;
		this.state.activeSessionStartedAt = now.toISOString();
		this.state.cleanShutdown = false;
		await this.writeState();

		const win = typeof window !== 'undefined' ? window : null;
		const nav = typeof navigator !== 'undefined' ? navigator : null;
		const perfMemory = (
			typeof performance !== 'undefined'
				? (performance as Performance & {
						memory?: {
							usedJSHeapSize?: number;
							totalJSHeapSize?: number;
							jsHeapSizeLimit?: number;
						};
					}).memory
				: undefined
		);
		const header: DiagnosticEvent = {
			seq: ++this.sequence,
			ts: now.toISOString(),
			ms: 0,
			event: 'diagnostics.session-start',
			fields: {
				reason,
				pluginVersion: this.pluginVersion,
				userAgent: nav?.userAgent ?? 'unavailable',
				devicePixelRatio: win?.devicePixelRatio ?? null,
				viewportWidth: win?.innerWidth ?? null,
				viewportHeight: win?.innerHeight ?? null,
				usedJSHeapSize: perfMemory?.usedJSHeapSize ?? null,
				totalJSHeapSize: perfMemory?.totalJSHeapSize ?? null,
				jsHeapSizeLimit: perfMemory?.jsHeapSizeLimit ?? null,
			},
		};
		await this.adapter.write(path, JSON.stringify(header) + '\n');
	}

	private async ensureStorage(): Promise<void> {
		if (this.storageReady) return;
		if (!(await this.adapter.exists(this.diagnosticsDir))) {
			await this.adapter.mkdir(this.diagnosticsDir);
		}
		if (!(await this.adapter.exists(this.sessionsDir))) {
			await this.adapter.mkdir(this.sessionsDir);
		}
		this.storageReady = true;
	}

	private async readState(): Promise<DiagnosticState> {
		if (!(await this.adapter.exists(this.statePath))) return initialState();
		try {
			const parsed = JSON.parse(await this.adapter.read(this.statePath)) as Partial<DiagnosticState>;
			if (parsed.schema !== STATE_SCHEMA) return initialState();
			return {
				...initialState(),
				...parsed,
				schema: STATE_SCHEMA,
			};
		} catch {
			return initialState();
		}
	}

	private async writeState(): Promise<void> {
		await this.ensureStorage();
		await this.adapter.write(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
	}

	private async writeStateSafe(): Promise<void> {
		try {
			await this.writeState();
		} catch (error) {
			console.error('[jot] diagnostics state write failed', error);
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		const host = typeof window !== 'undefined' ? window : null;
		if (!host) {
			void this.flush();
			return;
		}
		this.flushTimer = host.setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, FLUSH_DELAY_MS);
	}

	private clearFlushTimer(): void {
		if (this.flushTimer === null) return;
		if (typeof window !== 'undefined') window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
	}

	private async pruneOldSessions(): Promise<void> {
		try {
			const listing = await this.adapter.list(this.sessionsDir);
			const protectedPaths = new Set(
				[
					this.state.activeSessionPath,
					this.state.lastCrashSessionPath,
					this.state.lastCompletedSessionPath,
				].filter((path): path is string => typeof path === 'string'),
			);
			const files = [...listing.files].sort();
			const removable = files.filter((path) => !protectedPaths.has(path));
			let excess = Math.max(0, files.length - MAX_RETAINED_SESSION_FILES);
			while (excess > 0 && removable.length > 0) {
				const path = removable.shift();
				if (!path) break;
				await this.adapter.remove(path);
				excess -= 1;
			}
		} catch (error) {
			console.warn('[jot] diagnostics prune failed', error);
		}
	}
}
