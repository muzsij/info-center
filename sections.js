import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Shared builders for the Redmine / Hubstaff "time — this month" dropdown
// sections, which have the same shape: a separator, a title row with a
// right-aligned running total, and a rows box with one name/value row per
// project. Kept here so the two feature modules don't duplicate the layout.

// Build the (initially hidden) totals section. The caller binds its earnings
// tooltip to `titleRow` and toggles `separator`/`item` visibility as data
// comes and goes.
export function buildTotalsSection(menu, title) {
    const separator = new PopupMenu.PopupSeparatorMenuItem();
    separator.add_style_class_name('info-center-separator');
    menu.addMenuItem(separator);

    const box = new St.BoxLayout({
        style_class: 'info-center-usage-section',
        vertical: true,
    });
    const titleRow = new St.BoxLayout({ vertical: false });
    titleRow.add_child(new St.Label({
        text: title,
        style_class: 'info-center-section-title',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    const totalLabel = new St.Label({
        text: '',
        style_class: 'info-center-section-title',
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    });
    titleRow.add_child(totalLabel);
    box.add_child(titleRow);

    const rowsBox = new St.BoxLayout({
        vertical: true,
        style_class: 'info-center-redmine-rows',
    });
    box.add_child(rowsBox);

    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
    });
    item.add_child(box);
    menu.addMenuItem(item);

    separator.hide();
    item.hide();

    return { separator, item, titleRow, totalLabel, rowsBox };
}

// One name/value row (project name left, H:MM right). Returned so the caller
// can bind an earnings tooltip to it.
export function addTotalsRow(rowsBox, name, value) {
    const row = new St.BoxLayout({ vertical: false });
    row.add_child(new St.Label({
        text: name,
        style_class: 'info-center-reset-label',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    row.add_child(new St.Label({
        text: value,
        style_class: 'info-center-percent-label',
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    rowsBox.add_child(row);
    return row;
}

// A dim single-line message label (errors, empty states).
export function messageLabel(text) {
    return new St.Label({
        text,
        style_class: 'info-center-reset-label',
    });
}

// Format fractional hours as H:MM (e.g. 1.5 → "1:30").
export function formatHM(hours) {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}
