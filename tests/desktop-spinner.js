// REQ-FEATURE-001, REQ-LIFE-001/002: native mapped spinner disposal regression.
import GLib from 'gi://GLib'
import St from 'gi://St'
import System from 'system'
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js'

function assert(value, message) { if (!value) throw new Error(message) }
async function until(predicate, description, milliseconds = 3000) {
  const deadline = GLib.get_monotonic_time() + milliseconds * 1000
  while (!predicate()) {
    if (GLib.get_monotonic_time() > deadline) throw new Error(`Spinner timeout: ${description}`)
    await Scripting.sleep(8)
  }
}

export async function runSpinner(owner) {
  assert(GLib.getenv('UNITE_PRIVATE_TEST') === '1', 'Private spinner session required')
  const feature = owner.panelManager.appmenu
  const button = feature?.button
  const appSpinner = button?._spinner
  assert(button?.mapped && appSpinner instanceof Animation.Spinner, 'Mapped native app menu spinner required')
  assert(Object.getPrototypeOf(appSpinner) === Animation.Spinner.prototype, 'Custom spinner subclass remains active')
  const errors = []
  let temporary = null
  let paintedFrames = 0
  let cycles = 0
  let spinner = null
  const started = GLib.get_monotonic_time()
  const paintId = global.stage.connect('after-paint', () => paintedFrames++)
  async function frame(description) {
    const before = paintedFrames
    global.stage.queue_redraw()
    await until(() => paintedFrames > before, description)
  }
  try {
    // The private runner owns the native animation profile. Verify its actual
    // effect rather than changing global policy from a scenario helper.
    await until(() => St.Settings.get().enable_animations, 'native runner animation profile applied')

    // Menu visibility must dismiss the owned tooltip through the native menu
    // signal, without adding a competing pointer gesture to PanelMenu.Button.
    feature.tooltip.show()
    button.menu.open()
    await until(() => button.menu.isOpen, 'native app menu opened')
    assert(!feature.tooltip.visible, 'App menu opening retained its tooltip')
    button.menu.close()
    await until(() => !button.menu.isOpen, 'native app menu closed')

    // The product's focused-app owner may legitimately stop its own spinner as
    // focus or busy state changes. Verify its native wiring synchronously, then
    // stress a separate native actor whose complete lifecycle belongs to this test.
    button.startAnimation()
    assert(appSpinner.content !== null, 'App menu start did not reach its native spinner')
    button.stopAnimation()
    spinner = new Animation.Spinner(14, { animate: true, hideOnStop: true })
    spinner.set_position(100, 100)
    Main.uiGroup.add_child(spinner)
    for (; cycles < 8; cycles++) {
      spinner.play()
      await until(() => spinner.mapped && spinner.content !== null, 'spinner mapped with native content')
      let content = spinner.content
      let transition = spinner.get_transition('opacity')
      assert(transition !== null, 'Native animated fade was skipped')
      spinner.play()
      assert(spinner.content === content && spinner.get_transition('opacity') === transition,
        'Repeated busy state restarted the native spinner')
      content = transition = null
      await until(() => spinner.opacity === 255, 'native delayed fade completed')
      await frame('mapped spinner frame painted')
      spinner.stop()
      await until(() => !spinner.visible && spinner.content === null, 'native fade released spinner content')
      spinner.stop()
      assert(spinner.get_transition('opacity') === null, 'Idle stop created a new transition')

      temporary = new Animation.Spinner(14, { animate: false, hideOnStop: true })
      temporary.set_position(132, 100)
      Main.uiGroup.add_child(temporary)
      temporary.play()
      await until(() => temporary.mapped, 'disposable native spinner mapped')
      await frame('disposable spinner content painted')
      temporary.hide()
      await until(() => !temporary.mapped, 'disposable spinner unmapped')
      temporary.show()
      await frame('disposable spinner remapped and painted')
      temporary.destroy()
      temporary = null
      // Test-only collection exercises timeline callbacks after the content is
      // freed. Production teardown does not depend on forced collection.
      System.gc()
      await frame('frame clock progressed after native content disposal')
    }
    assert(GLib.get_monotonic_time() - started > 10000000,
      'Mapped spinner stress did not exceed the historical crash horizon')
    assert(paintedFrames >= cycles * 4, 'Spinner stress did not observe real frame-clock progress')
  } catch (error) {
    errors.push(error)
  } finally {
    const cleanup = callback => { try { callback() } catch (error) { errors.push(error) } }
    cleanup(() => temporary?.destroy())
    cleanup(() => spinner?.destroy())
    cleanup(() => button.menu.close())
    cleanup(() => button.stopAnimation())
    cleanup(() => global.stage.disconnect(paintId))
  }
  if (errors.length) throw new AggregateError(errors, `Native spinner acceptance failed: ${errors.map(error => error.message).join('; ')}`)
  const result = { cycles, paintedFrames, elapsedMilliseconds: (GLib.get_monotonic_time() - started) / 1000,
    nativeContentReleased: true, originalChromiumStartupReproduced: false }
  print(`UNITE_SPINNER_PASS ${JSON.stringify(result)}`)
  return result
}
