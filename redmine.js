import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Tooltip, formatMoney} from './tooltip.js';

// Owns the Redmine menu sections: the "Today" / "Tomorrow" issue lists and the
// per-project "this month" time totals. All sections are hidden until Redmine
// is configured with a URL, API key, and (for monthly totals) at least one
// selected project. The session is read through a getter so proxy recreation
// in the indicator is always reflected on the next fetch.
export class Redmine {
    constructor(settings, getSession) {
        this._settings = settings;
        this._getSession = getSession;
        this._cancellable = null;
        // Floating earnings tooltip (shared across the month-totals rows) and
        // the text shown when hovering the month-total title row.
        this._tooltip = new Tooltip();
        this._totalTooltip = '';
        // Last successful monthly-totals fetch, cached so a rate/currency change
        // can re-render earnings locally without hitting the API again (null =
        // no data yet).
        this._hoursByProject = null;
        this._namesByProject = null;
    }

    destroy() {
        // Cancel any in-flight issues / time-entries fetch so its callback
        // doesn't touch the menu widgets super.destroy() is about to dispose.
        this._cancellable?.cancel();
        this._cancellable = null;
        // The tooltip lives in Main.layoutManager.uiGroup, not under this.menu,
        // so super.destroy() won't reap it — drop it here or it leaks.
        this._tooltip.destroy();
    }

    buildMenu(menu) {
        this._menu = menu;

        // Today / Tomorrow task sections come before the "this month" totals.
        this._todaySection = this._createSection(menu, 'Redmine Issues — Today');
        this._tomorrowSection = this._createSection(menu, 'Redmine Issues — Tomorrow');

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this._separator.add_style_class_name('info-center-separator');
        menu.addMenuItem(this._separator);

        this._box = new St.BoxLayout({
            style_class: 'info-center-usage-section',
            vertical: true,
        });
        // Title row: heading on the left, the running month total on the right.
        const titleRow = new St.BoxLayout({ vertical: false });
        const title = new St.Label({
            text: 'Redmine time — this month',
            style_class: 'info-center-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(title);

        this._totalLabel = new St.Label({
            text: '',
            style_class: 'info-center-section-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(this._totalLabel);
        this._box.add_child(titleRow);

        // Hovering the title/total row reveals the estimated month earnings.
        // Bound once here (the row is persistent); it reads the latest text
        // from this._totalTooltip, set on each render.
        this._tooltip.bind(titleRow, () => this._totalTooltip);

        this._rowsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'info-center-redmine-rows',
        });
        this._box.add_child(this._rowsBox);

        this._item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._item.add_child(this._box);
        menu.addMenuItem(this._item);

        // Hidden until Redmine is configured with at least one selected project.
        this._separator.hide();
        this._item.hide();
    }

    _createSection(menu, title) {
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
        });
        box.add_child(titleLabel);

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

        // Hidden until Redmine is configured with at least one selected project.
        separator.hide();
        item.hide();

        return { separator, item, rowsBox };
    }

    refresh() {
        if (!this._item) {
            return;
        }

        // Cancel any in-flight fetch first, so overlapping refreshes (a timer
        // tick and a redmine-* settings change can both land here) don't race
        // to the display, and so teardown can stop work that would otherwise
        // touch the menu widgets after they're destroyed.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const baseUrl = this._settings.get_string('redmine-url').trim().replace(/\/+$/, '');
        const apiKey = this._settings.get_string('redmine-api-key').trim();
        const projectIds = this._settings.get_strv('redmine-projects');
        const allProjectTasks = this._settings.get_boolean('redmine-tasks-all-projects');

        // Tasks can run with all-projects mode even without a selection; the
        // monthly totals always need at least one selected project.
        if (!baseUrl || !apiKey || (projectIds.length === 0 && !allProjectTasks)) {
            this._hideTotals();
            this._todaySection.separator.hide();
            this._todaySection.item.hide();
            this._tomorrowSection.separator.hide();
            this._tomorrowSection.item.hide();
            return;
        }

        // Monthly time totals are project-scoped; skip (and hide) them when no
        // project is selected, even though task sections still run.
        if (projectIds.length > 0) {
            const now = GLib.DateTime.new_now_local();
            const from = `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-01`;
            const to = now.format('%Y-%m-%d');
            this._fetchTimeEntries(baseUrl, apiKey, from, to, 0, {}, {}, cancellable);
        } else {
            this._hideTotals();
        }

        this._fetchIssues(baseUrl, apiKey, 0, [], cancellable);
    }

    // Hide the monthly-totals section and drop its cached fetch + tooltip, so a
    // later rate/currency change (which calls rerender()) can't resurrect a
    // section that should stay hidden (e.g. no project selected).
    _hideTotals() {
        this._hoursByProject = null;
        this._namesByProject = null;
        this._totalTooltip = '';
        this._tooltip.hide();
        this._separator.hide();
        this._item.hide();
    }

    _fetchIssues(baseUrl, apiKey, offset, issues, cancellable) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const limit = 100;
        const url = `${baseUrl}/issues.json?assigned_to_id=me&status_id=*` +
            `&limit=${limit}&offset=${offset}`;
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('X-Redmine-API-Key', apiKey);

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
                        this._setIssuesMessage(`Error: HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const page = data.issues ?? [];
                    issues.push(...page);

                    const totalCount = data.total_count ?? issues.length;
                    const nextOffset = offset + limit;
                    if (nextOffset < totalCount && page.length > 0) {
                        this._fetchIssues(baseUrl, apiKey, nextOffset, issues, cancellable);
                    } else {
                        this._updateIssuesDisplay(issues);
                    }
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Failed to fetch Redmine issues:', e.message);
                    this._setIssuesMessage('Error fetching data');
                }
            }
        );
    }

    _updateIssuesDisplay(issues) {
        const allProjectTasks = this._settings.get_boolean('redmine-tasks-all-projects');
        const projectIds = new Set(this._settings.get_strv('redmine-projects'));
        const statusIds = new Set(this._settings.get_strv('redmine-statuses'));

        const now = GLib.DateTime.new_now_local();
        const today = now.format('%Y-%m-%d');
        const tomorrow = now.add_days(1).format('%Y-%m-%d');

        const todayIssues = [];
        const tomorrowIssues = [];

        for (const issue of issues) {
            const projectId = String(issue.project?.id ?? '');
            if (!allProjectTasks && !projectIds.has(projectId)) {
                continue;
            }

            // No statuses selected → all statuses count.
            const statusId = String(issue.status?.id ?? '');
            if (statusIds.size > 0 && !statusIds.has(statusId)) {
                continue;
            }

            const start = issue.start_date ?? null;
            const due = issue.due_date ?? null;
            if (!start && !due) {
                continue;
            }

            // A multi-day task is "active" on every day of its span. With only
            // one date set, the span collapses to that single day.
            const spanStart = start ?? due;
            const spanEnd = due ?? start;

            // YYYY-MM-DD strings sort chronologically.
            if (spanStart <= today && today <= spanEnd) {
                todayIssues.push(issue);
            }
            if (spanStart <= tomorrow && tomorrow <= spanEnd) {
                tomorrowIssues.push(issue);
            }
        }

        this._setIssueRows(this._todaySection, todayIssues);
        this._setIssueRows(this._tomorrowSection, tomorrowIssues);
    }

    _setIssueRows(section, issues) {
        section.rowsBox.destroy_all_children();

        if (issues.length === 0) {
            section.rowsBox.add_child(new St.Label({
                text: 'No tasks',
                style_class: 'info-center-reset-label',
            }));
        } else {
            const baseUrl = this._settings.get_string('redmine-url')
                .trim().replace(/\/+$/, '');

            for (const issue of issues) {
                const label = new St.Label({
                    text: issue.subject ?? `#${issue.id}`,
                    style_class: 'info-center-reset-label',
                    y_align: Clutter.ActorAlign.CENTER,
                });

                // Clickable only when we know where to point the browser.
                if (baseUrl) {
                    const button = new St.Button({
                        child: label,
                        style_class: 'info-center-issue-button',
                        x_align: Clutter.ActorAlign.START,
                        can_focus: true,
                    });
                    button.connect('clicked', () => {
                        Gio.AppInfo.launch_default_for_uri(
                            `${baseUrl}/issues/${issue.id}`, null);
                        this._menu.close();
                    });
                    section.rowsBox.add_child(button);
                } else {
                    section.rowsBox.add_child(label);
                }
            }
        }

        section.separator.show();
        section.item.show();
    }

    _setIssuesMessage(text) {
        for (const section of [this._todaySection, this._tomorrowSection]) {
            section.rowsBox.destroy_all_children();
            section.rowsBox.add_child(new St.Label({
                text,
                style_class: 'info-center-reset-label',
            }));
            section.separator.show();
            section.item.show();
        }
    }

    _fetchTimeEntries(baseUrl, apiKey, from, to, offset, hoursByProject, namesByProject, cancellable) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const limit = 100;
        const url = `${baseUrl}/time_entries.json?user_id=me` +
            `&from=${from}&to=${to}&limit=${limit}&offset=${offset}`;
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('X-Redmine-API-Key', apiKey);

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
                        this._setMessage(`Error: HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const entries = data.time_entries ?? [];

                    for (const entry of entries) {
                        const id = String(entry.project?.id ?? '');
                        if (id) {
                            hoursByProject[id] = (hoursByProject[id] ?? 0) + (entry.hours ?? 0);
                            if (entry.project?.name) {
                                namesByProject[id] = entry.project.name;
                            }
                        }
                    }

                    const totalCount = data.total_count ?? entries.length;
                    const nextOffset = offset + limit;
                    if (nextOffset < totalCount && entries.length > 0) {
                        this._fetchTimeEntries(
                            baseUrl, apiKey, from, to, nextOffset,
                            hoursByProject, namesByProject, cancellable
                        );
                    } else {
                        this._updateDisplay(hoursByProject, namesByProject);
                    }
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Failed to fetch Redmine time entries:', e.message);
                    this._setMessage('Error fetching data');
                }
            }
        );
    }

    _updateDisplay(hoursByProject, namesByProject = {}) {
        // Cache the raw fetch so rerender() can recompute earnings after a
        // rate/currency change without hitting the API again.
        this._hoursByProject = hoursByProject;
        this._namesByProject = namesByProject;

        const projectIds = this._settings.get_strv('redmine-projects');
        const storedNames = this._settings.get_value('redmine-project-names').deep_unpack();

        // A render replaces every row; hide any tooltip still pointing at one.
        this._tooltip.hide();
        this._rowsBox.destroy_all_children();

        // Earnings are derived here from the current rate so prefs changes take
        // effect on the next render (see rerender()).
        const rate = this._settings.get_double('redmine-hourly-rate');
        const currency = this._settings.get_string('redmine-currency').trim();
        const decimals = this._settings.get_int('redmine-currency-decimals');
        const earningsFor = (hours) => rate > 0 ? hours * rate : 0;

        const total = projectIds.reduce(
            (sum, id) => sum + (hoursByProject[id] ?? 0), 0);
        this._totalLabel.set_text(total > 0 ? this._formatHours(total) : '');

        // Month earnings tooltip on the title row — only when there is something
        // to show (rate > 0); an empty string disables the tooltip entirely.
        const totalEarnings = earningsFor(total);
        this._totalTooltip = totalEarnings > 0
            ? `Earned this month: ${formatMoney(totalEarnings, currency, decimals)}`
            : '';

        for (const id of projectIds) {
            const name = namesByProject[id] ?? storedNames[id] ?? `Project #${id}`;
            const hours = hoursByProject[id] ?? 0;

            const row = new St.BoxLayout({ vertical: false });
            const nameLabel = new St.Label({
                text: name,
                style_class: 'info-center-reset-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(nameLabel);

            const valueLabel = new St.Label({
                text: this._formatHours(hours),
                style_class: 'info-center-percent-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(valueLabel);

            // Per-project earnings tooltip (only when we have a rate).
            const earned = earningsFor(hours);
            if (earned > 0) {
                const text = `Earned: ${formatMoney(earned, currency, decimals)}`;
                this._tooltip.bind(row, () => text);
            }

            this._rowsBox.add_child(row);
        }

        this._separator.show();
        this._item.show();
    }

    // Re-render from the cached fetch (e.g. after a rate/currency change) so
    // earnings update without another round-trip. No-op until the first fetch.
    rerender() {
        if (this._item && this._hoursByProject) {
            this._updateDisplay(this._hoursByProject, this._namesByProject);
        }
    }

    _setMessage(text) {
        this._tooltip.hide();
        // The cached fetch is no longer what's on screen; drop it so a later
        // rate change doesn't re-render stale data over this message.
        this._hoursByProject = null;
        this._namesByProject = null;
        // No earnings to show in an error state — disable the tooltip.
        this._totalTooltip = '';
        this._totalLabel.set_text('');
        this._rowsBox.destroy_all_children();
        this._rowsBox.add_child(new St.Label({
            text,
            style_class: 'info-center-reset-label',
        }));
        this._separator.show();
        this._item.show();
    }

    _formatHours(hours) {
        const totalMinutes = Math.round(hours * 60);
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return `${h}:${String(m).padStart(2, '0')}`;
    }
}
