# Info Center
![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)

A GNOME Shell extension that displays your Claude Code API usage in the top panel, and optionally your z.ai GLM Coding Plan usage, Redmine time and tasks, and Hubstaff time tracked this month.

> Private fork of [Haletran/claude-usage-extension](https://github.com/Haletran/claude-usage-extension), rebranded as **Info Center** for further development.

## Features

- **Real-time Claude usage monitoring** - View your 5-hour and 7-day Claude Code usage in the panel, with a reset notification when the 5-hour window rolls over
- **z.ai GLM Coding Plan usage** *(optional)* - Show your GLM 5-hour and weekly usage next to Claude in the panel
- **Redmine time tracking** *(optional)* - Show this month's logged hours per project in the dropdown menu, with estimated earnings on hover
- **Redmine task lists** *(optional)* - Show issues assigned to you that are due today and tomorrow, with optional status filtering, clickable straight to Redmine
- **Hubstaff time tracking** *(optional)* - Show this month's tracked hours per project in the dropdown menu, with estimated earnings on hover
- **Settings menu** - Change the panel layout, position, refresh intervals, and proxy

## Requirements

- GNOME Shell 46 or later
- Claude Code installed and authenticated (`~/.claude/.credentials.json`)

## Installation

```bash
git clone https://github.com/muzsij/info-center
cp -r info-center ~/.local/share/gnome-shell/extensions/info-center@muzsij
cd ~/.local/share/gnome-shell/extensions/info-center@muzsij/schemas
glib-compile-schemas .
## Restart Gnome Shell with Alt + F2 type r or logout
## Then enable the extension
```

## Redmine integration

The dropdown menu can show how many hours you have logged in Redmine this month,
broken down per project. To set it up, open the extension preferences and switch
to the **Redmine** tab:

1. Enter your **Server URL** (e.g. `https://redmine.example.com`) and click apply.
2. Enter your **API Key** (Redmine → *My account* → *API access key*) and click apply.
3. Click **Fetch projects** and tick the projects you want to track.

The dropdown also lists the issues assigned to you that fall due **today** and
**tomorrow** (by their start/due date span). Use the **Status** filter to limit
these lists to specific issue statuses, and the **all projects** toggle to include
tasks from every project rather than only the ones ticked above. Each issue is a
link that opens it in Redmine.

Leave the Server URL empty to disable the integration — the Redmine section is
hidden from the panel menu until a URL, API key, and (for the monthly time totals)
at least one project are set. Time entries are fetched for the current user
(`user_id=me`) from the first day of the month through today, and everything is
refreshed on the same interval as the usage data.

## z.ai GLM Coding Plan integration

Off by default. Open the extension preferences, switch to the **GLM** tab, and
paste an API key created at [z.ai](https://z.ai/manage-apikey/apikey-list). Once
set, your GLM 5-hour and weekly usage appears in the panel next to Claude (with its
own logo, layout, and refresh interval). Clear the key to hide it again.

## Hubstaff integration

Off by default. Open the extension preferences and switch to the **Hubstaff** tab:

1. Create a **Personal Access Token** with the `hubstaff:read` scope at
   [developer.hubstaff.com](https://developer.hubstaff.com/).
2. Paste the token and click apply.

The dropdown then lists every project you tracked time on this month, summed and
sorted most-tracked first. Set an hourly rate in the **Earnings** group to see
estimated earnings on hover. Clear the token to hide the section.

## Earnings tooltips

For both Redmine and Hubstaff you can enter a manual **hourly rate** and currency
in the preferences. Hovering a project row (or the section total) then shows the
estimated earnings for that project this month. Rates are applied locally and are
never sent anywhere.
