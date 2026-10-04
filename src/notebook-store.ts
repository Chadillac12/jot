import type { TFile, Vault } from 'obsidian';
import type { NotebookSessionManager } from './notebook-session';

const SAVE_DEBOUNCE_MS = 750;
const RETRY_DELAY_MS = 2000;

export interface NotebookTimerHost {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(id: number): void;
}

const DEFAULT_TIMER_HOST: NotebookTimerHost = {
	setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimeout: (id) => window.clearTimeout(id),
};

export class NotebookStore {
	private saveTimers = new Map<string, number>();
	private inFlightSaves = new Map<string, Promise<boolean>>();
	private ownedPaths = new Set<string>();

	constructor(
		private vault: Vault,
		private sessions: NotebookSessionManager,
		private onSaveError?: (path: string, error: Error) => void,
		private timers: NotebookTimerHost = DEFAULT_TIMER_HOST,
	) {}

	scheduleSave(path: string): void {
		this.ownedPaths.add(path);
		this.queueSave(path, SAVE_DEBOUNCE_MS);
	}

	async save(path: string): Promise<boolean> {
		const existing = this.inFlightSaves.get(path);
		if (existing) {
			const priorSucceeded = await existing;
			if (!priorSucceeded) return false;
			return this.sessions.get(path).lifecycle.isDirty ? this.save(path) : true;
		}

		const operation = this.performSave(path);
		this.inFlightSaves.set(path, operation);
		try {
			return await operation;
		} finally {
			if (this.inFlightSaves.get(path) === operation) this.inFlightSaves.delete(path);
		}
	}

	async flush(path: string): Promise<boolean> {
		this.clearTimer(path);
		const session = this.sessions.get(path);
		if (!session.lifecycle.isDirty) return true;
		const saved = await this.save(path);
		if (saved && !session.lifecycle.isDirty) this.clearTimer(path);
		return saved;
	}

	async flushAll(): Promise<boolean> {
		const paths = new Set<string>([
			...this.saveTimers.keys(),
			...Array.from(this.ownedPaths).filter(
				(path) => this.sessions.get(path).lifecycle.isDirty,
			),
		]);
		let allSaved = true;
		for (const path of paths) {
			if (!(await this.flush(path))) allSaved = false;
		}
		return allSaved;
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;
		const inFlight = this.inFlightSaves.get(oldPath);
		if (inFlight) await inFlight;

		const hadTimer = this.saveTimers.has(oldPath);
		this.clearTimer(oldPath);
		const wasOwned = this.ownedPaths.delete(oldPath);
		this.sessions.rename(oldPath, newPath);
		if (wasOwned || hadTimer) this.ownedPaths.add(newPath);

		if (this.sessions.get(newPath).lifecycle.isDirty || hadTimer) {
			this.queueSave(newPath, SAVE_DEBOUNCE_MS);
		}
	}

	private async performSave(path: string): Promise<boolean> {
		const session = this.sessions.get(path);
		const prepared = session.prepareSave();
		if (!prepared) return !session.lifecycle.isDirty;

		try {
			const file = this.vault.getAbstractFileByPath(path);
			if (!file || !('extension' in file)) throw new Error(`Notebook file not found: ${path}`);
			await this.vault.modify(file as TFile, prepared.text);
			session.completeSave(prepared.token, prepared.text);
			if (session.lifecycle.isDirty) this.queueSave(path, SAVE_DEBOUNCE_MS);
			return true;
		} catch (error) {
			session.failSave(prepared.token, error);
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.onSaveError?.(path, normalized);
			this.queueSave(path, RETRY_DELAY_MS);
			return false;
		}
	}

	private queueSave(path: string, delayMs: number): void {
		this.clearTimer(path);
		const id = this.timers.setTimeout(() => {
			this.saveTimers.delete(path);
			void this.save(path);
		}, delayMs);
		this.saveTimers.set(path, id);
	}

	private clearTimer(path: string): void {
		const existing = this.saveTimers.get(path);
		if (existing !== undefined) this.timers.clearTimeout(existing);
		this.saveTimers.delete(path);
	}
}
