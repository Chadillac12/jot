import { App, TFile, WorkspaceLeaf } from 'obsidian';
import { INK_KEY_ATTR } from './ink-surface';
import {
	PDF_LIVE_OVERLAY_CLASS,
	PDF_OVERLAY_CLASS,
	PdfPageBinding,
} from './pdf-page-binding';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

export const OVERLAY_KEY_ATTR = INK_KEY_ATTR;

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
	private pageBindings = new Map<WorkspaceLeaf, Map<HTMLElement, PdfPageBinding>>();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => () => void,
	) {}

	attachToActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const filePath = this.filePathForLeaf(leaf);
		if (!filePath) return;
		const container = leaf.view.containerEl;

		this.syncPages(leaf, container, filePath);
		if (this.containerObservers.has(leaf)) return;

		const observer = new MutationObserver(() => {
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			this.syncPages(leaf, container, currentPath);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
	}

	pruneClosedObservers(): void {
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const leaf of new Set([
			...this.containerObservers.keys(),
			...this.pageBindings.keys(),
		])) {
			if (!live.has(leaf)) this.disposeLeaf(leaf);
		}
	}

	disconnectAll(): void {
		for (const leaf of new Set([
			...this.containerObservers.keys(),
			...this.pageBindings.keys(),
		])) {
			this.disposeLeaf(leaf);
		}
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
		for (const binding of this.pageBindings.get(leaf)?.values() ?? []) binding.redraw();
	}

	redrawOverlaysForPdf(pdfPath: string): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.filePathForLeaf(leaf) !== pdfPath) return;
			for (const binding of this.pageBindings.get(leaf)?.values() ?? []) binding.redraw();
		});
	}

	overlayForKey(key: string): HTMLCanvasElement | null {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return null;
		for (const binding of this.pageBindings.get(leaf)?.values() ?? []) {
			if (binding.key === key) return binding.persistentCanvas;
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

	private syncPages(leaf: WorkspaceLeaf, container: HTMLElement, filePath: string): void {
		const pages = new Set(
			Array.from(container.querySelectorAll<HTMLElement>('.page')),
		);
		const bindings = this.pageBindings.get(leaf) ?? new Map<HTMLElement, PdfPageBinding>();

		for (const [page, binding] of bindings) {
			if (!pages.has(page) || !page.isConnected || binding.filePath !== filePath) {
				binding.dispose();
				bindings.delete(page);
			}
		}

		for (const page of pages) {
			if (bindings.has(page)) continue;
			const binding = new PdfPageBinding(page, filePath, this.strokes, this.wireOverlay);
			if (binding.key) bindings.set(page, binding);
			else binding.dispose();
		}

		if (bindings.size > 0) this.pageBindings.set(leaf, bindings);
		else this.pageBindings.delete(leaf);
	}

	private bindingForCanvas(canvas: HTMLCanvasElement): PdfPageBinding | null {
		for (const bindings of this.pageBindings.values()) {
			for (const binding of bindings.values()) {
				if (
					binding.persistentCanvas === canvas ||
					binding.liveCanvas === canvas ||
					binding.page.contains(canvas)
				) {
					return binding;
				}
			}
		}
		return null;
	}

	private disposeLeaf(leaf: WorkspaceLeaf): void {
		this.containerObservers.get(leaf)?.disconnect();
		this.containerObservers.delete(leaf);
		for (const binding of this.pageBindings.get(leaf)?.values() ?? []) binding.dispose();
		this.pageBindings.delete(leaf);
	}

	private filePathForLeaf(leaf: WorkspaceLeaf): string | null {
		const file = (leaf.view as { file?: TFile }).file;
		return file?.path ?? null;
	}
}

export { PDF_LIVE_OVERLAY_CLASS, PDF_OVERLAY_CLASS };
