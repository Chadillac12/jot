import { App, DataAdapter, Notice } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { PdfTransactionWriter } from './pdf-transaction';
import { ExportChoiceModal, drawStrokesOnPdfPage } from './merge';
import type { SidecarStore } from './sidecar-store';
import type { StrokeStore } from './stroke-store';
import type { UndoHistory } from './undo';

const PLUGIN_LOG = '[jot]';

type MergeChoice = 'overwrite' | 'copy';

export interface MergeServiceCallbacks {
	prepareForMerge: (pdfPath: string) => Promise<boolean>;
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
		if (!(await this.callbacks.prepareForMerge(pdfPath))) {
			new Notice('Jot: merge blocked because annotations could not be safely synchronized.');
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
			if (!(await this.sidecar.flush(pdfPath))) {
				throw new Error('annotations could not be flushed before merge');
			}
			const outPath = await this.writeMerged(pdfPath, choice, copyTarget);
			if (choice === 'overwrite') {
				const discarded = await this.discardAnnotations(pdfPath);
				if (!discarded) {
					new Notice(
						`Jot: PDF was merged and verified, but the annotation sidecar could not be removed. It was left intact to avoid data loss: ${outPath}`,
						10000,
					);
					return;
				}
			}
			new Notice(`Jot: notes merged into ${outPath}`);
		} catch (error) {
			console.error(`${PLUGIN_LOG} merge failed:`, error);
			new Notice(
				`Jot: merge failed — ${error instanceof Error ? error.message : 'see console'}`,
				8000,
			);
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
		const expectedPages = pages.length;

		const writer = new PdfTransactionWriter(this.adapter);
		if (choice === 'copy') {
			await writer.writeCopy(copyTarget, buffer, expectedPages);
			return copyTarget;
		}

		await writer.replaceOriginal(pdfPath, buffer, expectedPages);
		return pdfPath;
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

	private async discardAnnotations(pdfPath: string): Promise<boolean> {
		if (!(await this.sidecar.discard(pdfPath))) return false;
		this.strokes.clearFor(pdfPath);
		this.history.dropPath(pdfPath);
		this.callbacks.redrawOverlays();
		return true;
	}

}
