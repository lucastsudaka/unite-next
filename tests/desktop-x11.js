import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'

function assert(value, message) { if (!value) throw new Error(message) }
async function until(predicate, description) {
  const deadline = GLib.get_monotonic_time() + 10000000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Timed out: ${description}`)
    await Scripting.sleep(16)
  }
}
function property(xid) {
  const process = Gio.Subprocess.new(['xprop', '-id', xid, '-f', '_MOTIF_WM_HINTS', '32x', '_MOTIF_WM_HINTS'],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [, output, errors] = process.communicate_utf8(null, null)
  assert(process.get_successful(), `Independent xprop read failed: ${errors}`)
  if (/not found/.test(output)) return null
  const match = output.match(/^_MOTIF_WM_HINTS\(([^)]+)\) = (.+)/)
  assert(match, `Unexpected independent property output: ${output}`)
  return { type: match[1], data: match[2].split(',').map(value => Number(value.trim())) }
}

export async function runX11(owner, settings) {
  for (const mode of ['absent', 'custom']) {
    settings.set_string('hide-window-titlebars', 'never')
    await Scripting.waitLeisure()
    const ready = GLib.build_filenamev([GLib.get_user_runtime_dir(), `unite-x11-${mode}.json`])
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE })
    launcher.setenv('GDK_BACKEND', 'x11', true)
    const process = launcher.spawnv(['gjs', '-m', `${GLib.getenv('UNITE_TEST_SOURCE')}/tests/x11-window.mjs`,
      owner.dir.get_child('x11.py').get_path(), ready, mode])
    let win
    try {
      await until(() => GLib.file_test(ready, GLib.FileTest.EXISTS), 'XWayland fixture initialized')
      const data = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(ready)[1]))
      await until(() => {
        win = global.get_window_actors().map(actor => actor.meta_window)
          .find(window => window.get_title() === `Unite XWayland ${mode}`)
        return win
      }, 'XWayland fixture mapped')
      assert(win.get_client_type() === Meta.WindowClientType.X11, 'Expected XWayland client')
      const original = property(data.xid)
      const originalFrame = win.get_frame_type()
      print(`XWAYLAND_ORIGINAL ${JSON.stringify({ mode, original, move: win.allows_move(), resize: win.allows_resize(), decorated: win.decorated })}`)
      assert(mode === 'absent' ? original === null : original.type === '_MOTIF_WM_HINTS' &&
        original.data.join(',') === '3,4,1,17,42,4294967295', 'Fixture bytes differ from independent original expectation')
      Main.activateWindow(win)
      settings.set_string('hide-window-titlebars', 'always')
      await until(() => owner.windowManager.getWindow(win)?.decorations.owned, 'XWayland hints changed')
      const hidden = property(data.xid)
      print(`XWAYLAND_HIDDEN ${JSON.stringify({ mode, hidden, move: win.allows_move(), resize: win.allows_resize(), decorated: win.decorated })}`)
      assert(hidden.type === '_MOTIF_WM_HINTS', 'Motif type was changed')
      assert(hidden.data.join(',') === (mode === 'absent' ? '2,0,2,0,0' : '3,4,2,17,42,4294967295'),
        'Unrelated Motif fields were changed')
      await until(() => win.get_frame_type() === Meta.FrameType.BORDER, 'native XWayland titlebar hidden')
      if (mode === 'custom') {
        // Mutter deliberately derives resizing from WM_NORMAL_HINTS, overriding
        // the Motif resize bit; its minimize/maximize restrictions remain native.
        await until(() => !win.can_minimize() && !win.can_maximize(), 'application restrictions observed')
        assert(win.allows_move() && !win.can_minimize() && !win.can_maximize(), 'Application function restrictions were lost')
      }
      Main.extensionManager.disableExtension(owner.uuid)
      await until(() => !owner.context, 'disable with open XWayland window')
      assert(JSON.stringify(property(data.xid)) === JSON.stringify(original), 'Disable did not restore exact Motif state/absence')
      await until(() => win.get_frame_type() === originalFrame, 'native XWayland titlebar restored')
      Main.extensionManager.enableExtension(owner.uuid)
      await until(() => owner.context, 're-enable with open XWayland window')
      settings.set_string('hide-window-titlebars', 'never')
      await Scripting.waitLeisure()
      assert(JSON.stringify(property(data.xid)) === JSON.stringify(original), 'Never mode altered original state')
    } finally {
      process.force_exit()
      process.wait(null)
      if (GLib.file_test(ready, GLib.FileTest.EXISTS)) Gio.File.new_for_path(ready).delete(null)
    }
    await until(() => !global.get_window_actors().some(actor => actor.meta_window === win), 'XWayland fixture closed')
  }
  settings.reset('hide-window-titlebars')
  print('XWAYLAND_STATE_PASS absent/custom/type/fields/function-restrictions/disable/re-enable')
}
