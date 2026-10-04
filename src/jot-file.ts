import { STROKE_RENDER_VERSION, type Stroke, type StrokeRenderProfile } from './stroke-math';

export const JOT_SUFFIX = '.jot.json';
export const JOT_FORMAT_VERSION = 2;
export const PAGE_KEY_SEPARATOR = '::';

export interface JotFileFormat {
	version: number;
	pages: Record<string, Stroke[]>;
}

export function jotPathFor(pdfPath: string): string {
	return pdfPath + JOT_SUFFIX;
}

export function isSidecarPath(path: string): boolean {
	return path.endsWith(JOT_SUFFIX);
}

export function pdfPathFromSidecar(sidecarPath: string): string | null {
	if (!sidecarPath.endsWith(JOT_SUFFIX)) return null;
	return sidecarPath.slice(0, -JOT_SUFFIX.length);
}

export function documentPageKey(documentPath: string, pageId: string | number): string {
	return `${documentPath}${PAGE_KEY_SEPARATOR}${pageId}`;
}

export function pageKey(pdfPath: string, pageNumber: number): string {
	return documentPageKey(pdfPath, pageNumber);
}

export function documentPathFromKey(key: string): string | null {
	const separatorIndex = key.lastIndexOf(PAGE_KEY_SEPARATOR);
	return separatorIndex < 0 ? null : key.slice(0, separatorIndex);
}

/** @deprecated Use documentPathFromKey for surfaces that may not be PDFs. */
export function pdfPathFromKey(key: string): string | null {
	return documentPathFromKey(key);
}

export function parseJotText(text: string): JotFileFormat | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.version !== 'number' || !isRecord(parsed.pages)) return null;

		const pages: Record<string, Stroke[]> = {};
		for (const [pageId, rawStrokes] of Object.entries(parsed.pages)) {
			if (!/^\d+$/.test(pageId) || !Array.isArray(rawStrokes)) return null;
			const strokes: Stroke[] = [];
			for (const rawStroke of rawStrokes) {
				const stroke = parseStoredStroke(rawStroke);
				if (!stroke) return null;
				strokes.push(stroke);
			}
			pages[pageId] = strokes;
		}
		return { version: parsed.version, pages };
	} catch {
		return null;
	}
}

export function isSupportedVersion(version: number): boolean {
	return version === JOT_FORMAT_VERSION || version === 1;
}

/**
 * Validate and normalize persisted ink. Missing legacy style fields are filled
 * with defaults, but malformed coordinates are rejected instead of reaching
 * the renderer as NaN/Infinity or arbitrary objects.
 */
export function parseStoredStroke(value: unknown): Stroke | null {
	if (!isRecord(value) || !Array.isArray(value.points)) return null;
	const points = [];
	for (const rawPoint of value.points) {
		if (!isRecord(rawPoint)) return null;
		const { x, y, pressure } = rawPoint;
		if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(pressure)) return null;
		points.push({
			x,
			y,
			pressure: clamp01(pressure),
		});
	}

	const color = normalizeHexColor(value.color === undefined ? '#000000' : value.color);
	if (!color) return null;

	const width = value.width === undefined ? 0.0025 : value.width;
	if (!isFiniteNumber(width) || width <= 0 || width > 0.1) return null;

	const tool = value.tool === undefined ? 'pen' : value.tool;
	if (tool !== 'pen' && tool !== 'highlighter') return null;

	const render = parseRenderProfile(value.render);
	if (value.render !== undefined && !render) return null;

	return { points, color, width, tool, ...(render ? { render } : {}) };
}

export function migrateStroke(raw: Partial<Stroke>): Stroke {
	const points = Array.isArray(raw.points)
		? raw.points
				.filter(
					(point) =>
						isFiniteNumber(point?.x) &&
						isFiniteNumber(point?.y) &&
						isFiniteNumber(point?.pressure),
				)
				.map((point) => ({
					x: point.x,
					y: point.y,
					pressure: clamp01(point.pressure),
				}))
		: [];
	const color = normalizeHexColor(raw.color) ?? '#000000';
	const width =
		isFiniteNumber(raw.width) && raw.width > 0 && raw.width <= 0.1 ? raw.width : 0.0025;
	const tool = raw.tool === 'highlighter' ? 'highlighter' : 'pen';
	const render = parseRenderProfile(raw.render);
	return { points, color, width, tool, ...(render ? { render } : {}) };
}

export function hasStrokesForPdf(pdfPath: string, strokesByKey: Map<string, Stroke[]>): boolean {
	const prefix = pdfPath + PAGE_KEY_SEPARATOR;
	for (const [key, strokes] of strokesByKey.entries()) {
		if (key.startsWith(prefix) && strokes.length > 0) return true;
	}
	return false;
}

export function dropStrokesForPdf(pdfPath: string, strokesByKey: Map<string, Stroke[]>): void {
	const prefix = pdfPath + PAGE_KEY_SEPARATOR;
	for (const key of [...strokesByKey.keys()]) {
		if (key.startsWith(prefix)) strokesByKey.delete(key);
	}
}

export function buildJotPayload(
	pdfPath: string,
	strokesByKey: Map<string, Stroke[]>,
): JotFileFormat | null {
	const prefix = pdfPath + PAGE_KEY_SEPARATOR;
	const pages: Record<string, Stroke[]> = {};
	for (const [key, strokes] of strokesByKey.entries()) {
		if (!key.startsWith(prefix)) continue;
		if (strokes.length === 0) continue;
		pages[key.slice(prefix.length)] = strokes;
	}
	if (Object.keys(pages).length === 0) return null;
	return { version: JOT_FORMAT_VERSION, pages };
}

function normalizeHexColor(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
	if (/^#[0-9a-fA-F]{3}$/.test(value)) {
		const [r, g, b] = value.slice(1).split('');
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	return null;
}

function parseRenderProfile(value: unknown): StrokeRenderProfile | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	if (value.version !== STROKE_RENDER_VERSION) return undefined;
	if (!isFiniteNumber(value.smoothing) || !isFiniteNumber(value.pressureSensitivity)) {
		return undefined;
	}
	if (
		value.smoothing < 0 ||
		value.smoothing > 1 ||
		value.pressureSensitivity < 0 ||
		value.pressureSensitivity > 1
	) {
		return undefined;
	}
	return {
		version: STROKE_RENDER_VERSION,
		smoothing: value.smoothing,
		pressureSensitivity: value.pressureSensitivity,
	};
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
