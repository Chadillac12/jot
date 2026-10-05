import { App, TFile, WorkspaceLeaf } from 'obsidian';
import { INK_KEY_ATTR } from './ink-surface';
import { pageKey } from './jot-file';
import { PdfPageBinding } from './pdf-page-binding';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

export const OVERLAY_KEY_ATTR = INK_KEY_ATTR;

interface LeafBinding {
	containerObserver: MutationObserver;
	pages: Map<HTMLElement, PdfPageBinding>;
	container: HTMLElement;
}

export class OverlayManager {
	private leaves = new Map<WorkspaceLeaf, LeafBinding>();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => (() => void) | void,
	) {}

	attachToActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const filePath = this.filePathForLeaf(leaf);
		if (!filePath) return;
		const container = leaf.view.containerEl;

		let binding = this.leaves.get(leaf);
		if (!binding) {
			const pages = new Map<HTMLElement, PdfPageBinding>();
			const observer = new MutationObserver(() => {
				const currentPath = this.filePathForLeaf(leaf);
				if (!currentPath) return;
				this.syncPages(container, currentPath, pages);
			});
			observer.observe(container, { childList: true, subtree: true });
			binding = { containerObserver: observer, pages, container };
			this.leaves.set(leaf, binding);
		}
		this.syncPages(container, filePath, binding.pages);
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
		for (const binding of this.leaves.get(leaf)?.pages.values() ?? []) binding.redraw();
	}

	redrawOverlaysForPdf(pdfPath: string): void {
		for (const [leaf, binding] of this.leaves) {
			if (this.filePathForLeaf(leaf) !== pdfPath) continue;
			for (const page of binding.pages.values()) page.redraw();
		}
	}

	overlayForKey(key: string): HTMLCanvasElement | null {
		for (const binding of this.leaves.values()) {
			for (const page of binding.pages.values()) {
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

	private syncPages(
		container: HTMLElement,
		filePath: string,
		bindings: Map<HTMLElement, PdfPageBinding>,
	): void {
		const currentPages = new Set(
			Array.from(container.querySelectorAll<HTMLElement>('.page')),
		);
		for (const [page, binding] of bindings) {
			if (!currentPages.has(page) || !page.isConnected) {
				binding.dispose();
				bindings.delete(page);
			}
		}

		for (const page of currentPages) {
			const attr = page.getAttribute('data-page-number');
			const pageNumber = attr && /^\d+$/.test(attr) ? Number(attr) : NaN;
			if (!Number.isFinite(pageNumber)) continue;
			const key = pageKey(filePath, pageNumber);
			const existing = bindings.get(page);
			if (existing) {
				existing.refreshKey(key);
				continue;
			}
			const created = new PdfPageBinding(page, key, this.strokes, this.wireOverlay);
			created.mount();
			bindings.set(page, created);
		}
	}

	private bindingForCanvas(canvas: HTMLCanvasElement): PdfPageBinding | null {
		for (const leaf of this.leaves.values()) {
			for (const binding of leaf.pages.values()) {
				if (binding.contains(canvas)) return binding;
			}
		}
		return null;
	}

	private disposeLeaf(leaf: WorkspaceLeaf, binding: LeafBinding): void {
		binding.containerObserver.disconnect();
		for (const page of binding.pages.values()) page.dispose();
		binding.pages.clear();
		this.leaves.delete(leaf);
	}

	private filePathForLeaf(leaf: WorkspaceLeaf): string | null {
		const file = (leaf.view as { file?: TFile }).file;
		return file?.path ?? null;
	}
}
