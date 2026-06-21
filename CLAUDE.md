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

Two entry points, loaded by GNOME Shell into different processes. The Shell-side entry point delegates its dropdown sections and fetch logic to two feature modules:

- **`extension.js`** — runs in the Shell (compositor) process. `InfoCenterExtension.enable()` creates the panel indicator. `InfoCenterIndicator` (a `PanelMenu.Button`) owns the panel widget (icon, label, panel progress bar), the dropdown menu, the refresh timer, the `Soup.Session`, and the settings signal. It builds nothing inside the dropdown itself beyond the footer separator + **Settings** item; it hands the menu to the two modules to populate.
- **`claudeUsage.js`** — the `ClaudeUsage` class. Owns the Claude 5-hour / 7-day dropdown sections and drives the panel label + panel progress bar (those panel widgets are created by the indicator and passed into the constructor, because their placement and visibility are governed by the display mode). Reads credentials, fetches usage, renders. This is the only place that touches the Claude credentials/API.
- **`redmine.js`** — the `Redmine` class. Owns the Redmine dropdown sections (Today / Tomorrow issue lists + this-month per-project time totals), fetches issues and time entries, and renders them. This is the only place that touches Redmine.
- **`prefs.js`** — runs in a separate preferences process (GTK4/Adwaita, not Shell). It only reads/writes GSettings keys; it shares no runtime state with `extension.js`. The two communicate exclusively through GSettings.

Both feature modules receive the `Soup.Session` through a `getSession` getter (`() => this._session`) rather than a stored reference, so when the indicator recreates the session on a proxy change the modules pick up the new session on their next request. They are passed `settings` directly and read their own keys. `Redmine` creates no timers, signals, or sessions of its own. `ClaudeUsage` owns a short-lived auth-retry timer and a `Gio.Cancellable` for its in-flight async I/O (see below) and exposes `destroy()` to tear both down; the indicator's `destroy()` calls `this._claude.destroy()`. All menu items are owned by `this.menu` (destroyed by `super.destroy()`).

The GSettings schema (`schemas/*.gschema.xml`) is the contract between Shell and prefs. Adding a setting means: add the key to the schema XML, add a UI row in `prefs.js`, recompile the schema, and (if it affects the panel live) handle it in the `settings.connect('changed', ...)` switch in `extension.js._init` (which dispatches `redmine-*` keys to `this._redmine.refresh()`).

### Claude usage data flow (claudeUsage.js)

1. The indicator's timer fires every `refresh-interval` seconds (`_startTimer`) and calls `this._claude.refresh()` (also called on `_init` and after a proxy-driven session recreation).
2. `ClaudeUsage.refresh()` reads the OAuth token from `$CLAUDE_CONFIG_DIR/.credentials.json` (falls back to `~/.claude/.credentials.json`), at `json.claudeAiOauth.accessToken`.
3. `_fetchUsage(token)` GETs `https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and the `anthropic-beta: oauth-2025-04-20` header.
4. `_updateDisplay(data)` renders `data.five_hour.utilization` and `data.seven_day.utilization` (percentages) into the panel label, panel progress bar, and dropdown.

Stale-token handling: right after login the on-disk token is often expired (Claude Code refreshes it lazily). `refresh()` skips the request when `claudeAiOauth.expiresAt` is already past, and `_fetchUsage` treats an HTTP 401 the same way — both route into `_handleStaleToken`, which shows a soft "Refreshing…" state (keeping the last good percentages if `_hasData`, but flagging the reset labels so frozen numbers aren't presented as current) and arms a one-shot `_scheduleRetry` timer (`AUTH_RETRY_SECONDS`) that re-reads the credentials file, so a refreshed token is picked up in ~20s instead of waiting a full `refresh-interval`. Both stale paths share one `_authRetries` budget: `_handleStaleToken` counts one retry **per scheduled round** (it no-ops when a retry timer is already pending, so the main timer and retry timer firing together don't burn the budget per-tick) and shows a hard `Error` after `MAX_AUTH_RETRIES`; the counter resets on a successful fetch. `ClaudeUsage` owns two resources, both torn down in `destroy()`: the retry timer (`_clearRetry`) and a `Gio.Cancellable` (`_cancellable`) threaded into the credential read and the usage fetch — `refresh()` cancels the previous one before starting, so overlapping refreshes don't race and callbacks can't `set_text` on widgets `super.destroy()` has disposed.

Usage thresholds drive the `usage-low/medium/high/critical` CSS classes (40/70/90) in `_updateProgressBar` — these class names are defined in `stylesheet.css`.

### Redmine data flow (redmine.js)

Optional, off by default. Configured via the `redmine-url`, `redmine-api-key`, `redmine-projects`, `redmine-project-names`, `redmine-statuses`, and `redmine-tasks-all-projects` GSettings keys (set from the **Redmine** prefs page).

1. `Redmine.refresh()` runs alongside `ClaudeUsage.refresh()` — on `_init`, on every timer tick, and whenever a `redmine-*` setting changes. It hides every section and bails unless URL + API key are set and either at least one project is selected or all-projects task mode is on.
2. `_fetchIssues()` GETs `<redmine-url>/issues.json?assigned_to_id=me&status_id=*` (paged, `limit=100`), then `_updateIssuesDisplay()` filters by selected projects (unless `redmine-tasks-all-projects`) and statuses (`redmine-statuses`; empty = all), and buckets each issue into the **Today** / **Tomorrow** sections by its `start_date`..`due_date` span. Rows are clickable buttons that open `<redmine-url>/issues/<id>`. `_setIssuesMessage` shows errors there.
3. `_fetchTimeEntries()` GETs `<redmine-url>/time_entries.json?user_id=me&from=<1st of month>&to=<today>` (paged, `limit=100`), summing `hours` per `project.id`. It only runs when at least one project is selected (monthly totals are project-scoped). `_updateDisplay()` renders one row per selected project (name + `H:MM`-formatted hours via `_formatHours`), falling back to `redmine-project-names` then `Project #<id>` for labels. `_setMessage` shows errors in that spot.

All Redmine requests use the `X-Redmine-API-Key` header and reuse the indicator's `Soup.Session` (via the getter), refresh timer, and settings signal — adding no new resources to tear down in `destroy()`.

The **prefs.js** Redmine page (`_buildRedminePage`) is the only place that fetches the project list: "Fetch projects" (and auto-fetch on tab `map`) calls `_fetchProjects`, which GETs `<redmine-url>/projects.json`, renders a checkbox per project into `redmine-projects`, and caches id→name into `redmine-project-names` so the panel can label projects before its own fetch returns.

### Things that must stay consistent

- **Three display modes** (`text`/`bar`/`both`) are handled in `_updateDisplayMode` (in `extension.js`, since they govern the panel widgets the indicator owns), defined in the schema, and selected in `prefs.js`. The index↔string mapping (`['text','bar','both']`) is duplicated in both files — keep them in sync.
- **Lifecycle / leaks:** the indicator's `destroy()` must stop the timer, abort the Soup session, and disconnect the settings signal. The feature modules deliberately hold no resources of their own — if you add a timer, signal, or session inside `claudeUsage.js` / `redmine.js`, give the module a teardown method and call it from the indicator's `destroy()`, or it leaks across enable/disable cycles (a common reason extensions get rejected from extensions.gnome.org).
- **`metadata.json` `version`** is an integer that must be bumped on each release submitted to extensions.gnome.org. `shell-version` lists supported GNOME majors.

## GNOME conventions to follow here

- Async I/O only — use `*_async`/`*_finish` (as `ClaudeUsage.refresh`/`_fetchUsage` do). Never block the Shell's main loop with sync file or network calls.
- Imports use `gi://` (GObject introspection) and `resource:///org/gnome/shell/...` (Shell internals). These resolve only inside the Shell runtime, not under plain `node`.
- The icon is loaded from disk via `GLib.build_filenamev([extensionPath, ...])`; `extensionPath` comes from `this.path` and is passed into the indicator — don't hardcode paths.
