import { Notice, type App, type DataAdapter } from 'obsidian';
import { ExportChoiceModal } from './export-choice-modal';
import {
	PdfMergeExecutor,
	type MergeChoice,
} from './pdf-merge-executor';
import type { SidecarLoadStatus, SidecarStore } from './sidecar-store';
import type { StrokeStore } from './stroke-store';
import type { UndoHistory } from './undo';

const PLUGIN_LOG = '[jot]';

export interface MergeServiceCallbacks {
	ensureLoaded: (pdfPath: string) => Promise<SidecarLoadStatus>;
	redrawOverlays: () => void;
}

export class MergeService {
	private executor: PdfMergeExecutor;

	constructor(
		private app: App,
		adapter: DataAdapter,
		private strokes: StrokeStore,
		private sidecar: SidecarStore,
		history: UndoHistory,
		private callbacks: MergeServiceCallbacks,
	) {
		this.executor = new PdfMergeExecutor(
			adapter,
			strokes,
			sidecar,
			history,
			() => callbacks.redrawOverlays(),
		);
	}

	async start(pdfPath: string): Promise<void> {
		try {
			if (this.sidecar.getSession(pdfPath).isDirty) {
				await this.sidecar.flush(pdfPath);
			}
			const status = await this.callbacks.ensureLoaded(pdfPath);
			const session = this.sidecar.getSession(pdfPath);
			if (status === 'protected' || status === 'error' || session.state === 'conflict') {
				new Notice(
					'Jot: merge is blocked because the annotation sidecar is unresolved. Resolve or recover the sidecar before a destructive PDF operation.',
					8000,
				);
				return;
			}
			if (!this.strokes.hasFor(pdfPath)) {
				new Notice('Jot: no notes on this PDF to merge.');
				return;
			}
			const copyTarget = await this.executor.uniqueAnnotatedPath(pdfPath);
			new ExportChoiceModal(this.app, copyTarget, (choice) => {
				if (choice === 'cancel') return;
				void this.run(pdfPath, choice, copyTarget);
			}).open();
		} catch (error) {
			console.error(`${PLUGIN_LOG} merge preparation failed:`, error);
			new Notice(
				`Jot: merge could not start — ${error instanceof Error ? error.message : 'see console'}`,
			);
		}
	}

	async execute(
		pdfPath: string,
		choice: MergeChoice,
		copyTarget: string,
	): Promise<string> {
		const result = await this.executor.execute(pdfPath, choice, copyTarget);
		if (result.transaction.backupPath) {
			new Notice(
				`Jot: PDF committed successfully, but a verified backup remains at ${result.transaction.backupPath} because cleanup failed.`,
				8000,
			);
		}
		return result.outPath;
	}

	private async run(pdfPath: string, choice: MergeChoice, copyTarget: string): Promise<void> {
		try {
			const outPath = await this.execute(pdfPath, choice, copyTarget);
			new Notice(`Jot: notes merged into ${outPath}`);
		} catch (err) {
			console.error(`${PLUGIN_LOG} merge failed:`, err);
			new Notice(`Jot: merge failed — ${err instanceof Error ? err.message : 'see console'}`);
		}
	}
}
