import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {Tooltip, formatMoney} from './tooltip.js';
import {buildTotalsSection, addTotalsRow, messageLabel, formatHM} from './sections.js';

const TOKEN_URL = 'https://account.hubstaff.com/access_tokens';
const API_BASE = 'https://api.hubstaff.com/v2';

// Fallback access-token lifetime (seconds) used when the token response omits
// expires_in. Hubstaff access tokens live ~24–72h; defaulting to 24h keeps the
// cache usable so we don't re-exchange (and rotate the refresh token) on every
// refresh. If the real token expires sooner, the 401 path in _apiGet re-exchanges
// and recovers on its own.
const DEFAULT_ACCESS_TOKEN_TTL = 86400;

// Owns the "Hubstaff time — this month" dropdown section: one row per project
// you tracked time on this month, summed. The section stays hidden until a
// Hubstaff personal access token is configured. The session is read through a
// getter so proxy recreation in the indicator is reflected on the next fetch.
//
// Auth: a Hubstaff personal access token (PAT) is itself a long-lived refresh
// token. We exchange it at the OAuth token endpoint for a short-lived access
// token (grant_type=refresh_token, no client credentials). Each exchange ROTATES
// the refresh token — the response carries a new one that supersedes the old —
// so we persist the rotated token back into settings. The access token is cached
// (with its expiry) so we only hit the token endpoint when it is near expiry,
// not on every refresh. The user-entered PAT lives in `hubstaff-personal-access-token`
// (the seed, never overwritten by us) and the rotating token in `hubstaff-refresh-token`;
// `_currentRefreshToken` prefers the rotated one and falls back to the seed.
export class Hubstaff {
    constructor(settings, getSession) {
        this._settings = settings;
        this._getSession = getSession;
        this._cancellable = null;
        // A token exchange rotates the refresh token server-side and only the
        // response carries its replacement, so it must outlive an overlapping
        // refresh: it runs under its own cancellable (never cancelled by
        // refresh(), only by destroy()) and concurrent callers queue here onto
        // the single in-flight exchange rather than each starting their own.
        this._tokenCancellable = null;
        this._tokenWaiters = [];
        // Floating earnings tooltip (shared across this section's rows) and the
        // text shown when hovering the month-total row.
        this._tooltip = new Tooltip();
        this._totalTooltip = '';
        // Last successful fetch, cached so a rate/currency change can re-render
        // earnings locally without hitting the API again (null = no data yet).
        this._secondsByProject = null;
        this._namesByProject = null;
    }

    destroy() {
        // Cancel any in-flight token exchange / data fetch so its callback
        // doesn't touch the menu widgets super.destroy() is about to dispose.
        this._cancellable?.cancel();
        this._cancellable = null;
        this._tokenCancellable?.cancel();
        this._tokenCancellable = null;
        this._tokenWaiters = [];
        // The tooltip lives in Main.layoutManager.uiGroup, not under this.menu,
        // so super.destroy() won't reap it — drop it here or it leaks.
        this._tooltip.destroy();
    }

    buildMenu(menu) {
        const totals = buildTotalsSection(menu, 'Hubstaff time — this month');
        this._separator = totals.separator;
        this._item = totals.item;
        this._totalLabel = totals.totalLabel;
        this._rowsBox = totals.rowsBox;

        // Hovering the title/total row reveals the estimated month earnings.
        // Bound once here (the row is persistent); it reads the latest text
        // from this._totalTooltip, set on each render.
        this._tooltip.bind(totals.titleRow, () => this._totalTooltip);
    }

    // The active refresh token: the rotated one once we've exchanged at least
    // once, otherwise the user-entered seed PAT.
    _currentRefreshToken() {
        const rotated = this._settings.get_string('hubstaff-refresh-token').trim();
        if (rotated) {
            return rotated;
        }
        return this._settings.get_string('hubstaff-personal-access-token').trim();
    }

    refresh() {
        if (!this._item) {
            return;
        }

        // Cancel any in-flight work first, so overlapping refreshes (a timer
        // tick and a token settings change can both land here) don't race to
        // the display, and so teardown can stop work that would otherwise
        // touch the menu widgets after they're destroyed.
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        if (!this._currentRefreshToken()) {
            this._hideSection();
            return;
        }

        const now = GLib.DateTime.new_now_local();
        const from = now.format('%Y-%m-01');
        const to = now.format('%Y-%m-%d');

        this._ensureAccessToken((token) => {
            // null means the token exchange failed; _exchangeRefreshToken has
            // already shown the error, so just stop this round.
            if (!token) {
                return;
            }
            this._fetchUserId(token, cancellable, (userId) => {
                this._fetchOrganizations(token, 0, [], cancellable, (orgs) => {
                    this._processOrgs(
                        token, userId, orgs, 0, from, to, {}, {}, cancellable);
                });
            });
        });
    }

    // Reuse the cached access token until it is within a minute of expiry;
    // otherwise exchange the refresh token. The exchange rotates the refresh
    // token server-side, so it must run exactly once at a time and must not be
    // cancelled by an overlapping refresh — concurrent callers queue onto the
    // single in-flight exchange instead of each starting their own (a second
    // exchange would reuse the now-dead refresh token).
    _ensureAccessToken(onToken) {
        const nowSec = GLib.get_real_time() / 1000000;
        const cached = this._settings.get_string('hubstaff-access-token');
        const expiresAt = this._settings.get_int64('hubstaff-token-expires-at');
        if (cached && nowSec < expiresAt - 60) {
            onToken(cached);
            return;
        }

        this._tokenWaiters.push(onToken);
        if (this._tokenWaiters.length > 1) {
            // An exchange is already in flight; its callback serves us too.
            return;
        }
        this._exchangeRefreshToken();
    }

    // Hand the exchange result to every queued waiter and clear the queue. The
    // value is the fresh access token on success, or null when the exchange
    // failed — callers must treat null as "auth unavailable, abort this round"
    // so a failed exchange can't leave a fetch chain hanging.
    _drainTokenWaiters(token) {
        const waiters = this._tokenWaiters;
        this._tokenWaiters = [];
        for (const onToken of waiters) {
            onToken(token);
        }
    }

    // Exchange the current refresh token for a fresh access token, persisting the
    // new access token, its expiry, and the rotated refresh token, then hand the
    // access token to every queued waiter. Runs under its own cancellable that a
    // normal refresh() never cancels, so the rotated token in the response can
    // never be lost to an overlapping refresh (which would brick auth, since the
    // old refresh token is already dead the moment the request reaches Hubstaff).
    _exchangeRefreshToken() {
        const refreshToken = this._currentRefreshToken();
        const session = this._getSession();
        if (!refreshToken || !session) {
            this._drainTokenWaiters(null);
            return;
        }

        this._tokenCancellable = new Gio.Cancellable();
        const cancellable = this._tokenCancellable;

        const message = Soup.Message.new('POST', TOKEN_URL);
        const params = 'grant_type=refresh_token' +
            `&refresh_token=${encodeURIComponent(refreshToken)}`;
        const bytes = new GLib.Bytes(new TextEncoder().encode(params));
        message.set_request_body_from_bytes('application/x-www-form-urlencoded', bytes);
        message.request_headers.append('Accept', 'application/json');

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (sess, result) => {
                if (cancellable.is_cancelled()) {
                    // Only destroy() cancels this exchange; the menu widgets are
                    // being disposed, so drop the queued waiters without calling
                    // them (their callbacks would touch destroyed widgets).
                    this._tokenWaiters = [];
                    return;
                }
                try {
                    const respBytes = sess.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        this._setMessage(
                            'Token error — re-enter Personal Access Token');
                        // Serve queued callers with null so their fetch chains
                        // abort cleanly instead of hanging until the next tick.
                        this._drainTokenWaiters(null);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(respBytes.get_data()));
                    const accessToken = data.access_token;
                    const newRefresh = data.refresh_token;
                    const expiresIn = Number(data.expires_in) > 0
                        ? Number(data.expires_in)
                        : DEFAULT_ACCESS_TOKEN_TTL;

                    if (!accessToken || !newRefresh) {
                        this._setMessage('Token error — unexpected response');
                        this._drainTokenWaiters(null);
                        return;
                    }

                    const issuedSec = GLib.get_real_time() / 1000000;
                    this._settings.set_string('hubstaff-access-token', accessToken);
                    this._settings.set_int64(
                        'hubstaff-token-expires-at',
                        Math.floor(issuedSec + expiresIn));
                    // Persist the rotated refresh token: the old one is now dead.
                    this._settings.set_string('hubstaff-refresh-token', newRefresh);

                    this._drainTokenWaiters(accessToken);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error(
                        'Info Center: Hubstaff token exchange failed:', e.message);
                    this._setMessage('Token error');
                    this._drainTokenWaiters(null);
                }
            }
        );
    }

    // Authenticated GET returning parsed JSON via onSuccess. Surfaces non-200s
    // and failures into the section message and does not call onSuccess. A 401
    // means the cached access token was rejected before its cached expiry
    // (server-side revocation or clock skew); we drop the cache, re-exchange the
    // still-valid refresh token once, and replay the request, so the section
    // recovers on its own without the user re-entering a PAT.
    _apiGet(url, token, cancellable, onSuccess, retried = false) {
        const session = this._getSession();
        if (!session) {
            return;
        }

        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('Accept', 'application/json');

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (sess, result) => {
                if (cancellable.is_cancelled()) {
                    return;
                }
                try {
                    const bytes = sess.send_and_read_finish(result);

                    if (message.status_code === 401 && !retried) {
                        // Invalidate the cached access token (expire it now) so
                        // _ensureAccessToken forces a fresh exchange, then replay
                        // this request once with the new token.
                        this._settings.set_int64('hubstaff-token-expires-at', 0);
                        this._ensureAccessToken((newToken) => {
                            // Exchange failed — the error is already shown; don't
                            // replay with a missing token.
                            if (!newToken) {
                                return;
                            }
                            this._apiGet(url, newToken, cancellable, onSuccess, true);
                        });
                        return;
                    }

                    if (message.status_code !== 200) {
                        this._setMessage(`Error: HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    onSuccess(JSON.parse(decoder.decode(bytes.get_data())));
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    console.error('Info Center: Hubstaff request failed:', e.message);
                    this._setMessage('Error fetching data');
                }
            }
        );
    }

    _fetchUserId(token, cancellable, done) {
        this._apiGet(`${API_BASE}/users/me`, token, cancellable, (data) => {
            const id = data.user?.id;
            if (!id) {
                this._setMessage('Error: no user id');
                return;
            }
            done(id);
        });
    }

    _fetchOrganizations(token, pageStartId, orgs, cancellable, done) {
        let url = `${API_BASE}/organizations`;
        if (pageStartId) {
            url += `?page_start_id=${pageStartId}`;
        }
        this._apiGet(url, token, cancellable, (data) => {
            orgs.push(...(data.organizations ?? []));
            const next = data.pagination?.next_page_start_id;
            if (next) {
                this._fetchOrganizations(token, next, orgs, cancellable, done);
            } else {
                done(orgs);
            }
        });
    }

    // Walk organizations one at a time, accumulating project names and tracked
    // seconds per project across all of them before rendering once. Earnings are
    // not summed here — they are derived from the seconds at render time so a
    // rate/currency change can re-render without refetching.
    _processOrgs(token, userId, orgs, idx, from, to, secondsByProject, namesByProject, cancellable) {
        if (idx >= orgs.length) {
            this._updateDisplay(secondsByProject, namesByProject);
            return;
        }

        const org = orgs[idx];
        this._fetchProjects(token, org.id, 0, namesByProject, cancellable, () => {
            this._fetchDaily(
                token, org.id, userId, from, to, 0, secondsByProject, cancellable,
                () => {
                    this._processOrgs(
                        token, userId, orgs, idx + 1, from, to,
                        secondsByProject, namesByProject, cancellable);
                });
        });
    }

    _fetchProjects(token, orgId, pageStartId, namesByProject, cancellable, done) {
        let url = `${API_BASE}/organizations/${orgId}/projects`;
        if (pageStartId) {
            url += `?page_start_id=${pageStartId}`;
        }
        this._apiGet(url, token, cancellable, (data) => {
            for (const project of data.projects ?? []) {
                if (project?.id != null) {
                    namesByProject[String(project.id)] = project.name;
                }
            }
            const next = data.pagination?.next_page_start_id;
            if (next) {
                this._fetchProjects(
                    token, orgId, next, namesByProject, cancellable, done);
            } else {
                done();
            }
        });
    }

    _fetchDaily(token, orgId, userId, from, to, pageStartId, secondsByProject, cancellable, done) {
        // date[start]/date[stop] brackets are percent-encoded so GLib's URI
        // parser accepts the query; user_ids scopes the totals to the signed-in
        // user even when the token has manager/owner visibility into the org.
        let url = `${API_BASE}/organizations/${orgId}/activities/daily` +
            `?date%5Bstart%5D=${from}&date%5Bstop%5D=${to}&user_ids=${userId}`;
        if (pageStartId) {
            url += `&page_start_id=${pageStartId}`;
        }
        this._apiGet(url, token, cancellable, (data) => {
            for (const activity of data.daily_activities ?? []) {
                const pid = String(activity.project_id ?? '');
                if (pid) {
                    secondsByProject[pid] =
                        (secondsByProject[pid] ?? 0) + (activity.tracked ?? 0);
                }
            }
            const next = data.pagination?.next_page_start_id;
            if (next) {
                this._fetchDaily(
                    token, orgId, userId, from, to, next,
                    secondsByProject, cancellable, done);
            } else {
                done();
            }
        });
    }

    _updateDisplay(secondsByProject, namesByProject) {
        // Cache the raw fetch so rerender() can recompute earnings after a
        // rate/currency change without hitting the API again.
        this._secondsByProject = secondsByProject;
        this._namesByProject = namesByProject;

        // A render replaces every row; hide any tooltip still pointing at one.
        this._tooltip.hide();
        this._rowsBox.destroy_all_children();

        // Earnings are derived here from the current rate so prefs changes take
        // effect on the next render (see rerender()).
        const rate = this._settings.get_double('hubstaff-hourly-rate');
        const currency = this._settings.get_string('hubstaff-currency').trim();
        const decimals = this._settings.get_int('hubstaff-currency-decimals');
        const earningsFor = (seconds) =>
            rate > 0 ? (seconds / 3600) * rate : 0;

        // Most-tracked project first; drop any zero-second entries.
        const entries = Object.entries(secondsByProject)
            .filter(([, seconds]) => seconds > 0)
            .sort((a, b) => b[1] - a[1]);

        const total = entries.reduce((sum, [, seconds]) => sum + seconds, 0);
        this._totalLabel.set_text(total > 0 ? formatHM(total / 3600) : '');

        // Month earnings tooltip on the title row — only when there is something
        // to show (rate > 0); an empty string disables the tooltip entirely.
        const totalEarnings = earningsFor(total);
        this._totalTooltip = totalEarnings > 0
            ? `Earned this month: ${formatMoney(totalEarnings, currency, decimals)}`
            : '';

        if (entries.length === 0) {
            this._rowsBox.add_child(messageLabel('No time tracked'));
        } else {
            for (const [pid, seconds] of entries) {
                const name = namesByProject[pid] ?? `Project #${pid}`;

                const row = addTotalsRow(
                    this._rowsBox, name, formatHM(seconds / 3600));

                // Per-project earnings tooltip (only when we have a rate).
                const earned = earningsFor(seconds);
                if (earned > 0) {
                    const text = `Earned: ${formatMoney(earned, currency, decimals)}`;
                    this._tooltip.bind(row, () => text);
                }
            }
        }

        this._separator.show();
        this._item.show();
    }

    // Re-render from the cached fetch (e.g. after a rate/currency change) so
    // earnings update without another round-trip. No-op until the first fetch.
    rerender() {
        if (this._item && this._secondsByProject) {
            this._updateDisplay(this._secondsByProject, this._namesByProject);
        }
    }

    // Hide the section and drop the cached fetch, so a later rate/currency
    // change (which calls rerender()) can't resurrect a section that should
    // stay hidden because the user cleared the PAT. Also abort any in-flight
    // token exchange: with no refresh token there is nothing to rotate, and
    // letting the exchange finish would let its error path (_setMessage) re-show
    // the very section the user just disabled. destroy() also cancels this, so
    // its callback already bails cleanly on a cancelled _tokenCancellable.
    _hideSection() {
        this._secondsByProject = null;
        this._namesByProject = null;
        this._totalTooltip = '';
        this._tooltip.hide();
        this._tokenCancellable?.cancel();
        this._separator.hide();
        this._item.hide();
    }

    _setMessage(text) {
        this._tooltip.hide();
        // The cached fetch is no longer what's on screen; drop it so a later
        // rate change doesn't re-render stale data over this message.
        this._secondsByProject = null;
        this._namesByProject = null;
        // No earnings to show in an error/token state — disable the tooltip.
        this._totalTooltip = '';
        this._totalLabel.set_text('');
        this._rowsBox.destroy_all_children();
        this._rowsBox.add_child(messageLabel(text));
        this._separator.show();
        this._item.show();
    }
}
