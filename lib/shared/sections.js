import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {sectionTitleIcon} from './usageSection.js';

// Shared builders for the Redmine / Hubstaff "time — this month" dropdown
// sections, which have the same shape: a separator, a title row with a
// right-aligned running total, and a rows box with one name/value row per
// project — plus the Redmine / ClickUp task-list sections (Today / Tomorrow),
// which share a title + clickable-task-rows shape. Kept here so the feature
// modules don't duplicate the layout.

// Build the (initially hidden) totals section. The caller binds its earnings
// tooltip to `titleRow` and toggles `separator`/`item` visibility as data
// comes and goes.
export function buildTotalsSection(menu, title, iconPath) {
    const separator = new PopupMenu.PopupSeparatorMenuItem();
    separator.add_style_class_name('info-center-separator');
    menu.addMenuItem(separator);

    const box = new St.BoxLayout({
        style_class: 'info-center-usage-section',
        vertical: true,
    });
    const titleRow = new St.BoxLayout({ vertical: false });
    const icon = sectionTitleIcon(iconPath);
    if (icon) {
        titleRow.add_child(icon);
    }
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

// Build an (initially hidden) task-list section: separator + icon/title row +
// rows box. Same shell as the totals section but without the running total —
// used by the Redmine and ClickUp Today / Tomorrow task lists.
export function buildTaskListSection(menu, title, iconPath) {
    const separator = new PopupMenu.PopupSeparatorMenuItem();
    separator.add_style_class_name('info-center-separator');
    menu.addMenuItem(separator);

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

    // Hidden until the owning module is configured and has data to show.
    separator.hide();
    item.hide();

    return { separator, item, rowsBox };
}

// One task row: a wrapping label, clickable when a URL is given (opens it in
// the browser and closes `menu`).
export function addTaskRow(rowsBox, menu, text, url) {
    const label = new St.Label({
        text,
        style_class: 'info-center-issue-label',
        y_align: Clutter.ActorAlign.CENTER,
        // Fill the row width so wrapping happens at the (capped) menu width
        // instead of the label taking its natural single-line width and being
        // clipped on the right.
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
    });
    // Wrap long task names onto multiple lines instead of letting the label
    // grow and push the whole menu wider. This only takes effect because the
    // label fills the row and the section's max-width caps how wide that row
    // can get.
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

    // Clickable only when we know where to point the browser.
    if (!url) {
        rowsBox.add_child(label);
        return;
    }

    const button = new St.Button({
        child: label,
        style_class: 'info-center-issue-button',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        can_focus: true,
    });
    button.connect('clicked', () => {
        Gio.AppInfo.launch_default_for_uri(url, null);
        menu.close();
    });
    rowsBox.add_child(button);
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
