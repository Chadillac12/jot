import type { PdfInsertedPage } from './jot-file';

const DEFAULT_WIDTH = 1536;
const DEFAULT_HEIGHT = 2048;

export class PdfInsertedPageStore {
	private pagesByPdf = new Map<string, PdfInsertedPage[]>();
	private sequence = 0;

	all(pdfPath: string): PdfInsertedPage[] {
		return (this.pagesByPdf.get(pdfPath) ?? []).map((page) => ({ ...page }));
	}

	hasFor(pdfPath: string): boolean {
		return (this.pagesByPdf.get(pdfPath)?.length ?? 0) > 0;
	}

	replace(pdfPath: string, pages: PdfInsertedPage[]): void {
		if (pages.length === 0) {
			this.pagesByPdf.delete(pdfPath);
			return;
		}
		this.pagesByPdf.set(
			pdfPath,
			pages.map((page) => ({ ...page })),
		);
	}

	add(pdfPath: string, slot: number, paper: PdfInsertedPage['paper'] = 'ruled'): PdfInsertedPage {
		const existing = this.pagesByPdf.get(pdfPath) ?? [];
		const page: PdfInsertedPage = {
			id: this.nextId(existing),
			slot: Math.max(0, Math.trunc(slot)),
			paper,
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
		};
		this.pagesByPdf.set(pdfPath, [...existing, page]);
		return { ...page };
	}

	updatePaper(
		pdfPath: string,
		id: string,
		paper: PdfInsertedPage['paper'],
	): boolean {
		const pages = this.pagesByPdf.get(pdfPath);
		if (!pages) return false;
		const page = pages.find((candidate) => candidate.id === id);
		if (!page || page.paper === paper) return false;
		page.paper = paper;
		return true;
	}

	remove(pdfPath: string, id: string): PdfInsertedPage | null {
		const pages = this.pagesByPdf.get(pdfPath);
		if (!pages) return null;
		const index = pages.findIndex((page) => page.id === id);
		if (index < 0) return null;
		const [removed] = pages.splice(index, 1);
		if (pages.length === 0) this.pagesByPdf.delete(pdfPath);
		return removed ? { ...removed } : null;
	}

	clear(pdfPath: string): void {
		this.pagesByPdf.delete(pdfPath);
	}

	rekeyDocumentPath(oldPath: string, newPath: string): void {
		if (oldPath === newPath) return;
		const pages = this.pagesByPdf.get(oldPath);
		if (!pages) return;
		this.pagesByPdf.delete(oldPath);
		const destination = this.pagesByPdf.get(newPath) ?? [];
		this.pagesByPdf.set(newPath, [...destination, ...pages].map((page) => ({ ...page })));
	}

	private nextId(existing: PdfInsertedPage[]): string {
		const ids = new Set(existing.map((page) => page.id));
		let id = '';
		do {
			this.sequence += 1;
			id = `inserted-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
		} while (ids.has(id));
		return id;
	}
}
