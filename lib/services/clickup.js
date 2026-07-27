import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {buildTaskListSection, addTaskRow, messageLabel} from '../shared/sections.js';

const API_BASE = 'https://api.clickup.com/api/v2';

// Owns the ClickUp menu sections: the "Today" / "Tomorrow" task lists, fed by
// the open tasks assigned to the signed-in user across every Workspace the
// personal API token can see. Off unless a clickup-api-token is set. This is
// the only place that touches the ClickUp API. The session is read through a
// getter so proxy recreation in the indicator is always reflected on the next
// fetch.
export class ClickUp {
    constructor(settings, getSession, extensionPath) {
        this._settings = settings;
        this._getSession = getSession;
        this._iconPath = GLib.build_filenamev([
            extensionPath, 'icons', 'info-center-clickup.svg']);
        this._cancellable = null;
    }

    destroy() {
        // Cancel any in-flight fetch chain so its callback doesn't touch the
        // menu widgets super.destroy() is about to dispose.
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    buildMenu(menu) {
        this._menu = menu;
        this._todaySection = buildTaskListSection(
            menu, 'ClickUp Tasks — Today', this._iconPath);
        this._tomorrowSection = buildTaskListSection(
            menu, 'ClickUp Tasks — Tomorrow', this._iconPath);
    }

    refresh() {
        if (!this._todaySection) {
            return;
        }

        // Cancel any in-flight fetch first, so overlapping refreshes (a timer
        // tick racing a clickup-api-token change) don't interleave on the
        // display, and so teardown can stop work that would otherwise touch
        // destroyed widgets.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const token = this._settings.get_string('clickup-api-token').trim();
        if (!token) {
            this._hideSections();
            return;
        }

        // Chain: own user id → Workspaces (teams) → per-Workspace tasks
        // assigned to me. The assignee filter needs the numeric user id, which
        // the token alone doesn't reveal.
        this._apiGet('/user', token, cancellable, (user) => {
            const userId = user?.user?.id;
            if (!userId) {
                this._setMessage('Error: unexpected user response');
                return;
            }
            this._apiGet('/team', token, cancellable, (data) => {
                const teams = data?.teams ?? [];
                if (teams.length === 0) {
                    this._setMessage('No Workspaces');
                    return;
                }
                this._fetchTeamTasks(
                    token, String(userId), teams, 0, 0, [], cancellable);
            });
        });
    }

    _hideSections() {
        for (const section of [this._todaySection, this._tomorrowSection]) {
            section.separator.hide();
            section.item.hide();
        }
    }

    // GET one page of a Workspace's tasks assigned to me, walking pages (100
    // tasks each; a short page means the last one) and then Workspaces
    // sequentially, accumulating into `tasks`. Closed tasks are excluded by
    // default (no include_closed), matching "every open task".
    _fetchTeamTasks(token, userId, teams, teamIndex, page, tasks, cancellable) {
        const teamId = teams[teamIndex].id;
        const url = `${API_BASE}/team/${teamId}/task` +
            `?assignees[]=${encodeURIComponent(userId)}` +
            `&subtasks=true&order_by=due_date&page=${page}`;

        this._apiGet(url, token, cancellable, (data) => {
            const pageTasks = data?.tasks ?? [];
            tasks.push(...pageTasks);

            if (pageTasks.length === 100) {
                this._fetchTeamTasks(
                    token, userId, teams, teamIndex, page + 1, tasks, cancellable);
            } else if (teamIndex + 1 < teams.length) {
                this._fetchTeamTasks(
                    token, userId, teams, teamIndex + 1, 0, tasks, cancellable);
            } else {
                this._updateDisplay(tasks);
            }
        });
    }

    // GET a ClickUp JSON endpoint (`path` may be a bare /v2 path or a full
    // URL) and call onData(parsed) on success; errors render into the task
    // sections. A personal token goes in Authorization verbatim (no Bearer).
    _apiGet(path, token, cancellable, onData) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
        const message = Soup.Message.new('GET', url);
        if (!message) {
            this._setMessage('Error: invalid ClickUp URL');
            return;
        }
        message.request_headers.append('Authorization', token);

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

                    if (message.status_code === 401 || message.status_code === 403) {
                        this._setMessage('Auth error — check API token');
                        return;
                    }
                    if (message.status_code !== 200) {
                        this._setMessage(`Error: HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    onData(JSON.parse(decoder.decode(bytes.get_data())));
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Failed to fetch ClickUp data:', e.message);
                    this._setMessage('Error fetching data');
                }
            }
        );
    }

    _updateDisplay(tasks) {
        const now = GLib.DateTime.new_now_local();
        const today = now.format('%Y-%m-%d');
        const tomorrow = now.add_days(1).format('%Y-%m-%d');

        // ClickUp dates are Unix-ms epochs serialized as strings (or null).
        const dateOf = (ms) => {
            if (!ms) {
                return null;
            }
            const dt = GLib.DateTime.new_from_unix_local(
                Math.floor(Number(ms) / 1000));
            return dt ? dt.format('%Y-%m-%d') : null;
        };

        const todayTasks = [];
        const tomorrowTasks = [];

        for (const task of tasks) {
            const start = dateOf(task.start_date);
            const due = dateOf(task.due_date);
            if (!start && !due) {
                continue;
            }

            // Same bucketing as Redmine: a multi-day task is "active" on every
            // day of its start..due span; with only one date set, the span
            // collapses to that single day. YYYY-MM-DD strings sort
            // chronologically.
            const spanStart = start ?? due;
            const spanEnd = due ?? start;

            if (spanStart <= today && today <= spanEnd) {
                todayTasks.push(task);
            }
            if (spanStart <= tomorrow && tomorrow <= spanEnd) {
                tomorrowTasks.push(task);
            }
        }

        this._setTaskRows(this._todaySection, todayTasks);
        this._setTaskRows(this._tomorrowSection, tomorrowTasks);
    }

    _setTaskRows(section, tasks) {
        section.rowsBox.destroy_all_children();

        if (tasks.length === 0) {
            section.rowsBox.add_child(messageLabel('No tasks'));
        } else {
            for (const task of tasks) {
                addTaskRow(
                    section.rowsBox, this._menu,
                    task.name ?? `#${task.id}`,
                    task.url ?? null
                );
            }
        }

        section.separator.show();
        section.item.show();
    }

    _setMessage(text) {
        for (const section of [this._todaySection, this._tomorrowSection]) {
            section.rowsBox.destroy_all_children();
            section.rowsBox.add_child(messageLabel(text));
            section.separator.show();
            section.item.show();
        }
    }
}
