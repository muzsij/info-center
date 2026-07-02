import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';

// When the on-disk OAuth token is stale (expired, or rejected with 401), Claude
// Code rewrites .credentials.json with a fresh token the next time it runs. We
// re-read the file on a short one-shot timer so we pick that up quickly instead
// of waiting for the full refresh-interval, and cap how many times we retry a
// server-rejected token so a genuinely dead token doesn't hammer the API.
const AUTH_RETRY_SECONDS = 20;
const MAX_AUTH_RETRIES = 9;

// Owns the Claude usage menu sections and drives the panel label / progress
// bar. The panel widgets are created by the indicator (they live in the panel
// box and their visibility is governed by the display mode) and handed in here.
// The session is read through a getter so proxy recreation in the indicator is
// always reflected on the next fetch.
export class ClaudeUsage {
    constructor(settings, getSession, panelLabel, panelProgressBar) {
        this._settings = settings;
        this._getSession = getSession;
        this._label = panelLabel;
        this._panelProgressBar = panelProgressBar;
        this._retryTimerId = null;
        this._authRetries = 0;
        this._hasData = false;
        this._cancellable = null;
    }

    destroy() {
        this._clearRetry();
        // Cancel any in-flight credential read / usage fetch so its callback
        // doesn't fire set_text on widgets super.destroy() is about to dispose.
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _clearRetry() {
        if (this._retryTimerId) {
            GLib.source_remove(this._retryTimerId);
            this._retryTimerId = null;
        }
    }

    // Re-read credentials after a short delay so a freshly refreshed token is
    // picked up without waiting for the next regular timer tick. One-shot and
    // self-guarding so overlapping triggers don't stack timers.
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

    // Hard "no data" state: set the panel label and both dropdown percent
    // labels, and clear the bars and reset labels too — whatever was on screen
    // is no longer valid, and a stale bar fill contradicting the error text
    // would be misleading.
    _setMessage(label, fiveHour, sevenDay) {
        this._hasData = false;
        this._label.remove_style_class_name('info-center-refreshing');
        this._label.set_text(label);
        this._fiveHourPercent.set_text(fiveHour);
        this._sevenDayPercent.set_text(sevenDay);
        this._fiveHourResetLabel.set_text('—');
        this._sevenDayResetLabel.set_text('—');
        this._updatePanelProgressBar(0);
        this._updateProgressBar(this._fiveHourProgressBar, this._fiveHourProgressBg, 0);
        this._updateProgressBar(this._sevenDayProgressBar, this._sevenDayProgressBg, 0);
    }

    // Soft state for a stale/refreshing token: keep the last good percentages
    // on screen if we have them — but flag in the reset labels that we're
    // re-checking, so frozen numbers aren't silently presented as current.
    // Otherwise show a neutral placeholder rather than a scary "Error".
    _showRefreshing() {
        if (this._hasData) {
            // Dim the panel number so the always-visible last-good percentage
            // isn't silently presented as current while we re-check the token.
            this._label.add_style_class_name('info-center-refreshing');
            this._fiveHourResetLabel.set_text('Refreshing…');
            this._sevenDayResetLabel.set_text('Refreshing…');
            return;
        }
        this._label.set_text('…');
        this._fiveHourPercent.set_text('Refreshing…');
        this._sevenDayPercent.set_text('—');
    }

    // Enter the stale-token state, shared by the expired-on-disk and HTTP 401
    // paths. We poll for a refreshed token on a short timer, counting one retry
    // per scheduled round — not per call, since both the main timer and the
    // retry timer land here — and give up after MAX_AUTH_RETRIES so a genuinely
    // dead token stops polling (the file read and the API alike). `detail` is
    // the message shown once the retries are exhausted.
    _handleStaleToken(detail) {
        // A retry round is already pending: the stale state is being handled,
        // so don't double-count it against the budget or stack another timer.
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

    buildMenu(menu) {
        const five = this._buildUsageSection(menu, 'Claude 5-Hour Usage');
        this._fiveHourPercent = five.percent;
        this._fiveHourProgressBar = five.bar;
        this._fiveHourProgressBg = five.bg;
        this._fiveHourResetLabel = five.resetLabel;

        const separator = new PopupMenu.PopupSeparatorMenuItem();
        separator.add_style_class_name('info-center-separator');
        menu.addMenuItem(separator);

        const seven = this._buildUsageSection(menu, 'Claude 7-Day Usage');
        this._sevenDayPercent = seven.percent;
        this._sevenDayProgressBar = seven.bar;
        this._sevenDayProgressBg = seven.bg;
        this._sevenDayResetLabel = seven.resetLabel;
    }

    // One usage section: title + right-aligned percent, a progress bar, and a
    // reset-time label. The 5-hour and 7-day sections are identical in shape.
    _buildUsageSection(menu, title) {
        const box = new St.BoxLayout({
            style_class: 'info-center-usage-section',
            vertical: true,
        });
        const header = new St.BoxLayout({ vertical: false });
        header.add_child(new St.Label({
            text: title,
            style_class: 'info-center-section-title',
        }));
        const percent = new St.Label({
            text: '...',
            style_class: 'info-center-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(percent);
        box.add_child(header);

        const bg = new St.Widget({
            style_class: 'info-center-progress-bg',
        });
        const bar = new St.Widget({
            style_class: 'info-center-progress-bar usage-low',
        });
        bg.add_child(bar);
        // The bg stretches to the menu width, so the fill width must track the
        // bg's *actual* allocated width, not a hardcoded max — recompute it
        // whenever the bg is (re)allocated (e.g. the first time the menu opens).
        bg.connect('notify::width', () => this._applyBarWidth(bar, bg));
        box.add_child(bg);

        const resetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'info-center-reset-label',
        });
        box.add_child(resetLabel);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(box);
        menu.addMenuItem(item);

        return { percent, bar, bg, resetLabel };
    }

    refresh() {
        // Cancel any in-flight credential read / fetch first, so overlapping
        // refreshes (the main timer and the retry timer can both call this)
        // don't race to the display, and so teardown can stop work that would
        // otherwise touch the panel widgets after they're destroyed.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(cancellable, (file, result) => {
            if (cancellable.is_cancelled()) {
                return;
            }
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;
                const expiresAt = json.claudeAiOauth?.expiresAt;

                if (!token) {
                    this._setMessage('No token', 'No credentials', '—');
                    return;
                }

                // Token already expired on disk (common right after login,
                // before Claude Code refreshes it). Skip the guaranteed 401 and
                // poll for the refreshed token instead — bounded like 401 so a
                // permanently-expired token doesn't poll the file forever.
                if (expiresAt && Date.now() >= expiresAt) {
                    this._handleStaleToken('Token expired');
                    return;
                }

                this._fetchUsage(token, cancellable);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    return;
                }
                console.error('Info Center: Failed to read credentials:', e.message);
                this._setMessage('No token', 'No credentials', '—');
            }
        });
    }

    _fetchUsage(token, cancellable) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

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
                        // 401 means the token the file gave us is stale; Claude
                        // Code will refresh it. Treat it as a stale-token state
                        // (soft, bounded retries) like an expired-on-disk token.
                        if (message.status_code === 401) {
                            this._handleStaleToken('HTTP 401');
                            return;
                        }
                        this._setMessage('Error', `HTTP ${message.status_code}`, '—');
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._updateDisplay(data);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Failed to fetch usage:', e.message);
                    this._label.remove_style_class_name('info-center-refreshing');
                    this._label.set_text('Error');
                }
            }
        );
    }

    _updateDisplay(data) {
        this._authRetries = 0;
        this._hasData = true;
        // Fresh data is in hand: cancel any pending stale-token poll so it
        // doesn't fire a redundant refresh, and drop the refreshing cue.
        this._clearRetry();
        this._label.remove_style_class_name('info-center-refreshing');

        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;

        this._label.set_text(`${Math.round(fiveHour)}%`);

        this._updatePanelProgressBar(fiveHour);

        this._fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(this._fiveHourProgressBar, this._fiveHourProgressBg, fiveHour);

        this._sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(this._sevenDayProgressBar, this._sevenDayProgressBg, sevenDay);

        // Always rewrite the reset labels — otherwise a "Refreshing…" left by
        // _showRefreshing persists when a successful response omits resets_at.
        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        } else {
            this._fiveHourResetLabel.set_text('—');
        }

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        } else {
            this._sevenDayResetLabel.set_text('—');
        }
    }

    _updatePanelProgressBar(usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    // Store the 0..1 fill fraction on the bar and size it against the bg's
    // current allocated width. The width is reapplied from notify::width too,
    // so it stays correct when the menu (and thus the bg) is resized.
    _applyBarWidth(progressBar, bg) {
        const fraction = progressBar._fillFraction ?? 0;
        progressBar.set_width(Math.round(bg.get_width() * fraction));
    }

    _updateProgressBar(progressBar, bg, usage) {
        progressBar._fillFraction = Math.min(100, Math.max(0, usage)) / 100;
        this._applyBarWidth(progressBar, bg);

        const level = usage >= 90 ? 'usage-critical'
            : usage >= 70 ? 'usage-high'
            : usage >= 40 ? 'usage-medium'
            : 'usage-low';
        for (const cls of ['usage-low', 'usage-medium', 'usage-high', 'usage-critical']) {
            if (cls === level) {
                progressBar.add_style_class_name(cls);
            } else {
                progressBar.remove_style_class_name(cls);
            }
        }
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            // An unparsable date yields NaN (new Date() doesn't throw, so the
            // catch below never sees it) — without this it renders as "NaNm".
            if (Number.isNaN(diffMs)) {
                return '—';
            }

            if (diffMs < 0) {
                return 'now';
            }

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else {
                return `${diffMins}m`;
            }
        } catch (e) {
            return '—';
        }
    }
}
