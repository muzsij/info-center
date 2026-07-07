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
} from './usageSection.js';
import {isUsageReset, notifyUsageReset} from './notifications.js';

// Z.ai GLM Coding Plan usage. The quota endpoint returns a `data.limits` array;
// each token-limit entry is keyed by (unit, number): a 5-hour window is
// (unit=3, number=5) and the weekly window is (unit=6, number=1). Each entry
// carries a `percentage` (0..100) and a `nextResetTime` (Unix ms).
const API_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

const TOKENS_LIMIT = 'TOKENS_LIMIT';

// Owns the GLM usage menu sections and drives its own panel label / progress
// bar (both created by the indicator and handed in, so the indicator governs
// their placement and display-mode/configured visibility, like the Claude
// widgets). Off unless a z.ai API key is configured. The session is read
// through a getter so proxy recreation in the indicator is picked up on the
// next fetch. Auth is a static, long-lived API key — no OAuth / token rotation.
export class ZaiUsage {
    constructor(settings, getSession, panelLabel, panelProgressBar, extensionPath) {
        this._settings = settings;
        this._getSession = getSession;
        this._label = panelLabel;
        this._panelProgressBar = panelProgressBar;
        this._iconPath = GLib.build_filenamev([
            extensionPath, 'icons', 'info-center-glm.svg']);
        // Last successfully-read 5-hour percentage, used to detect a reset (a
        // downward crossing of the notify threshold). Null until the first good
        // fetch so start-up doesn't fire a spurious reset notification.
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
        if (this._reapplyId) {
            GLib.source_remove(this._reapplyId);
            this._reapplyId = 0;
        }
        if (this._menu && this._openStateId) {
            this._menu.disconnect(this._openStateId);
        }
        this._openStateId = 0;
        this._menu = null;
        // Cancel any in-flight fetch so its callback doesn't set_text on widgets
        // super.destroy() is about to dispose.
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    isConfigured() {
        return this._settings.get_string('zai-api-key').trim() !== '';
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

        // Leading separator dividing GLM from the section above it (Claude).
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this._separator.add_style_class_name('info-center-separator');
        menu.addMenuItem(this._separator);

        // Compact: one "GLM" block with both windows. Otherwise two separate
        // sections split by an inner separator. Either way the same widget
        // fields are populated, and `_sectionItems` lists the menu items to
        // hide/show together (the leading separator plus the section item(s)).
        this._compact = this._settings.get_boolean('zai-compact-view');

        if (this._compact) {
            const compact = buildCompactUsageSection(
                menu, 'GLM', '5 hour', '7-day', this._iconPath);
            this._fiveHourPercent = compact.five.percent;
            this._fiveHourProgressBar = compact.five.bar;
            this._fiveHourProgressBg = compact.five.bg;
            this._fiveHourResetLabel = compact.five.resetLabel;
            this._weeklyPercent = compact.weekly.percent;
            this._weeklyProgressBar = compact.weekly.bar;
            this._weeklyProgressBg = compact.weekly.bg;
            this._weeklyResetLabel = compact.weekly.resetLabel;
            this._sectionItems = [this._separator, compact.item];
            this._titles = [{ label: compact.titleLabel, base: 'GLM' }];
        } else {
            const five = buildUsageSection(menu, 'GLM 5-Hour Usage', this._iconPath);
            this._fiveHourPercent = five.percent;
            this._fiveHourProgressBar = five.bar;
            this._fiveHourProgressBg = five.bg;
            this._fiveHourResetLabel = five.resetLabel;

            const innerSeparator = new PopupMenu.PopupSeparatorMenuItem();
            innerSeparator.add_style_class_name('info-center-separator');
            menu.addMenuItem(innerSeparator);

            const weekly = buildUsageSection(menu, 'GLM Weekly Usage', this._iconPath);
            this._weeklyPercent = weekly.percent;
            this._weeklyProgressBar = weekly.bar;
            this._weeklyProgressBg = weekly.bg;
            this._weeklyResetLabel = weekly.resetLabel;

            this._sectionItems = [this._separator, five.item, innerSeparator, weekly.item];
            this._titles = [
                { label: five.titleLabel, base: 'GLM 5-Hour Usage' },
                { label: weekly.titleLabel, base: 'GLM Weekly Usage' },
            ];
        }

        this._applyPlan();

        // Hidden until a key is configured (a fetch un-hides it).
        this._setSectionsVisible(this.isConfigured());
    }

    // Rewrite each section title with the current plan tag (e.g. "Pro"). Called
    // on build (so a rebuilt menu shows the last known plan) and on every fetch
    // (the level ships in the quota response).
    _applyPlan() {
        for (const t of this._titles) {
            t.label.set_text(titleWithPlan(t.base, this._plan, this._compact));
        }
    }

    // Toggle the whole GLM block (section item(s) + separators) so users
    // without a z.ai key don't see empty "GLM … 0%" rows.
    _setSectionsVisible(visible) {
        for (const item of this._sectionItems) {
            if (item) {
                item.visible = visible;
            }
        }
    }

    refresh() {
        // Cancel any in-flight fetch first so overlapping refreshes (the main
        // timer racing a key change) don't race to the display, and so teardown
        // can stop work that would otherwise touch destroyed widgets.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const token = this._settings.get_string('zai-api-key').trim();
        if (!token) {
            // Not configured: blank the panel number and hide the sections.
            this._label.set_text('');
            updatePanelProgressBar(this._panelProgressBar, 0);
            this._plan = '';
            this._applyPlan();
            this._setSectionsVisible(false);
            return;
        }

        this._setSectionsVisible(true);
        this._fetchUsage(token, cancellable);
    }

    _fetchUsage(token, cancellable) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const message = Soup.Message.new('GET', API_URL);
        // z.ai passes the API key directly in Authorization, with NO "Bearer"
        // prefix (unlike Claude / Hubstaff).
        message.request_headers.append('Authorization', token);
        message.request_headers.append('Accept-Language', 'en-US,en');
        message.request_headers.append('Content-Type', 'application/json');

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
                        if (message.status_code === 401 || message.status_code === 403) {
                            this._setMessage('Auth error', 'Check API key', '—');
                            return;
                        }
                        this._setMessage('Error', `HTTP ${message.status_code}`, '—');
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const json = JSON.parse(decoder.decode(bytes.get_data()));
                    this._updateDisplay(json.data ?? json);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Failed to fetch GLM usage:', e.message);
                    this._setMessage('Error', 'Fetch failed', '—');
                }
            }
        );
    }

    // Pick the 5-hour (unit=3, number=5) and weekly (unit=6, number=1) token
    // limits out of the `limits` array.
    _findLimit(limits, unit, number) {
        return limits.find(l =>
            l?.type === TOKENS_LIMIT && l.unit === unit && l.number === number);
    }

    _updateDisplay(data) {
        // The plan tier ("pro"/"lite"/"max") rides along with the quota data.
        this._plan = formatPlanName(data?.level);
        this._applyPlan();

        const limits = Array.isArray(data?.limits) ? data.limits : [];
        const five = this._findLimit(limits, 3, 5);
        const weekly = this._findLimit(limits, 6, 1);

        const fivePct = typeof five?.percentage === 'number' ? five.percentage : 0;
        const weeklyPct = typeof weekly?.percentage === 'number' ? weekly.percentage : 0;

        this._maybeNotifyReset(fivePct);

        this._label.set_text(`${Math.round(fivePct)}%`);
        updatePanelProgressBar(this._panelProgressBar, fivePct);

        this._fiveHourPercent.set_text(`${fivePct.toFixed(1)}%`);
        updateProgressBar(this._fiveHourProgressBar, this._fiveHourProgressBg, fivePct);
        this._setResetLabel(this._fiveHourResetLabel, five?.nextResetTime);

        this._weeklyPercent.set_text(`${weeklyPct.toFixed(1)}%`);
        updateProgressBar(this._weeklyProgressBar, this._weeklyProgressBg, weeklyPct);
        this._setResetLabel(this._weeklyResetLabel, weekly?.nextResetTime);
    }

    _setResetLabel(label, nextResetTime) {
        if (typeof nextResetTime === 'number' && nextResetTime > 0) {
            label.set_text(`Resets in ${formatResetCountdown(new Date(nextResetTime))}`);
        } else {
            label.set_text('—');
        }
    }

    // Hard "no data" state: set the panel number and both dropdown percent
    // labels, and clear the bars and reset labels — a stale bar fill
    // contradicting the error text would be misleading.
    _setMessage(label, fiveHour, weekly) {
        // Drop any stale plan tag so an error state doesn't keep advertising a
        // tier we can no longer confirm.
        this._plan = '';
        this._applyPlan();
        this._label.set_text(label);
        this._fiveHourPercent.set_text(fiveHour);
        this._weeklyPercent.set_text(weekly);
        this._fiveHourResetLabel.set_text('—');
        this._weeklyResetLabel.set_text('—');
        updatePanelProgressBar(this._panelProgressBar, 0);
        updateProgressBar(this._fiveHourProgressBar, this._fiveHourProgressBg, 0);
        updateProgressBar(this._weeklyProgressBar, this._weeklyProgressBg, 0);
    }

    // Fire a reset notification when the 5-hour usage drops below the configured
    // threshold after having reached it. Always updates the baseline (even when
    // notifications are off) so toggling the setting on mid-session has a valid
    // previous reading to compare against.
    _maybeNotifyReset(fivePct) {
        if (this._settings.get_boolean('zai-notify-reset') &&
            isUsageReset(this._lastFivePct, fivePct,
                this._settings.get_int('zai-notify-threshold'))) {
            notifyUsageReset('GLM');
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
            applyBarWidth(this._fiveHourProgressBar, this._fiveHourProgressBg);
            applyBarWidth(this._weeklyProgressBar, this._weeklyProgressBg);
            return GLib.SOURCE_REMOVE;
        });
    }
}
