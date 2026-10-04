import type { DataAdapter } from 'obsidian';
import { DocumentSessionManager } from './document-session';
import {
	JOT_FORMAT_VERSION,
	isSupportedVersion,
	jotPathFor,
	parseJotText,
} from './jot-file';
import type { StrokeStore } from './stroke-store';
import { transactionalWriteText } from './transactional-write';

const SAVE_DEBOUNCE_MS = 750;
const RETRY_DELAY_MS = 2000;
const SELF_SAVE_SUPPRESS_MS = 1500;
const PLUGIN_LOG = '[jot]';

export type SidecarLoadStatus =
	| 'loaded'
	| 'missing'
	| 'protected'
	| 'dirty'
	| 'error';

export interface TimerHost {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(id: number): void;
}

const DEFAULT_TIMER_HOST: TimerHost = {
	setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimeout: (id) => window.clearTimeout(id),
};

export class SidecarStore {
	private saveTimers = new Map<string, number>();
	private recentSelfSaves = new Map<string, number>();
	private protectedOriginals = new Map<string, string>();
	private ownedPdfPaths = new Set<string>();

	constructor(
		private adapter: DataAdapter,
		private strokes: StrokeStore,
		private sessions: DocumentSessionManager = new DocumentSessionManager(),
		private onSaveError?: (pdfPath: string, error: Error) => void,
		private timers: TimerHost = DEFAULT_TIMER_HOST,
	) {}

	async load(pdfPath: string): Promise<SidecarLoadStatus> {
		this.ownedPdfPaths.add(pdfPath);
		const session = this.sessions.get(pdfPath);
		if (!session.beginLoad()) return 'dirty';

		const path = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(path))) {
				this.protectedOriginals.delete(pdfPath);
				this.strokes.clearFor(pdfPath);
				session.completeLoad();
				return 'missing';
			}

			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed) {
				this.protectedOriginals.set(pdfPath, text);
				const error = new Error(`${path} is invalid`);
				session.failLoad(error);
				console.warn(`${PLUGIN_LOG} ${error.message}; keeping current annotations in memory`);
				return 'protected';
			}
			if (!isSupportedVersion(parsed.version)) {
				this.protectedOriginals.set(pdfPath, text);
				const error = new Error(`${path} has unknown version ${parsed.version}`);
				session.failLoad(error);
				console.warn(`${PLUGIN_LOG} ${error.message}; keeping current annotations in memory`);
				return 'protected';
			}

			this.protectedOriginals.delete(pdfPath);
			this.strokes.clearFor(pdfPath);
			this.strokes.populateFromPayload(pdfPath, parsed.pages);
			session.completeLoad();
			return 'loaded';
		} catch (error) {
			session.failLoad(error);
			console.error(`${PLUGIN_LOG} load failed for ${path}:`, error);
			return 'error';
		}
	}

	async save(pdfPath: string): Promise<boolean> {
		const session = this.sessions.get(pdfPath);
		const token = session.beginSave();
		if (!token) return !session.isDirty;

		const path = jotPathFor(pdfPath);
		const payload = this.strokes.buildPayload(pdfPath) ?? {
			version: JOT_FORMAT_VERSION,
			pages: {},
		};
		const text = JSON.stringify(payload, null, 2);

		try {
			const protectedText = this.protectedOriginals.get(pdfPath);
			if (protectedText !== undefined) {
				const recoveryPath = `${path}.recovery-${Date.now()}.json`;
				await transactionalWriteText(this.adapter, recoveryPath, protectedText);
			}

			await transactionalWriteText(
				this.adapter,
				path,
				text,
				(candidate) => {
					const parsed = parseJotText(candidate);
					return parsed !== null && isSupportedVersion(parsed.version);
				},
			);
			this.protectedOriginals.delete(pdfPath);
			this.recentSelfSaves.set(path, Date.now());
			session.completeSave(token);

			// A new edit may have arrived while the previous revision was in flight.
			if (session.isDirty) this.queueSave(pdfPath, SAVE_DEBOUNCE_MS);
			return true;
		} catch (error) {
			session.failSave(token, error);
			const normalized = error instanceof Error ? error : new Error(String(error));
			console.error(`${PLUGIN_LOG} save failed for ${path}:`, normalized);
			this.onSaveError?.(pdfPath, normalized);
			this.queueSave(pdfPath, RETRY_DELAY_MS);
			return false;
		}
	}

	scheduleSave(pdfPath: string): void {
		this.ownedPdfPaths.add(pdfPath);
		this.sessions.get(pdfPath).markDirty();
		this.queueSave(pdfPath, SAVE_DEBOUNCE_MS);
	}

	async flush(pdfPath: string): Promise<boolean> {
		this.clearTimer(pdfPath);
		const session = this.sessions.get(pdfPath);
		if (!session.isDirty) return true;
		return this.save(pdfPath);
	}

	async flushAll(): Promise<boolean> {
		const paths = new Set<string>([
			...this.saveTimers.keys(),
			...Array.from(this.ownedPdfPaths).filter(
				(path) => this.sessions.peek(path)?.isDirty === true,
			),
		]);
		let allSaved = true;
		for (const path of paths) {
			if (!(await this.flush(path))) allSaved = false;
		}
		return allSaved;
	}

	hasPendingSave(pdfPath: string): boolean {
		return this.sessions.get(pdfPath).isDirty || this.saveTimers.has(pdfPath);
	}

	async preserveExternalConflictAndFlushLocal(pdfPath: string): Promise<string | null> {
		const session = this.sessions.get(pdfPath);
		if (!session.isDirty) return null;

		const sidecarPath = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(sidecarPath))) return null;
			const remoteText = await this.adapter.read(sidecarPath);
			const conflictPath = `${sidecarPath}.conflict-${Date.now()}.json`;
			await transactionalWriteText(this.adapter, conflictPath, remoteText);
			session.markConflict();
			session.resolveConflictKeepLocal();
			await this.flush(pdfPath);
			return conflictPath;
		} catch (error) {
			session.markConflict(error);
			console.error(
				`${PLUGIN_LOG} could not preserve external conflict for ${sidecarPath}:`,
				error,
			);
			return null;
		}
	}

	async renamePdfPath(oldPdfPath: string, newPdfPath: string): Promise<void> {
		if (oldPdfPath === newPdfPath) return;
		const oldSidecar = jotPathFor(oldPdfPath);
		const newSidecar = jotPathFor(newPdfPath);
		const protectedText = this.protectedOriginals.get(oldPdfPath);
		if (protectedText !== undefined) {
			this.protectedOriginals.delete(oldPdfPath);
			this.protectedOriginals.set(newPdfPath, protectedText);
		}

		const hadPending = this.hasPendingSave(oldPdfPath);
		this.clearTimer(oldPdfPath);
		this.ownedPdfPaths.delete(oldPdfPath);
		this.ownedPdfPaths.add(newPdfPath);
		this.sessions.rename(oldPdfPath, newPdfPath);

		try {
			if (await this.adapter.exists(oldSidecar)) {
				const sourceText = await this.adapter.read(oldSidecar);
				if (await this.adapter.exists(newSidecar)) {
					const destinationText = await this.adapter.read(newSidecar);
					const conflictPath = `${newSidecar}.conflict-${Date.now()}.json`;
					await transactionalWriteText(this.adapter, conflictPath, destinationText);
				}
				await transactionalWriteText(this.adapter, newSidecar, sourceText);
				await this.adapter.remove(oldSidecar);
			}
			this.recentSelfSaves.delete(oldSidecar);
		} catch (error) {
			console.error(
				`${PLUGIN_LOG} could not move sidecar from ${oldSidecar} to ${newSidecar}:`,
				error,
			);
			this.onSaveError?.(
				newPdfPath,
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (hadPending || this.strokes.hasFor(newPdfPath)) {
			if (!this.sessions.get(newPdfPath).isDirty) this.sessions.get(newPdfPath).markDirty();
			this.queueSave(newPdfPath, SAVE_DEBOUNCE_MS);
		}
	}

	isOwnRecentSave(path: string): boolean {
		const writtenAt = this.recentSelfSaves.get(path);
		if (writtenAt === undefined) return false;
		if (Date.now() - writtenAt >= SELF_SAVE_SUPPRESS_MS) return false;
		this.recentSelfSaves.delete(path);
		return true;
	}

	async discard(pdfPath: string): Promise<void> {
		if (!(await this.flush(pdfPath))) {
			throw new Error(`Cannot discard ${pdfPath} annotations because dirty data failed to save`);
		}
		const path = jotPathFor(pdfPath);
		this.protectedOriginals.delete(pdfPath);
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
		this.ownedPdfPaths.delete(pdfPath);
		this.sessions.remove(pdfPath);
	}

	private queueSave(pdfPath: string, delayMs: number): void {
		this.clearTimer(pdfPath);
		const id = this.timers.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, delayMs);
		this.saveTimers.set(pdfPath, id);
	}

	private clearTimer(pdfPath: string): void {
		const existing = this.saveTimers.get(pdfPath);
		if (existing !== undefined) this.timers.clearTimeout(existing);
		this.saveTimers.delete(pdfPath);
	}
}
