import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// A single floating tooltip shared across a feature module's rows. It lives in
// Main.layoutManager.uiGroup (NOT under the dropdown menu) so it can paint above
// the menu's boxpointer; it is created lazily on first hover and must be torn
// down explicitly in the owner's destroy() — super.destroy() won't reap it
// because it isn't a child of this.menu.
//
// Usage: create one per feature module, bind it to each hoverable row with a
// getText callback (return '' to suppress the tooltip), hide() it whenever the
// rows are replaced, and destroy() it in the module's destroy().
export class Tooltip {
    constructor() {
        this._label = null;
    }

    // Make `actor` reveal the tooltip while hovered. getText() is read on each
    // hover so the text can change between renders; returning a falsy/empty
    // string suppresses the tooltip (e.g. when there is nothing to show).
    bind(actor, getText) {
        actor.reactive = true;
        actor.track_hover = true;
        actor.connect('notify::hover', () => {
            const text = getText();
            if (actor.hover && text) {
                this._ensure();
                // The open menu's boxpointer is a later sibling in the uiGroup,
                // so raise the tooltip above it or it paints behind the menu.
                const parent = this._label.get_parent();
                parent?.set_child_above_sibling(this._label, null);
                this._label.set_text(text);
                const [px, py] = global.get_pointer();
                let x = px + 12;
                let y = py + 16;
                // Keep the tooltip on-screen when the pointer is near an edge.
                // Clamp to the monitor under the pointer, not the primary one,
                // so the tooltip stays put on a secondary-monitor dropdown.
                const monitorIndex = global.display.get_current_monitor();
                const monitor = Main.layoutManager.monitors[monitorIndex];
                if (monitor) {
                    const [, natW] = this._label.get_preferred_width(-1);
                    const [, natH] = this._label.get_preferred_height(natW);
                    x = Math.min(x, monitor.x + monitor.width - natW - 4);
                    y = Math.min(y, monitor.y + monitor.height - natH - 4);
                }
                this._label.set_position(Math.round(x), Math.round(y));
                this._label.show();
            } else {
                this._label?.hide();
            }
        });
    }

    hide() {
        this._label?.hide();
    }

    _ensure() {
        if (this._label) {
            return;
        }
        this._label = new St.Label({
            style_class: 'info-center-tooltip',
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._label);
    }

    destroy() {
        this._label?.destroy();
        this._label = null;
    }
}

// Format an amount, grouped in thousands with a space separator and suffixed
// with the currency label when one is set (e.g. "1 312.45 USD", or just
// "1 312.45" when no currency is configured). `decimals` is the number of
// decimal places to round to, and may be negative to round to higher place
// values: 2 → "1 312.46", 0 → "1 312", -2 → "1 300" (nearest 100).
export function formatMoney(amount, currency, decimals = 2) {
    const d = Number.isFinite(decimals) ? Math.trunc(decimals) : 2;
    const factor = Math.pow(10, d);
    const rounded = Math.round(amount * factor) / factor;
    // Fractional digits are only meaningful when rounding to a fractional place;
    // for d <= 0 the value is a whole number, so show no decimals.
    const fixed = rounded.toFixed(Math.max(d, 0));
    // Group the integer part in thousands with a space ("1234567.8" → "1 234 567.8").
    const [intPart, fracPart] = fixed.split('.');
    const sign = intPart.startsWith('-') ? '-' : '';
    const grouped = (sign ? intPart.slice(1) : intPart)
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const value = fracPart ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`;
    return currency ? `${value} ${currency}` : value;
}
