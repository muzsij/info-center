import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Tooltip, formatMoney} from '../shared/tooltip.js';
import {buildTotalsSection, messageLabel} from '../shared/sections.js';
import {applyBarWidth, allocatedWidth} from '../shared/usageSection.js';

const PACE_LEVELS = ['goal-behind', 'goal-on-pace', 'goal-ahead'];

// Matches .info-center-goal-marker's width in stylesheet.css.
const MARKER_WIDTH = 2;

// Owns the "Monthly goal" dropdown section: this month's estimated earnings
// (the sum of the Redmine and Hubstaff earnings) measured against the part of
// the monthly income goal that is due by today. It fetches nothing — it reads
// monthEarnings() from its sources, and is re-evaluated through update()
// whenever a source re-renders or a goal-* setting changes.
//
// The section itself stays terse — the share of the whole goal earned in the
// title row, the pace bar with the pace percentage beside it, and the day of
// the month; the amounts are shown in a tooltip on hover.
//
// The pace bar is centered on "exactly on pace": the fill is earned/expected
// halved, so on pace fills half the track, 2× the pace (or more) fills it all,
// and nothing earned leaves it empty. A tick marks the center.
export class EarningsGoal {
    // sources: [{name, module}] where module exposes monthEarnings() returning
    // {status: 'off' | 'pending' | 'ok', amount}.
    constructor(settings, sources) {
        this._settings = settings;
        this._sources = sources;
        // Floating amounts tooltip and its current text ('' disables it).
        this._tooltip = new Tooltip();
        this._tooltipText = '';
    }

    destroy() {
        // The widgets belong to the menu (reaped by super.destroy()); drop the
        // references so a late source callback turns update() into a no-op.
        this._item = null;
        // The tooltip lives in Main.layoutManager.uiGroup, not under this.menu,
        // so super.destroy() won't reap it — drop it here or it leaks.
        this._tooltip.destroy();
    }

    buildMenu(menu) {
        const section = buildTotalsSection(menu, 'Monthly goal', '');
        this._separator = section.separator;
        this._item = section.item;
        // Title row: the share of the whole monthly goal earned so far.
        this._goalPercentLabel = section.totalLabel;

        this._content = new St.BoxLayout({vertical: true});
        section.rowsBox.add_child(this._content);

        // Bar row: the pace bar with the pace percentage (earned vs. the part of
        // the goal due by today) beside it, laid out like a compact usage row.
        const barRow = new St.BoxLayout({
            vertical: false,
            style_class: 'info-center-compact-bar-row',
        });
        this._content.add_child(barRow);

        this._bg = new St.Widget({
            style_class: 'info-center-progress-bg',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bar = new St.Widget({style_class: 'info-center-progress-bar'});
        this._marker = new St.Widget({style_class: 'info-center-goal-marker'});
        this._bg.add_child(this._bar);
        // Added after the fill so the center tick paints on top of it.
        this._bg.add_child(this._marker);
        // Track the bg's actual allocated width, like the usage bars.
        this._bg.connect('notify::width', () => this._layoutBar());
        barRow.add_child(this._bg);

        this._pacePercentLabel = new St.Label({
            text: '',
            style_class: 'info-center-percent-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        barRow.add_child(this._pacePercentLabel);

        this._dayLabel = messageLabel('');
        this._content.add_child(this._dayLabel);

        this._message = messageLabel('');
        this._message.hide();
        section.rowsBox.add_child(this._message);

        // Hovering the title row or the bar/day block reveals the amounts. Bound
        // once here (the widgets are persistent); the text is read on each hover.
        this._tooltip.bind(section.titleRow, () => this._tooltipText);
        this._tooltip.bind(this._content, () => this._tooltipText);
    }

    _layoutBar() {
        applyBarWidth(this._bar, this._bg);
        this._marker.set_position(
            Math.round((allocatedWidth(this._bg) - MARKER_WIDTH) / 2), 0);
    }

    update() {
        if (!this._item) {
            return;
        }

        const goal = this._settings.get_double('goal-monthly-income');
        if (goal <= 0) {
            this._tooltipText = '';
            this._tooltip.hide();
            this._separator.hide();
            this._item.hide();
            return;
        }

        let earned = 0;
        let contributing = 0;
        const pending = [];
        for (const {name, module} of this._sources) {
            const {status, amount} = module.monthEarnings();
            if (status === 'off') {
                continue;
            }
            contributing++;
            if (status === 'pending') {
                pending.push(name);
            } else {
                earned += amount;
            }
        }

        if (contributing === 0) {
            this._setMessage('Set an hourly rate on the Redmine or Hubstaff page');
            return;
        }
        // A partial sum would read as "behind"; wait until every enabled source
        // has data (an erroring source keeps this message up until it recovers).
        if (pending.length > 0) {
            this._setMessage(`Waiting for ${pending.join(' and ')} earnings…`);
            return;
        }

        const currency = this._settings.get_string('goal-currency').trim();
        const decimals = this._settings.get_int('goal-currency-decimals');
        const money = (amount) => formatMoney(amount, currency, decimals);

        // Today counts as elapsed, since the fetched totals include today.
        const now = new Date();
        const day = now.getDate();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const expected = goal * day / daysInMonth;
        const ratio = earned / expected;
        const tolerance = this._settings.get_int('goal-tolerance') / 100;

        let level;
        let paceLine;
        if (ratio < 1 - tolerance) {
            level = 'goal-behind';
            paceLine = `Behind pace by ${money(expected - earned)}`;
        } else if (ratio > 1 + tolerance) {
            level = 'goal-ahead';
            paceLine = `Ahead of pace by ${money(earned - expected)}`;
        } else {
            level = 'goal-on-pace';
            paceLine = 'On pace';
        }

        for (const cls of PACE_LEVELS) {
            if (cls === level) {
                this._bar.add_style_class_name(cls);
                this._pacePercentLabel.add_style_class_name(cls);
            } else {
                this._bar.remove_style_class_name(cls);
                this._pacePercentLabel.remove_style_class_name(cls);
            }
        }

        this._bar._fillFraction = Math.min(1, Math.max(0, ratio / 2));
        this._layoutBar();

        this._goalPercentLabel.set_text(`${Math.round(earned / goal * 100)}%`);
        this._pacePercentLabel.set_text(`${Math.round(ratio * 100)}%`);
        this._dayLabel.set_text(`Day ${day} / ${daysInMonth}`);

        const projected = earned / day * daysInMonth;
        this._tooltipText = [
            `Earned: ${money(earned)} / ${money(goal)}`,
            `Target by today: ${money(expected)}`,
            paceLine,
            `Projected month end: ${money(projected)} ` +
                `(${Math.round(projected / goal * 100)}%)`,
        ].join('\n');

        this._message.hide();
        this._content.show();
        this._separator.show();
        this._item.show();
    }

    _setMessage(text) {
        this._tooltipText = '';
        this._tooltip.hide();
        this._goalPercentLabel.set_text('');
        this._content.hide();
        this._message.set_text(text);
        this._message.show();
        this._separator.show();
        this._item.show();
    }
}
