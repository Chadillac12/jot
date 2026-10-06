import { App, ColorComponent, PluginSettingTab, Setting } from 'obsidian';
import {
	DEFAULT_HIGHLIGHTER_MEMORY,
	DEFAULT_PEN_MEMORY,
	DEFAULT_TOOL_STATE,
	Handedness,
	PALETTE_COLORS,
	ToolMemory,
	ToolState,
} from './palette';
import {
	DEFAULT_PALETTE_PREFERENCES,
	normalizePalettePreferences,
	type FloatingPaletteButtonPosition,
	type PaletteActivation,
	type PalettePreferences,
} from './palette-activation';
import type JotPlugin from './main';

export type { Handedness };

export interface JotSettings extends PalettePreferences {
	handedness: Handedness;
	toolState: ToolState;
	penState: ToolMemory;
	highlighterState: ToolMemory;
	colors: string[];
	inkSmoothing: number;
	pressureSensitivity: number;
}

export const DEFAULT_SETTINGS: JotSettings = {
	handedness: 'right',
	toolState: { ...DEFAULT_TOOL_STATE },
	penState: { ...DEFAULT_PEN_MEMORY },
	highlighterState: { ...DEFAULT_HIGHLIGHTER_MEMORY },
	colors: [...PALETTE_COLORS],
	inkSmoothing: 0.5,
	pressureSensitivity: 0.5,
	...DEFAULT_PALETTE_PREFERENCES,
};

export function normalizeJotSettings(stored: unknown): JotSettings {
	const raw = isRecord(stored) ? stored : {};
	const palettePreferences = normalizePalettePreferences(raw);
	return {
		...DEFAULT_SETTINGS,
		...palettePreferences,
		handedness: raw.handedness === 'left' ? 'left' : 'right',
		toolState: normalizeToolState(raw.toolState, DEFAULT_TOOL_STATE),
		penState: normalizeToolMemory(raw.penState, DEFAULT_PEN_MEMORY),
		highlighterState: normalizeToolMemory(raw.highlighterState, DEFAULT_HIGHLIGHTER_MEMORY),
		colors: normalizeColors(raw.colors),
		inkSmoothing: normalizeUnitInterval(raw.inkSmoothing, DEFAULT_SETTINGS.inkSmoothing),
		pressureSensitivity: normalizeUnitInterval(
			raw.pressureSensitivity,
			DEFAULT_SETTINGS.pressureSensitivity,
		),
	};
}

function normalizeToolState(value: unknown, fallback: ToolState): ToolState {
	if (!isRecord(value)) return { ...fallback };
	const tool =
		value.tool === 'pen' || value.tool === 'highlighter' || value.tool === 'eraser'
			? value.tool
			: fallback.tool;
	return {
		tool,
		color: normalizeColor(value.color, fallback.color),
		width: normalizeWidth(value.width, fallback.width),
	};
}

function normalizeToolMemory(value: unknown, fallback: ToolMemory): ToolMemory {
	if (!isRecord(value)) return { ...fallback };
	return {
		color: normalizeColor(value.color, fallback.color),
		width: normalizeWidth(value.width, fallback.width),
	};
}

function normalizeColors(value: unknown): string[] {
	const incoming = Array.isArray(value) ? value : [];
	return PALETTE_COLORS.map((fallback, index) => normalizeColor(incoming[index], fallback));
}

function normalizeColor(value: unknown, fallback: string): string {
	return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
		? value
		: fallback;
}

function normalizeWidth(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 0.1
		? value
		: fallback;
}

function normalizeUnitInterval(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export class JotSettingTab extends PluginSettingTab {
	plugin: JotPlugin;

	constructor(app: App, plugin: JotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Handedness')
			.setDesc(
				"The palette fans away from your pen hand so it doesn't sit under your wrist.",
			)
			.addDropdown((d) =>
				d
					.addOption('right', 'Right-handed')
					.addOption('left', 'Left-handed')
					.setValue(this.plugin.settings.handedness)
					.onChange(async (value) => {
						this.plugin.settings.handedness = value as Handedness;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Palette activation')
			.setDesc(
				'Double-tap + hold: make one quick pencil-tip tap, then press nearby again and hold briefly. Normal pencil holds always keep writing.',
			)
			.addDropdown((d) =>
				d
					.addOption('pencil-double-tap-hold', 'Pencil double-tap + hold (recommended)')
					.addOption('two-finger', 'Two-finger hold')
					.addOption('both', 'Pencil double-tap + hold + two-finger hold')
					.setValue(this.plugin.settings.paletteActivation)
					.onChange(async (value) => {
						this.plugin.settings.paletteActivation = value as PaletteActivation;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Floating palette button')
			.setDesc('Show a small edge button on the active ink view as a gesture-free fallback.')
			.addDropdown((d) =>
				d
					.addOption('off', 'Off')
					.addOption('left', 'Left edge')
					.addOption('right', 'Right edge')
					.setValue(this.plugin.settings.floatingPaletteButtonPosition)
					.onChange(async (value) => {
						this.plugin.settings.floatingPaletteButtonPosition =
							value as FloatingPaletteButtonPosition;
						await this.plugin.saveSettings();
						this.plugin.refreshFloatingPaletteButton();
					}),
			);

		new Setting(containerEl)
			.setName('Apple pencil pro squeeze')
			.setDesc(
				'Optional: assign pencil pro squeeze to an ipad shortcut that opens Obsidian://jot-palette.',
			);

		new Setting(containerEl)
			.setName('Stroke smoothing')
			.setDesc('Balances steadier handwriting against stylus responsiveness. 50% is the recommended starting point.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.inkSmoothing)
					.onChange(async (value) => {
						this.plugin.settings.inkSmoothing = value;
						this.plugin.applyInkSettings();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Pressure sensitivity')
			.setDesc('Controls how strongly stylus pressure changes pen thickness.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.pressureSensitivity)
					.onChange(async (value) => {
						this.plugin.settings.pressureSensitivity = value;
						this.plugin.applyInkSettings();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Palette colors')
			.setDesc('The seven swatches shown in the color sub-arc.')
			.setHeading();

		const pickers: ColorComponent[] = [];
		PALETTE_COLORS.forEach((_, index) => {
			new Setting(containerEl)
				.setName(`Color ${index + 1}`)
				.addColorPicker((picker) => {
					pickers[index] = picker;
					picker
						.setValue(this.plugin.settings.colors[index] ?? PALETTE_COLORS[index]!)
						.onChange(async (value) => {
							this.plugin.settings.colors[index] = value;
							await this.plugin.saveSettings();
						});
				});
		});

		new Setting(containerEl).addButton((button) =>
			button.setButtonText('Reset palette colors to defaults').onClick(async () => {
				this.plugin.settings.colors = [...PALETTE_COLORS];
				await this.plugin.saveSettings();
				PALETTE_COLORS.forEach((color, i) => {
					pickers[i]?.setValue(color);
				});
			}),
		);
	}
}
