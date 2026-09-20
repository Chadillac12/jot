export interface CanvasSurface {
	width: number;
	height: number;
	dpr: number;
}

export interface CanvasBackingStoreLimits {
	maxDimension: number;
	maxArea: number;
}

// Keep individual canvases below conservative WebKit/iPad limits. iPad PDF.js
// already owns one or more large page canvases, so Jot should leave headroom
// instead of consuming another ~64 MiB per annotation overlay at extreme zoom.
export const DEFAULT_BACKING_STORE_LIMITS: CanvasBackingStoreLimits = {
	maxDimension: 4096,
	maxArea: 8_388_608,
};

export function devicePixelRatioFor(host: { devicePixelRatio?: number }): number {
	const value = host.devicePixelRatio;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

export function safeBackingStoreDpr(
	cssWidth: number,
	cssHeight: number,
	requestedDpr: number,
	limits: CanvasBackingStoreLimits = DEFAULT_BACKING_STORE_LIMITS,
): number {
	const dpr = Number.isFinite(requestedDpr) && requestedDpr > 0 ? requestedDpr : 1;
	if (!(cssWidth > 0) || !(cssHeight > 0)) return dpr;

	const maxDimension =
		Number.isFinite(limits.maxDimension) && limits.maxDimension > 0
			? limits.maxDimension
			: DEFAULT_BACKING_STORE_LIMITS.maxDimension;
	const maxArea =
		Number.isFinite(limits.maxArea) && limits.maxArea > 0
			? limits.maxArea
			: DEFAULT_BACKING_STORE_LIMITS.maxArea;

	const byWidth = maxDimension / cssWidth;
	const byHeight = maxDimension / cssHeight;
	const byArea = Math.sqrt(maxArea / (cssWidth * cssHeight));
	const effective = Math.min(dpr, byWidth, byHeight, byArea);
	return Number.isFinite(effective) && effective > 0 ? effective : dpr;
}

export function applyBackingStoreSize(
	canvas: HTMLCanvasElement,
	cssWidth: number,
	cssHeight: number,
	dpr: number,
): boolean {
	const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
	const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
	let changed = false;
	if (canvas.width !== targetWidth) {
		canvas.width = targetWidth;
		changed = true;
	}
	if (canvas.height !== targetHeight) {
		canvas.height = targetHeight;
		changed = true;
	}
	return changed;
}

export function readCanvasSurface(canvas: HTMLCanvasElement): CanvasSurface {
	const styleW = parseFloat(canvas.style.width);
	const styleH = parseFloat(canvas.style.height);
	const cssWidth = Number.isFinite(styleW) && styleW > 0 ? styleW : canvas.width;
	const cssHeight = Number.isFinite(styleH) && styleH > 0 ? styleH : canvas.height;
	const dpr = cssWidth > 0 ? canvas.width / cssWidth : 1;
	return { width: cssWidth, height: cssHeight, dpr: dpr > 0 ? dpr : 1 };
}
