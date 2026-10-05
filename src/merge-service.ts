import { App, DataAdapter, Notice, TFile } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { ExportChoiceModal } from './merge';
import { jotPathFor } from './jot-file';
import { drawStrokesOnPdfPage } from './pdf-render';
import type { SidecarLoadStatus, SidecarStore } from './sidecar-store';
import {
	recoverInterruptedVaultBinary,
	transactionalModifyVaultBinary,
	transactionalWriteBinary,
} from './transactional-write';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';
import type { UndoHistory } from './undo';

const PLUGIN_LOG = '[jot]';

type MergeChoice = 'overwrite' | 'copy';

export interface MergeServiceCallbacks {
	ensureLoaded: (pdfPath: string) => Promise<SidecarLoadStatus>;
	redrawOverlays: () => void;
	acquireMutationLock: (pdfPath: string) => boolean;
	releaseMutationLock: (pdfPath: string) => void;
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

	async recoverInterruptedOverwrite(pdfPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(pdfPath);
		if (!(file instanceof TFile)) return;
		const outcome = await recoverInterruptedVaultBinary(
			this.app.vault,
			this.adapter,
			file,
			async (candidate) => {
				await PDFDocument.load(candidate);
			},
			jotPathFor(pdfPath),
		);
		if (outcome === 'rolled-back') {
			new Notice(
				'Jot: recovered an interrupted PDF overwrite and restored the original PDF before loading its annotations.',
				8000,
			);
		} else if (outcome === 'external-preserved') {
			new Notice(
				'Jot: found an interrupted PDF overwrite, but the current PDF no longer matched Jot’s recorded replacement. The current PDF was preserved and the pre-merge backup was kept as a recovery copy.',
				10000,
			);
		}
	}

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
		if (!this.callbacks.acquireMutationLock(pdfPath)) {
			new Notice('Jot: this PDF is already busy with another protected operation.');
			return;
		}
		try {
			if (!(await this.sidecar.flush(pdfPath))) {
				throw new Error('annotations could not be safely flushed before merge');
			}
			const loadStatus = await this.callbacks.ensureLoaded(pdfPath);
			if (loadStatus === 'protected' || loadStatus === 'error' || loadStatus === 'dirty') {
				throw new Error('annotation source is not in a verified clean state');
			}
			const strokeSnapshot = this.strokes.snapshotFor(pdfPath);
			const sidecarBaseline = this.sidecar.captureBaseline(pdfPath);
			const outPath = await this.writeMerged(
				pdfPath,
				choice,
				copyTarget,
				strokeSnapshot,
				sidecarBaseline,
			);
			if (choice === 'overwrite') this.clearAnnotationState(pdfPath);
			new Notice(`Jot: notes merged into ${outPath}`);
		} catch (err) {
			console.error(`${PLUGIN_LOG} merge failed:`, err);
			new Notice(`Jot: merge failed — ${err instanceof Error ? err.message : 'see console'}`);
		} finally {
			this.callbacks.releaseMutationLock(pdfPath);
		}
	}

	private async writeMerged(
		pdfPath: string,
		choice: MergeChoice,
		copyTarget: string,
		strokeSnapshot: Map<number, Stroke[]>,
		sidecarBaseline: string | null,
	): Promise<string> {
		const bytes = await this.adapter.readBinary(pdfPath);
		const pdfDoc = await PDFDocument.load(bytes);
		const pages = pdfDoc.getPages();
		for (let i = 0; i < pages.length; i++) {
			const page = pages[i];
			if (!page) continue;
			const strokes = strokeSnapshot.get(i + 1) ?? [];
			if (strokes.length === 0) continue;
			drawStrokesOnPdfPage(page, strokes);
		}
		const out = await pdfDoc.save();
		const buffer = new ArrayBuffer(out.byteLength);
		new Uint8Array(buffer).set(out);
		const outPath = choice === 'overwrite' ? pdfPath : copyTarget;
		const expectedPages = pages.length;
		const validatePdf = async (candidate: ArrayBuffer): Promise<void> => {
			const verified = await PDFDocument.load(candidate);
			if (verified.getPageCount() !== expectedPages) {
				throw new Error(
					`Merged PDF verification failed: expected ${expectedPages} pages, found ${verified.getPageCount()}`,
				);
			}
		};

		if (choice === 'overwrite') {
			const file = this.app.vault.getAbstractFileByPath(pdfPath);
			if (!(file instanceof TFile)) throw new Error(`PDF no longer exists at ${pdfPath}`);
			await transactionalModifyVaultBinary(
				this.app.vault,
				this.adapter,
				file,
				buffer,
				validatePdf,
				async () => this.sidecar.discardIfBaselineUnchanged(pdfPath, sidecarBaseline),
				bytes,
			);
		} else {
			await transactionalWriteBinary(this.adapter, outPath, buffer, validatePdf);
		}
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

	private clearAnnotationState(pdfPath: string): void {
		this.strokes.clearFor(pdfPath);
		this.history.dropPath(pdfPath);
		this.callbacks.redrawOverlays();
	}
}
