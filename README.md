# Info Center
![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)

A GNOME Shell extension that displays your Claude Code API usage percentage in the top panel.

> Private fork of [Haletran/claude-usage-extension](https://github.com/Haletran/claude-usage-extension), rebranded as **Info Center** for further development.

## Features

- **Real-time usage monitoring** - View your 5-hour and 7-day Claude Code usage
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
