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
	FloatingPaletteButtonPosition,
	MAX_PENCIL_LONG_PRESS_MS,
	MIN_PENCIL_LONG_PRESS_MS,
	PaletteActivation,
	PalettePreferences,
} from './palette-activation';
import type JotPlugin from './main';

export type { Handedness };

export interface JotSettings extends PalettePreferences {
	handedness: Handedness;
	toolState: ToolState;
	penState: ToolMemory;
	highlighterState: ToolMemory;
	colors: string[];
}

export const DEFAULT_SETTINGS: JotSettings = {
	handedness: 'right',
	toolState: { ...DEFAULT_TOOL_STATE },
	penState: { ...DEFAULT_PEN_MEMORY },
	highlighterState: { ...DEFAULT_HIGHLIGHTER_MEMORY },
	colors: [...PALETTE_COLORS],
	...DEFAULT_PALETTE_PREFERENCES,
};

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
				'Apple Pencil strokes start immediately unless Pencil long-press is enabled. Mouse long-press remains available on desktop.',
			)
			.addDropdown((d) =>
				d
					.addOption('two-finger', 'Two-finger hold (recommended)')
					.addOption('pencil-long-press', 'Pencil long-press')
					.addOption('both', 'Both')
					.setValue(this.plugin.settings.paletteActivation)
					.onChange(async (value) => {
						this.plugin.settings.paletteActivation = value as PaletteActivation;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Pencil long-press duration')
			.setDesc('Advanced: delay before the palette opens when Pencil long-press is enabled.')
			.addSlider((slider) =>
				slider
					.setLimits(MIN_PENCIL_LONG_PRESS_MS, MAX_PENCIL_LONG_PRESS_MS, 50)
					.setValue(this.plugin.settings.pencilLongPressMs)
					.onChange(async (value) => {
						this.plugin.settings.pencilLongPressMs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Floating palette button')
			.setDesc('Show a small edge button on the active PDF. Select Off to hide it.')
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
			.setName('Apple Pencil Pro squeeze')
			.setDesc(
				'Optional: assign Pencil Pro squeeze to an iPad Shortcut that opens obsidian://jot-palette. This opens the existing radial palette without enabling Pencil long-press.',
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
