import type { DataAdapter } from 'obsidian';
import { DocumentSessionManager } from './document-session';
import { isSupportedVersion, jotPathFor, parseJotText } from './jot-file';
import { PdfInsertedPageStore } from './pdf-inserted-page-store';
import type { StrokeStore } from './stroke-store';

const SAVE_DEBOUNCE_MS = 750;
const RETRY_DELAY_MS = 1500;
const SELF_SAVE_SUPPRESS_MS = 1500;
const PLUGIN_LOG = '[jot]';

export type SidecarLoadStatus =
	| 'loaded'
	| 'missing'
	| 'protected'
	| 'dirty'
	| 'error';

export interface SidecarStoreCallbacks {
	onSaveError?: (pdfPath: string, error: unknown) => void;
	onSaveRecovered?: (pdfPath: string) => void;
}

export class SidecarStore {
	private saveTimers = new Map<string, number>();
	private retryTimers = new Map<string, number>();
	private recentSelfSaves = new Map<string, { at: number; content: string }>();
	private protectedOriginals = new Map<string, string>();
	// An unreadable existing sidecar must never be overwritten by partial in-memory ink.
	private unreadableLoads = new Set<string>();
	private saveChains = new Map<string, Promise<boolean>>();

	constructor(
		private adapter: DataAdapter,
		private strokes: StrokeStore,
		private sessions: DocumentSessionManager = new DocumentSessionManager(),
		private callbacks: SidecarStoreCallbacks = {},
		private insertedPages: PdfInsertedPageStore = new PdfInsertedPageStore(),
	) {}

	async load(pdfPath: string): Promise<SidecarLoadStatus> {
		const session = this.sessions.get(pdfPath);
		if (!session.beginLoad()) return 'dirty';

		const path = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(path))) {
				this.protectedOriginals.delete(pdfPath);
				this.unreadableLoads.delete(pdfPath);
				this.strokes.clearFor(pdfPath);
				this.insertedPages.clear(pdfPath);
				session.completeLoad();
				return 'missing';
			}

			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed || !isSupportedVersion(parsed.version)) {
				this.unreadableLoads.delete(pdfPath);
				this.protectedOriginals.set(pdfPath, text);
				session.completeLoad();
				console.warn(
					`${PLUGIN_LOG} ${path} could not be safely loaded; preserving current memory and protecting the original`,
				);
				return 'protected';
			}

			// Parse and validate fully before touching the live StrokeStore.
			this.protectedOriginals.delete(pdfPath);
			this.unreadableLoads.delete(pdfPath);
			this.strokes.clearFor(pdfPath);
			this.insertedPages.clear(pdfPath);
			this.strokes.populateFromPayload(pdfPath, parsed.pages);
			this.insertedPages.replace(pdfPath, parsed.insertedPages ?? []);
			session.completeLoad();
			return 'loaded';
		} catch (error) {
			this.unreadableLoads.add(pdfPath);
			session.failLoad(error);
			console.error(`${PLUGIN_LOG} load failed for ${path}:`, error);
			return 'error';
		}
	}

	isWriteBlocked(pdfPath: string): boolean {
		return this.unreadableLoads.has(pdfPath);
	}

	scheduleSave(pdfPath: string): void {
		this.sessions.get(pdfPath).markDirty();
		if (this.isWriteBlocked(pdfPath)) {
			this.callbacks.onSaveError?.(pdfPath, new Error('Existing annotation sidecar could not be read; writes blocked to protect the original.'));
			return;
		}
		this.clearTimer(this.saveTimers, pdfPath);
		const id = window.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, SAVE_DEBOUNCE_MS);
		this.saveTimers.set(pdfPath, id);
	}

	hasPendingSave(pdfPath: string): boolean {
		return this.saveTimers.has(pdfPath) || this.retryTimers.has(pdfPath);
	}

	hasUnsavedChanges(pdfPath: string): boolean {
		return this.sessions.get(pdfPath).isDirty;
	}

	async save(pdfPath: string): Promise<boolean> {
		const previous = this.saveChains.get(pdfPath) ?? Promise.resolve(true);
		const current = previous.then(
			() => this.performSave(pdfPath),
			() => this.performSave(pdfPath),
		);
		this.saveChains.set(pdfPath, current);
		try {
			return await current;
		} finally {
			if (this.saveChains.get(pdfPath) === current) this.saveChains.delete(pdfPath);
		}
	}

	async flush(pdfPath: string): Promise<boolean> {
		if (this.isWriteBlocked(pdfPath)) return false;
		this.clearTimer(this.saveTimers, pdfPath);
		this.clearTimer(this.retryTimers, pdfPath);
		if (!this.sessions.get(pdfPath).isDirty) return true;
		return this.save(pdfPath);
	}

	async flushAll(): Promise<boolean> {
		for (const path of [...this.saveTimers.keys()]) this.clearTimer(this.saveTimers, path);
		for (const path of [...this.retryTimers.keys()]) this.clearTimer(this.retryTimers, path);
		const dirty = this.sessions.dirtySessions().map((session) => session.path);
		const results = await Promise.all(dirty.map((path) => this.save(path)));
		return results.every(Boolean);
	}

	retry(pdfPath: string): void {
		if (!this.sessions.get(pdfPath).isDirty) return;
		this.clearTimer(this.retryTimers, pdfPath);
		void this.save(pdfPath);
	}

	async preserveExternalConflictAndFlushLocal(pdfPath: string): Promise<string | null> {
		if (!this.hasUnsavedChanges(pdfPath)) return null;
		const sidecarPath = jotPathFor(pdfPath);
		try {
			if (await this.adapter.exists(sidecarPath)) {
				const remoteText = await this.adapter.read(sidecarPath);
				const conflictPath = `${sidecarPath}.conflict-${Date.now()}.json`;
				await this.atomicWriteText(conflictPath, remoteText, false);
				this.sessions.get(pdfPath).markConflict(
					'External annotations changed while local annotations were unsaved.',
				);
				this.sessions.get(pdfPath).resolveConflictKeepLocal();
				await this.flush(pdfPath);
				return conflictPath;
			}
			await this.flush(pdfPath);
			return null;
		} catch (error) {
			this.sessions.get(pdfPath).markConflict(
				'External annotations changed and the conflict copy could not be created.',
			);
			console.error(`${PLUGIN_LOG} could not preserve external conflict for ${sidecarPath}:`, error);
			return null;
		}
	}

	async renamePdfPath(oldPdfPath: string, newPdfPath: string): Promise<boolean> {
		if (oldPdfPath === newPdfPath) return true;
		await this.flush(oldPdfPath);

		const oldSidecar = jotPathFor(oldPdfPath);
		const newSidecar = jotPathFor(newPdfPath);
		const protectedText = this.protectedOriginals.get(oldPdfPath);
		if (protectedText !== undefined) {
			this.protectedOriginals.delete(oldPdfPath);
			this.protectedOriginals.set(newPdfPath, protectedText);
		}

		// The PDF path has already changed in the vault. In-memory page layout
		// and session identity must follow even if sidecar migration later fails.
		this.insertedPages.rekeyDocumentPath(oldPdfPath, newPdfPath);
		const session = this.sessions.rename(oldPdfPath, newPdfPath);
		if (this.unreadableLoads.delete(oldPdfPath)) this.unreadableLoads.add(newPdfPath);
		let displacedDestination: string | null = null;
		let displacedConflictPath: string | null = null;

		try {
			if (await this.adapter.exists(oldSidecar)) {
				if (await this.adapter.exists(newSidecar)) {
					displacedDestination = await this.adapter.read(newSidecar);
					displacedConflictPath = `${newSidecar}.conflict-${Date.now()}.json`;
					await this.atomicWriteText(displacedConflictPath, displacedDestination, false);
					await this.adapter.remove(newSidecar);
				}
				await this.adapter.rename(oldSidecar, newSidecar);
			}
			this.recentSelfSaves.delete(oldSidecar);
			return true;
		} catch (error) {
			// Restore any displaced destination if the actual migration failed.
			if (
				displacedDestination !== null &&
				!(await this.adapter.exists(newSidecar))
			) {
				try {
					await this.atomicWriteText(newSidecar, displacedDestination, false);
				} catch (restoreError) {
					console.error(
						`${PLUGIN_LOG} could not restore displaced destination sidecar ${newSidecar}:`,
						restoreError,
					);
				}
			}
			if (displacedConflictPath) {
				console.warn(
					`${PLUGIN_LOG} preserved destination sidecar at ${displacedConflictPath}`,
				);
			}

			// The document itself has moved, so keep the new session dirty and
			// retry writing a correct sidecar at the new path. The old sidecar is
			// left in place as recovery evidence if its rename failed.
			session.markDirty();
			session.failSave(error);
			this.callbacks.onSaveError?.(newPdfPath, error);
			this.scheduleRetry(newPdfPath);
			console.error(
				`${PLUGIN_LOG} could not move sidecar from ${oldSidecar} to ${newSidecar}:`,
				error,
			);
			return false;
		}
	}

	async isOwnRecentSave(path: string): Promise<boolean> {
		const marker = this.recentSelfSaves.get(path);
		if (!marker) return false;
		if (Date.now() - marker.at >= SELF_SAVE_SUPPRESS_MS) {
			this.recentSelfSaves.delete(path);
			return false;
		}
		try {
			// Multiple watcher events from one atomic commit may be duplicates.
			// A real external edit with different bytes must never be ignored.
			return (await this.adapter.read(path)) === marker.content;
		} catch {
			return false;
		}
	}

	/** @deprecated Use flushAll(); retained while older callers migrate. */
	async cancelAllPending(): Promise<boolean> {
		return this.flushAll();
	}

	async discard(pdfPath: string): Promise<boolean> {
		const path = jotPathFor(pdfPath);
		this.clearTimer(this.saveTimers, pdfPath);
		this.clearTimer(this.retryTimers, pdfPath);
		if (this.isWriteBlocked(pdfPath)) return false;
		this.protectedOriginals.delete(pdfPath);
		try {
			if (await this.adapter.exists(path)) await this.transactionalDelete(path);
			this.insertedPages.clear(pdfPath);
			this.sessions.drop(pdfPath);
			return true;
		} catch (error) {
			this.sessions.get(pdfPath).failSave(error);
			this.callbacks.onSaveError?.(pdfPath, error);
			console.error(`${PLUGIN_LOG} could not delete sidecar ${path}:`, error);
			return false;
		}
	}

	private async performSave(pdfPath: string): Promise<boolean> {
		if (this.isWriteBlocked(pdfPath)) return false;
		const session = this.sessions.get(pdfPath);
		const wasError = session.state === 'error';
		const saveRevision = session.beginSave();
		if (saveRevision === null) return true;

		const path = jotPathFor(pdfPath);
		const payload = this.strokes.buildPayload(pdfPath, this.insertedPages.all(pdfPath));
		try {
			const protectedText = this.protectedOriginals.get(pdfPath);
			if (protectedText !== undefined) {
				const recoveryPath = `${path}.recovery-${Date.now()}.json`;
				await this.atomicWriteText(recoveryPath, protectedText, false);
			}
			if (!payload) {
				if (await this.adapter.exists(path)) await this.transactionalDelete(path);
				this.protectedOriginals.delete(pdfPath);
			} else {
				const text = JSON.stringify(payload, null, 2);
				await this.atomicWriteText(path, text, true);
				this.protectedOriginals.delete(pdfPath);
				this.recentSelfSaves.set(path, { at: Date.now(), content: text });
			}

			session.completeSave(saveRevision);
			if (wasError) this.callbacks.onSaveRecovered?.(pdfPath);
			if (session.isDirty) this.scheduleRetry(pdfPath);
			return true;
		} catch (error) {
			session.failSave(error);
			this.callbacks.onSaveError?.(pdfPath, error);
			this.scheduleRetry(pdfPath);
			console.error(`${PLUGIN_LOG} save failed for ${path}:`, error);
			return false;
		}
	}

	private scheduleRetry(pdfPath: string): void {
		if (!this.sessions.get(pdfPath).isDirty || this.retryTimers.has(pdfPath)) return;
		const id = window.setTimeout(() => {
			this.retryTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, RETRY_DELAY_MS);
		this.retryTimers.set(pdfPath, id);
	}

	private async atomicWriteText(path: string, text: string, validateSidecar: boolean): Promise<void> {
		const tmpPath = `${path}.jot-tmp`;
		const backupPath = `${path}.jot-backup`;
		await this.recoverStaleBackup(path, backupPath);
		await this.safeRemove(tmpPath);
		await this.adapter.write(tmpPath, text);

		const verifyTmp = await this.adapter.read(tmpPath);
		if (verifyTmp !== text) throw new Error(`Verification failed for temporary file ${tmpPath}`);
		if (validateSidecar) {
			const parsed = parseJotText(verifyTmp);
			if (!parsed || !isSupportedVersion(parsed.version)) {
				throw new Error(`Temporary sidecar validation failed for ${path}`);
			}
		}

		const hadOriginal = await this.adapter.exists(path);
		if (hadOriginal) await this.adapter.rename(path, backupPath);
		try {
			await this.adapter.rename(tmpPath, path);
			const verifyFinal = await this.adapter.read(path);
			if (verifyFinal !== text) throw new Error(`Final verification failed for ${path}`);
			if (hadOriginal) await this.safeRemove(backupPath);
		} catch (error) {
			await this.safeRemove(path);
			if (hadOriginal && (await this.adapter.exists(backupPath))) {
				await this.adapter.rename(backupPath, path);
			}
			throw error;
		}
	}

	private async recoverStaleBackup(path: string, backupPath: string): Promise<void> {
		if (!(await this.adapter.exists(backupPath))) return;
		if (!(await this.adapter.exists(path))) {
			await this.adapter.rename(backupPath, path);
			return;
		}
		const recoveryPath = `${path}.recovery-${Date.now()}.json`;
		await this.adapter.rename(backupPath, recoveryPath);
	}

	private async transactionalDelete(path: string): Promise<void> {
		const backupPath = `${path}.jot-delete-backup`;
		await this.safeRemove(backupPath);
		await this.adapter.rename(path, backupPath);
		try {
			await this.adapter.remove(backupPath);
		} catch (error) {
			if (!(await this.adapter.exists(path)) && (await this.adapter.exists(backupPath))) {
				await this.adapter.rename(backupPath, path);
			}
			throw error;
		}
	}

	private async safeRemove(path: string): Promise<void> {
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
	}

	private clearTimer(map: Map<string, number>, path: string): void {
		const id = map.get(path);
		if (id !== undefined) window.clearTimeout(id);
		map.delete(path);
	}
}
