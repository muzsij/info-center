import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClaudeUsage} from './claudeUsage.js';
import {Redmine} from './redmine.js';

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

        // The Claude and Redmine feature modules own their own menu sections and
        // fetch/render logic. They read the live Soup session through a getter so
        // proxy recreation here is picked up on their next request.
        const getSession = () => this._session;
        this._claude = new ClaudeUsage(
            this._settings, getSession, this._label, this._panelProgressBar);
        this._redmine = new Redmine(this._settings, getSession);

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
                key === 'redmine-project-names' ||
                key === 'redmine-statuses' ||
                key === 'redmine-tasks-all-projects'
            ) {
                // Toggling project/status checkboxes in prefs writes a key per
                // click; debounce so a flurry of changes triggers one fetch.
                this._scheduleRedmineRefresh();
            }
        });

        this._claude.refresh();
        this._redmine.refresh();
        this._startTimer();
    }

    _createMenu() {
        this._claude.buildMenu(this.menu);
        this._redmine.buildMenu(this.menu);

        const footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        footerSeparator.add_style_class_name('info-center-separator');
        this.menu.addMenuItem(footerSeparator);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
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
        this._claude.refresh();
        this._redmine.refresh();
    }

    // Coalesce rapid redmine-* settings changes (e.g. ticking several project
    // checkboxes in prefs) into a single refresh.
    _scheduleRedmineRefresh() {
        if (this._redmineRefreshId) {
            GLib.source_remove(this._redmineRefreshId);
        }
        this._redmineRefreshId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            400,
            () => {
                this._redmineRefreshId = null;
                this._redmine.refresh();
                return GLib.SOURCE_REMOVE;
            }
        );
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

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._claude.refresh();
                this._redmine.refresh();
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

    destroy() {
        this._stopTimer();
        if (this._redmineRefreshId) {
            GLib.source_remove(this._redmineRefreshId);
            this._redmineRefreshId = null;
        }
        this._claude.destroy();
        this._redmine.destroy();
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
        this._placeIndicator();

        this._placementChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'panel-box' || key === 'panel-position') {
                this._placeIndicator();
            }
        });
    }

    _placeIndicator() {
        // Re-create so the indicator can move between panel boxes; destroying it
        // first clears its entry in Main.panel.statusArea[this.uuid].
        this._indicator?.destroy();
        this._indicator = new InfoCenterIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );

        const validBoxes = ['left', 'center', 'right'];
        let box = this._settings.get_string('panel-box');
        if (!validBoxes.includes(box)) {
            box = 'right';
        }
        const position = this._settings.get_int('panel-position');

        Main.panel.addToStatusArea(this.uuid, this._indicator, position, box);
    }

    disable() {
        if (this._placementChangedId) {
            this._settings.disconnect(this._placementChangedId);
            this._placementChangedId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
