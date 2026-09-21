import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildZoomDiagnosticsReport,
	countZoomDiagnostic,
	isZoomDiagnosticsEnabled,
	recordZoomDiagnosticEvent,
	resetZoomDiagnosticsForTests,
	startZoomDiagnostics,
	stopZoomDiagnostics,
	zoomDiagnosticId,
} from '../src/zoom-diagnostics';

afterEach(() => {
	resetZoomDiagnosticsForTests();
	vi.useRealTimers();
});

describe('zoom diagnostics', () => {
	it('does no capture work until explicitly started', () => {
		countZoomDiagnostic('resizeCallbacks');
		recordZoomDiagnosticEvent('should not be recorded');

		const report = buildZoomDiagnosticsReport(['snapshot=ok']);
		expect(report).toContain('captureEnabled=0');
		expect(report).toContain('[counters]\n(none)');
		expect(report).toContain('[recent events]\n(none)');
		expect(zoomDiagnosticId({}, 'page')).toBe('disabled');
	});

	it('captures counters and a bounded event history after start', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
		startZoomDiagnostics();
		expect(isZoomDiagnosticsEnabled()).toBe(true);

		countZoomDiagnostic('resizeCallbacks', 3);
		vi.advanceTimersByTime(25);
		recordZoomDiagnosticEvent('settle batch pages=2');

		const report = buildZoomDiagnosticsReport(['activePdf=notes.pdf']);
		expect(report).toContain('captureEnabled=1');
		expect(report).toContain('resizeCallbacks=3');
		expect(report).toContain('+25ms settle batch pages=2');
		expect(report).toContain('activePdf=notes.pdf');
	});

	it('assigns stable ids only while capture is enabled', () => {
		startZoomDiagnostics();
		const page = {};
		expect(zoomDiagnosticId(page, 'page')).toBe('page-1');
		expect(zoomDiagnosticId(page, 'page')).toBe('page-1');
		expect(zoomDiagnosticId({}, 'overlay')).toBe('overlay-2');

		stopZoomDiagnostics();
		expect(zoomDiagnosticId({}, 'page')).toBe('disabled');
	});
});
