import type { Stroke } from './stroke-math';
import { parseStoredStroke } from './jot-file';

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

export type JotNoteParseFailureReason =
	| 'invalid-json'
	| 'invalid-schema'
	| 'unsupported-version';

export type JotNoteParseResult =
	| { ok: true; note: JotNoteFile }
	| { ok: false; reason: JotNoteParseFailureReason; message: string };

const DEFAULT_PAGE_WIDTH = 1536;
const DEFAULT_PAGE_HEIGHT = 2048;
export const MAX_NOTEBOOK_PAGES = 500;
const MAX_PAGE_DIMENSION = 100_000;
const MIN_PAGE_ASPECT = 0.05;
const MAX_PAGE_ASPECT = 20;

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

export function parseJotNoteText(text: string): JotNoteFile | null {
	const result = parseJotNoteTextResult(text);
	return result.ok ? result.note : null;
}

export function parseJotNoteTextResult(text: string): JotNoteParseResult {
	if (text.trim().length === 0) return { ok: true, note: createJotNote() };

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {
			ok: false,
			reason: 'invalid-json',
			message: 'This Jot note is not valid JSON. The original file has been left untouched.',
		};
	}

	if (!isRecord(raw) || raw.type !== 'notebook' || !Array.isArray(raw.pages)) {
		return {
			ok: false,
			reason: 'invalid-schema',
			message: 'This file is not a valid Jot notebook. The original file has been left untouched.',
		};
	}

	if (raw.version !== JOT_NOTE_FORMAT_VERSION) {
		return {
			ok: false,
			reason: 'unsupported-version',
			message:
				typeof raw.version === 'number'
					? `This notebook uses unsupported Jot format version ${raw.version}. It was opened read-only to prevent data loss.`
					: 'This notebook is missing a supported Jot format version. It was opened read-only to prevent data loss.',
		};
	}

	if (raw.pages.length > MAX_NOTEBOOK_PAGES) {
		return {
			ok: false,
			reason: 'invalid-schema',
			message: `This Jot notebook contains more than ${MAX_NOTEBOOK_PAGES} pages and was opened read-only for safety.`,
		};
	}

	const pages: JotNotePage[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < raw.pages.length; index++) {
		const page = parsePage(raw.pages[index], index);
		if (!page || ids.has(page.id)) {
			return {
				ok: false,
				reason: 'invalid-schema',
				message:
					'This Jot notebook contains invalid or duplicate page data. The original file has been left untouched.',
			};
		}
		ids.add(page.id);
		pages.push(page);
	}

	return {
		ok: true,
		note: {
			version: JOT_NOTE_FORMAT_VERSION,
			type: 'notebook',
			paper: isPaperStyle(raw.paper) ? raw.paper : 'ruled',
			pages: pages.length > 0 ? pages : [createJotPage('page-1')],
		},
	};
}

export function serializeJotNote(note: JotNoteFile): string {
	return JSON.stringify(note, null, 2);
}

function parsePage(value: unknown, index: number): JotNotePage | null {
	if (!isRecord(value)) return null;
	const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : `page-${index + 1}`;
	if (id.length > 128 || id.includes('::')) return null;
	const width = value.width === undefined ? DEFAULT_PAGE_WIDTH : value.width;
	const height = value.height === undefined ? DEFAULT_PAGE_HEIGHT : value.height;
	if (!finitePositive(width) || !finitePositive(height)) return null;
	if (width > MAX_PAGE_DIMENSION || height > MAX_PAGE_DIMENSION) return null;
	const aspect = width / height;
	if (aspect < MIN_PAGE_ASPECT || aspect > MAX_PAGE_ASPECT) return null;
	if (!Array.isArray(value.strokes)) return null;

	const strokes: Stroke[] = [];
	for (const rawStroke of value.strokes) {
		const stroke = parseStoredStroke(rawStroke);
		if (!stroke) return null;
		strokes.push(stroke);
	}

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
