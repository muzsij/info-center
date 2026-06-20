# Info Center
![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)

A GNOME Shell extension that displays your Claude Code API usage percentage in the top panel.

> Private fork of [Haletran/claude-usage-extension](https://github.com/Haletran/claude-usage-extension), rebranded as **Info Center** for further development.

## Features

- **Real-time usage monitoring** - View your 5-hour and 7-day Claude Code usage
- **Redmine time tracking** - Show this month's logged hours per project in the dropdown menu
- **Settings menu** - Change the layout or the refresh time

## Requirements

- GNOME Shell 48 or later
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

Leave the Server URL empty to disable the integration — the Redmine section is
hidden from the panel menu until a URL, API key, and at least one project are set.
Time entries are fetched for the current user (`user_id=me`) from the first day of
the month through today, and refreshed on the same interval as the usage data.
