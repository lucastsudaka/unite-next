"""Desktop result classification must preserve evidence and reject new failures."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('unite_desktop_diagnostics',
    Path(__file__).resolve().parents[1] / 'tools/test-desktop.py')
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class DiagnosticTests(unittest.TestCase):
    def test_missing_private_services_are_retained_with_proven_native_identity(self):
        lines = [
            '(gnome-shell:1): GNOME Shell-CRITICAL **: 10:20:30.001: Could not get a proxy for user 0: '
            'Gio.DBusError: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: '
            'The name org.freedesktop.login1 was not provided by any .service files',
            '(gnome-shell:1): GNOME Shell-CRITICAL **: 10:20:30.001: '
            'Gio.DBusError: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: '
            'The name org.gnome.Shell.CalendarServer was not provided by any .service files',
        ]
        baseline, unexpected = desktop.classify_diagnostics('\n'.join(lines), '51')
        self.assertEqual(unexpected, [])
        self.assertEqual([item['line'] for item in baseline], lines)

    def test_menu_baseline_is_only_classified_during_observed_native_menu_operation(self):
        line = ("(gnome-shell:1): Clutter-CRITICAL **: 10:20:30.001: "
                "clutter_actor_set_allocation_internal: assertion '!isnan (box->x1) && "
                "!isnan (box->x2) && !isnan (box->y1) && !isnan (box->y2)' failed")
        baseline, unexpected = desktop.classify_diagnostics(line, '50')
        self.assertEqual(baseline, [])
        self.assertEqual(unexpected, [line])
        baseline, unexpected = desktop.classify_diagnostics(
            'UNITE_INPUT_MENU_BEFORE {}\n' + line + '\nUNITE_INPUT_MENU_AFTER {}', '50')
        self.assertEqual(unexpected, [])
        self.assertEqual(baseline[0]['line'], line)
        baseline, unexpected = desktop.classify_diagnostics(
            'UNITE_INPUT_MENU_BEFORE {}\n' + line + '\nUNITE_INPUT_MENU_AFTER {}', '51')
        self.assertEqual(baseline, [])
        self.assertEqual(unexpected, [line])

    def test_extension_and_unknown_native_failures_never_become_baseline_success(self):
        lines = [
            '(gnome-shell:1): GNOME Shell-CRITICAL **: 10:20:30.001: Extension unite-next@lucastsudaka.github.io: failure',
            '(gnome-shell:1): Clutter-CRITICAL **: 10:20:30.001: unknown native failure',
            '(gjs:1): Gjs-CRITICAL **: 10:20:30.001: JS ERROR: widget acquisition failed',
            '(gnome-shell:1): GLib-CRITICAL **: 10:20:30.001: Source ID was not found',
        ]
        baseline, unexpected = desktop.classify_diagnostics('\n'.join(lines), '50')
        self.assertEqual(baseline, [])
        self.assertEqual(unexpected, lines)

    def test_extension_resource_loader_warning_is_an_acceptance_failure(self):
        line = ("(gnome-shell:17): St-WARNING **: 20:11:50.654: Failed to load "
                "file:///tmp/unite-gnome51-private/data/gnome-shell/extensions/unite-next@lucastsudaka.github.io/"
                "themes/default/dark/minimize.svg: Loader process exited early with status '1'Command:")
        baseline, unexpected = desktop.classify_diagnostics(line, '51')
        self.assertEqual(baseline, [])
        self.assertEqual(unexpected, [line])


class ConflictDiagnosticTests(unittest.TestCase):
    uuid = 'unite-next@lucastsudaka.github.io'
    messages = {
        'startup': 'Unite Next cannot run while unite@hardpixel.eu is active or activating',
        'cleanup': 'Injected native fork conflict cleanup failure',
    }

    def protocol(self, phase):
        message = self.messages[phase]
        return [
            'UNITE_CONFLICT_EXPECT_ERROR ' + json.dumps({'phase': phase, 'uuid': self.uuid, 'message': message}),
            f'(gnome-shell:17): GNOME Shell-CRITICAL **: 10:20:30.001: Extension {self.uuid}: Error: {message}',
            'UNITE_CONFLICT_OBSERVED_ERROR ' + json.dumps({'phase': phase, 'uuid': self.uuid, 'error': message}),
        ]

    def classify(self, lines, scenario='conflict', uuid=None):
        return desktop.classify_diagnostics('\n'.join(lines), '51', scenario, uuid or self.uuid)

    def test_only_both_exact_native_errors_with_matching_observed_protocol_are_expected(self):
        startup, cleanup = self.protocol('startup'), self.protocol('cleanup')
        lines = startup + cleanup
        baseline, unexpected = self.classify(lines)
        self.assertEqual(unexpected, [])
        self.assertEqual([item['line'] for item in baseline], [startup[1], cleanup[1]])
        self.assertEqual([item['phase'] for item in baseline], ['startup', 'cleanup'])
        self.assertTrue(all(item['category'] == 'intentional-conflict-error' for item in baseline))
        self.assertTrue(all(item['uuid'] == self.uuid for item in baseline))

    def test_expected_words_and_markers_do_not_hide_errors_outside_the_conflict_scenario(self):
        lines = self.protocol('startup') + self.protocol('cleanup')
        for scenario in ['full', 'preferences']:
            with self.subTest(scenario=scenario):
                baseline, unexpected = self.classify(lines, scenario)
                self.assertEqual(baseline, [])
                self.assertEqual(unexpected, lines)

    def test_unknown_errors_inside_the_expected_interval_remain_visible(self):
        startup, cleanup = self.protocol('startup'), self.protocol('cleanup')
        unknown = startup[1] + '; unexpected acquisition failure'
        baseline, unexpected = self.classify(startup[:1] + [unknown] + startup[1:] + cleanup)
        self.assertEqual(unexpected, [unknown])
        self.assertEqual(len(baseline), 2)

    def test_missing_duplicate_or_out_of_order_protocol_cannot_pass(self):
        startup, cleanup = self.protocol('startup'), self.protocol('cleanup')
        cases = {
            'missing observed': startup[:2] + cleanup,
            'missing native error': startup[::2] + cleanup,
            'duplicate native error': startup[:2] + startup[1:] + cleanup,
            'repeated phase': startup + startup + cleanup,
            'wrong phase order': cleanup + startup,
            'no protocol': [],
            'unmarked error': [startup[1], cleanup[1]],
            'invalid JSON': ['UNITE_CONFLICT_EXPECT_ERROR {invalid'] + startup + cleanup,
        }
        for name, lines in cases.items():
            with self.subTest(case=name):
                _, unexpected = self.classify(lines)
                self.assertTrue(unexpected)

    def test_wrong_native_identity_message_phase_and_observation_cannot_pass(self):
        startup, cleanup = self.protocol('startup'), self.protocol('cleanup')
        for index, before, after in [
            (0, self.uuid, 'foreign@example.org'),
            (0, self.messages['startup'], 'arbitrary error'),
            (1, 'gnome-shell:17', 'gjs:17'),
            (1, self.uuid, 'foreign@example.org'),
            (1, ': Extension ', ': JS ERROR: Extension '),
            (1, 'Error: ', 'TypeError: '),
            (2, self.uuid, 'foreign@example.org'),
            (2, self.messages['startup'], self.messages['startup'] + '; other failure'),
            (2, 'startup', 'cleanup'),
        ]:
            with self.subTest(index=index, replacement=after):
                lines = startup.copy()
                lines[index] = lines[index].replace(before, after)
                baseline, unexpected = self.classify(lines + cleanup)
                self.assertTrue(unexpected)
                self.assertFalse(any(item.get('phase') == 'startup' for item in baseline))

    def test_protocol_cannot_authorize_errors_from_another_archive_uuid(self):
        baseline, unexpected = self.classify(self.protocol('startup') + self.protocol('cleanup'), uuid='foreign@example.org')
        self.assertEqual(baseline, [])
        self.assertTrue(unexpected)


if __name__ == '__main__':
    unittest.main()
