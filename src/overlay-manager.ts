import { App, TFile, WorkspaceLeaf } from 'obsidian';
import { INK_KEY_ATTR } from './ink-surface';
import { pageKey, type PdfInsertedPage } from './jot-file';
import {
	PDF_INSERTED_PAGE_CLASS,
	PdfInsertedPageBinding,
} from './pdf-inserted-page-binding';
import { PdfInsertedPageStore } from './pdf-inserted-page-store';
import { PdfPageBinding } from './pdf-page-binding';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

export const OVERLAY_KEY_ATTR = INK_KEY_ATTR;
const PDF_INSERTED_GAP_CLASS = 'jot-pdf-inserted-gap';

type PageBinding = PdfPageBinding | PdfInsertedPageBinding;

interface LeafBinding {
	containerObserver: MutationObserver;
	pages: Map<HTMLElement, PdfPageBinding>;
	insertedPages: Map<string, PdfInsertedPageBinding>;
	gaps: Map<number, HTMLElement>;
	container: HTMLElement;
}

export interface OverlayManagerCallbacks {
	onInsertedPagePaperChange: (
		pdfPath: string,
		pageId: string,
		paper: PdfInsertedPage['paper'],
	) => void;
}

export class OverlayManager {
	private leaves = new Map<WorkspaceLeaf, LeafBinding>();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => (() => void) | void,
		private insertedPageStore: PdfInsertedPageStore = new PdfInsertedPageStore(),
		private callbacks: OverlayManagerCallbacks = {
			onInsertedPagePaperChange: () => {},
		},
	) {}

	attachToActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const filePath = this.filePathForLeaf(leaf);
		if (!filePath) return;
		const container = leaf.view.containerEl;

		let binding = this.leaves.get(leaf);
		if (!binding) {
			let created!: LeafBinding;
			const observer = new MutationObserver(() => {
				const currentPath = this.filePathForLeaf(leaf);
				if (!currentPath) return;
				this.syncLeaf(created, currentPath);
			});
			created = {
				containerObserver: observer,
				pages: new Map(),
				insertedPages: new Map(),
				gaps: new Map(),
				container,
			};
			observer.observe(container, { childList: true, subtree: true });
			binding = created;
			this.leaves.set(leaf, binding);
		}
		this.syncLeaf(binding, filePath);
	}

	refreshPdf(pdfPath: string): void {
		for (const [leaf, binding] of this.leaves) {
			if (this.filePathForLeaf(leaf) !== pdfPath) continue;
			this.syncLeaf(binding, pdfPath);
		}
	}

	pruneClosedObservers(): void {
		if (this.leaves.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const [leaf, binding] of this.leaves) {
			if (!live.has(leaf)) this.disposeLeaf(leaf, binding);
		}
	}

	disconnectAll(): void {
		for (const [leaf, binding] of this.leaves) this.disposeLeaf(leaf, binding);
		this.leaves.clear();
	}

	redrawPage(canvas: HTMLCanvasElement): void {
		this.bindingForCanvas(canvas)?.redraw();
	}

	appendPersistedStroke(canvas: HTMLCanvasElement, stroke: Stroke): void {
		this.bindingForCanvas(canvas)?.appendStroke(stroke);
	}

	clearLivePage(canvas: HTMLCanvasElement): void {
		this.bindingForCanvas(canvas)?.clearLive();
	}

	redrawOverlaysForActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const binding = this.leaves.get(leaf);
		if (!binding) return;
		for (const page of binding.pages.values()) page.redraw();
		for (const page of binding.insertedPages.values()) page.redraw();
	}

	redrawOverlaysForPdf(pdfPath: string): void {
		for (const [leaf, binding] of this.leaves) {
			if (this.filePathForLeaf(leaf) !== pdfPath) continue;
			for (const page of binding.pages.values()) page.redraw();
			for (const page of binding.insertedPages.values()) page.redraw();
		}
	}

	overlayForKey(key: string): HTMLCanvasElement | null {
		for (const binding of this.leaves.values()) {
			for (const page of binding.pages.values()) {
				if (page.key === key) return page.persistentCanvas();
			}
			for (const page of binding.insertedPages.values()) {
				if (page.key === key) return page.persistentCanvas();
			}
		}
		return null;
	}

	getActivePdfLeaf(): WorkspaceLeaf | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) return null;
		return leaf.view.getViewType?.() === 'pdf' ? leaf : null;
	}

	getActivePdfFilePath(): string | null {
		const leaf = this.getActivePdfLeaf();
		return leaf ? this.filePathForLeaf(leaf) : null;
	}

	getActivePdfPageNumber(): number | null {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return null;
		const pages = this.pdfPageElements(leaf.view.containerEl);
		if (pages.length === 0) return null;
		const containerRect = leaf.view.containerEl.getBoundingClientRect();
		const centerY = containerRect.top + containerRect.height / 2;
		let best: { pageNumber: number; distance: number } | null = null;
		for (const page of pages) {
			const pageNumber = this.pageNumberForElement(page);
			if (pageNumber === null) continue;
			const rect = page.getBoundingClientRect();
			const pageCenter = rect.top + rect.height / 2;
			const distance = Math.abs(pageCenter - centerY);
			if (!best || distance < best.distance) best = { pageNumber, distance };
		}
		return best?.pageNumber ?? null;
	}

	getActivePdfPageCount(): number {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return 0;
		return this.pdfPageElements(leaf.view.containerEl)
			.map((page) => this.pageNumberForElement(page) ?? 0)
			.reduce((max, value) => Math.max(max, value), 0);
	}

	scrollInsertedPageIntoView(pdfPath: string, pageId: string): void {
		for (const [leaf, binding] of this.leaves) {
			if (this.filePathForLeaf(leaf) !== pdfPath) continue;
			const root = binding.insertedPages.get(pageId)?.root;
			if (!root) continue;
			root.scrollIntoView({ block: 'center', behavior: 'smooth' });
			return;
		}
	}

	private syncLeaf(binding: LeafBinding, filePath: string): void {
		this.syncPdfPages(binding, filePath);
		this.syncInsertedPages(binding, filePath);
	}

	private syncPdfPages(binding: LeafBinding, filePath: string): void {
		const currentPages = new Set(this.pdfPageElements(binding.container));
		for (const [page, pageBinding] of binding.pages) {
			if (!currentPages.has(page) || !page.isConnected) {
				pageBinding.dispose();
				binding.pages.delete(page);
			}
		}

		for (const page of currentPages) {
			const pageNumber = this.pageNumberForElement(page);
			if (pageNumber === null) continue;
			const key = pageKey(filePath, pageNumber);
			const existing = binding.pages.get(page);
			if (existing) {
				existing.refreshKey(key);
				continue;
			}
			const created = new PdfPageBinding(page, key, this.strokes, this.wireOverlay);
			created.mount();
			binding.pages.set(page, created);
		}
	}

	private syncInsertedPages(binding: LeafBinding, filePath: string): void {
		const layout = this.insertedPageStore.all(filePath);
		const liveIds = new Set(layout.map((page) => page.id));
		for (const [id, pageBinding] of binding.insertedPages) {
			if (liveIds.has(id)) continue;
			pageBinding.dispose();
			binding.insertedPages.delete(id);
		}

		const actualPages = this.pdfPageElements(binding.container)
			.map((element) => ({
				element,
				pageNumber: this.pageNumberForElement(element),
			}))
			.filter(
				(item): item is { element: HTMLElement; pageNumber: number } =>
					item.pageNumber !== null,
			)
			.sort((a, b) => a.pageNumber - b.pageNumber);
		if (actualPages.length === 0) return;

		for (const page of layout) {
			let pageBinding = binding.insertedPages.get(page.id);
			if (!pageBinding) {
				pageBinding = new PdfInsertedPageBinding(
					filePath,
					page,
					this.strokes,
					this.wireOverlay,
					{
						onPaperChange: (paper) =>
							this.callbacks.onInsertedPagePaperChange(filePath, page.id, paper),
					},
					binding.container.ownerDocument,
				);
				binding.insertedPages.set(page.id, pageBinding);
			} else {
				pageBinding.update(page);
			}
		}

		const groups = new Map<number, PdfInsertedPage[]>();
		const pageCount = actualPages[actualPages.length - 1]?.pageNumber ?? actualPages.length;
		for (const page of layout) {
			const slot = Math.max(0, Math.min(page.slot, pageCount));
			const group = groups.get(slot) ?? [];
			group.push(page);
			groups.set(slot, group);
		}

		for (const [slot, pages] of groups) {
			const reference =
				slot > 0
					? actualPages.find((page) => page.pageNumber === slot)?.element ??
						actualPages[actualPages.length - 1]!.element
					: actualPages[0]!.element;
			const target =
				slot < pageCount
					? actualPages.find((page) => page.pageNumber === slot + 1)?.element ?? null
					: null;
			const parent = (target ?? actualPages[actualPages.length - 1]!.element).parentElement;
			if (!parent) continue;

			let gap = binding.gaps.get(slot);
			if (!gap) {
				gap = binding.container.ownerDocument.createElement('div');
				gap.className = PDF_INSERTED_GAP_CLASS;
				gap.dataset.jotPdfGap = String(slot);
				binding.gaps.set(slot, gap);
			}

			if (target) {
				if (gap.parentElement !== parent || gap.nextSibling !== target) {
					parent.insertBefore(gap, target);
				}
			} else {
				let endTarget = actualPages[actualPages.length - 1]!.element.nextSibling;
				while (
					endTarget instanceof HTMLElement &&
					endTarget.classList.contains(PDF_INSERTED_GAP_CLASS)
				) {
					endTarget = endTarget.nextSibling;
				}
				if (gap.parentElement !== parent || gap.nextSibling !== endTarget) {
					parent.insertBefore(gap, endTarget);
				}
			}

			const roots = pages
				.map((page) => binding.insertedPages.get(page.id)?.root ?? null)
				.filter((root): root is HTMLElement => root !== null);
			const current = Array.from(gap.children);
			const sameOrder =
				current.length === roots.length && current.every((node, index) => node === roots[index]);
			if (!sameOrder) gap.replaceChildren(...roots);
			for (const page of pages) binding.insertedPages.get(page.id)?.setReferencePage(reference);
		}

		for (const [slot, gap] of binding.gaps) {
			if (groups.has(slot)) continue;
			gap.remove();
			binding.gaps.delete(slot);
		}
	}

	private pdfPageElements(container: HTMLElement): HTMLElement[] {
		return Array.from(container.querySelectorAll<HTMLElement>('.page')).filter(
			(page) => !page.closest(`.${PDF_INSERTED_PAGE_CLASS}`),
		);
	}

	private pageNumberForElement(page: HTMLElement): number | null {
		const attr = page.getAttribute('data-page-number');
		if (!attr || !/^\d+$/.test(attr)) return null;
		const pageNumber = Number(attr);
		return Number.isFinite(pageNumber) ? pageNumber : null;
	}

	private bindingForCanvas(canvas: HTMLCanvasElement): PageBinding | null {
		for (const leaf of this.leaves.values()) {
			for (const binding of leaf.pages.values()) {
				if (binding.contains(canvas)) return binding;
			}
			for (const binding of leaf.insertedPages.values()) {
				if (binding.contains(canvas)) return binding;
			}
		}
		return null;
	}

	private disposeLeaf(leaf: WorkspaceLeaf, binding: LeafBinding): void {
		binding.containerObserver.disconnect();
		for (const page of binding.pages.values()) page.dispose();
		for (const page of binding.insertedPages.values()) page.dispose();
		for (const gap of binding.gaps.values()) gap.remove();
		binding.pages.clear();
		binding.insertedPages.clear();
		binding.gaps.clear();
		this.leaves.delete(leaf);
	}

	private filePathForLeaf(leaf: WorkspaceLeaf): string | null {
		const file = (leaf.view as { file?: TFile }).file;
		return file?.path ?? null;
	}
}
