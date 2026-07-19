import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Shared builders for the two-part "usage" dropdown sections used by both the
// Claude (claudeUsage.js) and GLM / z.ai (zai.js) modules: a title + right-
// aligned percent, a progress bar, and a reset-time label. Both providers
// expose the same shape (a 5-hour and a longer rolling window), so the section
// widget and the bar math live here once.

// A small product logo placed before a section title. Sized (14px, centered) so
// it aligns with the ~13px title text without making the row taller. Returns
// null for an empty path so callers can prepend it unconditionally.
export function sectionTitleIcon(iconPath) {
    if (!iconPath) {
        return null;
    }
    return new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        style_class: 'info-center-section-icon',
        icon_size: 14,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// One usage section: title + right-aligned percent, a progress bar, and a
// reset-time label. Returns the widgets the caller updates plus the menu item
// itself, so a caller can toggle the whole section's visibility. An optional
// iconPath prepends the product logo before the title.
export function buildUsageSection(menu, title, iconPath) {
    const box = new St.BoxLayout({
        style_class: 'info-center-usage-section',
        vertical: true,
    });
    const header = new St.BoxLayout({ vertical: false });
    const icon = sectionTitleIcon(iconPath);
    if (icon) {
        header.add_child(icon);
    }
    const titleLabel = new St.Label({
        text: title,
        style_class: 'info-center-section-title',
        y_align: Clutter.ActorAlign.CENTER,
    });
    header.add_child(titleLabel);
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

    return { percent, bar, bg, resetLabel, item, titleLabel };
}

// Compact variant of the two-window usage block: a single dropdown item with
// one title ("Claude"/"GLM"), and for each window a bar row (progress bar +
// right-aligned percent) followed by a reset row (reset countdown + a
// right-aligned tag naming the window, e.g. "5 hour" / "7-day"). Returns the
// same per-window widget shape as buildUsageSection so the caller's update code
// (percent/bar/bg/resetLabel) is identical; `item` is the single menu item. An
// optional iconPath prepends the product logo before the title.
export function buildCompactUsageSection(menu, title, fiveTag, weekTag, iconPath) {
    const box = new St.BoxLayout({
        style_class: 'info-center-usage-section',
        vertical: true,
    });
    const titleLabel = new St.Label({
        text: title,
        style_class: 'info-center-section-title',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const icon = sectionTitleIcon(iconPath);
    if (icon) {
        const titleRow = new St.BoxLayout({ vertical: false });
        titleRow.add_child(icon);
        titleRow.add_child(titleLabel);
        box.add_child(titleRow);
    } else {
        box.add_child(titleLabel);
    }

    const five = buildCompactWindow(box, fiveTag);
    const weekly = buildCompactWindow(box, weekTag);

    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
    });
    item.add_child(box);
    menu.addMenuItem(item);

    return { five, weekly, item, titleLabel, box };
}

// One window inside a compact block: a bar row and a reset row appended to
// `box`. `tag` labels the window at the end of the reset row. Exported so a
// caller can append an extra window to a compact block's `box` (e.g. the
// model-scoped weekly limit); the rows and tag label are returned so such an
// optional window can be hidden/relabelled by the caller.
export function buildCompactWindow(box, tag) {
    const barRow = new St.BoxLayout({
        vertical: false,
        style_class: 'info-center-compact-bar-row',
    });
    const bg = new St.Widget({
        style_class: 'info-center-progress-bg',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const bar = new St.Widget({
        style_class: 'info-center-progress-bar usage-low',
    });
    bg.add_child(bar);
    // Track the bg's actual allocated width — see buildUsageSection.
    bg.connect('notify::width', () => applyBarWidth(bar, bg));
    barRow.add_child(bg);
    const percent = new St.Label({
        text: '...',
        style_class: 'info-center-percent-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    barRow.add_child(percent);
    box.add_child(barRow);

    const resetRow = new St.BoxLayout({ vertical: false });
    const resetLabel = new St.Label({
        text: 'Resets: ...',
        style_class: 'info-center-reset-label',
        x_expand: true,
    });
    resetRow.add_child(resetLabel);
    const tagLabel = new St.Label({
        text: tag,
        style_class: 'info-center-reset-label info-center-compact-tag',
        x_align: Clutter.ActorAlign.END,
    });
    resetRow.add_child(tagLabel);
    box.add_child(resetRow);

    return { percent, bar, bg, resetLabel, barRow, resetRow, tagLabel };
}

// Size the fill against the bg's current allocated width from the 0..1 fraction
// stored on the bar. Reapplied from notify::width too, so it stays correct when
// the menu (and thus the bg) is resized.
export function applyBarWidth(bar, bg) {
    const fraction = bar._fillFraction ?? 0;
    const full = bg.get_width();
    let width = Math.round(full * fraction);
    // A nonzero-but-tiny fill (e.g. 1%) rounds to a few pixels — narrower than
    // the 8px bar height / 4px corner radius — so its rounded corners can't
    // render and it shows as a sharp sliver poking out of the track's rounded
    // left edge. Floor a visible fill at the bar height so it always draws as a
    // clean rounded pill that sits inside the track.
    if (fraction > 0) {
        width = Math.max(width, 8);
    }
    bar.set_width(Math.min(width, full));
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

// Insert a plan/subscription tag into a section title. Non-compact titles read
// "Claude (Max 5x) 5-Hour Usage" (tag in parens after the brand word); compact
// titles are just the brand ("Claude") and read "Claude · Max 5x". An empty
// plan restores the bare base title.
export function titleWithPlan(base, plan, compact) {
    if (!plan) {
        return base;
    }
    if (compact) {
        return `${base} · ${plan}`;
    }
    const sp = base.indexOf(' ');
    if (sp === -1) {
        return `${base} (${plan})`;
    }
    return `${base.slice(0, sp)} (${plan})${base.slice(sp)}`;
}

// Capitalize a plan/level identifier for display ("pro" → "Pro", "max" → "Max").
// Empty/non-string input yields '' so the title falls back to its bare form.
export function formatPlanName(type) {
    if (!type || typeof type !== 'string') {
        return '';
    }
    return type.charAt(0).toUpperCase() + type.slice(1);
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
