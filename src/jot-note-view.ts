import {
	ButtonComponent,
	DropdownComponent,
	Notice,
	TFile,
	TextFileView,
	type IconName,
	type WorkspaceLeaf,
} from 'obsidian';
import type { NotebookDocumentSession, SessionChange } from './document-session';
import {
	JOT_NOTE_VIEW_TYPE,
	createJotPage,
	nextPageId,
	type JotPaperStyle,
} from './jot-note-file';
import { JotNoteSurface } from './jot-note-surface';
import { UndoController } from './undo-controller';
import type JotPlugin from './main';

const NOTE_SAVE_RETRY_MS = 2000;
const MAX_NOTE_SAVE_RETRIES = 3;

export class JotNoteView extends TextFileView {
	private session: NotebookDocumentSession | null = null;
	private surface: JotNoteSurface | null = null;
	private undoController: UndoController | null = null;
	private pagesEl: HTMLElement | null = null;
	private unsubscribeSession: (() => void) | null = null;
	private saveRetryCount = 0;
	private saveRetryTimer: number | null = null;

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
		if (!this.session) return this.data ?? '';
		if (this.session.loadError) return this.session.rawData;
		return this.session.serializeCurrent();
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.detachViewState();
		const path = this.file?.path;
		if (!path) {
			this.data = data;
			return;
		}

		const session = this.plugin.getNotebookSession(path);
		this.attachSession(session);
		const result = session.loadText(data);

		if (result === 'invalid') {
			this.data = session.rawData;
			this.renderLoadError(session.loadError ?? 'This Jot notebook could not be validated.');
			return;
		}
		if (result === 'conflict') {
			this.data = session.rawData;
			new Notice(
				'Jot: this notebook changed on disk while local edits were unsaved. Local edits were kept and the session is marked as conflicted.',
				8000,
			);
			this.render();
			return;
		}

		this.data = session.rawData;
		this.render();
	}

	override async save(clear?: boolean): Promise<void> {
		const session = this.session;
		if (!session || session.loadError) return;
		const revision = session.beginSave();
		if (revision === null) {
			if (session.state === 'saving') return;
			await super.save(clear);
			return;
		}

		const serialized = session.serializeCurrent();
		try {
			await super.save(clear);
			session.notebookSaveSucceeded(revision, serialized);
			this.data = serialized;
			this.saveRetryCount = 0;
			this.clearSaveRetry();
		} catch (error) {
			session.saveFailed(error);
			this.scheduleSaveRetry();
			new Notice(
				`Jot: notebook save failed and remains dirty — ${error instanceof Error ? error.message : String(error)}`,
				8000,
			);
			throw error;
		}
	}

	clear(): void {
		this.detachViewState();
		this.contentEl.empty();
	}

	override async onRename(file: TFile): Promise<void> {
		const session = this.session;
		const oldPath = session?.path;
		if (session && oldPath && oldPath !== file.path) {
			this.plugin.renameDocumentSession(oldPath, file.path);
		}
		await super.onRename(file);
		this.render();
	}

	getUndoController(): UndoController | null {
		return this.session?.loadError ? null : this.undoController;
	}

	getSessionPath(): string | null {
		return this.session?.path ?? null;
	}

	redrawAll(): void {
		if (!this.session?.loadError) this.surface?.redrawAll();
	}

	refreshFromSharedSession(): void {
		if (!this.session?.loadError) this.render();
	}

	private attachSession(session: NotebookDocumentSession): void {
		if (this.session === session) return;
		this.unsubscribeSession?.();
		this.session = session;
		this.unsubscribeSession = session.subscribe((change) => this.onSessionChange(change));
	}

	private detachViewState(): void {
		this.surface?.disconnect();
		this.surface = null;
		this.pagesEl = null;
		this.undoController = null;
		this.unsubscribeSession?.();
		this.unsubscribeSession = null;
		this.session = null;
		this.clearSaveRetry();
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
			if (!this.surface || !this.undoController) return () => {};
			return this.plugin.wireInkCanvas(
				canvas,
				this.surface,
				{
					scheduleSave: () => {
						session.markDirty('ink');
						this.requestSave();
						this.plugin.notifyNotebookInkChanged(session.path, this);
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
					this.plugin.notifyNotebookInkChanged(session.path, this);
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
		session.setPaperStyle(style);
		this.surface?.setPaperStyle(style);
		this.plugin.notifyNotebookStructureChanged(session.path, this);
		this.requestSave();
	}

	private addPage(): void {
		const session = this.session;
		if (!session || session.loadError) {
			new Notice('Jot: this notebook is read-only because its data could not be validated.');
			return;
		}
		const page = createJotPage(nextPageId(session.note.pages));
		session.setNote({ ...session.note, pages: [...session.note.pages, page] });
		this.render();
		this.plugin.notifyNotebookStructureChanged(session.path, this);
		this.requestSave();
		const pages = this.pagesEl?.querySelectorAll<HTMLElement>('.jot-note-page');
		pages?.[pages.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	private onSessionChange(change: SessionChange): void {
		if (change === 'rename') this.render();
	}

	private scheduleSaveRetry(): void {
		if (this.saveRetryCount >= MAX_NOTE_SAVE_RETRIES || this.saveRetryTimer !== null) return;
		this.saveRetryCount += 1;
		const win = this.containerEl.ownerDocument.defaultView;
		if (!win) return;
		this.saveRetryTimer = win.setTimeout(() => {
			this.saveRetryTimer = null;
			void this.save();
		}, NOTE_SAVE_RETRY_MS * this.saveRetryCount);
	}

	private clearSaveRetry(): void {
		if (this.saveRetryTimer === null) return;
		this.containerEl.ownerDocument.defaultView?.clearTimeout(this.saveRetryTimer);
		this.saveRetryTimer = null;
	}
}
