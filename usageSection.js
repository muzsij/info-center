import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Shared builders for the two-part "usage" dropdown sections used by both the
// Claude (claudeUsage.js) and GLM / z.ai (zai.js) modules: a title + right-
// aligned percent, a progress bar, and a reset-time label. Both providers
// expose the same shape (a 5-hour and a longer rolling window), so the section
// widget and the bar math live here once.

// One usage section: title + right-aligned percent, a progress bar, and a
// reset-time label. Returns the widgets the caller updates plus the menu item
// itself, so a caller can toggle the whole section's visibility.
export function buildUsageSection(menu, title) {
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
        x_expand: true,
    });
    const bar = new St.Widget({
        style_class: 'info-center-progress-bar usage-low',
    });
    bg.add_child(bar);
    // The bg stretches to the menu width, so the fill width must track the bg's
    // *actual* allocated width, not a hardcoded max — recompute it whenever the
    // bg is (re)allocated (e.g. the first time the menu opens).
    bg.connect('notify::width', () => applyBarWidth(bar, bg));
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

    return { percent, bar, bg, resetLabel, item };
}

// Size the fill against the bg's current allocated width from the 0..1 fraction
// stored on the bar. Reapplied from notify::width too, so it stays correct when
// the menu (and thus the bg) is resized.
export function applyBarWidth(bar, bg) {
    const fraction = bar._fillFraction ?? 0;
    bar.set_width(Math.round(bg.get_width() * fraction));
}

// Store the 0..1 fill fraction on the bar, size it, and swap the usage-* CSS
// class driving the fill color (thresholds 40/70/90 → low/medium/high/critical).
export function updateProgressBar(bar, bg, usage) {
    bar._fillFraction = Math.min(100, Math.max(0, usage)) / 100;
    applyBarWidth(bar, bg);

    const level = usage >= 90 ? 'usage-critical'
        : usage >= 70 ? 'usage-high'
        : usage >= 40 ? 'usage-medium'
        : 'usage-low';
    for (const cls of ['usage-low', 'usage-medium', 'usage-high', 'usage-critical']) {
        if (cls === level) {
            bar.add_style_class_name(cls);
        } else {
            bar.remove_style_class_name(cls);
        }
    }
}

// The small fixed-width panel progress bar (0..50px) that mirrors the 5-hour
// utilization next to the panel number.
export function updatePanelProgressBar(panelBar, usage) {
    const maxWidth = 50;
    const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
    panelBar.set_width(width);
}

// Countdown to a reset moment given as a Date, an ISO string, or a ms epoch
// (Claude reports an ISO `resets_at`; z.ai reports a `nextResetTime` in ms).
// Returns "now" if past and "—" if unparseable.
export function formatResetCountdown(when) {
    const resetDate = when instanceof Date ? when : new Date(when);
    const diffMs = resetDate - new Date();

    // An unparsable input yields NaN (new Date() doesn't throw) — without this
    // it renders as "NaNm".
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
}
