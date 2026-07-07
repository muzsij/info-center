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
import {ZaiUsage} from './zai.js';
import {Redmine} from './redmine.js';
import {Hubstaff} from './hubstaff.js';

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

        const iconPath = GLib.build_filenamev([
            this._extensionPath, 'icons', 'info-center-claude.svg']);
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

        // GLM (z.ai) panel segment, shown next to the Claude number when a z.ai
        // API key is configured. Its own GLM logo disambiguates the two
        // percentages; its bg/label/logo visibility is governed together with
        // the Claude widgets in _updateDisplayMode (gated on being configured).
        const zaiIconPath = GLib.build_filenamev([
            this._extensionPath, 'icons', 'info-center-glm.svg']);
        this._zaiPrefix = new St.Icon({
            gicon: Gio.icon_new_for_string(zaiIconPath),
            style_class: 'info-center-zai-prefix',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._zaiPrefix);

        this._zaiPanelProgressBg = new St.Widget({
            style_class: 'info-center-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._zaiPanelProgressBar = new St.Widget({
            style_class: 'info-center-panel-progress-bar',
        });
        this._zaiPanelProgressBg.add_child(this._zaiPanelProgressBar);
        this._box.add_child(this._zaiPanelProgressBg);

        this._zaiLabel = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'info-center-usage-label',
        });
        this._box.add_child(this._zaiLabel);

        this.add_child(this._box);

        // The Claude and Redmine feature modules own their own menu sections and
        // fetch/render logic. They read the live Soup session through a getter so
        // proxy recreation here is picked up on their next request.
        const getSession = () => this._session;
        this._claude = new ClaudeUsage(
            this._settings, getSession, this._label, this._panelProgressBar,
            this._extensionPath);
        this._zai = new ZaiUsage(
            this._settings, getSession, this._zaiLabel, this._zaiPanelProgressBar,
            this._extensionPath);
        this._redmine = new Redmine(this._settings, getSession, this._extensionPath);
        this._hubstaff = new Hubstaff(this._settings, getSession, this._extensionPath);

        // One refresh timer per feature module, each driven by its own
        // interval key; started/stopped/restarted by name via _startTimer & co.
        this._timers = {
            claude: {
                intervalKey: 'refresh-interval',
                module: this._claude,
                id: null,
            },
            zai: {
                intervalKey: 'zai-refresh-interval',
                module: this._zai,
                id: null,
            },
            redmine: {
                intervalKey: 'redmine-refresh-interval',
                module: this._redmine,
                id: null,
            },
            hubstaff: {
                intervalKey: 'hubstaff-refresh-interval',
                module: this._hubstaff,
                id: null,
            },
        };

        this._createMenu();

        this._updateDisplayMode();
        this._updateIconVisibility();
        this._updateIconStyle();

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer('claude');
            } else if (key === 'zai-refresh-interval') {
                this._restartTimer('zai');
            } else if (key === 'zai-api-key') {
                // Key added/changed/removed: refetch and re-evaluate the GLM
                // panel segment's visibility (it hides when no key is set).
                this._zai.refresh();
                this._updateDisplayMode();
            } else if (key === 'redmine-refresh-interval') {
                this._restartTimer('redmine');
            } else if (key === 'hubstaff-refresh-interval') {
                this._restartTimer('hubstaff');
            } else if (key === 'hubstaff-personal-access-token') {
                // The user-entered seed PAT changed (the rotating token and the
                // access-token cache are written by us and are not watched here,
                // so token rotation does not retrigger a refresh).
                this._hubstaff.refresh();
            } else if (key === 'hubstaff-hourly-rate' || key === 'hubstaff-currency' ||
                       key === 'hubstaff-currency-decimals') {
                // Earnings derive from the already-fetched tracked time, so just
                // recompute and re-render locally — no need to hit the API again.
                this._hubstaff.rerender();
            } else if (key === 'redmine-hourly-rate' || key === 'redmine-currency' ||
                       key === 'redmine-currency-decimals') {
                // Same as Hubstaff: earnings derive from the already-fetched
                // monthly time, so re-render locally instead of refetching.
                this._redmine.rerender();
            } else if (key === 'display-mode' || key === 'zai-display-mode') {
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

        this._refreshNow();
    }

    _createMenu() {
        this._claude.buildMenu(this.menu);
        this._zai.buildMenu(this.menu);
        this._redmine.buildMenu(this.menu);
        this._hubstaff.buildMenu(this.menu);

        const footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        footerSeparator.add_style_class_name('info-center-separator');
        this.menu.addMenuItem(footerSeparator);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        // Override activate() instead of connecting to its 'activate' signal so
        // the menu stays open — the base activate() is what tells the menu to
        // close, and here we want the user to watch the sections refresh in place.
        refreshItem.activate = () => this._refreshNow();
        this.menu.addMenuItem(refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    // Manual refresh (also the initial one): fetch every feature module now and
    // reset its refresh timer so the next automatic tick lands a full interval
    // after this refresh, instead of firing redundantly moments later.
    _refreshNow() {
        for (const name of Object.keys(this._timers)) {
            this._timers[name].module.refresh();
            this._restartTimer(name);
        }
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        this._panelProgressBg.visible = mode === 'bar' || mode === 'both';
        this._label.visible = mode !== 'bar';
        this._label.set_style(mode === 'both' ? 'margin-left: 6px;' : 'margin-left: 0;');

        // The GLM segment has its own independent display mode, but the whole
        // segment (tag + bar + number) is hidden unless a z.ai key is
        // configured, so users who don't use GLM see no change to the panel.
        const zaiMode = this._settings.get_string('zai-display-mode');
        const zaiOn = this._zai.isConfigured();
        this._zaiPrefix.visible = zaiOn;
        this._zaiPanelProgressBg.visible = zaiOn && (zaiMode === 'bar' || zaiMode === 'both');
        this._zaiLabel.visible = zaiOn && zaiMode !== 'bar';
        this._zaiLabel.set_style(zaiMode === 'both' ? 'margin-left: 6px;' : 'margin-left: 0;');
    }

    _updateIconVisibility() {
        this._icon.visible = this._settings.get_boolean('show-icon');
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
        // Deliberately do NOT abort() the old session here. abort() cancels
        // every in-flight request on it, including Hubstaff's refresh-token
        // exchange — which is intentionally run under its own cancellable that
        // refresh() never touches, precisely because losing the rotated token in
        // its response permanently bricks auth. Each module instead cancels its
        // own in-flight data fetch via its per-module cancellable when the
        // refresh() calls below run, so the old session drains cleanly and is
        // GC'd once its requests finish; only the token exchange survives, as
        // intended.
        this._session = this._createSession();
        this._claude.refresh();
        this._zai.refresh();
        this._redmine.refresh();
        this._hubstaff.refresh();
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

    // Apply the color/monochrome choice to both panel logos (Claude and GLM), so
    // toggling monochrome desaturates the whole panel consistently.
    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';

        for (const icon of [this._icon, this._zaiPrefix]) {
            const hasEffect = icon.get_effect(desatName) !== null;

            if (style === 'monochrome' && !hasEffect) {
                icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
                const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
                brightnessEffect.set_brightness_full(1, 1, 1);
                icon.add_effect(brightnessEffect);
            } else if (style !== 'monochrome' && hasEffect) {
                icon.remove_effect_by_name(desatName);
                icon.remove_effect_by_name(brightName);
            }
        }
    }

    _startTimer(name) {
        const timer = this._timers[name];
        timer.id = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_int(timer.intervalKey),
            () => {
                timer.module.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer(name) {
        const timer = this._timers[name];
        if (timer.id) {
            GLib.source_remove(timer.id);
            timer.id = null;
        }
    }

    _restartTimer(name) {
        this._stopTimer(name);
        this._startTimer(name);
    }

    destroy() {
        for (const name of Object.keys(this._timers)) {
            this._stopTimer(name);
        }
        if (this._redmineRefreshId) {
            GLib.source_remove(this._redmineRefreshId);
            this._redmineRefreshId = null;
        }
        this._claude.destroy();
        this._zai.destroy();
        this._redmine.destroy();
        this._hubstaff.destroy();
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

        this._placementChangedId = this._settings.connect('changed', (_settings, key) => {
            // The compact-view toggles change the dropdown's section layout, which
            // is built once in each module's buildMenu — recreate the whole
            // indicator (like a placement change) so the menu is rebuilt fresh.
            if (key === 'panel-box' || key === 'panel-position' ||
                key === 'claude-compact-view' || key === 'zai-compact-view') {
                this._schedulePlaceIndicator();
            }
        });
    }

    // Re-placing destroys and re-creates the whole indicator (three fetches);
    // debounce so spinning the position SpinRow in prefs rebuilds once, not
    // once per click.
    _schedulePlaceIndicator() {
        if (this._placeTimeoutId) {
            GLib.source_remove(this._placeTimeoutId);
        }
        this._placeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            400,
            () => {
                this._placeTimeoutId = null;
                this._placeIndicator();
                return GLib.SOURCE_REMOVE;
            }
        );
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
        if (this._placeTimeoutId) {
            GLib.source_remove(this._placeTimeoutId);
            this._placeTimeoutId = null;
        }
        if (this._placementChangedId) {
            this._settings.disconnect(this._placementChangedId);
            this._placementChangedId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
