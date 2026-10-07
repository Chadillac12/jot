import { JOT_NOTE_FORMAT_VERSION, type JotNoteFile } from './jot-note-file';
import {
	documentPathFromKey,
	insertedPageKey,
	insertedPageStorageId,
	type PdfInsertedPage,
} from './jot-file';
import { JotNoteSurface } from './jot-note-surface';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

export const PDF_INSERTED_PAGE_CLASS = 'jot-pdf-inserted-page';
export const PDF_INSERTED_BACKING_STORE_LIMITS = {
	maxDimension: 2048,
	maxArea: 2_500_000,
} as const;

export interface PdfInsertedPageBindingCallbacks {
	onPaperChange: (paper: PdfInsertedPage['paper']) => void;
}

export class PdfInsertedPageBinding {
	readonly root: HTMLElement;
	readonly key: string;
	private host: HTMLElement;
	private surface: JotNoteSurface;
	private page: PdfInsertedPage;
	private referencePage: HTMLElement | null = null;
	private referenceObserver: ResizeObserver | null = null;

	constructor(
		pdfPath: string,
		page: PdfInsertedPage,
		strokes: StrokeStore,
		wireOverlay: (canvas: HTMLCanvasElement) => (() => void) | void,
		private callbacks: PdfInsertedPageBindingCallbacks,
		doc: Document,
		observerRoot: Element,
	) {
		this.page = { ...page };
		this.key = insertedPageKey(pdfPath, page.id);
		this.root = doc.createElement('section');
		this.root.className = PDF_INSERTED_PAGE_CLASS;
		this.root.dataset.jotInsertedPageId = page.id;

		const toolbar = doc.createElement('div');
		toolbar.className = 'jot-pdf-inserted-toolbar';

		const label = doc.createElement('span');
		label.className = 'jot-pdf-inserted-label';
		label.textContent = 'Jot page';
		toolbar.appendChild(label);

		const paperLabel = doc.createElement('label');
		paperLabel.className = 'jot-pdf-inserted-paper-label';
		paperLabel.textContent = 'Paper';
		const select = doc.createElement('select');
		select.className = 'jot-pdf-inserted-paper-select';
		for (const paper of ['blank', 'ruled', 'grid', 'dot'] as const) {
			const option = doc.createElement('option');
			option.value = paper;
			option.textContent = paper[0]!.toUpperCase() + paper.slice(1);
			option.selected = paper === page.paper;
			select.appendChild(option);
		}
		select.addEventListener('change', () => {
			const paper = select.value;
			if (paper !== 'blank' && paper !== 'ruled' && paper !== 'grid' && paper !== 'dot') return;
			this.page.paper = paper;
			this.surface.setPaperStyle(paper);
			this.callbacks.onPaperChange(paper);
		});
		paperLabel.appendChild(select);
		toolbar.appendChild(paperLabel);
		this.root.appendChild(toolbar);

		this.host = doc.createElement('div');
		this.host.className = 'jot-pdf-inserted-host';
		this.root.appendChild(this.host);

		this.surface = new JotNoteSurface(this.host, strokes, wireOverlay, {
			observerRoot,
			eagerMountFirstPage: false,
			rootMargin: '50% 0px 50% 0px',
			backingStoreLimits: PDF_INSERTED_BACKING_STORE_LIMITS,
			fixedLogicalBackingStore: true,
		});
		this.surface.render(this.asNotebook(), pdfPath);
	}

	update(page: PdfInsertedPage): void {
		const dimensionsChanged =
			page.width !== this.page.width || page.height !== this.page.height;
		if (dimensionsChanged) {
			this.page = { ...page };
			this.surface.render(this.asNotebook(), documentPathFromKey(this.key) ?? this.key);
		} else if (page.paper !== this.page.paper) {
			this.surface.setPaperStyle(page.paper);
			this.page = { ...page };
		} else {
			this.page = { ...page };
		}
		const select = this.root.querySelector<HTMLSelectElement>('.jot-pdf-inserted-paper-select');
		if (select && select.value !== page.paper) select.value = page.paper;
	}

	setReferencePage(referencePage: HTMLElement | null): void {
		if (referencePage === this.referencePage) return;
		this.referenceObserver?.disconnect();
		this.referenceObserver = null;
		this.referencePage = referencePage;
		this.syncWidth();
		if (!referencePage) return;
		const ResizeObserverCtor = referencePage.ownerDocument.defaultView?.ResizeObserver;
		if (!ResizeObserverCtor) return;
		this.referenceObserver = new ResizeObserverCtor(() => this.syncWidth());
		this.referenceObserver.observe(referencePage);
	}

	contains(canvas: HTMLCanvasElement): boolean {
		return this.root.contains(canvas);
	}

	persistentCanvas(): HTMLCanvasElement | null {
		return this.surface.overlayForKey(this.key);
	}

	redraw(): void {
		this.surface.redrawKey(this.key);
	}

	appendStroke(stroke: Stroke): void {
		const canvas = this.persistentCanvas();
		if (canvas) this.surface.appendPersistedStroke(canvas, stroke);
	}

	clearLive(): void {
		const canvas = this.persistentCanvas();
		if (canvas) this.surface.clearLivePage(canvas);
	}

	dispose(): void {
		this.referenceObserver?.disconnect();
		this.referenceObserver = null;
		this.referencePage = null;
		this.surface.disconnect();
		this.root.remove();
	}

	private syncWidth(): void {
		const reference = this.referencePage;
		if (!reference) return;
		const rect = reference.getBoundingClientRect();
		if (rect.width > 0) {
			this.root.style.width = `${rect.width}px`;
			return;
		}
		const explicitWidth = reference.style.width;
		if (explicitWidth) this.root.style.width = explicitWidth;
	}

	private asNotebook(): JotNoteFile {
		return {
			version: JOT_NOTE_FORMAT_VERSION,
			type: 'notebook',
			paper: this.page.paper,
			pages: [
				{
					id: insertedPageStorageId(this.page.id),
					width: this.page.width,
					height: this.page.height,
					strokes: [],
				},
			],
		};
	}
}
