# Cockpit graphs

A dependency-free Cockpit page with clean CPU, RAM/swap, disk and network time-series charts and a searchable, sortable process table.

The page appears as **Pi monitor** in Cockpit. It runs on Linux and is designed to keep overhead low on a Raspberry Pi.

## Install

Requires Cockpit 265 or newer and Python 3. Historical graphs also require Performance Co-Pilot (`pcp`, including `pmrep`), the Cockpit PCP bridge (`cockpit-pcp`), and running PCP collection/archive services. Live graphs and process monitoring work without archives; the page reports when history is unavailable.

```sh
git clone https://github.com/shaansheikh/cockpit-graphs.git
cd cockpit-graphs
sudo sh ./install.sh
```

Install the Cockpit and PCP packages using your distribution's package manager if they are not already installed. The installer copies only this page's files; it does not enable or reconfigure monitoring services.

## Features and memory accounting

The RAM donut represents total usable device RAM. Its inner ring groups processes by user; its outer ring splits each user into processes. Free memory includes reclaimable cache, matching the available-memory summary. Process allocation uses RSS estimates: if summed RSS exceeds used RAM, shares are proportionally reduced so the whole circle stays equal to device RAM. Any remaining used memory is System / other. Hover, click, or keyboard-focus a segment for its name, owner, PID, share and raw resident memory. The table continues to show raw RSS. Small process slices are retained rather than combined into an Other category.

Installed at `/usr/local/share/cockpit/pi-monitor`. Refresh Cockpit and select **Pi monitor**. If the menu is cached, sign out and back in.

Historical graphs use existing PCP archives at `/var/log/pcp/pmlogger/<hostname>`. Time ranges: 30 minutes, 1 hour, 6 hours and 24 hours. History has 60-second resolution, reduced to 4 minutes for the 24-hour range. The page reads archives once when opened or refreshed. Hover over a chart or use arrow keys to inspect samples. Dates and times follow the browser's timezone.

Live readings and processes are read from `/proc` every 5 seconds. The small Python collector runs only while the page is visible, under the logged-in account's existing permissions; no separate service or elevated privileges are required. It stops when switching Cockpit pages or leaving the browser tab. History is not extended on disk by this page; PCP continues its existing recording independently. Process CPU is measured over the last sample interval (100% is one core), not lifetime average.

RAM usage is total minus available, including reclaimable cache in the available figure. Process RAM is RSS and includes shared pages. CPU processing and storage wait are shown separately. Disk activity sums whole physical disks; network uses PCP's configured interface exclusions. Network rates are bytes/sec. Missing historical samples create gaps. Archive and live collection errors are shown independently, so live readings remain usable if history fails.

Home Assistant's Python process is displayed as `homeassistant` in the table and donut. The collector checks Python's module argument locally to recognize it, without sending command arguments to the browser. This label follows process restarts and does not rename or restart the actual service.

No CDN, npm dependencies, server daemon, external accounts or telemetry. No process command arguments, passwords, tokens, or environment variables are exported or stored. The page has no process-killing controls.

## Validation

```sh
python3 -m unittest test_collector.py
node test_ram_model.js
node --check app.js
sh -n install.sh
```

Node is needed only for the JavaScript development checks, not to run the page. The page was also checked with real live collector and one-hour/24-hour PCP reads, plus browser rendering, filtering, sorting, table expansion, keyboard inspection, mobile layout, history failure, and visibility cleanup.

To update after editing source files:

```sh
sudo install -m 644 manifest.json index.html style.css app.js ram-model.js collector.py /usr/local/share/cockpit/pi-monitor/
```

To remove:

```sh
sudo rm -r /usr/local/share/cockpit/pi-monitor
```
