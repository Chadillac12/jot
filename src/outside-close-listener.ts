export class OutsideCloseListener {
	private handler: ((e: PointerEvent) => void) | null = null;
	private boundDoc: Document | null = null;
	private attachTimer: number | null = null;

	constructor(
		private element: () => HTMLElement | null,
		private onOutsideClick: () => void,
	) {}

	attach(doc: Document): void {
		this.detach();
		const handler = (e: PointerEvent) => {
			const element = this.element();
			if (!element) return;
			const target = e.target as Node | null;
			if (target && element.contains(target)) return;
			this.onOutsideClick();
		};
		this.handler = handler;
		this.boundDoc = doc;
		// Let the pointer/command gesture that opened the palette finish before
		// arming outside-dismiss. Prevents instant close on mobile WKWebView.
		const win = doc.defaultView ?? window;
		this.attachTimer = win.setTimeout(() => {
			this.attachTimer = null;
			if (this.handler === handler) doc.addEventListener('pointerdown', handler, true);
		}, 120);
	}

	detach(): void {
		if (this.attachTimer !== null) {
			(this.boundDoc?.defaultView ?? window).clearTimeout(this.attachTimer);
			this.attachTimer = null;
		}
		if (this.handler && this.boundDoc) {
			this.boundDoc.removeEventListener('pointerdown', this.handler, true);
		}
		this.handler = null;
		this.boundDoc = null;
	}
}
