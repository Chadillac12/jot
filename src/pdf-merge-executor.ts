import type { DataAdapter } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { drawStrokesOnPdfPage } from './merge';
import type { SidecarStore } from './sidecar-store';
import type { StrokeStore } from './stroke-store';
import { transactionalWriteBinary, type TransactionResult } from './transactional-write';
import type { UndoHistory } from './undo';

export type MergeChoice = 'overwrite' | 'copy';

export interface PdfMergeResult {
	outPath: string;
	transaction: TransactionResult;
}

export class PdfMergeExecutor {
	constructor(
		private adapter: DataAdapter,
		private strokes: StrokeStore,
		private sidecar: SidecarStore,
		private history: UndoHistory,
		private redrawOverlays: () => void,
	) {}

	async execute(
		pdfPath: string,
		choice: MergeChoice,
		copyTarget: string,
	): Promise<PdfMergeResult> {
		await this.sidecar.flush(pdfPath);
		const result = await this.writeMerged(pdfPath, choice, copyTarget);
		if (choice === 'overwrite') await this.discardAnnotations(pdfPath);
		return result;
	}

	async uniqueAnnotatedPath(pdfPath: string): Promise<string> {
		const base = pdfPath.replace(/\.pdf$/i, '.annotated');
		let candidate = `${base}.pdf`;
		let n = 2;
		while (await this.adapter.exists(candidate)) {
			candidate = `${base}.${n}.pdf`;
			n++;
		}
		return candidate;
	}

	private async writeMerged(
		pdfPath: string,
		choice: MergeChoice,
		copyTarget: string,
	): Promise<PdfMergeResult> {
		const bytes = await this.adapter.readBinary(pdfPath);
		const sourceDoc = await PDFDocument.load(bytes);
		const sourcePageCount = sourceDoc.getPageCount();
		const pages = sourceDoc.getPages();
		for (let i = 0; i < pages.length; i++) {
			const page = pages[i];
			if (!page) continue;
			const strokes = this.strokes.forPage(pdfPath, i + 1);
			if (strokes.length === 0) continue;
			drawStrokesOnPdfPage(page, strokes);
		}

		const out = await sourceDoc.save();
		const buffer = toArrayBuffer(out);
		await validatePdf(buffer, sourcePageCount);

		const outPath = choice === 'overwrite' ? pdfPath : copyTarget;
		const transaction = await transactionalWriteBinary(
			this.adapter,
			outPath,
			buffer,
			(data) => validatePdf(data, sourcePageCount),
		);
		return { outPath, transaction };
	}

	private async discardAnnotations(pdfPath: string): Promise<void> {
		await this.sidecar.discard(pdfPath);
		this.strokes.clearFor(pdfPath);
		this.history.dropPath(pdfPath);
		this.redrawOverlays();
	}
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

async function validatePdf(data: ArrayBuffer, expectedPageCount: number): Promise<void> {
	const pdf = await PDFDocument.load(data);
	if (pdf.getPageCount() !== expectedPageCount) {
		throw new Error(
			`PDF verification failed: expected ${expectedPageCount} pages but found ${pdf.getPageCount()}`,
		);
	}
}
