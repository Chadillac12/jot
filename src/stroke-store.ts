import {
	JotFileFormat,
	type PdfInsertedPage,
	buildJotPayload,
	documentPageKey,
	dropStrokesForPdf,
	hasStrokesForPdf,
	migrateStroke,
	pageKey,
} from './jot-file';
import type { Stroke } from './stroke-math';

export class StrokeStore {
	private strokesByKey = new Map<string, Stroke[]>();

	forPage(pdfPath: string, pageNumber: number): Stroke[] {
		return this.strokesByKey.get(pageKey(pdfPath, pageNumber)) ?? [];
	}

	forKey(key: string): Stroke[] {
		return this.strokesByKey.get(key) ?? [];
	}

	hasKey(key: string): boolean {
		return this.strokesByKey.has(key);
	}

	setForKey(key: string, strokes: Stroke[]): void {
		this.strokesByKey.set(key, strokes);
	}

	appendToKey(key: string, stroke: Stroke): void {
		const existing = this.strokesByKey.get(key) ?? [];
		existing.push(stroke);
		this.strokesByKey.set(key, existing);
	}

	clearKey(key: string): void {
		this.strokesByKey.set(key, []);
	}

	hasFor(pdfPath: string): boolean {
		return hasStrokesForPdf(pdfPath, this.strokesByKey);
	}

	clearFor(pdfPath: string): void {
		dropStrokesForPdf(pdfPath, this.strokesByKey);
	}

	buildPayload(pdfPath: string, insertedPages: PdfInsertedPage[] = []): JotFileFormat | null {
		return buildJotPayload(pdfPath, this.strokesByKey, insertedPages);
	}

	populateFromPayload(pdfPath: string, pages: Record<string, Stroke[]>): void {
		for (const [pageId, strokes] of Object.entries(pages)) {
			if (!/^\d+$/.test(pageId) && !/^jot:[^:]{1,128}$/.test(pageId)) continue;
			this.strokesByKey.set(documentPageKey(pdfPath, pageId), strokes.map(migrateStroke));
		}
	}


	rekeyDocumentPath(oldPath: string, newPath: string): void {
		if (oldPath === newPath) return;
		const oldPrefix = oldPath + '::';
		const moves: Array<{ oldKey: string; newKey: string; strokes: Stroke[] }> = [];
		for (const [key, strokes] of this.strokesByKey.entries()) {
			if (!key.startsWith(oldPrefix)) continue;
			moves.push({
				oldKey: key,
				newKey: newPath + '::' + key.slice(oldPrefix.length),
				strokes: [...strokes],
			});
		}
		for (const move of moves) this.strokesByKey.delete(move.oldKey);
		for (const move of moves) {
			const existing = this.strokesByKey.get(move.newKey);
			this.strokesByKey.set(
				move.newKey,
				existing ? [...existing, ...move.strokes] : move.strokes,
			);
		}
	}

	keysForPage(pdfPath: string): string[] {
		const prefix = pdfPath + '::';
		return [...this.strokesByKey.keys()].filter((key) => key.startsWith(prefix));
	}

	asMap(): Map<string, Stroke[]> {
		return this.strokesByKey;
	}
}
