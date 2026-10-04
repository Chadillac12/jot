import type { DataAdapter } from 'obsidian';
import { type DocumentSession, DocumentSessionManager } from './document-session';
import {
	JOT_FORMAT_VERSION,
	isSupportedVersion,
	jotPathFor,
	parseJotText,
} from './jot-file';
import { transactionalWriteText } from './transactional-write';

const SAVE_DEBOUNCE_MS = 750;
const RETRY_BASE_MS = 2000;
const MAX_AUTO_RETRIES = 3;
const SELF_SAVE_SUPPRESS_MS = 1500;
const PLUGIN_LOG = '[jot]';

export type SidecarLoadStatus =
	| 'loaded'
	| 'missing'
	| 'protected'
	| 'error'
	| 'skipped-dirty';

export interface SidecarStoreCallbacks {
	onSaveError?: (pdfPath: string, error: Error, retryCount: number) => void;
	onSaveRecovered?: (pdfPath: string) => void;
}

export class SidecarStore {
	private saveTimers = new Map<string, number>();
	private retryTimers = new Map<string, number>();
	private retryCounts = new Map<string, number>();
	private recentSelfSaves = new Map<string, number>();
	private protectedOriginals = new Map<string, string>();
	private inFlight = new Map<string, Promise<void>>();

	constructor(
		private adapter: DataAdapter,
		private sessions: DocumentSessionManager,
		private callbacks: SidecarStoreCallbacks = {},
	) {}

	async load(pdfPath: string): Promise<SidecarLoadStatus> {
		const session = this.sessions.pdf(pdfPath);
		if (!session.beginLoad()) return 'skipped-dirty';

		const path = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(path))) {
				this.protectedOriginals.delete(pdfPath);
				this.sessions.strokes.clearFor(pdfPath);
				this.sessions.history.dropPath(pdfPath);
				session.completeLoad();
				return 'missing';
			}

			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed || !isSupportedVersion(parsed.version)) {
				this.protectedOriginals.set(pdfPath, text);
				session.markConflict(
					parsed
						? `Unsupported sidecar version ${parsed.version}`
						: 'Invalid annotation sidecar',
				);
				return 'protected';
			}

			this.protectedOriginals.delete(pdfPath);
			this.sessions.strokes.clearFor(pdfPath);
			this.sessions.history.dropPath(pdfPath);
			this.sessions.strokes.populateFromPayload(pdfPath, parsed.pages);
			session.completeLoad();
			return 'loaded';
		} catch (error) {
			session.loadFailed(error);
			console.error(`${PLUGIN_LOG} load failed for ${path}:`, error);
			return 'error';
		}
	}

	scheduleSave(pdfPath: string): void {
		const session = this.sessions.pdf(pdfPath);
		session.markDirty();
		this.clearTimer(this.saveTimers, pdfPath);
		this.clearTimer(this.retryTimers, pdfPath);
		this.retryCounts.delete(pdfPath);
		const win = activeWindowForTimers();
		const id = win.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.saveWithRetry(pdfPath);
		}, SAVE_DEBOUNCE_MS);
		this.saveTimers.set(pdfPath, id);
	}

	async flush(pdfPath: string): Promise<void> {
		this.clearTimer(this.saveTimers, pdfPath);
		this.clearTimer(this.retryTimers, pdfPath);
		await this.save(pdfPath);
	}

	async flushAll(): Promise<Array<{ path: string; error: Error }>> {
		const failures: Array<{ path: string; error: Error }> = [];
		for (const session of this.sessions.all()) {
			if (session.kind !== 'pdf' || !session.isDirty) continue;
			try {
				await this.flush(session.path);
			} catch (error) {
				failures.push({ path: session.path, error: asError(error) });
			}
		}
		return failures;
	}

	hasPendingSave(pdfPath: string): boolean {
		const session = this.sessions.get(pdfPath);
		return (
			this.saveTimers.has(pdfPath) ||
			this.retryTimers.has(pdfPath) ||
			(session?.kind === 'pdf' && session.isDirty) ||
			false
		);
	}

	async preserveExternalConflictAndFlushLocal(pdfPath: string): Promise<string | null> {
		const session = this.sessions.pdf(pdfPath);
		const sidecarPath = jotPathFor(pdfPath);
		try {
			let conflictPath: string | null = null;
			if (await this.adapter.exists(sidecarPath)) {
				const remoteText = await this.adapter.read(sidecarPath);
				conflictPath = await this.writeConflictCopy(sidecarPath, remoteText);
			}
			session.markConflict('External annotation update arrived while local edits were unsaved.');
			await this.flush(pdfPath);
			return conflictPath;
		} catch (error) {
			session.saveFailed(error);
			console.error(
				`${PLUGIN_LOG} could not preserve external conflict for ${sidecarPath}:`,
				error,
			);
			return null;
		}
	}

	async renamePdfPath(oldPdfPath: string, newPdfPath: string): Promise<void> {
		if (oldPdfPath === newPdfPath) return;
		if (this.sessions.get(newPdfPath)) {
			throw new Error(`Cannot rename Jot session: destination already open: ${newPdfPath}`);
		}

		const oldSession = this.sessions.pdf(oldPdfPath);
		if (oldSession.isDirty) await this.flush(oldPdfPath);

		const oldSidecar = jotPathFor(oldPdfPath);
		const newSidecar = jotPathFor(newPdfPath);
		const protectedText = this.protectedOriginals.get(oldPdfPath);

		if (await this.adapter.exists(oldSidecar)) {
			const sourceText = await this.adapter.read(oldSidecar);
			if (await this.adapter.exists(newSidecar)) {
				const destinationText = await this.adapter.read(newSidecar);
				await this.writeConflictCopy(newSidecar, destinationText);
			}
			const sourceIsProtected =
				protectedText !== undefined && sourceText === protectedText;
			await transactionalWriteText(
				this.adapter,
				newSidecar,
				sourceText,
				sourceIsProtected ? () => {} : validateSidecarText,
			);
			try {
				await this.adapter.remove(oldSidecar);
			} catch (error) {
				console.warn(`${PLUGIN_LOG} renamed sidecar committed but old copy remains:`, error);
			}
		}

		this.clearTimer(this.saveTimers, oldPdfPath);
		this.clearTimer(this.retryTimers, oldPdfPath);
		this.retryCounts.delete(oldPdfPath);
		this.recentSelfSaves.delete(oldSidecar);
		this.sessions.rename(oldPdfPath, newPdfPath);

		if (protectedText !== undefined) {
			this.protectedOriginals.delete(oldPdfPath);
			this.protectedOriginals.set(newPdfPath, protectedText);
		}
	}

	isOwnRecentSave(path: string): boolean {
		const writtenAt = this.recentSelfSaves.get(path);
		if (writtenAt === undefined) return false;
		if (Date.now() - writtenAt >= SELF_SAVE_SUPPRESS_MS) {
			this.recentSelfSaves.delete(path);
			return false;
		}
		this.recentSelfSaves.delete(path);
		return true;
	}

	async discard(pdfPath: string): Promise<void> {
		const session = this.sessions.pdf(pdfPath);
		if (session.isDirty) await this.flush(pdfPath);
		const path = jotPathFor(pdfPath);
		this.protectedOriginals.delete(pdfPath);
		if (!(await this.adapter.exists(path))) return;

		const backupPath = `${path}.discard-backup-${Date.now()}.json`;
		const original = await this.adapter.read(path);
		await this.adapter.write(backupPath, original);
		if ((await this.adapter.read(backupPath)) !== original) {
			throw new Error(`Could not verify annotation backup before deleting ${path}`);
		}
		await this.adapter.remove(path);
		try {
			await this.adapter.remove(backupPath);
		} catch {
			// A verified stale backup is harmless.
		}
	}

	getSession(pdfPath: string): DocumentSession {
		return this.sessions.pdf(pdfPath);
	}

	private async save(pdfPath: string): Promise<void> {
		const existing = this.inFlight.get(pdfPath);
		if (existing) {
			await existing;
			if (this.sessions.pdf(pdfPath).isDirty) await this.save(pdfPath);
			return;
		}

		const task = this.runSaveLoop(pdfPath);
		this.inFlight.set(pdfPath, task);
		try {
			await task;
		} finally {
			if (this.inFlight.get(pdfPath) === task) this.inFlight.delete(pdfPath);
		}
	}

	private async runSaveLoop(pdfPath: string): Promise<void> {
		const session = this.sessions.pdf(pdfPath);
		while (session.isDirty) {
			const previousState = session.state;
			const revision = session.beginSave();
			if (revision === null) {
				if (session.state === 'saving') return;
				break;
			}

			const path = jotPathFor(pdfPath);
			try {
				const protectedText = this.protectedOriginals.get(pdfPath);
				if (protectedText !== undefined) {
					await this.writeRecoveryCopy(path, protectedText);
				}

				const payload =
					this.sessions.strokes.buildPayload(pdfPath) ??
					{ version: JOT_FORMAT_VERSION, pages: {} };
				const text = JSON.stringify(payload, null, 2);
				await transactionalWriteText(this.adapter, path, text, validateSidecarText);
				this.recentSelfSaves.set(path, Date.now());
				this.protectedOriginals.delete(pdfPath);
				session.saveSucceeded(revision);
				if (previousState === 'save-error') this.callbacks.onSaveRecovered?.(pdfPath);
				this.retryCounts.delete(pdfPath);
			} catch (error) {
				session.saveFailed(error);
				throw error;
			}
		}
	}

	private async saveWithRetry(pdfPath: string): Promise<void> {
		try {
			await this.save(pdfPath);
		} catch (error) {
			const nextRetry = (this.retryCounts.get(pdfPath) ?? 0) + 1;
			this.retryCounts.set(pdfPath, nextRetry);
			const typed = asError(error);
			this.callbacks.onSaveError?.(pdfPath, typed, nextRetry);
			if (nextRetry > MAX_AUTO_RETRIES) return;

			const win = activeWindowForTimers();
			const id = win.setTimeout(() => {
				this.retryTimers.delete(pdfPath);
				void this.saveWithRetry(pdfPath);
			}, RETRY_BASE_MS * nextRetry);
			this.retryTimers.set(pdfPath, id);
		}
	}

	private async writeRecoveryCopy(sidecarPath: string, text: string): Promise<string> {
		const recoveryPath = `${sidecarPath}.recovery-${Date.now()}.json`;
		await this.adapter.write(recoveryPath, text);
		if ((await this.adapter.read(recoveryPath)) !== text) {
			throw new Error(`Recovery copy verification failed for ${sidecarPath}`);
		}
		return recoveryPath;
	}

	private async writeConflictCopy(sidecarPath: string, text: string): Promise<string> {
		const conflictPath = `${sidecarPath}.conflict-${Date.now()}.json`;
		await this.adapter.write(conflictPath, text);
		if ((await this.adapter.read(conflictPath)) !== text) {
			throw new Error(`Conflict copy verification failed for ${sidecarPath}`);
		}
		return conflictPath;
	}

	private clearTimer(timers: Map<string, number>, path: string): void {
		const id = timers.get(path);
		if (id === undefined) return;
		activeWindowForTimers().clearTimeout(id);
		timers.delete(path);
	}
}

function validateSidecarText(text: string): void {
	const parsed = parseJotText(text);
	if (!parsed || !isSupportedVersion(parsed.version)) {
		throw new Error('Sidecar transaction validation failed');
	}
}

function activeWindowForTimers(): Window {
	return window;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
