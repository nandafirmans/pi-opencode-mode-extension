/**
 * OpenCode-style Build/Plan mode for Pi.
 *
 * Modes:
 * - BUILD: normal Pi behavior
 * - PLAN: read-only planning, safe bash/RTK allowlist, no edit/write
 *
 * Shortcuts:
 * - Ctrl+Alt+P: toggle mode
 * Commands:
 * - /plan, /build, /mode
 */

import fs from "node:fs";
import path from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

type Mode = "build" | "plan";

type ModeEntry = {
	type?: string;
	customType?: string;
	data?: {
		mode?: Mode;
	};
};

const CUSTOM_MODE_ENTRY = "opencode-mode-state";
const PLAN_CONTEXT_TYPE = "opencode-plan-context";
const BUILD_HANDOFF_TYPE = "opencode-build-handoff";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

const SAFE_SHELL_PATTERNS = [
	/^\s*(ls|pwd|cat|head|tail|less|more|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime)\b/,
	/^\s*(grep|rg|find|fd)\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote)\b/i,
	/^\s*git\s+config\s+--get\b/i,
	/^\s*(npm|pnpm|yarn)\s+(list|ls|view|info|outdated|why)\b/i,
	/^\s*(node|python|python3)\s+--version\b/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/,
];

const SAFE_RTK_PATTERNS = [
	/^\s*rtk\s+(read|find|grep|ls|tree|diff|wc|json|err)\b/,
	/^\s*rtk\s+git\s+(status|diff|log|show)\b/i,
	/^\s*rtk\s+npm\s+(list|outdated|view|info)\b/i,
	/^\s*rtk\s+tsc\s+--noEmit\b/i,
	/^\s*rtk\s+lint\s+--check\b/i,
	/^\s*rtk\s+test\s+--list\b/i,
];

const BLOCKED_COMMAND_PATTERNS = [
	/(^|[^<])>(?!>)/,
	/>>/,
	/\b(--fix|--write|--apply|--delete|--force)\b/i,
	/(^|\s)-i(\s|$)/,
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/i,
	/\b(git)\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\b(npm|pnpm|yarn)\s+(install|add|remove|update|ci|publish|link)\b/i,
	/\b(pip|pip3)\s+(install|uninstall)\b/i,
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\b(sed\s+-i|perl\s+-p?i)\b/i,
	/\b(open\s*\([^)]*["']w|writeFileSync|writeFile|appendFileSync|appendFile)\b/i,
	/\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b/i,
];

function isSafePlanCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;

	// Keep plan mode conservative: default deny shell composition because it can hide writes.
	if (/[;&|`]|\$\(/.test(trimmed)) return false;

	return [...SAFE_SHELL_PATTERNS, ...SAFE_RTK_PATTERNS].some((pattern) => pattern.test(trimmed));
}

function normalizeToolPath(filePath: unknown): string | undefined {
	if (typeof filePath !== "string" || filePath.trim().length === 0) return undefined;
	return path.resolve(process.cwd(), filePath);
}

function fileExists(filePath: string): boolean {
	try {
		return fs.existsSync(filePath);
	} catch {
		return true;
	}
}

function isModeToggleKey(data: string): boolean {
	return matchesKey(data, Key.ctrlAlt("p")) || data === "\x1b\x10";
}

class ToggleEditor extends CustomEditor {
	constructor(
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		private readonly toggleMode: () => void,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (isModeToggleKey(data)) {
			this.toggleMode();
			return;
		}
		super.handleInput(data);
	}
}

class ToggleEditorWrapper implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly base: Component & Partial<Focusable>,
		private readonly toggleMode: () => void,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if ("focused" in this.base) {
			this.base.focused = value;
		}
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	handleInput(data: string): void {
		if (isModeToggleKey(data)) {
			this.toggleMode();
			return;
		}
		this.base.handleInput?.(data);
	}

	invalidate(): void {
		this.base.invalidate();
	}
}

export default function opencodeModeExtension(pi: ExtensionAPI): void {
	let mode: Mode = "build";
	let previousTools: string[] | undefined;
	let freshReadRequired = false;
	let readFilesAfterBuildSwitch = new Set<string>();

	pi.registerFlag("plan", {
		description: "Start in OpenCode-style plan mode",
		type: "boolean",
		default: false,
	});

	function persistMode(): void {
		pi.appendEntry(CUSTOM_MODE_ENTRY, { mode });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (mode === "plan") {
			ctx.ui.setStatus("opencode-mode", ctx.ui.theme.fg("warning", "⏸ PLAN"));
		} else {
			ctx.ui.setStatus("opencode-mode", ctx.ui.theme.fg("accent", "⚒ BUILD"));
		}
	}

	function applyToolVisibility(): void {
		if (mode === "plan") {
			previousTools ??= pi.getActiveTools();
			pi.setActiveTools(PLAN_TOOLS);
			return;
		}

		if (previousTools) {
			pi.setActiveTools(previousTools);
			previousTools = undefined;
		}
	}

	function switchMode(ctx: ExtensionContext, nextMode: Mode, notify = true): void {
		const previousMode = mode;
		mode = nextMode;

		if (previousMode === "plan" && nextMode === "build") {
			freshReadRequired = true;
			readFilesAfterBuildSwitch = new Set<string>();
			pi.sendMessage(
				{
					customType: BUILD_HANDOFF_TYPE,
					content: `[MODE SWITCH: PLAN → BUILD]\n\nYou may now edit files. Before editing any file from the plan, re-read the current file contents, confirm assumptions still hold, then implement.`,
					display: false,
				},
				{ triggerTurn: false },
			);
		}

		if (nextMode === "plan") {
			freshReadRequired = false;
			readFilesAfterBuildSwitch = new Set<string>();
		}

		applyToolVisibility();
		updateStatus(ctx);
		persistMode();

		if (notify) {
			ctx.ui.notify(
				nextMode === "plan"
					? "Plan mode: read-only. Use /build or Ctrl+Alt+P to build."
					: "Build mode: full tools restored. Re-read planned files before editing.",
				"info",
			);
		}
	}

	function toggleMode(ctx: ExtensionContext): void {
		switchMode(ctx, mode === "build" ? "plan" : "build");
	}

	pi.registerCommand("plan", {
		description: "Switch to OpenCode-style plan mode (read-only)",
		handler: async (_args, ctx) => switchMode(ctx, "plan"),
	});

	pi.registerCommand("build", {
		description: "Switch to OpenCode-style build mode",
		handler: async (_args, ctx) => switchMode(ctx, "build"),
	});

	pi.registerCommand("mode", {
		description: "Select OpenCode-style mode",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select(`Current mode: ${mode.toUpperCase()}`, ["Build", "Plan"]);
			if (choice === "Build") switchMode(ctx, "build");
			if (choice === "Plan") switchMode(ctx, "plan");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle build/plan mode",
		handler: async (ctx) => toggleMode(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			mode = "plan";
		}

		const entries = ctx.sessionManager.getEntries() as ModeEntry[];
		const latestModeEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_MODE_ENTRY)
			.pop();
		if (latestModeEntry?.data?.mode === "build" || latestModeEntry?.data?.mode === "plan") {
			mode = latestModeEntry.data.mode;
		}

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			if (previousFactory) {
				return new ToggleEditorWrapper(previousFactory(tui, theme, keybindings), () => toggleMode(ctx));
			}
			return new ToggleEditor(tui, theme, keybindings, () => toggleMode(ctx));
		});

		applyToolVisibility();
		updateStatus(ctx);
	});

	pi.on("context", async (event) => {
		if (mode === "plan") return;

		return {
			messages: event.messages.filter((message: unknown) => {
				const typed = message as { customType?: string };
				return typed.customType !== PLAN_CONTEXT_TYPE;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (mode !== "plan") return;

		return {
			message: {
				customType: PLAN_CONTEXT_TYPE,
				content: `[MODE: PLAN]\n\nYou are in read-only planning mode.\n\nRules:\n- Inspect and reason only. Do not modify files.\n- Do not use edit/write or mutating shell commands.\n- Prefer RTK read-only wrappers when available: rtk read, rtk grep, rtk find, rtk ls, rtk tree, rtk git diff/status/log/show.\n- Do not use RTK mutation/fix/write commands in plan mode.\n- If implementation is requested, first produce a concrete plan.\n\nEnd with this format when ready:\n\nPlan:\n1. ...\n2. ...\n3. ...\n\nRisks:\n- ...\n\nVerification:\n- ...`,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event) => {
		const toolName = event.toolName;
		const input = event.input as Record<string, unknown>;

		if (toolName === "read") {
			const normalized = normalizeToolPath(input.path);
			if (normalized && mode === "build" && freshReadRequired) {
				readFilesAfterBuildSwitch.add(normalized);
			}
			return;
		}

		if (mode === "plan") {
			if (toolName === "edit" || toolName === "write") {
				return {
					block: true,
					reason: "PLAN mode is read-only. Switch to BUILD with /build or Ctrl+Alt+P before editing.",
				};
			}

			if (toolName === "bash") {
				const command = String(input.command ?? "");
				if (!isSafePlanCommand(command)) {
					return {
						block: true,
						reason: `PLAN mode blocked this shell command. Use read-only commands/RTK wrappers, or switch to BUILD with /build.\n\nAllowed examples: rtk read, rtk grep, rtk find, rtk ls, rtk tree, rtk git diff/status/log/show.\n\nCommand: ${command}`,
					};
				}
			}

			return;
		}

		if (mode === "build" && freshReadRequired && (toolName === "edit" || toolName === "write")) {
			const normalized = normalizeToolPath(input.path);
			if (!normalized) return;

			// New files cannot be read first. Existing files must be freshly read after PLAN → BUILD.
			if (toolName === "write" && !fileExists(normalized)) return;

			if (!readFilesAfterBuildSwitch.has(normalized)) {
				return {
					block: true,
					reason: `Fresh read required after PLAN → BUILD before ${toolName}. Use read on this file, then retry ${toolName} once.\n\nFile: ${String(input.path)}`,
				};
			}
		}
	});
}
