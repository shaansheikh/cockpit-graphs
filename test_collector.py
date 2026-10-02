"""Regression checks for PCP units, missing rate samples, and access boundaries."""
import subprocess
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


if __name__ == '__main__':
    unittest.main()
