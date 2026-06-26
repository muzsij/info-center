import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class InfoCenterPreferences extends ExtensionPreferences {
    // One Soup session reused by the project / status fetches, instead of a new
    // one per click (the prefs process is short-lived, but no reason to leak).
    _prefsSession() {
        if (!this._session) {
            this._session = new Soup.Session();
        }
        return this._session;
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._buildSettingsPage(window, settings);
        this._buildClaudePage(window, settings);
        this._buildRedminePage(window, settings);
        this._buildHubstaffPage(window, settings);
    }

    _buildSettingsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'emblem-system-symbolic',
        });
        window.add(page);

        const placementGroup = new Adw.PreferencesGroup({
            title: 'Panel placement',
            description: 'Where the indicator appears in the top panel',
        });
        page.add(placementGroup);

        const boxRow = new Adw.ComboRow({
            title: 'Position',
            subtitle: 'Which side of the top panel to show the indicator',
        });
        const boxModel = new Gtk.StringList();
        boxModel.append('Left');
        boxModel.append('Center');
        boxModel.append('Right');
        boxRow.set_model(boxModel);

        const boxes = ['left', 'center', 'right'];
        const currentBox = settings.get_string('panel-box');
        boxRow.set_selected(Math.max(0, boxes.indexOf(currentBox)));
        boxRow.connect('notify::selected', () => {
            settings.set_string('panel-box', boxes[boxRow.get_selected()]);
        });
        placementGroup.add(boxRow);

        const priorityRow = new Adw.SpinRow({
            title: 'Priority',
            subtitle: 'Order within the chosen side (lower is closer to the start)',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('panel-position'),
            }),
        });
        settings.bind(
            'panel-position',
            priorityRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        placementGroup.add(priorityRow);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Proxy used for all outgoing requests (Claude and Redmine)',
        });
        page.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);

        const proxyHint = new Gtk.Label({
            label: 'Example: http://localhost:11809 (leave empty for no proxy)',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        networkGroup.add(proxyHint);
    }

    _buildClaudePage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Claude',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure the Info Center extension',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'Configure how usage is shown in the top panel',
        });
        page.add(displayGroup);

        const displayModeRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'Show usage as text percentage, progress bar, or both',
        });

        const displayModeModel = new Gtk.StringList();
        displayModeModel.append('Text (percentage)');
        displayModeModel.append('Progress Bar');
        displayModeModel.append('Both');
        displayModeRow.set_model(displayModeModel);

        const currentMode = settings.get_string('display-mode');
        const modeIndex = currentMode === 'bar' ? 1 : currentMode === 'both' ? 2 : 0;
        displayModeRow.set_selected(modeIndex);

        displayModeRow.connect('notify::selected', () => {
            const selected = displayModeRow.get_selected();
            const modes = ['text', 'bar', 'both'];
            settings.set_string('display-mode', modes[selected]);
        });

        displayGroup.add(displayModeRow);

        const iconStyleRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'Use a color or monochrome icon in the panel',
        });

        const iconStyleModel = new Gtk.StringList();
        iconStyleModel.append('Color');
        iconStyleModel.append('Monochrome');
        iconStyleRow.set_model(iconStyleModel);

        const currentStyle = settings.get_string('icon-style');
        iconStyleRow.set_selected(currentStyle === 'monochrome' ? 1 : 0);

        iconStyleRow.connect('notify::selected', () => {
            const selected = iconStyleRow.get_selected();
            settings.set_string('icon-style', selected === 1 ? 'monochrome' : 'color');
        });

        displayGroup.add(iconStyleRow);

        const showIconRow = new Adw.SwitchRow({
            title: 'Show Icon',
            subtitle: 'Display the icon in the top bar',
        });
        settings.bind(
            'show-icon',
            showIconRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(showIconRow);
    }

    _buildRedminePage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Redmine',
            icon_name: 'network-server-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure how Redmine data is refreshed',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh Redmine data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('redmine-refresh-interval'),
            }),
        });
        settings.bind(
            'redmine-refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const connectionGroup = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Configure access to your Redmine server',
        });
        page.add(connectionGroup);

        const urlRow = new Adw.EntryRow({
            title: 'Server URL',
            show_apply_button: true,
        });
        urlRow.set_text(settings.get_string('redmine-url'));
        urlRow.connect('apply', () => {
            settings.set_string('redmine-url', urlRow.get_text().trim());
        });
        connectionGroup.add(urlRow);

        const urlHint = new Gtk.Label({
            label: 'Example: https://redmine.example.com (leave empty to disable)',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        connectionGroup.add(urlHint);

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: 'API Key',
            show_apply_button: true,
        });
        apiKeyRow.set_text(settings.get_string('redmine-api-key'));
        apiKeyRow.connect('apply', () => {
            settings.set_string('redmine-api-key', apiKeyRow.get_text().trim());
        });
        connectionGroup.add(apiKeyRow);

        const apiKeyHint = new Gtk.Label({
            label: 'Found in Redmine under My account → API access key',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        connectionGroup.add(apiKeyHint);

        const fetchButton = new Gtk.Button({
            label: 'Fetch projects',
            css_classes: ['suggested-action'],
            halign: Gtk.Align.START,
            margin_start: 12,
            margin_top: 8,
            margin_bottom: 4,
        });
        connectionGroup.add(fetchButton);

        const statusLabel = new Gtk.Label({
            xalign: 0,
            visible: false,
            wrap: true,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        connectionGroup.add(statusLabel);

        const projectsGroup = new Adw.PreferencesGroup({
            title: 'Projects',
            description: 'Select the projects to fetch data from',
        });
        page.add(projectsGroup);

        const allProjectTasksRow = new Adw.SwitchRow({
            title: 'Show tasks from all projects',
            subtitle: 'Today and Tomorrow sections ignore the selection above ' +
                '(monthly totals still follow it)',
        });
        settings.bind(
            'redmine-tasks-all-projects',
            allProjectTasksRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        projectsGroup.add(allProjectTasksRow);

        // Rows currently shown in projectsGroup, so we can clear them on re-fetch.
        const projectRows = [];

        const statusesGroup = new Adw.PreferencesGroup({
            title: 'Task statuses',
            description: 'Select which issue statuses count for the Today and ' +
                'Tomorrow sections (none selected means all statuses count)',
        });
        page.add(statusesGroup);

        // Rows currently shown in statusesGroup, so we can clear them on re-fetch.
        const statusRows = [];

        const earningsGroup = new Adw.PreferencesGroup({
            title: 'Earnings',
            description: 'Show estimated earnings in a tooltip when you hover ' +
                'over the monthly time',
        });
        page.add(earningsGroup);

        const rateRow = new Adw.SpinRow({
            title: 'Hourly Rate',
            subtitle: 'Your pay rate, used to estimate earnings (set 0 to ' +
                'disable the earnings tooltip)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100000,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_double('redmine-hourly-rate'),
            }),
        });
        settings.bind(
            'redmine-hourly-rate',
            rateRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        earningsGroup.add(rateRow);

        const currencyRow = new Adw.EntryRow({
            title: 'Currency',
        });
        currencyRow.set_text(settings.get_string('redmine-currency'));
        currencyRow.connect('changed', () => {
            settings.set_string('redmine-currency', currencyRow.get_text().trim());
        });
        earningsGroup.add(currencyRow);

        const decimalsRow = new Adw.SpinRow({
            title: 'Decimal Places',
            subtitle: 'How many decimals to round earnings to. Negative rounds ' +
                'to higher values (e.g. -2 rounds to the nearest 100)',
            adjustment: new Gtk.Adjustment({
                lower: -6,
                upper: 6,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('redmine-currency-decimals'),
            }),
        });
        settings.bind(
            'redmine-currency-decimals',
            decimalsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        earningsGroup.add(decimalsRow);

        const earningsHint = new Gtk.Label({
            label: 'Earnings are estimated from your logged time × this hourly ' +
                'rate and shown in a tooltip when you hover over the monthly ' +
                'time. Currency is just a label (e.g. USD, EUR, $).',
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        earningsGroup.add(earningsHint);

        const fetchAll = () => {
            this._fetchProjects(settings, projectsGroup, projectRows, statusLabel, fetchButton);
            this._fetchStatuses(settings, statusesGroup, statusRows);
        };

        fetchButton.connect('clicked', fetchAll);

        // Auto-fetch when the tab becomes visible, if both fields are filled.
        page.connect('map', () => {
            const haveUrl = settings.get_string('redmine-url').trim() !== '';
            const haveKey = settings.get_string('redmine-api-key').trim() !== '';
            if (haveUrl && haveKey) {
                fetchAll();
            }
        });
    }

    _buildHubstaffPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Hubstaff',
            icon_name: 'preferences-desktop-time-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure how Hubstaff data is refreshed',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh Hubstaff data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('hubstaff-refresh-interval'),
            }),
        });
        settings.bind(
            'hubstaff-refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const connectionGroup = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Authenticate with the Hubstaff API',
        });
        page.add(connectionGroup);

        const tokenRow = new Adw.PasswordEntryRow({
            title: 'Personal Access Token',
            show_apply_button: true,
        });
        // Show the seed PAT, not the rotated token — that is the value the user
        // pasted and recognizes.
        tokenRow.set_text(settings.get_string('hubstaff-personal-access-token'));
        tokenRow.connect('apply', () => {
            const token = tokenRow.get_text().trim();
            const prev = settings.get_string('hubstaff-personal-access-token');
            // A new seed invalidates any rotated/cached token from the old one;
            // clear them first so the next refresh exchanges with the new PAT.
            // These keys are not watched in extension.js, so only the seed write
            // below triggers a refresh.
            settings.set_string('hubstaff-refresh-token', '');
            settings.set_string('hubstaff-access-token', '');
            settings.set_int64('hubstaff-token-expires-at', 0);
            // Re-applying the SAME PAT (e.g. to recover from an auth error) would
            // write an identical value, which dconf suppresses — no 'changed'
            // signal, so extension.js never re-runs the refresh. Force a value
            // transition by clearing the seed to '' first so the write below
            // always re-triggers.
            if (prev === token) {
                settings.set_string('hubstaff-personal-access-token', '');
            }
            settings.set_string('hubstaff-personal-access-token', token);
        });
        connectionGroup.add(tokenRow);

        const tokenHint = new Gtk.Label({
            label: 'Create one at developer.hubstaff.com → Personal access ' +
                'tokens, with the hubstaff:read scope (leave empty to disable). ' +
                'The token is a long-lived refresh token; the extension rotates ' +
                'it automatically.',
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        connectionGroup.add(tokenHint);

        const earningsGroup = new Adw.PreferencesGroup({
            title: 'Earnings',
            description: 'Show estimated earnings in a tooltip when you hover ' +
                'over the tracked time',
        });
        page.add(earningsGroup);

        const rateRow = new Adw.SpinRow({
            title: 'Hourly Rate',
            subtitle: 'Your pay rate, used to estimate earnings (set 0 to ' +
                'disable the earnings tooltip)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100000,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_double('hubstaff-hourly-rate'),
            }),
        });
        settings.bind(
            'hubstaff-hourly-rate',
            rateRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        earningsGroup.add(rateRow);

        const currencyRow = new Adw.EntryRow({
            title: 'Currency',
        });
        currencyRow.set_text(settings.get_string('hubstaff-currency'));
        currencyRow.connect('changed', () => {
            settings.set_string('hubstaff-currency', currencyRow.get_text().trim());
        });
        earningsGroup.add(currencyRow);

        const decimalsRow = new Adw.SpinRow({
            title: 'Decimal Places',
            subtitle: 'How many decimals to round earnings to. Negative rounds ' +
                'to higher values (e.g. -2 rounds to the nearest 100)',
            adjustment: new Gtk.Adjustment({
                lower: -6,
                upper: 6,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('hubstaff-currency-decimals'),
            }),
        });
        settings.bind(
            'hubstaff-currency-decimals',
            decimalsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        earningsGroup.add(decimalsRow);

        const earningsHint = new Gtk.Label({
            label: 'Earnings are estimated from your tracked time × this ' +
                'hourly rate and shown in a tooltip when you hover over the ' +
                'tracked time. Currency is just a label (e.g. USD, EUR, $).',
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        earningsGroup.add(earningsHint);
    }

    _fetchStatuses(settings, statusesGroup, statusRows) {
        const baseUrl = settings.get_string('redmine-url').trim().replace(/\/+$/, '');
        const apiKey = settings.get_string('redmine-api-key').trim();

        if (!baseUrl || !apiKey) {
            return;
        }

        for (const row of statusRows) {
            statusesGroup.remove(row);
        }
        statusRows.length = 0;

        const url = `${baseUrl}/issue_statuses.json`;
        const session = this._prefsSession();
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('X-Redmine-API-Key', apiKey);

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const statuses = data.issue_statuses ?? [];

                    if (statuses.length === 0) {
                        return;
                    }

                    const selected = new Set(settings.get_strv('redmine-statuses'));

                    const nameMap = {};
                    for (const status of statuses) {
                        nameMap[String(status.id)] = status.name;
                    }
                    settings.set_value(
                        'redmine-status-names',
                        new GLib.Variant('a{ss}', nameMap)
                    );

                    for (const status of statuses) {
                        const id = String(status.id);

                        const row = new Adw.ActionRow({ title: status.name });
                        const check = new Gtk.CheckButton({
                            active: selected.has(id),
                            valign: Gtk.Align.CENTER,
                        });
                        check.connect('toggled', () => {
                            const current = new Set(settings.get_strv('redmine-statuses'));
                            if (check.get_active()) {
                                current.add(id);
                            } else {
                                current.delete(id);
                            }
                            settings.set_strv('redmine-statuses', [...current]);
                        });
                        row.add_prefix(check);
                        row.set_activatable_widget(check);

                        statusesGroup.add(row);
                        statusRows.push(row);
                    }
                } catch (e) {
                    // Statuses are optional; surface nothing on failure.
                }
            }
        );
    }

    _fetchProjects(settings, projectsGroup, projectRows, statusLabel, fetchButton) {
        const baseUrl = settings.get_string('redmine-url').trim().replace(/\/+$/, '');
        const apiKey = settings.get_string('redmine-api-key').trim();

        const setStatus = (text) => {
            statusLabel.set_text(text);
            statusLabel.visible = true;
        };

        if (!baseUrl || !apiKey) {
            setStatus('Set the Server URL and API Key first (use the apply buttons).');
            return;
        }

        for (const row of projectRows) {
            projectsGroup.remove(row);
        }
        projectRows.length = 0;

        fetchButton.set_sensitive(false);
        setStatus('Fetching projects…');

        const url = `${baseUrl}/projects.json?limit=100`;
        const session = this._prefsSession();
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('X-Redmine-API-Key', apiKey);

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (sess, result) => {
                fetchButton.set_sensitive(true);
                try {
                    const bytes = sess.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        setStatus(`Error: HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const projects = data.projects ?? [];

                    if (projects.length === 0) {
                        setStatus('No projects found.');
                        return;
                    }

                    const selected = new Set(settings.get_strv('redmine-projects'));

                    const nameMap = {};
                    for (const project of projects) {
                        nameMap[String(project.id)] = project.name;
                    }
                    settings.set_value(
                        'redmine-project-names',
                        new GLib.Variant('a{ss}', nameMap)
                    );

                    for (const project of projects) {
                        const id = String(project.id);

                        const row = new Adw.ActionRow({ title: project.name });
                        const check = new Gtk.CheckButton({
                            active: selected.has(id),
                            valign: Gtk.Align.CENTER,
                        });
                        check.connect('toggled', () => {
                            const current = new Set(settings.get_strv('redmine-projects'));
                            if (check.get_active()) {
                                current.add(id);
                            } else {
                                current.delete(id);
                            }
                            settings.set_strv('redmine-projects', [...current]);
                        });
                        row.add_prefix(check);
                        row.set_activatable_widget(check);

                        projectsGroup.add(row);
                        projectRows.push(row);
                    }

                    setStatus(`Loaded ${projects.length} project(s).`);
                } catch (e) {
                    setStatus(`Error: ${e.message}`);
                }
            }
        );
    }
}
