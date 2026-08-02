import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    buildUsageSection,
    buildCompactUsageSection,
    applyBarWidth,
    updateProgressBar,
    updatePanelProgressBar,
    formatResetCountdown,
    titleWithPlan,
    formatPlanName,
} from '../shared/usageSection.js';
import {isUsageReset, notifyUsageReset} from '../shared/notifications.js';

// OpenAI (Codex CLI) plan usage. This is the same endpoint the Codex CLI reads
// its rate-limit numbers from, authenticated with the OAuth token Codex already
// stores on disk — so there is nothing to paste in prefs, only a toggle.
const API_URL = 'https://chatgpt.com/backend-api/codex/usage';

// chatgpt.com sits behind a bot-protection layer that answers a request with a
// generic (or missing) User-Agent with an HTTP 403 challenge page instead of
// JSON; a `codex_cli_rs/…` agent is what the CLI itself sends and what the
// endpoint expects. `originator` likewise mirrors the CLI's own header.
const USER_AGENT = 'codex_cli_rs/0.145.0 (GNOME Shell; info-center)';
const ORIGINATOR = 'codex_cli_rs';

// Same stale-token dance as Claude: the token on disk is refreshed lazily by
// the Codex CLI, so an expired/rejected one is re-read on a short one-shot
// timer rather than waiting a full refresh interval — bounded so a genuinely
// dead login stops polling.
const AUTH_RETRY_SECONDS = 20;
const MAX_AUTH_RETRIES = 9;

// Windows up to a day are treated as the short ("5-hour") rolling window,
// anything longer as the weekly one. The API describes each window only by its
// length, and which pair a plan gets varies, so slot them by length instead of
// trusting primary/secondary ordering.
const SHORT_WINDOW_MAX_SECONDS = 24 * 60 * 60;

// Name a window from its length: the two common ones get their familiar names,
// anything else is labelled generically so an unexpected window is still
// readable rather than mislabelled.
function windowLabel(seconds) {
    if (seconds === 5 * 3600) {
        return '5-Hour';
    }
    if (seconds === 7 * 24 * 3600) {
        return 'Weekly';
    }
    if (seconds > 0 && seconds < 24 * 3600) {
        return `${Math.round(seconds / 3600)}-Hour`;
    }
    if (seconds > 0) {
        return `${Math.round(seconds / (24 * 3600))}-Day`;
    }
    return '';
}

// The compact block tags each window at the end of its reset row, in the same
// lowercase style as the Claude/GLM tags ("5 hour" / "weekly").
function windowTag(seconds) {
    const label = windowLabel(seconds);
    return label ? label.toLowerCase().replace('-', ' ') : '';
}

function windowSeconds(window) {
    return typeof window?.limit_window_seconds === 'number'
        ? window.limit_window_seconds : 0;
}

// Milliseconds epoch for a window's reset: `reset_at` is a Unix time in
// seconds; `reset_after_seconds` is the fallback offset from now.
function windowResetMs(window) {
    if (typeof window?.reset_at === 'number' && window.reset_at > 0) {
        return window.reset_at * 1000;
    }
    if (typeof window?.reset_after_seconds === 'number') {
        return Date.now() + window.reset_after_seconds * 1000;
    }
    return 0;
}

// Milliseconds epoch at which a JWT expires, or 0 when it can't be read (an
// opaque token, or a payload without `exp`) — in which case we just try the
// request and let an HTTP 401 tell us.
function tokenExpiryMs(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length < 2) {
        return 0;
    }
    try {
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) {
            b64 += '=';
        }
        const payload = JSON.parse(
            new TextDecoder('utf-8').decode(GLib.base64_decode(b64)));
        return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
    } catch {
        return 0;
    }
}

// Owns the OpenAI usage menu sections and drives its own panel label / progress
// bar (both created by the indicator and handed in, like the Claude and GLM
// widgets, so the indicator governs their placement and visibility). Off unless
// enabled in prefs. The session is read through a getter so proxy recreation in
// the indicator is picked up on the next fetch. Auth is the Codex CLI's own
// on-disk OAuth token — read-only: the token is never refreshed or written back
// from here, since rotating it behind the CLI's back would break its login.
export class OpenAiUsage {
    constructor(settings, getSession, panelLabel, panelProgressBar, extensionPath) {
        this._settings = settings;
        this._getSession = getSession;
        this._label = panelLabel;
        this._panelProgressBar = panelProgressBar;
        this._iconPath = GLib.build_filenamev([
            extensionPath, 'icons', 'info-center-openai.svg']);
        this._retryTimerId = null;
        this._authRetries = 0;
        this._hasData = false;
        // Last successfully-read short-window percentage, used to detect a reset
        // (a downward crossing of the notify threshold). Null until the first
        // good fetch so start-up doesn't fire a spurious notification.
        this._lastFivePct = null;
        this._cancellable = null;
        this._menu = null;
        this._openStateId = 0;
        this._reapplyId = 0;
        this._plan = '';
        this._compact = false;
        this._titles = [];
    }

    destroy() {
        this._clearRetry();
        if (this._reapplyId) {
            GLib.source_remove(this._reapplyId);
            this._reapplyId = 0;
        }
        if (this._menu && this._openStateId) {
            this._menu.disconnect(this._openStateId);
        }
        this._openStateId = 0;
        this._menu = null;
        // Cancel any in-flight credential read / usage fetch so its callback
        // doesn't set_text on widgets super.destroy() is about to dispose.
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    isConfigured() {
        return this._settings.get_boolean('openai-enabled');
    }

    buildMenu(menu) {
        this._menu = menu;
        // Recompute both bar fills every time the menu opens — see the matching
        // comment in claudeUsage.js for why notify::width alone isn't enough.
        this._openStateId = menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._reapplyBars();
            }
        });

        // Leading separator dividing OpenAI from the section above it (GLM).
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this._separator.add_style_class_name('info-center-separator');
        menu.addMenuItem(this._separator);

        this._compact = this._settings.get_boolean('openai-compact-view');

        if (this._compact) {
            const compact = buildCompactUsageSection(
                menu, 'OpenAI', '5 hour', 'weekly', this._iconPath);
            // In the compact block a window is two rows inside one menu item, so
            // that row pair is what gets hidden when the API omits the window.
            this._short = {
                ...compact.five,
                actors: [compact.five.barRow, compact.five.resetRow],
                tag: compact.five.tagLabel,
            };
            this._long = {
                ...compact.weekly,
                actors: [compact.weekly.barRow, compact.weekly.resetRow],
                tag: compact.weekly.tagLabel,
            };
            this._innerSeparator = null;
            this._sectionItems = [this._separator, compact.item];
            this._titles = [{ label: compact.titleLabel, base: 'OpenAI' }];
        } else {
            const five = buildUsageSection(menu, 'OpenAI 5-Hour Usage', this._iconPath);

            this._innerSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this._innerSeparator.add_style_class_name('info-center-separator');
            menu.addMenuItem(this._innerSeparator);

            const weekly = buildUsageSection(menu, 'OpenAI Weekly Usage', this._iconPath);

            this._short = { ...five, actors: [five.item], tag: null };
            this._long = { ...weekly, actors: [weekly.item], tag: null };
            this._sectionItems = [
                this._separator, five.item, this._innerSeparator, weekly.item];
            this._titles = [
                { label: five.titleLabel, base: 'OpenAI 5-Hour Usage' },
                { label: weekly.titleLabel, base: 'OpenAI Weekly Usage' },
            ];
        }

        this._applyPlan();

        // Hidden until enabled (a fetch un-hides it).
        this._setSectionsVisible(this.isConfigured());
    }

    // Rewrite each section title with the current plan tag (e.g. "Team").
    _applyPlan() {
        for (const t of this._titles) {
            t.label.set_text(titleWithPlan(t.base, this._plan, this._compact));
        }
    }

    // Toggle the whole OpenAI block (section item(s) + separators) so users who
    // don't use Codex don't see empty "OpenAI … 0%" rows.
    _setSectionsVisible(visible) {
        for (const item of this._sectionItems) {
            if (item) {
                item.visible = visible;
            }
        }
        // Coming up with nothing on screen yet (first build, or re-enabled after
        // being off): show both windows until a fetch says otherwise, so a
        // message can't land on a hidden row. With data already rendered, leave
        // the slots as the last fetch arranged them — re-showing a window the
        // API doesn't report would flash an empty section on every refresh.
        if (visible && !this._hasData) {
            this._setWindowsVisible(true, true);
        }
    }

    // Show only the windows the API actually reported: a plan that has no
    // 5-hour limit (or hasn't been given one yet) would otherwise show a
    // permanently empty section.
    _setWindowsVisible(shortVisible, longVisible) {
        for (const actor of this._short.actors) {
            actor.visible = shortVisible;
        }
        for (const actor of this._long.actors) {
            actor.visible = longVisible;
        }
        if (this._innerSeparator) {
            // The inner separator only earns its space when it actually divides
            // two visible sections.
            this._innerSeparator.visible = shortVisible && longVisible;
        }
    }

    // Relabel a window slot from its length, so a "5-hour" slot that is really a
    // 3-hour window (or a "weekly" slot that is monthly) reads correctly. The
    // full layout carries the label in the section title (which also carries the
    // plan tag), the compact one in the row's tag label.
    _setWindowLabel(slot, index, seconds) {
        const label = windowLabel(seconds);
        if (!label) {
            return;
        }
        if (this._compact) {
            slot.tag?.set_text(windowTag(seconds));
            return;
        }
        const title = this._titles[index];
        if (title) {
            title.base = `OpenAI ${label} Usage`;
            title.label.set_text(titleWithPlan(title.base, this._plan, this._compact));
        }
    }

    _clearRetry() {
        if (this._retryTimerId) {
            GLib.source_remove(this._retryTimerId);
            this._retryTimerId = null;
        }
    }

    // Re-read the token after a short delay so a token the Codex CLI has since
    // refreshed is picked up without waiting for the next regular tick.
    // One-shot and self-guarding so overlapping triggers don't stack timers.
    _scheduleRetry() {
        if (this._retryTimerId) {
            return;
        }
        this._retryTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            AUTH_RETRY_SECONDS,
            () => {
                this._retryTimerId = null;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    // Enter the stale-token state, shared by the expired-on-disk and HTTP 401
    // paths. Counts one retry per scheduled round (not per call — both the main
    // timer and the retry timer land here) and gives up after MAX_AUTH_RETRIES.
    _handleStaleToken(detail) {
        if (this._retryTimerId) {
            this._showRefreshing();
            return;
        }
        if (this._authRetries >= MAX_AUTH_RETRIES) {
            this._setMessage('Error', detail, '—');
            return;
        }
        this._authRetries++;
        this._showRefreshing();
        this._scheduleRetry();
    }

    // Soft state while the token is being re-checked: keep the last good
    // percentages if we have them, but flag it in the reset labels so frozen
    // numbers aren't presented as current.
    _showRefreshing() {
        if (this._hasData) {
            this._label.add_style_class_name('info-center-refreshing');
            this._short.resetLabel.set_text('Refreshing…');
            this._long.resetLabel.set_text('Refreshing…');
            return;
        }
        this._label.set_text('…');
        this._short.percent.set_text('Refreshing…');
        this._long.percent.set_text('—');
    }

    refresh() {
        // Cancel any in-flight read/fetch first so overlapping refreshes (the
        // main timer racing the retry timer or a settings change) don't race to
        // the display, and so teardown can stop work that would otherwise touch
        // destroyed widgets.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        if (!this.isConfigured()) {
            // Disabled: blank the panel number and hide the sections.
            this._clearRetry();
            this._hasData = false;
            this._label.remove_style_class_name('info-center-refreshing');
            this._label.set_text('');
            updatePanelProgressBar(this._panelProgressBar, 0);
            this._plan = '';
            this._applyPlan();
            this._setSectionsVisible(false);
            return;
        }

        this._setSectionsVisible(true);

        // The Codex CLI keeps its OAuth tokens here; CODEX_HOME relocates the
        // whole directory, exactly as the CLI reads it.
        const codexHome = GLib.getenv('CODEX_HOME') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        const authPath = GLib.build_filenamev([codexHome, 'auth.json']);

        const file = Gio.File.new_for_path(authPath);
        file.load_contents_async(cancellable, (file, result) => {
            if (cancellable.is_cancelled()) {
                return;
            }
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.tokens?.access_token;
                const accountId = json.tokens?.account_id ?? '';

                if (!token) {
                    this._setMessage('No token', 'Run codex login', '—');
                    return;
                }

                // Expired on disk: skip the guaranteed 401 and poll for the
                // token the Codex CLI will refresh on its next run.
                const expiresAt = tokenExpiryMs(token);
                if (expiresAt && Date.now() >= expiresAt) {
                    this._handleStaleToken('Token expired');
                    return;
                }

                this._fetchUsage(token, accountId, cancellable);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    return;
                }
                console.error('Info Center: Failed to read Codex credentials:', e.message);
                this._setMessage('No token', 'Run codex login', '—');
            }
        });
    }

    _fetchUsage(token, accountId, cancellable) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        if (accountId) {
            message.request_headers.append('chatgpt-account-id', accountId);
        }
        message.request_headers.append('Accept', 'application/json');
        message.request_headers.append('User-Agent', USER_AGENT);
        message.request_headers.append('originator', ORIGINATOR);

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                if (cancellable.is_cancelled()) {
                    return;
                }
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        // 401: the on-disk token is stale — the Codex CLI will
                        // refresh it, so poll for it like an expired token.
                        if (message.status_code === 401) {
                            this._handleStaleToken('HTTP 401');
                            return;
                        }
                        // 403 here is the bot-protection challenge page, not an
                        // auth failure — name it so it isn't mistaken for one.
                        if (message.status_code === 403) {
                            this._setMessage('Error', 'Request blocked (403)', '—');
                            return;
                        }
                        this._setMessage('Error', `HTTP ${message.status_code}`, '—');
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    this._updateDisplay(JSON.parse(decoder.decode(bytes.get_data())));
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Failed to fetch OpenAI usage:', e.message);
                    this._setMessage('Error', 'Fetch failed', '—');
                }
            }
        );
    }

    // Slot the reported windows by length: the shortest window up to a day is
    // the rolling ("5-hour") one, the longest beyond that the weekly one. A
    // window whose length the API omits falls into the short slot, which is what
    // the panel number follows.
    _pickWindows(data) {
        const rateLimit = data?.rate_limit ?? {};
        const windows = [rateLimit.primary_window, rateLimit.secondary_window]
            .filter(w => w && typeof w.used_percent === 'number');

        const short = windows
            .filter(w => windowSeconds(w) <= SHORT_WINDOW_MAX_SECONDS)
            .sort((a, b) => windowSeconds(a) - windowSeconds(b))[0] ?? null;
        const long = windows
            .filter(w => windowSeconds(w) > SHORT_WINDOW_MAX_SECONDS)
            .sort((a, b) => windowSeconds(b) - windowSeconds(a))[0] ?? null;

        return { short, long };
    }

    _updateDisplay(data) {
        this._authRetries = 0;
        // Fresh data is in hand: cancel any pending stale-token poll and drop
        // the refreshing cue.
        this._clearRetry();
        this._label.remove_style_class_name('info-center-refreshing');

        // The plan tier ("team"/"plus"/"pro") rides along with the usage data.
        this._plan = formatPlanName(data?.plan_type);
        this._applyPlan();

        const {short, long} = this._pickWindows(data);
        if (!short && !long) {
            this._setMessage('—', 'No usage data', '—');
            return;
        }

        this._hasData = true;
        this._setWindowsVisible(short !== null, long !== null);

        // The panel follows the short window — the one that actually moves
        // during a session — falling back to the long one for plans that only
        // have a weekly limit, so the panel number is never blank.
        const panelPct = short ? short.used_percent : long.used_percent;
        this._label.set_text(`${Math.round(panelPct)}%`);
        updatePanelProgressBar(this._panelProgressBar, panelPct);

        if (short) {
            this._maybeNotifyReset(short.used_percent);
            this._setWindowLabel(this._short, 0, windowSeconds(short));
            this._renderWindow(this._short, short);
        }
        if (long) {
            this._setWindowLabel(this._long, 1, windowSeconds(long));
            this._renderWindow(this._long, long);
        }
    }

    _renderWindow(slot, window) {
        const percent = window.used_percent;
        slot.percent.set_text(`${percent.toFixed(1)}%`);
        updateProgressBar(slot.bar, slot.bg, percent);

        const resetMs = windowResetMs(window);
        slot.resetLabel.set_text(resetMs
            ? `Resets in ${formatResetCountdown(new Date(resetMs))}`
            : '—');
    }

    // Hard "no data" state: set the panel number and both dropdown percent
    // labels, and clear the bars and reset labels — a stale bar fill
    // contradicting the error text would be misleading. Both windows are shown
    // so the message can't land on a hidden row.
    _setMessage(label, shortText, longText) {
        this._hasData = false;
        // Drop any stale plan tag so an error state doesn't keep advertising a
        // tier we can no longer confirm.
        this._plan = '';
        this._applyPlan();
        this._label.remove_style_class_name('info-center-refreshing');
        this._label.set_text(label);
        this._setWindowsVisible(true, true);
        this._short.percent.set_text(shortText);
        this._long.percent.set_text(longText);
        this._short.resetLabel.set_text('—');
        this._long.resetLabel.set_text('—');
        updatePanelProgressBar(this._panelProgressBar, 0);
        updateProgressBar(this._short.bar, this._short.bg, 0);
        updateProgressBar(this._long.bar, this._long.bg, 0);
    }

    // Fire a reset notification when the short-window usage drops below the
    // configured threshold after having reached it. Always updates the baseline
    // (even when notifications are off) so toggling the setting on mid-session
    // has a valid previous reading to compare against.
    _maybeNotifyReset(fivePct) {
        if (this._settings.get_boolean('openai-notify-reset') &&
            isUsageReset(this._lastFivePct, fivePct,
                this._settings.get_int('openai-notify-threshold'))) {
            notifyUsageReset('OpenAI');
        }
        this._lastFivePct = fivePct;
    }

    // Reapply both bar fills from their stored fractions once the menu has
    // settled its layout. Self-guarding so repeated opens don't stack idles.
    _reapplyBars() {
        if (this._reapplyId) {
            return;
        }
        this._reapplyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reapplyId = 0;
            applyBarWidth(this._short.bar, this._short.bg);
            applyBarWidth(this._long.bar, this._long.bg);
            return GLib.SOURCE_REMOVE;
        });
    }
}
