import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

export type MergeStrokeSnapshot = Record<string, Stroke[]>;

export function snapshotStrokesForPdf(
	strokes: StrokeStore,
	pdfPath: string,
): MergeStrokeSnapshot {
	const payload = strokes.buildPayload(pdfPath);
	if (!payload) return {};
	return Object.fromEntries(
		Object.entries(payload.pages).map(([pageId, pageStrokes]) => [
			pageId,
			pageStrokes.map((stroke) => ({
				...stroke,
				points: stroke.points.map((point) => ({ ...point })),
				render: stroke.render ? { ...stroke.render } : undefined,
			})),
		]),
	);
}
