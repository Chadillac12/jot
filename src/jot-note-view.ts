import {
	ButtonComponent,
	DropdownComponent,
	Notice,
	TFile,
	TextFileView,
	type IconName,
	type WorkspaceLeaf,
} from 'obsidian';
import {
	JOT_NOTE_VIEW_TYPE,
	createJotPage,
	nextPageId,
	type JotPaperStyle,
} from './jot-note-file';
import { JotNoteSurface } from './jot-note-surface';
import type { NotebookDocumentSession, NotebookSessionChange } from './notebook-session';
import { UndoController } from './undo-controller';
import type JotPlugin from './main';

export class JotNoteView extends TextFileView {
	private session: NotebookDocumentSession | null = null;
	private surface: JotNoteSurface | null = null;
	private undoController: UndoController | null = null;
	private pagesEl: HTMLElement | null = null;
	private unsubscribeSession: (() => void) | null = null;

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
		return this.session?.serialize() ?? this.data;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.detachViewState();
		this.data = data;
		const path = this.file?.path;
		if (!path) return;

		this.attachSession(this.plugin.getNotebookSession(path));
		const status = this.session?.load(data) ?? 'protected';
		if (status === 'protected') {
			this.renderLoadError(
				this.session?.loadError ??
					'This notebook could not be safely loaded. The original file is unchanged.',
			);
			return;
		}
		if (status === 'conflict') {
			this.renderConflict();
			return;
		}
		this.render();
	}

	override async save(clear = false): Promise<void> {
		const session = this.session;
		const file = this.file;
		if (!session || !file) {
			await super.save(clear);
			return;
		}
		if (session.state.state === 'conflict') {
			new Notice('Jot: notebook save blocked because an external edit conflicts with unsaved ink.');
			this.renderConflict();
			return;
		}

		const success = await this.plugin.saveNotebookSession(file, session);
		if (success) {
			this.data = session.rawData;
			if (clear) this.clear();
			return;
		}

		if (session.state.snapshot().state === 'conflict') {
			this.renderConflict();
			return;
		}
		new Notice(
			'Jot: notebook save failed. Changes remain dirty and jot will retry automatically.',
			8000,
		);
	}

	clear(): void {
		this.surface?.disconnect();
		this.surface = null;
		this.pagesEl = null;
		this.contentEl.empty();
		this.detachViewState();
	}

	override async onClose(): Promise<void> {
		try {
			if (this.session?.state.isDirty && this.session.state.state !== 'conflict') {
				await this.save();
			}
		} finally {
			this.surface?.disconnect();
			this.detachViewState();
			await super.onClose();
		}
	}

	override async onRename(file: TFile): Promise<void> {
		const oldPath = this.session?.path ?? this.file?.path;
		if (oldPath && oldPath !== file.path) {
			this.attachSession(this.plugin.renameNotebookSession(oldPath, file.path));
		}
		await super.onRename(file);
		this.render();
	}

	getUndoController(): UndoController | null {
		return this.session?.loadError ? null : this.undoController;
	}

	redrawAll(): void {
		if (!this.session?.loadError) this.surface?.redrawAll();
	}

	private attachSession(session: NotebookDocumentSession): void {
		if (this.session === session) return;
		this.unsubscribeSession?.();
		this.session = session;
		this.unsubscribeSession = session.subscribe((change) => this.onSessionChange(change));
	}

	private detachViewState(): void {
		this.unsubscribeSession?.();
		this.unsubscribeSession = null;
		this.undoController = null;
		this.session = null;
	}

	private onSessionChange(change: NotebookSessionChange): void {
		if (change === 'ink') {
			this.surface?.redrawAll();
			return;
		}
		if (change === 'save-error') return;
		if (change === 'conflict') {
			this.renderConflict();
			return;
		}
		this.render();
	}

	private render(): void {
		const session = this.session;
		if (!session || session.loadError) return;

		this.surface?.disconnect();
		this.contentEl.empty();
		this.contentEl.addClass('jot-note-view');

		const toolbar = this.contentEl.createDiv({ cls: 'jot-note-toolbar' });
		this.renderToolbar(toolbar);

		this.pagesEl = this.contentEl.createDiv({ cls: 'jot-note-pages' });
		this.surface = new JotNoteSurface(this.pagesEl, session.strokes, (canvas) => {
			if (!this.surface || !this.undoController) return;
			this.plugin.wireInkCanvas(
				canvas,
				this.surface,
				{
					scheduleSave: () => {
						session.markDirty('ink');
						this.requestSave();
					},
				},
				this.undoController,
				session.strokes,
			);
		});

		this.undoController = new UndoController(
			session.history,
			session.strokes,
			this.surface,
			{
				activeDocumentPath: () => session.path,
				onAfterApply: () => {
					session.markDirty('ink');
					this.requestSave();
				},
			},
		);

		this.surface.render(session.note, session.path);
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

	private renderConflict(): void {
		this.surface?.disconnect();
		this.surface = null;
		this.contentEl.empty();
		this.contentEl.addClass('jot-note-view');
		const panel = this.contentEl.createDiv({ cls: 'jot-note-load-error' });
		panel.createEl('h3', { text: 'Jot note has a sync conflict' });
		panel.createEl('p', {
			text: 'The file changed on disk while local handwriting was unsaved. Local ink remains in memory and jot has blocked automatic overwrite.',
		});
		new ButtonComponent(panel)
			.setButtonText('Keep local ink')
			.setTooltip('Resolve the conflict by keeping the current in-memory notebook')
			.onClick(() => {
				this.session?.resolveConflictKeepLocal();
				this.session?.markDirty('structure');
				this.render();
				this.requestSave();
			});
	}

	private renderToolbar(toolbar: HTMLElement): void {
		const session = this.session;
		if (!session) return;
		const paperWrap = toolbar.createDiv({ cls: 'jot-note-toolbar-group' });
		paperWrap.createSpan({ text: 'Paper' });
		new DropdownComponent(paperWrap)
			.addOption('blank', 'Blank')
			.addOption('ruled', 'Ruled')
			.addOption('grid', 'Grid')
			.addOption('dot', 'Dot')
			.setValue(session.note.paper)
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
		const session = this.session;
		if (!session || session.loadError || session.note.paper === style) return;
		session.note = { ...session.note, paper: style };
		this.surface?.setPaperStyle(style);
		session.markDirty('structure');
		this.requestSave();
	}

	private addPage(): void {
		const session = this.session;
		if (!session || session.loadError) {
			new Notice('Jot: this notebook is read-only because its data could not be validated.');
			return;
		}
		const page = createJotPage(nextPageId(session.note.pages));
		session.note = { ...session.note, pages: [...session.note.pages, page] };
		session.markDirty('structure');
		this.requestSave();
		const pages = this.pagesEl?.querySelectorAll<HTMLElement>('.jot-note-page');
		pages?.[pages.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
}
