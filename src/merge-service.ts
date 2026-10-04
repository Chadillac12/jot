import { App, DataAdapter, Notice } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { ExportChoiceModal, drawStrokesOnPdfPage } from './merge';
import type { SidecarLoadStatus, SidecarStore } from './sidecar-store';
import { transactionalWriteBinary } from './transactional-write';
import type { StrokeStore } from './stroke-store';
import type { UndoHistory } from './undo';

const PLUGIN_LOG = '[jot]';

type MergeChoice = 'overwrite' | 'copy';

export interface MergeServiceCallbacks {
	ensureLoaded: (pdfPath: string) => Promise<SidecarLoadStatus>;
	redrawOverlays: () => void;
}

export class MergeService {
	constructor(
		private app: App,
		private adapter: DataAdapter,
		private strokes: StrokeStore,
		private sidecar: SidecarStore,
		private history: UndoHistory,
		private callbacks: MergeServiceCallbacks,
	) {}

	async start(pdfPath: string): Promise<void> {
		if (!(await this.sidecar.flush(pdfPath))) {
			new Notice('Jot: annotations are not safely saved yet. Merge was blocked; Jot will retry saving first.');
			return;
		}
		const loadStatus = await this.callbacks.ensureLoaded(pdfPath);
		if (loadStatus === 'protected' || loadStatus === 'error' || loadStatus === 'dirty') {
			new Notice('Jot: merge was blocked because the annotation source is not in a verified clean state.');
			return;
		}
		if (!this.strokes.hasFor(pdfPath)) {
			new Notice('Jot: no notes on this PDF to merge.');
			return;
		}
		const copyTarget = await this.uniqueAnnotatedPath(pdfPath);
		new ExportChoiceModal(this.app, copyTarget, (choice) => {
			if (choice === 'cancel') return;
			void this.run(pdfPath, choice, copyTarget);
		}).open();
	}

	private async run(pdfPath: string, choice: MergeChoice, copyTarget: string): Promise<void> {
		try {
			const outPath = await this.writeMerged(pdfPath, choice, copyTarget);
			if (choice === 'overwrite') await this.discardAnnotations(pdfPath);
			new Notice(`Jot: notes merged into ${outPath}`);
		} catch (err) {
			console.error(`${PLUGIN_LOG} merge failed:`, err);
			new Notice(`Jot: merge failed — ${err instanceof Error ? err.message : 'see console'}`);
		}
	}

	private async writeMerged(
		pdfPath: string,
		choice: MergeChoice,
		copyTarget: string,
	): Promise<string> {
		const bytes = await this.adapter.readBinary(pdfPath);
		const pdfDoc = await PDFDocument.load(bytes);
		const pages = pdfDoc.getPages();
		for (let i = 0; i < pages.length; i++) {
			const page = pages[i];
			if (!page) continue;
			const strokes = this.strokes.forPage(pdfPath, i + 1);
			if (strokes.length === 0) continue;
			drawStrokesOnPdfPage(page, strokes);
		}
		const out = await pdfDoc.save();
		const buffer = new ArrayBuffer(out.byteLength);
		new Uint8Array(buffer).set(out);
		const outPath = choice === 'overwrite' ? pdfPath : copyTarget;
		const expectedPages = pages.length;
		await transactionalWriteBinary(this.adapter, outPath, buffer, async (candidate) => {
			const verified = await PDFDocument.load(candidate);
			if (verified.getPageCount() !== expectedPages) {
				throw new Error(
					`Merged PDF verification failed: expected ${expectedPages} pages, found ${verified.getPageCount()}`,
				);
			}
		});
		return outPath;
	}

	private async uniqueAnnotatedPath(pdfPath: string): Promise<string> {
		const base = pdfPath.replace(/\.pdf$/i, '.annotated');
		let candidate = `${base}.pdf`;
		let n = 2;
		while (await this.adapter.exists(candidate)) {
			candidate = `${base}.${n}.pdf`;
			n++;
		}
		return candidate;
	}

	private async discardAnnotations(pdfPath: string): Promise<void> {
		await this.sidecar.discard(pdfPath);
		this.strokes.clearFor(pdfPath);
		this.history.dropPath(pdfPath);
		this.callbacks.redrawOverlays();
	}
}
