# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Info Center is a GNOME Shell extension (GNOME 46–49) that displays Claude Code API usage in the top panel, and optionally this month's Redmine time entries per project and this month's Hubstaff time tracked per project in the dropdown. It is a private rebrand/fork of [Haletran/claude-usage-extension]. Pure GJS (GNOME JavaScript) — no build step, no package manager, no test suite.

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

Two entry points, loaded by GNOME Shell into different processes. The Shell-side entry point delegates its dropdown sections and fetch logic to three feature modules:

- **`extension.js`** — runs in the Shell (compositor) process. `InfoCenterExtension.enable()` creates the panel indicator. `InfoCenterIndicator` (a `PanelMenu.Button`) owns the panel widget (icon, label, panel progress bar), the dropdown menu, the refresh timer, the `Soup.Session`, and the settings signal. It builds nothing inside the dropdown itself beyond the footer separator + **Settings** item; it hands the menu to the two modules to populate.
- **`claudeUsage.js`** — the `ClaudeUsage` class. Owns the Claude 5-hour / 7-day dropdown sections and drives the panel label + panel progress bar (those panel widgets are created by the indicator and passed into the constructor, because their placement and visibility are governed by the display mode). Reads credentials, fetches usage, renders. This is the only place that touches the Claude credentials/API.
- **`redmine.js`** — the `Redmine` class. Owns the Redmine dropdown sections (Today / Tomorrow issue lists + this-month per-project time totals), fetches issues and time entries, and renders them. This is the only place that touches Redmine. It owns one resource — a `Gio.Cancellable` threaded into its fetches — torn down in `destroy()`.
- **`hubstaff.js`** — the `Hubstaff` class. Owns the single "Hubstaff time — this month" dropdown section (one row per project you tracked time on this month, summed, most-tracked first), handles the OAuth token exchange, fetches organizations / projects / daily activities, and renders them. This is the only place that touches Hubstaff. It owns two `Gio.Cancellable`s — one threaded into its data fetches (cancelled-and-replaced per `refresh()`), and a separate `_tokenCancellable` for the token exchange (so an overlapping refresh can't abort a refresh-token rotation mid-flight) — both torn down in `destroy()`.
- **`prefs.js`** — runs in a separate preferences process (GTK4/Adwaita, not Shell). It only reads/writes GSettings keys; it shares no runtime state with `extension.js`. The two communicate exclusively through GSettings.

All three feature modules receive the `Soup.Session` through a `getSession` getter (`() => this._session`) rather than a stored reference, so when the indicator recreates the session on a proxy change the modules pick up the new session on their next request. They are passed `settings` directly and read their own keys. `Redmine` and `Hubstaff` create no timers or signals of their own, but each owns a `Gio.Cancellable` for its in-flight fetches (Hubstaff owns a second one, `_tokenCancellable`, for its token exchange) and exposes `destroy()` to cancel it. `ClaudeUsage` owns a short-lived auth-retry timer and a `Gio.Cancellable` for its in-flight async I/O (see below) and exposes `destroy()` to tear both down; the indicator's `destroy()` calls `this._claude.destroy()`, `this._redmine.destroy()`, and `this._hubstaff.destroy()`. All menu items are owned by `this.menu` (destroyed by `super.destroy()`).

The indicator drives three independent refresh timers (`refresh-interval` for Claude, `redmine-refresh-interval` for Redmine, `hubstaff-refresh-interval` for Hubstaff), each with its own `_start*Timer` / `_stop*Timer` / `_restart*Timer` trio, all stopped in `destroy()`.

The GSettings schema (`schemas/*.gschema.xml`) is the contract between Shell and prefs. Adding a setting means: add the key to the schema XML, add a UI row in `prefs.js`, recompile the schema, and (if it affects the panel live) handle it in the `settings.connect('changed', ...)` switch in `extension.js._init` (which dispatches `redmine-*` keys to `this._redmine.refresh()` and `hubstaff-personal-access-token` to `this._hubstaff.refresh()`).

### Claude usage data flow (claudeUsage.js)

1. The indicator's Claude timer fires every `refresh-interval` seconds (`_startClaudeTimer`) and calls `this._claude.refresh()` (also called on `_init` and after a proxy-driven session recreation). Redmine has its own independent timer (`redmine-refresh-interval` / `_startRedmineTimer`) so the two refresh cadences are configured separately.
2. `ClaudeUsage.refresh()` reads the OAuth token from `$CLAUDE_CONFIG_DIR/.credentials.json` (falls back to `~/.claude/.credentials.json`), at `json.claudeAiOauth.accessToken`.
3. `_fetchUsage(token)` GETs `https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and the `anthropic-beta: oauth-2025-04-20` header.
4. `_updateDisplay(data)` renders `data.five_hour.utilization` and `data.seven_day.utilization` (percentages) into the panel label, panel progress bar, and dropdown.

Stale-token handling: right after login the on-disk token is often expired (Claude Code refreshes it lazily). `refresh()` skips the request when `claudeAiOauth.expiresAt` is already past, and `_fetchUsage` treats an HTTP 401 the same way — both route into `_handleStaleToken`, which shows a soft "Refreshing…" state (keeping the last good percentages if `_hasData`, but flagging the reset labels so frozen numbers aren't presented as current) and arms a one-shot `_scheduleRetry` timer (`AUTH_RETRY_SECONDS`) that re-reads the credentials file, so a refreshed token is picked up in ~20s instead of waiting a full `refresh-interval`. Both stale paths share one `_authRetries` budget: `_handleStaleToken` counts one retry **per scheduled round** (it no-ops when a retry timer is already pending, so the main timer and retry timer firing together don't burn the budget per-tick) and shows a hard `Error` after `MAX_AUTH_RETRIES`; the counter resets on a successful fetch. `ClaudeUsage` owns two resources, both torn down in `destroy()`: the retry timer (`_clearRetry`) and a `Gio.Cancellable` (`_cancellable`) threaded into the credential read and the usage fetch — `refresh()` cancels the previous one before starting, so overlapping refreshes don't race and callbacks can't `set_text` on widgets `super.destroy()` has disposed.

Usage thresholds drive the `usage-low/medium/high/critical` CSS classes (40/70/90) in `_updateProgressBar` — these class names are defined in `stylesheet.css`.

### Redmine data flow (redmine.js)

Optional, off by default. Configured via the `redmine-url`, `redmine-api-key`, `redmine-projects`, `redmine-project-names`, `redmine-statuses`, and `redmine-tasks-all-projects` GSettings keys (set from the **Redmine** prefs page).

1. `Redmine.refresh()` runs on `_init`, on every tick of its own `redmine-refresh-interval` timer, and whenever a `redmine-*` setting changes. It hides every section and bails unless URL + API key are set and either at least one project is selected or all-projects task mode is on.
2. `_fetchIssues()` GETs `<redmine-url>/issues.json?assigned_to_id=me&status_id=*` (paged, `limit=100`), then `_updateIssuesDisplay()` filters by selected projects (unless `redmine-tasks-all-projects`) and statuses (`redmine-statuses`; empty = all), and buckets each issue into the **Today** / **Tomorrow** sections by its `start_date`..`due_date` span. Rows are clickable buttons that open `<redmine-url>/issues/<id>`. `_setIssuesMessage` shows errors there.
3. `_fetchTimeEntries()` GETs `<redmine-url>/time_entries.json?user_id=me&from=<1st of month>&to=<today>` (paged, `limit=100`), summing `hours` per `project.id`. It only runs when at least one project is selected (monthly totals are project-scoped). `_updateDisplay()` renders one row per selected project (name + `H:MM`-formatted hours via `_formatHours`), falling back to `redmine-project-names` then `Project #<id>` for labels. `_setMessage` shows errors in that spot.

All Redmine requests use the `X-Redmine-API-Key` header and reuse the indicator's `Soup.Session` (via the getter) and settings signal, driven by the Redmine refresh timer (`redmine-refresh-interval`). They are threaded through a single `Gio.Cancellable` that `refresh()` cancels-and-replaces on each call, so overlapping refreshes (a timer tick racing a `redmine-*` settings change) don't interleave on the display and post-teardown callbacks can't touch destroyed widgets; the indicator's `destroy()` calls `this._redmine.destroy()` to cancel it. The indicator debounces `redmine-*` settings changes (`_scheduleRedmineRefresh`, 400 ms) so ticking several project/status checkboxes in prefs triggers one fetch rather than one per click.

The **prefs.js** Redmine page (`_buildRedminePage`) is the only place that fetches the project list: "Fetch projects" (and auto-fetch on tab `map`) calls `_fetchProjects`, which GETs `<redmine-url>/projects.json`, renders a checkbox per project into `redmine-projects`, and caches id→name into `redmine-project-names` so the panel can label projects before its own fetch returns.

### Hubstaff data flow (hubstaff.js)

Optional, off by default. Configured entirely from the **Hubstaff** prefs page (`_buildHubstaffPage`): a refresh interval and a single Personal Access Token. There is no project selection — the section shows every project you tracked time on this month, summed.

**Auth (token rotation).** A Hubstaff Personal Access Token (PAT) is itself a long-lived (90-day) OAuth *refresh* token, created at developer.hubstaff.com with the **`hubstaff:read`** scope. There are four token-related GSettings keys:
- `hubstaff-personal-access-token` — the seed the user pastes in prefs. **The user-entered value; the extension never overwrites it.** This is the only token key watched in `extension.js` (its change triggers `this._hubstaff.refresh()`).
- `hubstaff-refresh-token` — the rotating refresh token. `_ensureAccessToken` checks the cache, then delegates to `_exchangeRefreshToken`, which exchanges the current refresh token at `POST https://account.hubstaff.com/access_tokens` (`grant_type=refresh_token`, `application/x-www-form-urlencoded`, **no** client id/secret for a PAT); the response carries a *new* refresh token that **replaces** the old one (Hubstaff rotates on every exchange — the old one is dead the moment the request reaches Hubstaff), written back here. `_currentRefreshToken()` prefers this, falling back to the seed. Because losing the rotated token in the response permanently bricks auth, the exchange runs under its **own** `Gio.Cancellable` (`_tokenCancellable`) that a normal `refresh()` never cancels (only `destroy()` does), and concurrent callers queue onto the single in-flight exchange via `_tokenWaiters` rather than each starting their own with the same about-to-die refresh token. For the same reason the indicator's `_recreateSession()` deliberately **does not** `session.abort()` the old session (which would cancel the in-flight exchange too) — it lets the old session drain and relies on each module's own cancellable to drop its stale data fetch. When the exchange fails (non-200, unexpected body, or transport error) `_exchangeRefreshToken` serves every queued waiter `null` via `_drainTokenWaiters` (callers treat `null` as "abort this round") so a failed exchange can't leave a fetch chain hanging; on success it serves the access token. If the token response omits `expires_in`, the cache expiry falls back to `DEFAULT_ACCESS_TOKEN_TTL` (24h) so a missing field can't mark the cache instantly stale and force a re-exchange (and refresh-token rotation) on every refresh.
- `hubstaff-access-token` / `hubstaff-token-expires-at` — the cached short-lived (24–72h) access token and its Unix expiry. The cache is reused until within 60s of expiry, so the token endpoint is hit rarely (roughly once a day), not on every refresh. If a request is rejected with **HTTP 401** *before* that cached expiry (server-side revocation or clock skew), `_apiGet` expires the cache (`hubstaff-token-expires-at` ← 0), re-exchanges the still-valid refresh token once, and replays the request with the fresh token — so the section self-recovers without the user re-entering a PAT (a `retried` flag bounds it to one retry).

None of the three extension-written keys (`hubstaff-refresh-token`, `hubstaff-access-token`, `hubstaff-token-expires-at`) are watched in `extension.js`, so token rotation does not retrigger a refresh. When the user enters a new PAT, `_buildHubstaffPage` clears all three first, then writes the seed last, so the next refresh exchanges with the new token. Re-applying the **same** PAT writes a byte-identical seed, which dconf suppresses (no `changed` signal, no refresh) — so the apply handler first clears the seed to `''` when the value is unchanged, forcing a value transition so the final write always re-triggers the refresh (lets a user recover from an auth error by re-pasting the same token).

**Fetch.** With a valid access token (`Authorization: Bearer <token>`), `refresh()` chains: `GET /v2/users/me` (own user id) → `GET /v2/organizations` (paged via `pagination.next_page_start_id` / `page_start_id`) → for each org sequentially, `GET /v2/organizations/<id>/projects` (id→name) then `GET /v2/organizations/<id>/activities/daily?date[start]=<1st of month>&date[stop]=<today>&user_ids=<me>` (the bracketed keys are percent-encoded; `user_ids` scopes totals to the signed-in user even with manager/owner visibility). It sums `tracked` (seconds) per `project_id` across all orgs, then `_updateDisplay` renders one `H:MM` row per project (most-tracked first), labelling unknown ids `Project #<id>`. `_setMessage` shows token / fetch errors in that spot. The data fetches are threaded through one `Gio.Cancellable` that `refresh()` cancels-and-replaces, so overlapping refreshes don't interleave and post-teardown callbacks can't touch destroyed widgets; the token exchange uses the separate `_tokenCancellable` (see Auth above) so an overlapping refresh can't abort it mid-rotation. `destroy()` cancels both.

### Things that must stay consistent

- **Three display modes** (`text`/`bar`/`both`) are handled in `_updateDisplayMode` (in `extension.js`, since they govern the panel widgets the indicator owns), defined in the schema, and selected in `prefs.js`. The index↔string mapping (`['text','bar','both']`) is duplicated in both files — keep them in sync.
- **Lifecycle / leaks:** the indicator's `destroy()` must stop all three refresh timers (Claude + Redmine + Hubstaff), remove the debounce timer, call `this._claude.destroy()`, `this._redmine.destroy()`, and `this._hubstaff.destroy()`, abort the Soup session, and disconnect the settings signal. All three feature modules own a `Gio.Cancellable` (and `ClaudeUsage` a retry timer) torn down in their `destroy()` — if you add another timer, signal, or session inside `claudeUsage.js` / `redmine.js` / `hubstaff.js`, extend that teardown and ensure the indicator calls it, or it leaks across enable/disable cycles (a common reason extensions get rejected from extensions.gnome.org).
- **`metadata.json` `version`** is an integer that must be bumped on each release submitted to extensions.gnome.org. `shell-version` lists supported GNOME majors.

## GNOME conventions to follow here

- Async I/O only — use `*_async`/`*_finish` (as `ClaudeUsage.refresh`/`_fetchUsage` do). Never block the Shell's main loop with sync file or network calls.
- Imports use `gi://` (GObject introspection) and `resource:///org/gnome/shell/...` (Shell internals). These resolve only inside the Shell runtime, not under plain `node`.
- The icon is loaded from disk via `GLib.build_filenamev([extensionPath, ...])`; `extensionPath` comes from `this.path` and is passed into the indicator — don't hardcode paths.
