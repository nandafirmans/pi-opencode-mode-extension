# pi-opencode-mode-extension

OpenCode-style **Build / Plan** mode extension for Pi.

## Features

- Two modes only:
  - `build`: normal Pi behavior
  - `plan`: read-only planning and analysis
- Mode switch:
  - `Ctrl+Alt+P`
  - `/plan`, `/build`, `/mode` commands
- Status badge:
  - `⚒ BUILD`
  - `⏸ PLAN`
- Plan mode safety:
  - blocks `edit`
  - blocks `write`
  - guards `bash` with strict allowlist
  - supports safe RTK wrappers
- Fixes known plan→build problems:
  - filters stale plan context in build mode
  - injects plan→build handoff reminder
  - requires fresh `read` before editing existing files after plan→build

## Install

Install from npm:

```bash
pi install npm:pi-opencode-mode-extension
```

Try without installing:

```bash
pi -e npm:pi-opencode-mode-extension
```

Update after a new npm release:

```bash
pi update npm:pi-opencode-mode-extension
```

Local development from this repo:

```bash
pi --extension ./src/index.ts
```

## Usage

Switch to plan mode:

```text
/plan
```

Switch to build mode:

```text
/build
```

Select mode:

```text
/mode
```

Toggle mode:

```text
Ctrl+Alt+P
```

Start Pi in plan mode after installing:

```bash
pi --plan
```

Start Pi in plan mode from this repo:

```bash
pi --extension ./src/index.ts --plan
```

## Plan mode prompt behavior

In plan mode, the extension injects hidden context telling the agent to:

- inspect only
- avoid file changes
- prefer read-only RTK wrappers
- produce concrete plan with risks and verification

## Safe RTK commands in plan mode

Allowed examples:

```text
rtk read
rtk find
rtk grep
rtk ls
rtk tree
rtk diff
rtk wc
rtk json
rtk err
rtk git status
rtk git diff
rtk git log
rtk git show
rtk npm list
rtk npm outdated
rtk npm view
rtk npm info
rtk tsc --noEmit
rtk lint --check
rtk test --list
```

Blocked examples:

```text
rtk edit
rtk write
rtk rm
rtk mv
rtk cp
rtk npm install
rtk pnpm add
rtk lint --fix
rtk format --write
rtk test
```

Also blocked in plan mode:

```text
> >> --fix --write --apply --delete --force -i
```

## Safety model

Tool hiding is UX. Tool-call guard is security.

The extension may hide mutating tools in plan mode, but safety is enforced by `tool_call` blocking.

## Notes

`Ctrl+Alt+P` is the only keyboard shortcut. Use `/plan`, `/build`, or `/mode` if your terminal intercepts it.

Do not load this package together with another OpenCode/plan-mode extension. If you previously used a local extension like `~/.pi/agent/extensions/opencode-mode.ts`, disable or remove it before installing this package.
