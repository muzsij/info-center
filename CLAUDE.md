# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Info Center is a GNOME Shell extension (GNOME 46–49) that displays Claude Code API usage in the top panel, and optionally this month's Redmine time entries per project in the dropdown. It is a private rebrand/fork of [Haletran/claude-usage-extension]. Pure GJS (GNOME JavaScript) — no build step, no package manager, no test suite.

## Install / reload during development

There is no build. The `update.sh` script is the dev loop: it deletes the installed copy, recopies the repo into `~/.local/share/gnome-shell/extensions/info-center@muzsij`, recompiles the GSettings schema, and then prints the reload instructions for the current session type. It deliberately does **not** restart GNOME Shell itself — a detached `gnome-shell --replace` freezes the session on Wayland and can glitch X11 (this is why an earlier version hung the desktop).

```bash
./update.sh       # must be run from the repo root; it `cd ..` then copies the `info-center` dir
```

`./update.sh` only works if the repo directory is named `info-center` (it copies a sibling dir by that literal name). Reloading extension *code* always requires a full shell restart (re-enabling alone doesn't re-import the ESM modules): on **X11** press Alt+F2 → `r`; on **Wayland** there is no in-place reload, so log out and back in.

After editing the schema, you must recompile it or settings reads will fail:
```bash
cd schemas && glib-compile-schemas .
```
`schemas/gschemas.compiled` is gitignored — it is a build artifact, never commit it.

## Architecture

Two entry points, loaded by GNOME Shell into different processes:

- **`extension.js`** — runs in the Shell (compositor) process. `InfoCenterExtension.enable()` creates the panel indicator. `InfoCenterIndicator` (a `PanelMenu.Button`) owns the panel widget, the dropdown menu, the refresh timer, and the `Soup.Session`. This is the only place that touches the network and credentials.
- **`prefs.js`** — runs in a separate preferences process (GTK4/Adwaita, not Shell). It only reads/writes GSettings keys; it shares no runtime state with `extension.js`. The two communicate exclusively through GSettings.

The GSettings schema (`schemas/*.gschema.xml`) is the contract between the two. Adding a setting means: add the key to the schema XML, add a UI row in `prefs.js`, recompile the schema, and (if it affects the panel live) handle it in the `settings.connect('changed', ...)` switch in `extension.js._init`.

### Data flow (extension.js)

1. Timer fires every `refresh-interval` seconds (`_startTimer`).
2. `_refreshUsage()` reads the OAuth token from `$CLAUDE_CONFIG_DIR/.credentials.json` (falls back to `~/.claude/.credentials.json`), at `json.claudeAiOauth.accessToken`.
3. `_fetchUsage(token)` GETs `https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and the `anthropic-beta: oauth-2025-04-20` header.
4. `_updateDisplay(data)` renders `data.five_hour.utilization` and `data.seven_day.utilization` (percentages) into the panel label, panel progress bar, and dropdown.

Usage thresholds drive the `usage-low/medium/high/critical` CSS classes (40/70/90) in `_updateProgressBar` — these class names are defined in `stylesheet.css`.

### Redmine data flow (extension.js)

Optional, off by default. Configured via the `redmine-url`, `redmine-api-key`, `redmine-projects`, and `redmine-project-names` GSettings keys (set from the **Redmine** prefs page).

1. `_refreshRedmine()` runs alongside `_refreshUsage()` — on `_init`, on every timer tick, and whenever a `redmine-*` setting changes. It is a no-op (and hides the menu section) unless URL, API key, and at least one project are all set.
2. `_fetchRedmineTimeEntries()` GETs `<redmine-url>/time_entries.json?user_id=me&from=<1st of month>&to=<today>` with the `X-Redmine-API-Key` header, paging through results (`limit=100`, recursing on `offset`) and summing `hours` per `project.id`.
3. `_updateRedmineDisplay()` renders one row per selected project (name + `H:MM`-formatted hours via `_formatHours`) into the dropdown's Redmine section, falling back to `redmine-project-names` then `Project #<id>` for labels. `_setRedmineMessage` shows errors in the same spot.

Redmine reuses the existing `Soup.Session`, refresh timer, and settings signal — it adds no new resources to tear down in `destroy()`.

The **prefs.js** Redmine page (`_buildRedminePage`) is the only place that fetches the project list: "Fetch projects" (and auto-fetch on tab `map`) calls `_fetchProjects`, which GETs `<redmine-url>/projects.json`, renders a checkbox per project into `redmine-projects`, and caches id→name into `redmine-project-names` so the panel can label projects before its own fetch returns.

### Things that must stay consistent

- **Three display modes** (`text`/`bar`/`both`) are handled in `_updateDisplayMode`, defined in the schema, and selected in `prefs.js`. The index↔string mapping (`['text','bar','both']`) is duplicated in both files — keep them in sync.
- **Lifecycle / leaks:** `destroy()` must stop the timer, abort the Soup session, and disconnect the settings signal. Any new timer, signal connection, or session must be torn down there, or it leaks across enable/disable cycles (a common reason extensions get rejected from extensions.gnome.org).
- **`metadata.json` `version`** is an integer that must be bumped on each release submitted to extensions.gnome.org. `shell-version` lists supported GNOME majors.

## GNOME conventions to follow here

- Async I/O only — use `*_async`/`*_finish` (as `_refreshUsage`/`_fetchUsage` do). Never block the Shell's main loop with sync file or network calls.
- Imports use `gi://` (GObject introspection) and `resource:///org/gnome/shell/...` (Shell internals). These resolve only inside the Shell runtime, not under plain `node`.
- The icon is loaded from disk via `GLib.build_filenamev([extensionPath, ...])`; `extensionPath` comes from `this.path` and is passed into the indicator — don't hardcode paths.
