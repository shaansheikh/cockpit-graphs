#!/usr/bin/python3
"""Read-only Cockpit telemetry. No daemon, external Python dependencies or secrets."""
import csv
import datetime as dt
import io
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import time


def network_exclusions():
    try:
        lines = Path('/etc/pcp/linux/interfaces.conf').read_text().splitlines()
        pattern = ''.join(''.join(line.split('#', 1)[0].split()) for line in lines)
        return re.compile(pattern)
    except (OSError, re.error):
        return re.compile(r'^(lo|bond\d+|team\d+|tun\d+|virbr\d+|cni\d+|docker\d+|veth\d+)$')


EXCLUDED_NETWORK = network_exclusions()


def memory():
    values = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        values[key] = int(value.split()[0]) * 1024
    total = values['MemTotal']
    available = values.get('MemAvailable', values['MemFree'])
    zram = zram_usage()
    return dict(total=total, available=available, used=total-available,
                cache=values['Cached']+values['Buffers'], free=values['MemFree'],
                swap=values['SwapTotal']-values['SwapFree'], swapTotal=values['SwapTotal'],
                **zram)


def zram_usage(swaps_path='/proc/swaps', sys_block='/sys/block'):
    """Split swap into zram (compressed RAM) and disk-backed swap.

    zram is cheap and expected to fill up; use of a disk swap file or partition
    (here, the SD card) is what signals real memory pressure.
    """
    zram_used = zram_size = disk_used = disk_size = 0
    zram_ram = 0
    try:
        lines = Path(swaps_path).read_text().splitlines()[1:]
    except OSError:
        lines = []
    for line in lines:
        fields = line.split()
        if len(fields) < 4:
            continue
        name, size, used = fields[0], int(fields[2])*1024, int(fields[3])*1024
        if name.startswith('/dev/zram'):
            zram_size += size
            zram_used += used
            try:
                stat = Path(sys_block, name.rsplit('/', 1)[1], 'mm_stat').read_text().split()
                zram_ram += int(stat[2])
            except (OSError, ValueError, IndexError):
                pass
        else:
            disk_size += size
            disk_used += used
    return dict(zramUsed=zram_used, zramTotal=zram_size, zramRam=zram_ram,
                diskSwap=disk_used, diskSwapTotal=disk_size)


def counters():
    cpu = list(map(int, Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    disk = [0, 0]
    for line in Path('/proc/diskstats').read_text().splitlines():
        fields = line.split()
        # Count whole physical disks once; skip partitions and loop devices.
        if (Path('/sys/block') / fields[2] / 'device').exists():
            disk[0] += int(fields[5]) * 512
            disk[1] += int(fields[9]) * 512
    network = [0, 0]
    for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
        name, data = line.split(':', 1)
        if EXCLUDED_NETWORK.search(name.strip()):
            continue
        fields = data.split()
        network[0] += int(fields[0])
        network[1] += int(fields[8])
    return cpu, disk, network


USERS = {u.pw_uid: u.pw_name for u in pwd.getpwall()}
HZ = os.sysconf('SC_CLK_TCK')


def display_name(name, proc_path):
    """Recognize Home Assistant without exporting its command arguments."""
    if not name.startswith('python'):
        return name
    try:
        args = (proc_path / 'cmdline').read_bytes().split(b'\0')
        index = 1
        while index < len(args):
            arg = args[index]
            if arg == b'-m':
                return 'homeassistant' if args[index+1:index+2] == [b'homeassistant'] else name
            if arg == b'-mhomeassistant':
                return 'homeassistant'
            if arg in (b'-c', b'--') or not arg.startswith(b'-'):
                break
            index += 2 if arg in (b'-X', b'-W') else 1
    except OSError:
        pass
    return name


def processes(previous, elapsed):
    current, rows = {}, []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            stat = (path / 'stat').read_text()
            end = stat.rfind(')')
            name, fields = stat[stat.find('(')+1:end], stat[end+2:].split()
            ticks, start = int(fields[11])+int(fields[12]), int(fields[19])
            pid = int(path.name)
            current[pid] = (ticks, start)
            status = (path / 'status').read_text().splitlines()
            rss = next((int(s.split()[1])*1024 for s in status if s.startswith('VmRSS:')), 0)
            if not rss:
                continue
            name = display_name(name, path)
            uid = next(int(s.split()[1]) for s in status if s.startswith('Uid:'))
            old = previous.get(pid)
            cpu = (max(0, ticks-old[0])/HZ/elapsed*100) if old and old[1] == start else None
            rows.append(dict(pid=pid, name=name, user=USERS.get(uid, str(uid)),
                             ram=rss, cpu=cpu, state=fields[0]))
        except (OSError, ValueError, StopIteration, IndexError):
            continue
    return current, sorted(rows, key=lambda row: row['ram'], reverse=True)


def live():
    old = counters()
    previous, _ = processes({}, 1)
    last = time.monotonic()
    while True:
        time.sleep(5)
        now = time.monotonic()
        elapsed = now-last
        new = counters()
        delta = [max(0, b-a) for a, b in zip(old[0], new[0])]
        total = sum(delta) or 1
        mem = memory()
        previous, rows = processes(previous, elapsed)
        data = dict(time=time.time()*1000, cpu=(total-delta[3]-delta[4])/total*100,
                    wait=delta[4]/total*100, memory=mem['used']/mem['total']*100,
                    swap=mem['swap']/mem['swapTotal']*100 if mem['swapTotal'] else 0,
                    zram=mem['zramUsed']/mem['zramTotal']*100 if mem['zramTotal'] else None,
                    diskSwap=mem['diskSwap']/mem['diskSwapTotal']*100 if mem['diskSwapTotal'] else None,
                    diskRead=max(0,new[1][0]-old[1][0])/elapsed,
                    diskWrite=max(0,new[1][1]-old[1][1])/elapsed,
                    netIn=max(0,new[2][0]-old[2][0])/elapsed,
                    netOut=max(0,new[2][1]-old[2][1])/elapsed,
                    load=os.getloadavg()[0], cores=os.cpu_count(), mem=mem,
                    processes=rows)
        print(json.dumps(data), flush=True)
        old, last = new, now


METRICS = [
    'kernel.all.cpu.user', 'kernel.all.cpu.sys', 'kernel.all.cpu.nice',
    'kernel.all.cpu.idle', 'kernel.all.cpu.wait.total', 'kernel.all.cpu.intr',
    'mem.physmem', 'mem.util.available', 'mem.util.swapTotal', 'mem.util.swapFree',
    'disk.all.read_bytes', 'disk.all.write_bytes',
    'network.all.in.bytes', 'network.all.out.bytes', 'kernel.all.load', 'hinv.ncpu',
]


def history(minutes):
    end = dt.datetime.now()
    start = end-dt.timedelta(minutes=minutes)
    directory = Path('/var/log/pcp/pmlogger') / os.uname().nodename
    archives = []
    # Include the preceding archive for rates at the beginning of the window.
    for index in sorted(directory.glob('*.index')):
        if start.strftime('%Y%m%d') <= index.name[:8] <= end.strftime('%Y%m%d'):
            archives.append(str(index.with_suffix('')))
    if not archives:
        raise RuntimeError('No PCP archives are available for this time window.')
    interval = max(60, minutes*60//360)
    command = ['pmrep', '-a', ','.join(archives), '-S', start.strftime('%Y-%m-%d %H:%M:%S'),
               '-T', end.strftime('%Y-%m-%d %H:%M:%S'), '-t', str(interval), '-o', 'csv', '-B', 'byte', '-5'] + METRICS
    result = subprocess.run(command, capture_output=True, text=True, timeout=40)
    if result.returncode:
        raise RuntimeError('PCP history could not be read: '+result.stderr.strip()[:300])
    rows = []
    for row in csv.DictReader(io.StringIO(result.stdout)):
        def number(key):
            value = row.get(key)
            return float(value) if value and value not in ('N/A', '?') else None
        try:
            stamp = dt.datetime.fromisoformat(row['Time']).timestamp()*1000
            cpu = [number(key) for key in METRICS[:6]]
            physical, available = number('mem.physmem'), number('mem.util.available')
            if not physical or available is None:
                continue
            total = sum(cpu) if all(v is not None for v in cpu) else 0
            swap_total, swap_free = number('mem.util.swapTotal'), number('mem.util.swapFree')
            def byte_rate(key):
                value = number(key)
                return value
            rows.append(dict(time=stamp, cpu=(cpu[0]+cpu[1]+cpu[2]+cpu[5])/total*100 if total else None,
                             wait=cpu[4]/total*100 if total else None,
                             memory=(physical-available)/physical*100,
                             swap=(swap_total-swap_free)/swap_total*100 if swap_total and swap_free is not None else 0,
                             diskRead=byte_rate('disk.all.read_bytes'), diskWrite=byte_rate('disk.all.write_bytes'),
                             netIn=byte_rate('network.all.in.bytes'), netOut=byte_rate('network.all.out.bytes'),
                             load=number('kernel.all.load-1 minute')))
        except (ValueError, TypeError, KeyError):
            continue
    return dict(points=rows, interval=interval)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'history':
            minutes = int(sys.argv[2])
            if minutes not in (30, 60, 360, 1440):
                raise ValueError('Unsupported time range')
            print(json.dumps(history(minutes)))
        elif sys.argv[1:] == ['live']:
            live()
        else:
            raise ValueError('Expected live or history <minutes>')
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
