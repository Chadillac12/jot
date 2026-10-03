import type { DataAdapter } from 'obsidian';
import {
	isSupportedVersion,
	jotPathFor,
	parseJotText,
} from './jot-file';
import type { StrokeStore } from './stroke-store';

const SAVE_DEBOUNCE_MS = 750;
const SELF_SAVE_SUPPRESS_MS = 1500;
const PLUGIN_LOG = '[jot]';

export class SidecarStore {
	private saveTimers = new Map<string, number>();
	private recentSelfSaves = new Map<string, number>();

	constructor(
		private adapter: DataAdapter,
		private strokes: StrokeStore,
	) {}

	async load(pdfPath: string): Promise<void> {
		const path = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(path))) {
				this.strokes.clearFor(pdfPath);
				return;
			}
			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed) {
				console.warn(`${PLUGIN_LOG} ${path} is invalid; keeping current annotations in memory`);
				return;
			}
			if (!isSupportedVersion(parsed.version)) {
				console.warn(
					`${PLUGIN_LOG} ${path} has unknown version ${parsed.version}; keeping current annotations in memory`,
				);
				return;
			}

			// Validate completely before mutating the live store. A malformed or
			// future sidecar must never clear annotations that are already visible.
			this.strokes.clearFor(pdfPath);
			this.strokes.populateFromPayload(pdfPath, parsed.pages);
		} catch (err) {
			console.error(`${PLUGIN_LOG} load failed for ${path}:`, err);
		}
	}

	async save(pdfPath: string): Promise<void> {
		const path = jotPathFor(pdfPath);
		const payload = this.strokes.buildPayload(pdfPath);
		try {
			if (!payload) {
				if (await this.adapter.exists(path)) {
					await this.adapter.remove(path);
				}
				return;
			}
			await this.adapter.write(path, JSON.stringify(payload, null, 2));
			this.recentSelfSaves.set(path, Date.now());
		} catch (err) {
			console.error(`${PLUGIN_LOG} save failed for ${path}:`, err);
		}
	}

	scheduleSave(pdfPath: string): void {
		const existing = this.saveTimers.get(pdfPath);
		if (existing !== undefined) window.clearTimeout(existing);
		const id = window.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, SAVE_DEBOUNCE_MS);
		this.saveTimers.set(pdfPath, id);
	}

	hasPendingSave(pdfPath: string): boolean {
		return this.saveTimers.has(pdfPath);
	}

	/**
	 * An external sidecar edit arrived while local Pencil input is still dirty.
	 * Preserve the external bytes in a conflict file before allowing the local
	 * state to win, so neither device's annotations are silently destroyed.
	 */
	async preserveExternalConflictAndFlushLocal(pdfPath: string): Promise<string | null> {
		const timer = this.saveTimers.get(pdfPath);
		if (timer === undefined) return null;

		const sidecarPath = jotPathFor(pdfPath);
		try {
			if (!(await this.adapter.exists(sidecarPath))) return null;
			const remoteText = await this.adapter.read(sidecarPath);
			const conflictPath = `${sidecarPath}.conflict-${Date.now()}.json`;
			await this.adapter.write(conflictPath, remoteText);

			window.clearTimeout(timer);
			this.saveTimers.delete(pdfPath);
			await this.save(pdfPath);
			return conflictPath;
		} catch (err) {
			console.error(`${PLUGIN_LOG} could not preserve external conflict for ${sidecarPath}:`, err);
			return null;
		}
	}

	async renamePdfPath(oldPdfPath: string, newPdfPath: string): Promise<void> {
		if (oldPdfPath === newPdfPath) return;
		const oldSidecar = jotPathFor(oldPdfPath);
		const newSidecar = jotPathFor(newPdfPath);
		const pending = this.saveTimers.get(oldPdfPath);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.saveTimers.delete(oldPdfPath);
		}

		try {
			if (await this.adapter.exists(oldSidecar)) {
				if (await this.adapter.exists(newSidecar)) {
					const destinationText = await this.adapter.read(newSidecar);
					const conflictPath = `${newSidecar}.conflict-${Date.now()}.json`;
					await this.adapter.write(conflictPath, destinationText);
					await this.adapter.remove(newSidecar);
				}
				await this.adapter.rename(oldSidecar, newSidecar);
			}
			this.recentSelfSaves.delete(oldSidecar);
		} catch (err) {
			console.error(
				`${PLUGIN_LOG} could not move sidecar from ${oldSidecar} to ${newSidecar}:`,
				err,
			);
		}

		if (pending !== undefined || this.strokes.hasFor(newPdfPath)) {
			this.scheduleSave(newPdfPath);
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
		const path = jotPathFor(pdfPath);
		try {
			if (await this.adapter.exists(path)) {
				await this.adapter.remove(path);
			}
		} catch (err) {
			console.error(`${PLUGIN_LOG} could not delete sidecar ${path}:`, err);
		}
	}

	cancelAllPending(): void {
		this.saveTimers.forEach((id) => window.clearTimeout(id));
		this.saveTimers.clear();
	}
}
