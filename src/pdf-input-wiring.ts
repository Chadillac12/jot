import type { PdfLiveWiring, PdfPointerForwarder } from './pdf-page-binding';

/**
 * Keeps the recovery forwarding channel intact at the plugin/overlay boundary.
 * The PDF page binding can receive the first Pencil event before its replacement
 * canvas is hit-tested, so omitting this second parameter loses the stroke.
 */
export function createPdfInputWiring(
	wireInkCanvas: (
		canvas: HTMLCanvasElement,
		registerForwarder?: (forwarder: PdfPointerForwarder | null) => void,
	) => (() => void) | null,
): PdfLiveWiring {
	return (canvas, registerForwarder) => wireInkCanvas(canvas, registerForwarder);
}
