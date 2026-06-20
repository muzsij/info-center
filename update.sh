#!/usr/bin/env bash
set -euo pipefail

cd ..

if [ ! -d info-center ]; then
	echo "Extension folder not found (run from the repo root, dir must be named 'info-center')"
	exit 1
fi

dest=~/.local/share/gnome-shell/extensions/info-center@muzsij

rm -rf "$dest"
cp -r info-center "$dest"
glib-compile-schemas "$dest/schemas"

echo "Installed to $dest and compiled schema."
echo

# We deliberately do NOT restart GNOME Shell automatically: a detached
# 'gnome-shell --replace' freezes the session on Wayland and can glitch X11.
# Reloading extension code requires a full shell restart, so do it manually:
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
	echo "Wayland session detected — there is no in-place reload."
	echo "Log out and back in to load the new code."
else
	echo "X11 session detected — press Alt+F2, type 'r', and hit Enter to reload."
	echo "(Or log out and back in.)"
fi
