import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The overlay recovery tests deliberately inject a correctly wired handler.
// This guard covers the production integration seam that those tests cannot
// exercise: dropping the second PdfLiveWiring argument prevents the real
// plugin from forwarding any page-targeted Pencil stroke.
describe('production PDF Pencil wiring', () => {
	it('forwards the callback provided by OverlayManager to the real ink handler', () => {
		const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
		expect(main).toMatch(
			/\(canvas,\s*registerForwarder\)\s*=>\s*this\.wirePointerEvents\(canvas,\s*registerForwarder\)/,
		);
		expect(main).toContain(
			'registerForwarder?.((event) => handler.forwardPointerEvent(event));',
		);
	});
});
