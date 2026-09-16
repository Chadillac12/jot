import { setIcon } from 'obsidian';
import type { FloatingPaletteButtonPosition } from './palette-activation';

const EDGE_INSET_PX = 12;
const VIEWPORT_INSET_PX = 24;

export class FloatingPaletteButton {
	private element: HTMLButtonElement | null = null;

	constructor(
		private onActivate: (doc: Document, clientX: number, clientY: number) => void,
	) {}

	update(container: HTMLElement | null, position: FloatingPaletteButtonPosition): void {
		if (!container || position === 'off') {
			this.hide();
			return;
		}

		const doc = container.ownerDocument;
		const win = doc.defaultView;
		if (!win) {
			this.hide();
			return;
		}

		const rect = container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			this.hide();
			return;
		}

		const button = this.ensureElement(doc);
		button.dataset.position = position;

		const x =
			position === 'left'
				? Math.max(VIEWPORT_INSET_PX, rect.left + EDGE_INSET_PX)
				: Math.min(win.innerWidth - VIEWPORT_INSET_PX, rect.right - EDGE_INSET_PX);
		const y = Math.min(
			win.innerHeight - VIEWPORT_INSET_PX,
			Math.max(VIEWPORT_INSET_PX, rect.top + rect.height / 2),
		);

		button.style.left = `${x}px`;
		button.style.top = `${y}px`;
	}

	hide(): void {
		this.element?.remove();
		this.element = null;
	}

	private ensureElement(doc: Document): HTMLButtonElement {
		if (this.element?.ownerDocument === doc && this.element.isConnected) return this.element;
		this.element?.remove();

		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'jot-floating-palette-button';
		button.setAttribute('aria-label', 'Open Jot palette');
		setIcon(button, 'pencil');
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const rect = button.getBoundingClientRect();
			this.onActivate(
				button.ownerDocument,
				rect.left + rect.width / 2,
				rect.top + rect.height / 2,
			);
		});
		doc.body.appendChild(button);
		this.element = button;
		return button;
	}
}
