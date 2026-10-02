#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo: sudo ./install.sh" >&2
    exit 1
fi

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir=/usr/local/share/cockpit/pi-monitor

for file in manifest.json index.html style.css app.js ram-model.js collector.py; do
    if [ ! -f "$source_dir/$file" ]; then
        echo "Missing required file: $file" >&2
        exit 1
    fi
done

install -d -m 755 "$target_dir"
for file in manifest.json index.html style.css app.js ram-model.js collector.py; do
    install -m 644 "$source_dir/$file" "$target_dir/$file"
done

echo "Installed Pi monitor. Refresh Cockpit, then select Pi monitor in the sidebar."
