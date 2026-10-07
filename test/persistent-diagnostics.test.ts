/* eslint-disable obsidianmd/hardcoded-config-path */
import { describe, expect, it } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { PersistentDiagnostics } from '../src/persistent-diagnostics';

class MemoryAdapter {
	files = new Map<string, string>();
	dirs = new Set<string>();

	constructor() {
		this.dirs.add('');
		this.dirs.add('.obsidian');
		this.dirs.add('.obsidian/plugins');
		this.dirs.add('.obsidian/plugins/jot');
	}

	asAdapter(): DataAdapter {
		return this as unknown as DataAdapter;
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}

	async read(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`missing ${path}`);
		return value;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async append(path: string, data: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? '') + data);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith('/') ? path : path + '/';
		const files = [...this.files.keys()].filter((candidate) => {
			if (!candidate.startsWith(prefix)) return false;
			return !candidate.slice(prefix.length).includes('/');
		});
		const folders = [...this.dirs].filter((candidate) => {
			if (!candidate.startsWith(prefix)) return false;
			const remainder = candidate.slice(prefix.length);
			return remainder.length > 0 && !remainder.includes('/');
		});
		return { files, folders };
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async copy(source: string, target: string): Promise<void> {
		const value = this.files.get(source);
		if (value === undefined) throw new Error(`missing ${source}`);
		this.files.set(target, value);
	}
}

function state(adapter: MemoryAdapter) {
	return JSON.parse(
		adapter.files.get('.obsidian/plugins/jot/diagnostics/state.json') ?? '{}',
	) as {
		enabled?: boolean;
		cleanShutdown?: boolean;
		activeSessionPath?: string | null;
		lastCrashSessionPath?: string | null;
		lastCompletedSessionPath?: string | null;
	};
}

describe('PersistentDiagnostics', () => {
	it('starts disabled and persists manual start/stop state', async () => {
		const fs = new MemoryAdapter();
		const diagnostics = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);

		expect(await diagnostics.initialize()).toEqual({
			recording: false,
			recoveredCrash: false,
		});
		expect(diagnostics.isEnabled()).toBe(false);

		expect(await diagnostics.start()).toBe(true);
		diagnostics.record('pdf.test', { page: 2, width: 1000 });
		await diagnostics.flush();

		const started = state(fs);
		expect(started.enabled).toBe(true);
		expect(started.cleanShutdown).toBe(false);
		expect(started.activeSessionPath).toBeTruthy();
		expect(fs.files.get(started.activeSessionPath!)).toContain('"event":"pdf.test"');

		expect(await diagnostics.stop()).toBe(true);
		const stopped = state(fs);
		expect(stopped.enabled).toBe(false);
		expect(stopped.cleanShutdown).toBe(true);
		expect(stopped.activeSessionPath).toBeNull();
		expect(stopped.lastCompletedSessionPath).toBeTruthy();
	});

	it('detects an unclean restart, preserves that session, and auto-resumes recording', async () => {
		const fs = new MemoryAdapter();
		const first = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		await first.initialize();
		await first.start();
		first.record('pdf.before-crash', { marker: 'survives' });
		await first.flush();
		const crashedPath = state(fs).activeSessionPath!;

		const restarted = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		const result = await restarted.initialize();

		expect(result).toEqual({ recording: true, recoveredCrash: true });
		expect(restarted.isEnabled()).toBe(true);
		const restartedState = state(fs);
		expect(restartedState.lastCrashSessionPath).toBe(crashedPath);
		expect(restartedState.activeSessionPath).not.toBe(crashedPath);
		expect(fs.files.get(crashedPath)).toContain('"event":"pdf.before-crash"');
	});

	it('does not classify a clean shutdown as a crash and resumes because recording stays enabled', async () => {
		const fs = new MemoryAdapter();
		const first = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		await first.initialize();
		await first.start();
		await first.markCleanShutdown();
		const completedPath = state(fs).activeSessionPath!;

		const restarted = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		const result = await restarted.initialize();

		expect(result).toEqual({ recording: true, recoveredCrash: false });
		const restartedState = state(fs);
		expect(restartedState.lastCrashSessionPath).toBeNull();
		expect(restartedState.lastCompletedSessionPath).toBe(completedPath);
		expect(restartedState.activeSessionPath).not.toBe(completedPath);
	});

	it('treats synchronous unload intent as clean even before its async state write completes', async () => {
		const fs = new MemoryAdapter();
		const first = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		await first.initialize();
		await first.start();
		// Obsidian does not await onunload(). The sentinel must be available
		// synchronously to the next session without assuming the write finished.
		const finishing = first.markCleanShutdown();
		const restarted = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		expect((await restarted.initialize()).recoveredCrash).toBe(false);
		await finishing;
	});

	it('exports the preserved crash session ahead of the newly resumed live session', async () => {
		const fs = new MemoryAdapter();
		const first = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		await first.initialize();
		await first.start();
		first.record('pdf.crash-marker', { value: 42 });
		await first.flush();

		const restarted = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		await restarted.initialize();

		const exported = await restarted.exportLast();
		expect(exported).toMatch(/^Jot Diagnostics\/jot-diagnostics-.*\.jsonl$/);
		expect(fs.files.get(exported!)).toContain('"event":"pdf.crash-marker"');
	});

	it('clears retained recordings without disabling an active recorder', async () => {
		const fs = new MemoryAdapter();
		const diagnostics = new PersistentDiagnostics(
			fs.asAdapter(),
			'.obsidian/plugins/jot',
			'1.2.3-test',
		);
		await diagnostics.initialize();
		await diagnostics.start();
		diagnostics.record('old-event');
		await diagnostics.flush();

		expect(await diagnostics.clearRecordings()).toBe(true);
		expect(diagnostics.isEnabled()).toBe(true);
		const current = state(fs).activeSessionPath;
		expect(current).toBeTruthy();
		expect(fs.files.get(current!)).toContain('"event":"diagnostics.session-start"');
		expect(fs.files.get(current!)).not.toContain('"event":"old-event"');
	});
});
