import {
	ButtonComponent,
	DropdownComponent,
	Notice,
	TFile,
	TextFileView,
	type IconName,
	type WorkspaceLeaf,
} from 'obsidian';
import { documentPageKey } from './jot-file';
import {
	JOT_NOTE_VIEW_TYPE,
	createJotPage,
	createJotNote,
	nextPageId,
	parseJotNoteTextResult,
	serializeJotNote,
	type JotNoteFile,
	type JotPaperStyle,
} from './jot-note-file';
import { JotNoteSurface } from './jot-note-surface';
import { StrokeStore } from './stroke-store';
import { UndoController } from './undo-controller';
import { UndoHistory } from './undo';
import type JotPlugin from './main';

export class JotNoteView extends TextFileView {
	private note: JotNoteFile = createJotNote();
	private strokes = new StrokeStore();
	private history = new UndoHistory();
	private surface: JotNoteSurface | null = null;
	private undoController: UndoController | null = null;
	private pagesEl: HTMLElement | null = null;
	private documentPath: string | null = null;
	private rawData = '';
	private loadError: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: JotPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return JOT_NOTE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? 'Jot note';
	}

	getIcon(): IconName {
		return 'pencil';
	}

	getViewData(): string {
		if (this.loadError) {
			this.data = this.rawData;
			return this.rawData;
		}
		const path = this.documentPath ?? this.file?.path;
		if (path) {
			this.note = {
				...this.note,
				pages: this.note.pages.map((page) => ({
					...page,
					strokes: [...this.strokes.forKey(documentPageKey(path, page.id))],
				})),
			};
		}
		this.rawData = serializeJotNote(this.note);
		this.data = this.rawData;
		return this.rawData;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.resetState();
		this.rawData = data;
		this.data = data;
		this.documentPath = this.file?.path ?? this.documentPath;

		const parsed = parseJotNoteTextResult(data);
		if (!parsed.ok) {
			this.loadError = parsed.message;
			this.renderLoadError(parsed.message);
			return;
		}

		this.loadError = null;
		this.note = parsed.note;
		// Disk reloads define a new history boundary. Keeping undo entries from
		// before an external/sync update could resurrect stale strokes.
		this.history = new UndoHistory();
		this.undoController = null;
		this.loadStrokesFromNote();
		this.render();
	}

	clear(): void {
		this.surface?.disconnect();
		this.surface = null;
		this.pagesEl = null;
		this.contentEl.empty();
		this.resetState();
	}

	override async onRename(file: TFile): Promise<void> {
		const oldPath = this.documentPath;
		const newPath = file.path;
		if (!this.loadError && oldPath && oldPath !== newPath) {
			this.strokes.rekeyDocumentPath(oldPath, newPath);
			this.history.rekeyPath(oldPath, newPath);
		}
		this.documentPath = newPath;
		await super.onRename(file);
		if (!this.loadError) this.render();
	}

	getUndoController(): UndoController | null {
		return this.loadError ? null : this.undoController;
	}

	redrawAll(): void {
		if (!this.loadError) this.surface?.redrawAll();
	}

	private resetState(): void {
		this.surface?.disconnect();
		this.note = createJotNote();
		this.strokes = new StrokeStore();
		this.history = new UndoHistory();
		this.undoController = null;
		this.documentPath = null;
		this.rawData = '';
		this.data = '';
		this.loadError = null;
	}

	private loadStrokesFromNote(): void {
		const path = this.documentPath ?? this.file?.path;
		if (!path) return;
		this.strokes = new StrokeStore();
		for (const page of this.note.pages) {
			this.strokes.setForKey(documentPageKey(path, page.id), [...page.strokes]);
		}
	}

	private render(): void {
		const path = this.documentPath ?? this.file?.path;
		if (!path || this.loadError) return;

		this.surface?.disconnect();
		this.contentEl.empty();
		this.contentEl.addClass('jot-note-view');

		const toolbar = this.contentEl.createDiv({ cls: 'jot-note-toolbar' });
		this.renderToolbar(toolbar);

		this.pagesEl = this.contentEl.createDiv({ cls: 'jot-note-pages' });
		this.surface = new JotNoteSurface(this.pagesEl, this.strokes, (canvas) => {
			if (!this.surface || !this.undoController) return;
			this.plugin.wireInkCanvas(
				canvas,
				this.surface,
				{ scheduleSave: () => this.requestSave() },
				this.undoController,
				this.strokes,
			);
		});

		this.undoController = new UndoController(
			this.history,
			this.strokes,
			this.surface,
			{
				activeDocumentPath: () => this.documentPath ?? this.file?.path ?? null,
				onAfterApply: () => this.requestSave(),
			},
		);

		this.surface.render(this.note, path);
	}

	private renderLoadError(message: string): void {
		this.surface?.disconnect();
		this.surface = null;
		this.pagesEl = null;
		this.contentEl.empty();
		this.contentEl.addClass('jot-note-view');

		const panel = this.contentEl.createDiv({ cls: 'jot-note-load-error' });
		panel.createEl('h3', { text: 'Jot note opened read-only' });
		panel.createEl('p', { text: message });
		panel.createEl('p', {
			text: 'Jot will preserve the original file exactly and will not convert or overwrite it.',
		});
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const paperWrap = toolbar.createDiv({ cls: 'jot-note-toolbar-group' });
		paperWrap.createSpan({ text: 'Paper' });
		new DropdownComponent(paperWrap)
			.addOption('blank', 'Blank')
			.addOption('ruled', 'Ruled')
			.addOption('grid', 'Grid')
			.addOption('dot', 'Dot')
			.setValue(this.note.paper)
			.onChange((value) => this.setPaperStyle(value as JotPaperStyle));

		new ButtonComponent(toolbar)
			.setButtonText('Add page')
			.setTooltip('Add a new handwritten page')
			.onClick(() => this.addPage());

		new ButtonComponent(toolbar)
			.setButtonText('Undo')
			.setTooltip('Undo the last ink change')
			.onClick(() => this.undoController?.undo());

		new ButtonComponent(toolbar)
			.setButtonText('Redo')
			.setTooltip('Redo the last ink change')
			.onClick(() => this.undoController?.redo());
	}

	private setPaperStyle(style: JotPaperStyle): void {
		if (this.loadError || this.note.paper === style) return;
		this.note = { ...this.note, paper: style };
		this.surface?.setPaperStyle(style);
		this.requestSave();
	}

	private addPage(): void {
		if (this.loadError) {
			new Notice('Jot: this notebook is read-only because its data could not be validated.');
			return;
		}
		const page = createJotPage(nextPageId(this.note.pages));
		this.note = { ...this.note, pages: [...this.note.pages, page] };
		this.render();
		this.requestSave();
		const pages = this.pagesEl?.querySelectorAll<HTMLElement>('.jot-note-page');
		pages?.[pages.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
}
