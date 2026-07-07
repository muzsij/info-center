import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Shared reset-notification helpers for the Claude and GLM usage modules.
//
// A 5-hour usage window climbs monotonically within the window and drops back
// toward zero when it resets, so the only time the percentage *decreases* is at
// a reset. `isUsageReset` treats that downward crossing of `threshold` as the
// reset signal: the previous reading was at or above the threshold and the new
// one is below it. `prev` is null on the first reading after start-up or an
// error (no baseline yet), which never triggers — so a fresh start doesn't fire
// a spurious notification. The threshold therefore gates *which* resets matter:
// only windows that had climbed to at least `threshold` are announced.
export function isUsageReset(prev, current, threshold) {
    return prev !== null && prev >= threshold && current < threshold;
}

// Post the reset notification for a service ("Claude" / "GLM"). Uses
// Main.notify, whose MessageTray source is owned by the Shell — there is no
// per-extension resource to tear down, so this needs no lifecycle wiring.
export function notifyUsageReset(service) {
    Main.notify('Info Center', `Your ${service} 5h usage reseted!`);
}
