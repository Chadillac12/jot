import {
	ButtonComponent,
	DropdownComponent,
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
	parseJotNoteText,
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
		const path = this.file?.path;
		if (path) {
			this.note = {
				...this.note,
				pages: this.note.pages.map((page) => ({
					...page,
					strokes: [...this.strokes.forKey(documentPageKey(path, page.id))],
				})),
			};
		}
		return serializeJotNote(this.note);
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.resetState();
		this.note = parseJotNoteText(data);
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

	getUndoController(): UndoController | null {
		return this.undoController;
	}

	redrawAll(): void {
		this.surface?.redrawAll();
	}

	private resetState(): void {
		this.surface?.disconnect();
		this.note = createJotNote();
		this.strokes = new StrokeStore();
		this.history = new UndoHistory();
		this.undoController = null;
	}

	private loadStrokesFromNote(): void {
		const path = this.file?.path;
		if (!path) return;
		this.strokes = new StrokeStore();
		for (const page of this.note.pages) {
			this.strokes.setForKey(documentPageKey(path, page.id), [...page.strokes]);
		}
	}

	private render(): void {
		const path = this.file?.path;
		if (!path) return;

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
				activeDocumentPath: () => this.file?.path ?? null,
				onAfterApply: () => this.requestSave(),
			},
		);

		this.surface.render(this.note, path);
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
		if (this.note.paper === style) return;
		this.note = { ...this.note, paper: style };
		this.render();
		this.requestSave();
	}

	private addPage(): void {
		const page = createJotPage(nextPageId(this.note.pages));
		this.note = { ...this.note, pages: [...this.note.pages, page] };
		this.render();
		this.requestSave();
		const pages = this.pagesEl?.querySelectorAll<HTMLElement>('.jot-note-page');
		pages?.[pages.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
}
