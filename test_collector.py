"""Regression checks for PCP units, missing rate samples, and access boundaries."""
import subprocess
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch
import collector


class HistoryTests(unittest.TestCase):
    def test_homeassistant_display_name(self):
        path = collector.Path('/proc/123')
        examples = [
            (b'python3\0-P\0-m\0homeassistant\0--config\0/config\0', 'homeassistant'),
            (b'python3\0-X\0dev\0-m\0homeassistant\0', 'homeassistant'),
            (b'python3\0-m\0http.server\0', 'python3'),
            (b'python3\0other.py\0-m\0homeassistant\0', 'python3'),
            (b'python3\0-c\0print(1)\0-m\0homeassistant\0', 'python3'),
        ]
        for command, expected in examples:
            with self.subTest(command=command), patch.object(collector.Path, 'read_bytes', return_value=command):
                self.assertEqual(collector.display_name('python3', path), expected)
        with patch.object(collector.Path, 'read_bytes', side_effect=PermissionError):
            self.assertEqual(collector.display_name('python3', path), 'python3')

    def test_explicit_byte_units_and_cpu_wait(self):
        headers = ['Time'] + collector.METRICS[:14] + ['kernel.all.load-1 minute', 'hinv.ncpu']
        values = ['2026-10-02 00:49:00', '200', '200', '0', '0', '3600', '0',
                  '4000000000', '100000000', '500000000', '0',
                  '35000000', '1000', '2300', '800', '28', '4']
        output = ','.join(headers)+'\n'+','.join(values)+'\n'
        fake = subprocess.CompletedProcess([], 0, output, '')
        with patch.object(collector.Path, 'glob', return_value=[collector.Path('/archive/20990101.index')]), \
             patch.object(collector.dt, 'datetime') as clock, \
             patch.object(collector.subprocess, 'run', return_value=fake) as run:
            clock.now.return_value = datetime(2099, 1, 1, 1)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            result = collector.history(60)
        args = run.call_args.args[0]
        self.assertEqual(args[args.index('-B')+1], 'byte')
        point = result['points'][0]
        self.assertEqual(point['netIn'], 2300)
        self.assertEqual(point['diskRead'], 35000000)
        self.assertEqual(point['cpu'], 10)
        self.assertEqual(point['wait'], 90)
        self.assertEqual(point['memory'], 97.5)
        self.assertEqual(point['swap'], 100)

    def test_process_data_does_not_include_command_arguments(self):
        _, rows = collector.processes({}, 1)
        self.assertTrue(rows)
        self.assertTrue(all(set(row) == {'pid', 'name', 'user', 'ram', 'cpu', 'state'} for row in rows))
        self.assertTrue(all(row['cpu'] is None for row in rows))

class SwapTests(unittest.TestCase):
    def test_zram_and_disk_swap_are_reported_separately(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = collector.Path(tmp)
            swaps = root/'swaps'
            swaps.write_text('Filename\tType\tSize\tUsed\tPriority\n'
                             '/dev/zram0\tpartition\t1572864\t400000\t100\n'
                             '/var/swap\tfile\t524288\t2048\t-2\n')
            (root/'zram0').mkdir()
            (root/'zram0'/'mm_stat').write_text('409600000 108000000 112000000 0 112000000 46 0 93 93\n')
            result = collector.zram_usage(str(swaps), str(root))
        self.assertEqual(result, dict(zramUsed=400000*1024, zramTotal=1572864*1024, zramRam=112000000,
                                      diskSwap=2048*1024, diskSwapTotal=524288*1024))

    def test_no_zram_or_unreadable_swaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = collector.Path(tmp)
            (root/'swaps').write_text('Filename\tType\tSize\tUsed\tPriority\n/var/swap\tfile\t524288\t100\t-2\n')
            result = collector.zram_usage(str(root/'swaps'), str(root))
            self.assertEqual((result['zramTotal'], result['zramRam']), (0, 0))
            self.assertEqual(result['diskSwap'], 100*1024)
            missing = collector.zram_usage(str(root/'absent'), str(root))
        self.assertEqual(missing['diskSwapTotal'], 0)

    def test_memory_exposes_split_fields(self):
        mem = collector.memory()
        for key in ('swap', 'swapTotal', 'zramUsed', 'zramTotal', 'zramRam', 'diskSwap', 'diskSwapTotal'):
            self.assertIn(key, mem)


class SwapHistoryTests(unittest.TestCase):
    def test_swap_split_from_per_device_columns(self):
        row = {'swapdev.length-/var/swap': '536870912', 'swapdev.free-/var/swap': '536870912',
               'swapdev.length-/dev/zram0': '1073741824', 'swapdev.free-/dev/zram0': '536870912',
               'swapdev.length-/dev/zram1': '1073741824', 'swapdev.free-/dev/zram1': '1073741824'}
        zram, disk = collector.swap_split(row)
        self.assertEqual(zram, 25)
        self.assertEqual(disk, 0)

    def test_swap_split_before_zram_existed(self):
        row = {'swapdev.length-/var/swap': '1000', 'swapdev.free-/var/swap': '0',
               'swapdev.length-/dev/zram0': '', 'swapdev.free-/dev/zram0': ''}
        self.assertEqual(collector.swap_split(row), (None, 100))
        self.assertEqual(collector.swap_split({}), (None, None))

    def test_history_points_carry_zram_and_disk_swap(self):
        extra = ['swapdev.length-/var/swap', 'swapdev.length-/dev/zram0', 'swapdev.free-/var/swap', 'swapdev.free-/dev/zram0']
        headers = ['Time'] + collector.METRICS[:14] + ['kernel.all.load-1 minute', 'hinv.ncpu'] + extra
        values = ['2026-10-07 02:00:00', '200', '200', '0', '0', '3600', '0',
                  '4000000000', '100000000', '500000000', '0',
                  '0', '0', '0', '0', '1', '4', '536870912', '1073741824', '536870912', '268435456']
        output = ','.join(headers)+'\n'+','.join(values)+'\n'
        fake = subprocess.CompletedProcess([], 0, output, '')
        with patch.object(collector.Path, 'glob', return_value=[collector.Path('/archive/20990101.index')]), \
             patch.object(collector.dt, 'datetime') as clock, \
             patch.object(collector.subprocess, 'run', return_value=fake) as run:
            clock.now.return_value = datetime(2099, 1, 1, 1)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            point = collector.history(60)['points'][0]
        args = run.call_args.args[0]
        self.assertIn('swapdev.length', args)
        self.assertIn('swapdev.free', args)
        self.assertEqual(point['zram'], 75)
        self.assertEqual(point['diskSwap'], 0)


if __name__ == '__main__':
    unittest.main()
