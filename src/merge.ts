import { App, Modal } from 'obsidian';
import { LineCapStyle, PDFPage, rgb } from 'pdf-lib';
import type { Stroke } from './stroke-math';
import {
	HIGHLIGHTER_ALPHA,
	HIGHLIGHTER_WIDTH_FACTOR,
	penOutline,
	svgPathFromOutline,
} from './stroke-render';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const raw = hex.replace('#', '');
	const h =
		raw.length === 3
			? raw
					.split('')
					.map((digit) => digit + digit)
					.join('')
			: raw.slice(0, 6);
	return {
		r: (parseInt(h.slice(0, 2), 16) || 0) / 255,
		g: (parseInt(h.slice(2, 4), 16) || 0) / 255,
		b: (parseInt(h.slice(4, 6), 16) || 0) / 255,
	};
}

export function drawStrokesOnPdfPage(page: PDFPage, strokes: Stroke[]) {
	const pageW = page.getWidth();
	const pageH = page.getHeight();
	for (const stroke of strokes) {
		if (stroke.points.length === 0) continue;
		const c = hexToRgb(stroke.color);
		const baseWidth = stroke.width * pageH;
		const color = rgb(c.r, c.g, c.b);
		if (stroke.tool === 'highlighter') {
			const thickness = baseWidth * HIGHLIGHTER_WIDTH_FACTOR;
			if (stroke.points.length === 1) {
				const point = stroke.points[0]!;
				page.drawCircle({
					x: point.x * pageW,
					y: pageH - point.y * pageH,
					size: thickness / 2,
					color,
					opacity: HIGHLIGHTER_ALPHA,
				});
				continue;
			}
			for (let i = 1; i < stroke.points.length; i++) {
				const a = stroke.points[i - 1];
				const b = stroke.points[i];
				if (!a || !b) continue;
				page.drawLine({
					start: { x: a.x * pageW, y: pageH - a.y * pageH },
					end: { x: b.x * pageW, y: pageH - b.y * pageH },
					thickness,
					color,
					opacity: HIGHLIGHTER_ALPHA,
					lineCap: LineCapStyle.Butt,
				});
			}
			continue;
		}
		const outline = penOutline(
			stroke.points,
			stroke.width,
			{ width: pageW, height: pageH },
			stroke.render,
		);
		const path = svgPathFromOutline(outline);
		if (path) {
			// drawSvgPath uses SVG's downward-positive Y axis. Anchoring at the
			// page top makes the exported outline line up with the screen surface.
			page.drawSvgPath(path, {
				x: 0,
				y: pageH,
				color,
				opacity: 1,
			});
		}
	}
}

export function drawPaperOnPdfPage(
	page: PDFPage,
	paper: 'blank' | 'ruled' | 'grid' | 'dot',
	sourceWidth = 1536,
	sourceHeight = 2048,
): void {
	if (paper === 'blank') return;
	const pageW = page.getWidth();
	const pageH = page.getHeight();
	const xSpacing = pageW * (64 / sourceWidth);
	const ySpacing = pageH * (64 / sourceHeight);
	const guide = rgb(63 / 255, 99 / 255, 148 / 255);

	if (paper === 'ruled' || paper === 'grid') {
		const opacity = paper === 'grid' ? 0.14 : 0.18;
		for (let y = pageH - ySpacing; y > 0; y -= ySpacing) {
			page.drawLine({
				start: { x: 0, y },
				end: { x: pageW, y },
				thickness: 0.6,
				color: guide,
				opacity,
			});
		}
	}

	if (paper === 'grid') {
		for (let x = xSpacing; x < pageW; x += xSpacing) {
			page.drawLine({
				start: { x, y: 0 },
				end: { x, y: pageH },
				thickness: 0.6,
				color: guide,
				opacity: 0.14,
			});
		}
		return;
	}

	if (paper === 'dot') {
		const dot = rgb(63 / 255, 78 / 255, 102 / 255);
		const radius = Math.max(0.4, Math.min(1.2, pageW * (1.2 / sourceWidth)));
		for (let y = pageH - ySpacing; y > 0; y -= ySpacing) {
			for (let x = xSpacing; x < pageW; x += xSpacing) {
				page.drawCircle({
					x,
					y,
					size: radius,
					color: dot,
					opacity: 0.32,
				});
			}
		}
	}
}

export class ExportChoiceModal extends Modal {
	private onChoice: (choice: 'overwrite' | 'copy' | 'cancel') => void;
	private copyTarget: string;

	constructor(
		app: App,
		copyTarget: string,
		onChoice: (choice: 'overwrite' | 'copy' | 'cancel') => void,
	) {
		super(app);
		this.copyTarget = copyTarget;
		this.onChoice = onChoice;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Merge notes into PDF' });
		contentEl.createEl('p', {
			text: 'Bake the strokes for this PDF into a PDF file. The sidecar .jot.json is dropped only if you overwrite the original.',
		});
		const annotatedName = this.copyTarget.replace(/.*\//, '');
		const buttons = contentEl.createDiv({ cls: 'jot-modal-buttons' });
		const copyBtn = buttons.createEl('button', {
			text: `Save as "${annotatedName}"`,
		});
		copyBtn.classList.add('mod-cta');
		copyBtn.addEventListener('click', () => {
			this.onChoice('copy');
			this.close();
		});
		const overwriteBtn = buttons.createEl('button', {
			text: 'Overwrite original',
		});
		overwriteBtn.addEventListener('click', () => {
			this.onChoice('overwrite');
			this.close();
		});
		const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => {
			this.onChoice('cancel');
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
