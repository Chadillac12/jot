import { Notice, Plugin, TFile } from 'obsidian';
import { ConfirmClearModal } from './clear';
import { collectClearOperations, countStrokes, toUndoEntries } from './clear-ops';
import { FloatingPaletteButton } from './floating-palette-button';
import { isSidecarPath, pdfPathFromSidecar } from './jot-file';
import { MergeService } from './merge-service';
import { OverlayManager } from './overlay-manager';
import { DEFAULT_TOOL_STATE, Palette, ToolState } from './palette';
import { normalizePalettePreferences } from './palette-activation';
import { PointerEventHandler } from './pointer-event-handler';
import { DEFAULT_SETTINGS, JotSettings, JotSettingTab } from './settings';
import { SidecarStore } from './sidecar-store';
import { StrokeStore } from './stroke-store';
import { UndoEntry, UndoHistory } from './undo';
import { UndoController } from './undo-controller';
import {
	buildZoomDiagnosticsReport,
	countZoomDiagnostic,
	recordZoomDiagnosticEvent,
	resumeZoomDiagnosticsAfterReload,
	startZoomDiagnostics,
	stopZoomDiagnostics,
} from './zoom-diagnostics';

export type { Handedness } from './palette';

const PLUGIN_LOG = '[jot]';

export default class JotPlugin extends Plugin {
	private strokes = new StrokeStore();
	private sidecar!: SidecarStore;
	private merge!: MergeService;
	private overlays!: OverlayManager;
	private toolState: ToolState = { ...DEFAULT_TOOL_STATE };
	private palette!: Palette;
	private floatingPaletteButton!: FloatingPaletteButton;
	settings: JotSettings = { ...DEFAULT_SETTINGS };
	private history = new UndoHistory();
	private undoController!: UndoController;

	async onload() {
		resumeZoomDiagnosticsAfterReload();
		await this.loadSettings();
		this.sidecar = new SidecarStore(this.app.vault.adapter, this.strokes);
		this.overlays = new OverlayManager(this.app, this.strokes, (canvas) =>
			this.wirePointerEvents(canvas),
		);
		this.undoController = new UndoController(this.history, this.strokes, this.overlays, {
			activePdfPath: () => this.overlays.getActivePdfFilePath(),
			onAfterApply: (pdfPath) => this.scheduleSave(pdfPath),
		});
		this.merge = new MergeService(
			this.app,
			this.app.vault.adapter,
			this.strokes,
			this.sidecar,
			this.history,
			{
				ensureLoaded: (pdfPath) => this.ensureLoaded(pdfPath),
				redrawOverlays: () => this.overlays.redrawOverlaysForActivePdf(),
			},
		);
		this.addSettingTab(new JotSettingTab(this.app, this));
		this.addCommand({
			id: 'merge-notes-into-pdf',
			name: 'Merge notes into PDF',
			checkCallback: (checking) => {
				const path = this.overlays.getActivePdfFilePath();
				if (!path) return false;
				if (!checking) void this.merge.start(path);
				return true;
			},
		});
		this.addCommand({
			id: 'clear-annotations',
			name: 'Clear annotations on this PDF',
			checkCallback: (checking) => {
				const path = this.overlays.getActivePdfFilePath();
				if (!path) return false;
				if (!this.strokes.hasFor(path)) return false;
				if (!checking) this.startClearFlow(path);
				return true;
			},
		});
		this.addCommand({
			id: 'open-palette',
			name: 'Open palette',
			checkCallback: (checking) => {
				if (!this.overlays.getActivePdfLeaf()) return false;
				if (!checking) this.openPaletteForActivePdf();
				return true;
			},
		});
		this.addCommand({
			id: 'start-zoom-diagnostics',
			name: 'Start zoom diagnostics',
			callback: () => {
				startZoomDiagnostics();
				recordZoomDiagnosticEvent(
					`capture started on ${this.overlays.getActivePdfFilePath() ?? 'no active PDF'}`,
				);
				new Notice('Jot: zoom diagnostics started.');
			},
		});
		this.addCommand({
			id: 'copy-zoom-diagnostics',
			name: 'Copy zoom diagnostics',
			callback: () => void this.copyZoomDiagnostics(),
		});
		this.addCommand({
			id: 'stop-zoom-diagnostics',
			name: 'Stop zoom diagnostics',
			callback: () => {
				stopZoomDiagnostics();
				new Notice('Jot: zoom diagnostics stopped.');
			},
		});

		this.palette = new Palette(
			this.toolState,
			(state) => {
				this.toolState = state;
				this.settings.toolState = state;
				const mem = this.palette.getMemory();
				this.settings.penState = mem.pen;
				this.settings.highlighterState = mem.highlighter;
				void this.saveSettings();
			},
			{
				onUndo: () => this.undoController.undo(),
				onRedo: () => this.undoController.redo(),
				canUndo: () => this.undoController.canUndo(),
				canRedo: () => this.undoController.canRedo(),
				getColors: () => this.settings.colors,
			},
			{
				pen: this.settings.penState,
				highlighter: this.settings.highlighterState,
			},
		);
		this.floatingPaletteButton = new FloatingPaletteButton((doc, x, y) => {
			this.palette.show(doc.body, x, y, this.settings.handedness);
		});

		this.registerObsidianProtocolHandler('jot-palette', () => {
			this.openPaletteForActivePdf();
		});

		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile | null) => {
				if (file?.extension !== 'pdf') {
					this.refreshFloatingPaletteButton();
					return;
				}
				countZoomDiagnostic('pdfFileOpenEvents');
				recordZoomDiagnosticEvent(`PDF file-open path=${file.path}`);
				await this.ensureLoaded(file.path);
				window.setTimeout(() => {
					this.overlays.attachToActivePdf();
					this.refreshFloatingPaletteButton();
				}, 300);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				countZoomDiagnostic('layoutChangeEvents');
				this.overlays.pruneClosedObservers();
				this.overlays.attachToActivePdf();
				this.refreshFloatingPaletteButton();
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!isSidecarPath(file.path)) return;
				if (this.sidecar.isOwnRecentSave(file.path)) return;
				const pdfPath = pdfPathFromSidecar(file.path);
				if (pdfPath) void this.reloadSidecar(pdfPath);
			}),
		);

		this.registerDomEvent(window, 'resize', () => this.refreshFloatingPaletteButton());

		this.app.workspace.onLayoutReady(async () => {
			const filePath = this.overlays.getActivePdfFilePath();
			if (!filePath) {
				this.refreshFloatingPaletteButton();
				return;
			}
			await this.ensureLoaded(filePath);
			this.overlays.attachToActivePdf();
			this.refreshFloatingPaletteButton();
		});
	}

	onunload() {
		this.overlays?.disconnectAll();
		this.sidecar?.cancelAllPending();
		this.palette?.hide();
		this.floatingPaletteButton?.hide();
	}

	private async ensureLoaded(pdfPath: string) {
		await this.sidecar.load(pdfPath);
	}

	private async reloadSidecar(pdfPath: string) {
		await this.sidecar.load(pdfPath);
		this.overlays.redrawOverlaysForPdf(pdfPath);
	}

	private scheduleSave(pdfPath: string): void {
		this.sidecar.scheduleSave(pdfPath);
	}

	private wirePointerEvents(canvas: HTMLCanvasElement): PointerEventHandler | void {
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			console.error(`${PLUGIN_LOG} no 2d context`);
			return;
		}
		const handler = new PointerEventHandler(canvas, ctx, {
			palette: this.palette,
			strokes: this.strokes,
			overlays: this.overlays,
			sidecar: this.sidecar,
			undo: this.undoController,
			toolState: () => this.toolState,
			handedness: () => this.settings.handedness,
			paletteActivation: () => this.settings.paletteActivation,
			pencilLongPressMs: () => this.settings.pencilLongPressMs,
		});
		handler.attach();
		return handler;
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<JotSettings> | null;
		const isLegacySettings =
			stored !== null &&
			stored.paletteActivation === undefined &&
			stored.pencilLongPressMs === undefined &&
			stored.floatingPaletteButtonPosition === undefined;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(stored ?? {}),
			...normalizePalettePreferences(stored, isLegacySettings),
		};
		this.toolState = { ...this.settings.toolState };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshFloatingPaletteButton(): void {
		const leaf = this.overlays?.getActivePdfLeaf();
		this.floatingPaletteButton?.update(
			leaf?.view.containerEl ?? null,
			this.settings.floatingPaletteButtonPosition,
		);
	}

	private async copyZoomDiagnostics(): Promise<void> {
		const report = buildZoomDiagnosticsReport(this.overlays.zoomDiagnosticsSnapshot());
		try {
			await window.navigator.clipboard.writeText(report);
			new Notice('Jot: zoom diagnostics copied.');
		} catch (error) {
			console.error(`${PLUGIN_LOG} could not copy zoom diagnostics`, error);
			new Notice('Jot: could not copy zoom diagnostics.');
		}
	}

	openPaletteForActivePdf(): void {
		const leaf = this.overlays?.getActivePdfLeaf();
		if (!leaf) return;
		const container = leaf.view.containerEl;
		const doc = container.ownerDocument;
		const win = doc.defaultView;
		if (!win) return;
		const rect = container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const margin = 64;
		const x = Math.min(win.innerWidth - margin, Math.max(margin, rect.left + rect.width / 2));
		const y = Math.min(win.innerHeight - margin, Math.max(margin, rect.top + rect.height / 2));
		this.palette.show(doc.body, x, y, this.settings.handedness);
	}

	private pushUndo(entry: UndoEntry) {
		this.undoController.push(entry);
	}

	private startClearFlow(pdfPath: string) {
		new ConfirmClearModal(this.app, pdfPath, () => this.applyClear(pdfPath)).open();
	}

	private applyClear(pdfPath: string) {
		const operations = collectClearOperations(pdfPath, this.strokes.asMap());
		const totalStrokes = countStrokes(operations);
		if (totalStrokes === 0) return;
		for (const entry of toUndoEntries(pdfPath, operations)) {
			this.pushUndo(entry);
			this.strokes.clearKey(entry.key);
		}
		this.scheduleSave(pdfPath);
		this.overlays.redrawOverlaysForActivePdf();
		new Notice(
			`Jot: cleared ${totalStrokes} stroke${totalStrokes === 1 ? '' : 's'}. Undo to restore.`,
		);
	}
}
