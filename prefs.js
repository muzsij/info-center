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

    // The Claude and GLM pages share an identical Notifications group, differing
    // only in the settings-key prefix and the service name in the wording.
    _buildNotificationsGroup(page, settings, keyPrefix, serviceName) {
        const group = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: `Get notified when your ${serviceName} 5-hour usage ` +
                'window resets',
        });
        page.add(group);

        const enableRow = new Adw.SwitchRow({
            title: 'Notify on 5-Hour Reset',
            subtitle: `Send a notification when ${serviceName} 5-hour usage ` +
                'resets after reaching the threshold below',
        });
        settings.bind(
            `${keyPrefix}-notify-reset`,
            enableRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(enableRow);

        const thresholdRow = new Adw.SpinRow({
            title: 'Minimum Level',
            subtitle: 'Only announce resets of windows that reached at least ' +
                'this usage percentage',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int(`${keyPrefix}-notify-threshold`),
            }),
        });
        settings.bind(
            `${keyPrefix}-notify-threshold`,
            thresholdRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        // The threshold only matters when notifications are on, so gate its
        // sensitivity on the toggle.
        settings.bind(
            `${keyPrefix}-notify-reset`,
            thresholdRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );
        group.add(thresholdRow);
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._registerIcons(window);
        this._applyStyles(window);

        this._buildSettingsPage(window, settings);
        this._buildClaudePage(window, settings);
        this._buildZaiPage(window, settings);
        this._buildRedminePage(window, settings);
        this._buildHubstaffPage(window, settings);
    }

    // Register the bundled icons/ directory with the display's icon theme so the
    // per-product page tabs can show official product logos placed there
    // (info-center-claude/glm/redmine/hubstaff.svg). This wires up the lookup
    // path and remembers the dir for _pageIcon.
    _registerIcons(window) {
        this._iconsDir = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'icons']));
        if (this._iconsDir.query_exists(null)) {
            Gtk.IconTheme.get_for_display(window.get_display())
                .add_search_path(this._iconsDir.get_path());
        }
    }

    // Enlarge the product logos in the page-switcher (the top switcher and the
    // narrow-mode bottom bar) beyond the ~16px Adwaita default so the brand
    // marks read clearly. Scoped to the viewswitcher's images so nothing else
    // in the window is affected.
    _applyStyles(window) {
        const provider = new Gtk.CssProvider();
        provider.load_from_string(
            'viewswitcher button image { -gtk-icon-size: 24px; }');
        Gtk.StyleContext.add_provider_for_display(
            window.get_display(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }

    // Use the bundled product icon `name` if a matching file (SVG or PNG) exists
    // in icons/, otherwise fall back to a generic symbolic icon — so a tab never
    // shows a broken icon before the user drops in the official logo, and picks
    // it up automatically once the file is present.
    _pageIcon(name, fallback) {
        for (const ext of ['svg', 'png']) {
            if (this._iconsDir.get_child(`${name}.${ext}`).query_exists(null)) {
                return name;
            }
        }
        return fallback;
    }

    // Every feature page starts with the same General group holding a
    // refresh-interval spin row; only the key and wording differ.
    _buildGeneralGroup(page, settings, intervalKey, description, subtitle) {
        const group = new Adw.PreferencesGroup({
            title: 'General',
            description,
        });
        page.add(group);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int(intervalKey),
            }),
        });
        settings.bind(intervalKey, refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(refreshRow);
    }

    // The Redmine and Hubstaff pages have identical Earnings groups, differing
    // only in the settings-key prefix and how the tracked time is referred to.
    _buildEarningsGroup(page, settings, keyPrefix, sourceNoun, hoverNoun) {
        const earningsGroup = new Adw.PreferencesGroup({
            title: 'Earnings',
            description: 'Show estimated earnings in a tooltip when you hover ' +
                `over the ${hoverNoun}`,
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
                value: settings.get_double(`${keyPrefix}-hourly-rate`),
            }),
        });
        settings.bind(
            `${keyPrefix}-hourly-rate`,
            rateRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        earningsGroup.add(rateRow);

        const currencyRow = new Adw.EntryRow({
            title: 'Currency',
        });
        currencyRow.set_text(settings.get_string(`${keyPrefix}-currency`));
        currencyRow.connect('changed', () => {
            settings.set_string(`${keyPrefix}-currency`, currencyRow.get_text().trim());
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
                value: settings.get_int(`${keyPrefix}-currency-decimals`),
            }),
        });
        settings.bind(
            `${keyPrefix}-currency-decimals`,
            decimalsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        earningsGroup.add(decimalsRow);

        const earningsHint = new Gtk.Label({
            label: `Earnings are estimated from your ${sourceNoun} × this ` +
                'hourly rate and shown in a tooltip when you hover over the ' +
                `${hoverNoun}. Currency is just a label (e.g. USD, EUR, $).`,
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        earningsGroup.add(earningsHint);
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
            description: 'Proxy used for all outgoing requests (Claude, GLM, Redmine and Hubstaff)',
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
            icon_name: this._pageIcon('info-center-claude', 'preferences-system-symbolic'),
        });
        window.add(page);

        this._buildGeneralGroup(page, settings, 'refresh-interval',
            'Configure the Info Center extension',
            'How often to refresh usage data (in seconds)');

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

        const dropdownGroup = new Adw.PreferencesGroup({
            title: 'Dropdown',
            description: 'Configure how Claude usage is shown in the dropdown menu',
        });
        page.add(dropdownGroup);

        const compactRow = new Adw.SwitchRow({
            title: 'Compact View',
            subtitle: 'Show the 5-hour and 7-day usage as one compact block ' +
                'instead of two separate sections',
        });
        settings.bind(
            'claude-compact-view',
            compactRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        dropdownGroup.add(compactRow);

        this._buildNotificationsGroup(page, settings, 'claude', 'Claude');
    }

    _buildZaiPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'GLM',
            icon_name: this._pageIcon('info-center-glm', 'utilities-system-monitor-symbolic'),
        });
        window.add(page);

        this._buildGeneralGroup(page, settings, 'zai-refresh-interval',
            'Configure how z.ai GLM Coding Plan usage is refreshed',
            'How often to refresh GLM usage data (in seconds)');

        const connectionGroup = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Show your z.ai GLM Coding Plan 5-hour and weekly usage',
        });
        page.add(connectionGroup);

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: 'API Key',
            show_apply_button: true,
        });
        apiKeyRow.set_text(settings.get_string('zai-api-key'));
        apiKeyRow.connect('apply', () => {
            settings.set_string('zai-api-key', apiKeyRow.get_text().trim());
        });
        connectionGroup.add(apiKeyRow);

        const apiKeyHint = new Gtk.Label({
            label: 'Create one at z.ai/manage-apikey/apikey-list (leave empty to ' +
                'disable). When set, GLM 5-hour and weekly usage appears in the ' +
                'panel next to Claude and in the dropdown.',
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        connectionGroup.add(apiKeyHint);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'How the GLM number is shown in the panel, independently ' +
                'of Claude',
        });
        page.add(displayGroup);

        const displayModeRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'Show GLM usage as text percentage, progress bar, or both',
        });

        const displayModeModel = new Gtk.StringList();
        displayModeModel.append('Text (percentage)');
        displayModeModel.append('Progress Bar');
        displayModeModel.append('Both');
        displayModeRow.set_model(displayModeModel);

        const modes = ['text', 'bar', 'both'];
        const currentMode = settings.get_string('zai-display-mode');
        displayModeRow.set_selected(Math.max(0, modes.indexOf(currentMode)));

        displayModeRow.connect('notify::selected', () => {
            settings.set_string('zai-display-mode', modes[displayModeRow.get_selected()]);
        });

        displayGroup.add(displayModeRow);

        const dropdownGroup = new Adw.PreferencesGroup({
            title: 'Dropdown',
            description: 'Configure how GLM usage is shown in the dropdown menu',
        });
        page.add(dropdownGroup);

        const compactRow = new Adw.SwitchRow({
            title: 'Compact View',
            subtitle: 'Show the 5-hour and weekly usage as one compact block ' +
                'instead of two separate sections',
        });
        settings.bind(
            'zai-compact-view',
            compactRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        dropdownGroup.add(compactRow);

        this._buildNotificationsGroup(page, settings, 'zai', 'GLM');
    }

    _buildRedminePage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Redmine',
            icon_name: this._pageIcon('info-center-redmine', 'network-server-symbolic'),
        });
        window.add(page);

        this._buildGeneralGroup(page, settings, 'redmine-refresh-interval',
            'Configure how Redmine data is refreshed',
            'How often to refresh Redmine data (in seconds)');

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

        this._buildEarningsGroup(page, settings, 'redmine',
            'logged time', 'monthly time');

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
            icon_name: this._pageIcon('info-center-hubstaff', 'preferences-desktop-time-symbolic'),
        });
        window.add(page);

        this._buildGeneralGroup(page, settings, 'hubstaff-refresh-interval',
            'Configure how Hubstaff data is refreshed',
            'How often to refresh Hubstaff data (in seconds)');

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

        this._buildEarningsGroup(page, settings, 'hubstaff',
            'tracked time', 'tracked time');
    }

    // GET a Redmine JSON endpoint; calls onResult(error, data) exactly once.
    // Soup.Message.new returns null for an unparseable URL (e.g. one entered
    // without a scheme) — surfaced as an error instead of the null deref
    // throwing out of the caller mid-way.
    _redmineGet(url, apiKey, onResult) {
        const message = Soup.Message.new('GET', url);
        if (!message) {
            onResult(new Error('invalid server URL'), null);
            return;
        }
        message.request_headers.append('X-Redmine-API-Key', apiKey);

        this._prefsSession().send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        onResult(new Error(`HTTP ${message.status_code}`), null);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    onResult(null, JSON.parse(decoder.decode(bytes.get_data())));
                } catch (e) {
                    onResult(e, null);
                }
            }
        );
    }

    // Replace `rows` in `group` with one checkbox row per {id, name} item,
    // each toggling its id in the string-array key `settingsKey`.
    _populateCheckRows(settings, group, rows, items, settingsKey) {
        for (const row of rows) {
            group.remove(row);
        }
        rows.length = 0;

        const selected = new Set(settings.get_strv(settingsKey));
        for (const {id, name} of items) {
            const row = new Adw.ActionRow({ title: name });
            const check = new Gtk.CheckButton({
                active: selected.has(id),
                valign: Gtk.Align.CENTER,
            });
            check.connect('toggled', () => {
                const current = new Set(settings.get_strv(settingsKey));
                if (check.get_active()) {
                    current.add(id);
                } else {
                    current.delete(id);
                }
                settings.set_strv(settingsKey, [...current]);
            });
            row.add_prefix(check);
            row.set_activatable_widget(check);

            group.add(row);
            rows.push(row);
        }
    }

    _fetchStatuses(settings, statusesGroup, statusRows) {
        const baseUrl = settings.get_string('redmine-url').trim().replace(/\/+$/, '');
        const apiKey = settings.get_string('redmine-api-key').trim();

        if (!baseUrl || !apiKey) {
            return;
        }

        this._redmineGet(`${baseUrl}/issue_statuses.json`, apiKey, (error, data) => {
            // Statuses are optional; surface nothing on failure.
            if (error) {
                return;
            }

            const statuses = data.issue_statuses ?? [];
            if (statuses.length === 0) {
                return;
            }

            this._populateCheckRows(
                settings, statusesGroup, statusRows,
                statuses.map(s => ({id: String(s.id), name: s.name})),
                'redmine-statuses'
            );
        });
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

        fetchButton.set_sensitive(false);
        setStatus('Fetching projects…');

        this._redmineGet(`${baseUrl}/projects.json?limit=100`, apiKey, (error, data) => {
            fetchButton.set_sensitive(true);

            if (error) {
                setStatus(`Error: ${error.message}`);
                return;
            }

            const projects = data.projects ?? [];
            if (projects.length === 0) {
                setStatus('No projects found.');
                return;
            }

            // Cache id→name so the panel can label projects before its own
            // fetch returns.
            const nameMap = {};
            for (const project of projects) {
                nameMap[String(project.id)] = project.name;
            }
            settings.set_value(
                'redmine-project-names',
                new GLib.Variant('a{ss}', nameMap)
            );

            this._populateCheckRows(
                settings, projectsGroup, projectRows,
                projects.map(p => ({id: String(p.id), name: p.name})),
                'redmine-projects'
            );

            setStatus(`Loaded ${projects.length} project(s).`);
        });
    }
}
