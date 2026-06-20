import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';

const InfoCenterIndicator = GObject.registerClass(
class InfoCenterIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Info Center Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'info-center-icon-22.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'info-center-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'info-center-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'info-center-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'info-center-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();

        this._updateDisplayMode();
        this._updateIconVisibility();
        this._updateIconStyle();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (
                key === 'redmine-url' ||
                key === 'redmine-api-key' ||
                key === 'redmine-projects' ||
                key === 'redmine-project-names'
            ) {
                this._refreshRedmine();
            }
        });

        this._refreshUsage();
        this._refreshRedmine();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }
        this._session = this._createSession();
        this._refreshUsage();
	}
    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
    }

    _createMenu() {
        const fiveHourBox = new St.BoxLayout({
            style_class: 'info-center-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({ vertical: false });
        const fiveHourLabel = new St.Label({
            text: '5-Hour Usage',
            style_class: 'info-center-section-title',
        });
        fiveHourHeader.add_child(fiveHourLabel);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'info-center-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'info-center-progress-bg',
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'info-center-progress-bar usage-low',
        });
        fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'info-center-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sevenDayBox = new St.BoxLayout({
            style_class: 'info-center-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({ vertical: false });
        const sevenDayLabel = new St.Label({
            text: '7-Day Usage',
            style_class: 'info-center-section-title',
        });
        sevenDayHeader.add_child(sevenDayLabel);
        this._sevenDayPercent = new St.Label({
            text: '...',
            style_class: 'info-center-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        sevenDayHeader.add_child(this._sevenDayPercent);
        sevenDayBox.add_child(sevenDayHeader);

        const sevenDayProgressBg = new St.Widget({
            style_class: 'info-center-progress-bg',
        });
        this._sevenDayProgressBar = new St.Widget({
            style_class: 'info-center-progress-bar usage-low',
        });
        sevenDayProgressBg.add_child(this._sevenDayProgressBar);
        sevenDayBox.add_child(sevenDayProgressBg);

        this._sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'info-center-reset-label',
        });
        sevenDayBox.add_child(this._sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        this._redmineSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._redmineSeparator);

        this._redmineBox = new St.BoxLayout({
            style_class: 'info-center-usage-section',
            vertical: true,
        });
        const redmineTitle = new St.Label({
            text: 'Redmine — this month',
            style_class: 'info-center-section-title',
        });
        this._redmineBox.add_child(redmineTitle);

        this._redmineRowsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'info-center-redmine-rows',
        });
        this._redmineBox.add_child(this._redmineRowsBox);

        this._redmineItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._redmineItem.add_child(this._redmineBox);
        this.menu.addMenuItem(this._redmineItem);

        // Hidden until Redmine is configured with at least one selected project.
        this._redmineSeparator.hide();
        this._redmineItem.hide();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                this._refreshRedmine();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _refreshUsage() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(null, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;

                if (!token) {
                    this._label.set_text('No token');
                    this._fiveHourPercent.set_text('No credentials');
                    this._sevenDayPercent.set_text('—');
                    return;
                }

                this._fetchUsage(token);
            } catch (e) {
                console.error('Info Center: Failed to read credentials:', e.message);
                this._label.set_text('No token');
                this._fiveHourPercent.set_text('No credentials');
                this._sevenDayPercent.set_text('—');
            }
        });
    }

    _fetchUsage(token) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        this._label.set_text('Error');
                        this._fiveHourPercent.set_text(`HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._updateDisplay(data);
                } catch (e) {
                    console.error('Info Center: Failed to fetch usage:', e.message);
                    this._label.set_text('Error');
                }
            }
        );
    }

    _updateDisplay(data) {
        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;

        this._label.set_text(`${Math.round(fiveHour)}%`);

        this._updatePanelProgressBar(fiveHour);

        this._fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(this._fiveHourProgressBar, fiveHour);

        this._sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(this._sevenDayProgressBar, sevenDay);

        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        }

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        }
    }

    _refreshRedmine() {
        if (!this._redmineItem) {
            return;
        }

        const baseUrl = this._settings.get_string('redmine-url').trim().replace(/\/+$/, '');
        const apiKey = this._settings.get_string('redmine-api-key').trim();
        const projectIds = this._settings.get_strv('redmine-projects');

        if (!baseUrl || !apiKey || projectIds.length === 0) {
            this._redmineSeparator.hide();
            this._redmineItem.hide();
            return;
        }

        const now = GLib.DateTime.new_now_local();
        const from = `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-01`;
        const to = now.format('%Y-%m-%d');

        this._fetchRedmineTimeEntries(baseUrl, apiKey, from, to, 0, {}, {});
    }

    _fetchRedmineTimeEntries(baseUrl, apiKey, from, to, offset, hoursByProject, namesByProject) {
        if (!this._session) {
            return;
        }

        const limit = 100;
        const url = `${baseUrl}/time_entries.json?user_id=me` +
            `&from=${from}&to=${to}&limit=${limit}&offset=${offset}`;
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('X-Redmine-API-Key', apiKey);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        this._setRedmineMessage(`Error: HTTP ${message.status_code}`);
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
                    if (nextOffset < totalCount) {
                        this._fetchRedmineTimeEntries(
                            baseUrl, apiKey, from, to, nextOffset, hoursByProject, namesByProject
                        );
                    } else {
                        this._updateRedmineDisplay(hoursByProject, namesByProject);
                    }
                } catch (e) {
                    console.error('Info Center: Failed to fetch Redmine time entries:', e.message);
                    this._setRedmineMessage('Error fetching data');
                }
            }
        );
    }

    _updateRedmineDisplay(hoursByProject, namesByProject = {}) {
        const projectIds = this._settings.get_strv('redmine-projects');
        const storedNames = this._settings.get_value('redmine-project-names').deep_unpack();

        this._redmineRowsBox.destroy_all_children();

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

            this._redmineRowsBox.add_child(row);
        }

        this._redmineSeparator.show();
        this._redmineItem.show();
    }

    _setRedmineMessage(text) {
        this._redmineRowsBox.destroy_all_children();
        this._redmineRowsBox.add_child(new St.Label({
            text,
            style_class: 'info-center-reset-label',
        }));
        this._redmineSeparator.show();
        this._redmineItem.show();
    }

    _formatHours(hours) {
        const totalMinutes = Math.round(hours * 60);
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return `${h}:${String(m).padStart(2, '0')}`;
    }

    _updatePanelProgressBar(usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    _updateProgressBar(progressBar, usage) {
        const maxWidth = 200;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (usage >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (usage >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (usage >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

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

    destroy() {
        this._stopTimer();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

export default class InfoCenterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new InfoCenterIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
