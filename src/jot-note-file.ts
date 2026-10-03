import type { Stroke } from './stroke-math';
import { migrateStroke } from './jot-file';

export const JOT_NOTE_EXTENSION = 'jot';
export const JOT_NOTE_VIEW_TYPE = 'jot-note';
export const JOT_NOTE_FORMAT_VERSION = 1;

export type JotPaperStyle = 'blank' | 'ruled' | 'grid' | 'dot';

export interface JotNotePage {
	id: string;
	width: number;
	height: number;
	strokes: Stroke[];
}

export interface JotNoteFile {
	version: number;
	type: 'notebook';
	paper: JotPaperStyle;
	pages: JotNotePage[];
}

const DEFAULT_PAGE_WIDTH = 1536;
const DEFAULT_PAGE_HEIGHT = 2048;

export function createJotNote(): JotNoteFile {
	return {
		version: JOT_NOTE_FORMAT_VERSION,
		type: 'notebook',
		paper: 'ruled',
		pages: [createJotPage('page-1')],
	};
}

export function createJotPage(id: string): JotNotePage {
	return {
		id,
		width: DEFAULT_PAGE_WIDTH,
		height: DEFAULT_PAGE_HEIGHT,
		strokes: [],
	};
}

export function nextPageId(pages: JotNotePage[]): string {
	let index = pages.length + 1;
	const ids = new Set(pages.map((page) => page.id));
	while (ids.has(`page-${index}`)) index += 1;
	return `page-${index}`;
}

export function parseJotNoteText(text: string): JotNoteFile {
	if (text.trim().length === 0) return createJotNote();
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.type !== 'notebook' || !Array.isArray(raw.pages)) {
			return createJotNote();
		}
		const pages = raw.pages
			.map((page, index) => migratePage(page, index))
			.filter((page): page is JotNotePage => page !== null);
		return {
			version: JOT_NOTE_FORMAT_VERSION,
			type: 'notebook',
			paper: isPaperStyle(raw.paper) ? raw.paper : 'ruled',
			pages: pages.length > 0 ? pages : [createJotPage('page-1')],
		};
	} catch {
		return createJotNote();
	}
}

export function serializeJotNote(note: JotNoteFile): string {
	return JSON.stringify(note, null, 2);
}

function migratePage(value: unknown, index: number): JotNotePage | null {
	if (!isRecord(value)) return null;
	const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : `page-${index + 1}`;
	const width = finitePositive(value.width) ? value.width : DEFAULT_PAGE_WIDTH;
	const height = finitePositive(value.height) ? value.height : DEFAULT_PAGE_HEIGHT;
	const strokes = Array.isArray(value.strokes)
		? value.strokes
				.filter(isRecord)
				.map((stroke) => migrateStroke(stroke))
		: [];
	return { id, width, height, strokes };
}

function finitePositive(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPaperStyle(value: unknown): value is JotPaperStyle {
	return value === 'blank' || value === 'ruled' || value === 'grid' || value === 'dot';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
