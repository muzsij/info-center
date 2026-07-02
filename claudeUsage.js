import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    buildUsageSection,
    applyBarWidth,
    updateProgressBar,
    updatePanelProgressBar,
    formatResetCountdown,
} from './usageSection.js';

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
        this._menu = null;
        this._openStateId = 0;
        this._reapplyId = 0;
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
        updatePanelProgressBar(this._panelProgressBar, 0);
        updateProgressBar(this._fiveHourProgressBar, this._fiveHourProgressBg, 0);
        updateProgressBar(this._sevenDayProgressBar, this._sevenDayProgressBg, 0);
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
        this._menu = menu;
        // Recompute both bar fills every time the menu opens. notify::width on
        // the bg only fires when the allocated width *changes*, so it misses the
        // common case where a background (menu-closed) refresh computed the fill
        // against a not-yet-allocated bg (width 0) and a later open reuses the
        // same allocation — which left a real percentage rendering as an empty
        // bar. Deferred to idle so the just-opened menu has been allocated and
        // bg.get_width() reflects the real width.
        this._openStateId = menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._reapplyBars();
            }
        });

        const five = buildUsageSection(menu, 'Claude 5-Hour Usage');
        this._fiveHourPercent = five.percent;
        this._fiveHourProgressBar = five.bar;
        this._fiveHourProgressBg = five.bg;
        this._fiveHourResetLabel = five.resetLabel;

        const separator = new PopupMenu.PopupSeparatorMenuItem();
        separator.add_style_class_name('info-center-separator');
        menu.addMenuItem(separator);

        const seven = buildUsageSection(menu, 'Claude 7-Day Usage');
        this._sevenDayPercent = seven.percent;
        this._sevenDayProgressBar = seven.bar;
        this._sevenDayProgressBg = seven.bg;
        this._sevenDayResetLabel = seven.resetLabel;
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

        updatePanelProgressBar(this._panelProgressBar, fiveHour);

        this._fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        updateProgressBar(this._fiveHourProgressBar, this._fiveHourProgressBg, fiveHour);

        this._sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        updateProgressBar(this._sevenDayProgressBar, this._sevenDayProgressBg, sevenDay);

        // Always rewrite the reset labels — otherwise a "Refreshing…" left by
        // _showRefreshing persists when a successful response omits resets_at.
        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${formatResetCountdown(data.five_hour.resets_at)}`
            );
        } else {
            this._fiveHourResetLabel.set_text('—');
        }

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(
                `Resets in ${formatResetCountdown(data.seven_day.resets_at)}`
            );
        } else {
            this._sevenDayResetLabel.set_text('—');
        }
    }

    // Reapply both bar fills from their stored fractions once the menu has
    // settled its layout. Self-guarding so repeated opens don't stack idles.
    _reapplyBars() {
        if (this._reapplyId) {
            return;
        }
        this._reapplyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reapplyId = 0;
            applyBarWidth(this._fiveHourProgressBar, this._fiveHourProgressBg);
            applyBarWidth(this._sevenDayProgressBar, this._sevenDayProgressBg);
            return GLib.SOURCE_REMOVE;
        });
    }
}
