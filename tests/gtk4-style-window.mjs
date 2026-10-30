// REQ-FEATURE-001: actual toolkit CSD styling, on a private native display only.
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gtk from 'gi://Gtk?version=4.0'

if (GLib.getenv('UNITE_PRIVATE_TEST') !== '1') throw new Error('Private session required')
const [side, hiddenText, maximizedText = 'false', decoration = 'custom'] = ARGV
if (!['left', 'right'].includes(side) ||
    !['true', 'false'].includes(hiddenText) || !['true', 'false'].includes(maximizedText) ||
    !['custom', 'default'].includes(decoration)) {
  throw new Error('Pass left/right, expected hidden/maximized booleans and custom/default decoration')
}
const hidden = hiddenText === 'true'
const maximized = maximizedText === 'true'
const application = new Gtk.Application({ application_id: 'org.unite.Acceptance', flags: Gio.ApplicationFlags.NON_UNIQUE })
let failure = null

function descendants(widget, found = []) {
  found.push(widget)
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) descendants(child, found)
  return found
}

application.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({ application, title: 'Unite GTK 4 CSD', default_width: 480, default_height: 320 })
  Gtk.Settings.get_default().gtk_enable_animations = false
  const layout = side === 'left' ? 'minimize,maximize,close:' : ':minimize,maximize,close'
  Gtk.Settings.get_default().gtk_decoration_layout = layout
  if (decoration === 'custom') {
    const header = new Gtk.HeaderBar({ show_title_buttons: true, decoration_layout: layout })
    window.set_titlebar(header)
  }
  const label = new Gtk.Label({ label: 'Foreign CSS sentinel' })
  label.add_css_class('unite-acceptance-probe')
  window.set_child(label)
  window.present()
  if (maximized) window.maximize()
  const frameClock = window.get_frame_clock()
  let frameSignal = 0
  let completed = false
  let deadline = 0
  let observed = null
  const finish = error => {
    failure = error
    if (deadline) GLib.source_remove(deadline)
    deadline = 0
    if (frameSignal) frameClock.disconnect(frameSignal)
    frameSignal = 0
    window.destroy()
    application.quit()
  }
  const isMaximized = () => window.is_maximized()
  const finishAfterFrame = error => {
    completed = true
    if (deadline) GLib.source_remove(deadline)
    deadline = 0
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { finish(error); return GLib.SOURCE_REMOVE })
  }
  deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    deadline = 0
    finish(new Error(`Native GTK 4 styling deadline: ${JSON.stringify(observed)}`))
    return GLib.SOURCE_REMOVE
  })
  frameSignal = frameClock.connect('after-paint', () => {
    if (completed || !window.get_mapped() || (maximized && !isMaximized())) return
    try {
      const control = descendants(window).find(widget => decoration === 'default'
        ? widget instanceof Gtk.HeaderBar && widget.has_css_class('default-decoration')
        : widget instanceof Gtk.WindowControls && widget.get_side() === (side === 'left' ? Gtk.PackType.START : Gtk.PackType.END))
      if (!control) throw new Error(`Missing actual GTK 4 ${side} ${decoration} decoration`)
      const context = control.get_style_context()
      const margin = context.get_margin()
      const padding = context.get_padding()
      const border = context.get_border()
      const color = label.get_style_context().get_color()
      const bounds = control.compute_bounds(window)
      observed = { version: '4', side, decoration, hidden, maximized: isMaximized(), mapped: window.get_mapped(),
        margin: margin[decoration === 'default' ? 'top' : side], color: [color.red, color.green, color.blue],
        padding: [padding.top, padding.right, padding.bottom, padding.left],
        border: [border.top, border.right, border.bottom, border.left],
        bounds: bounds?.[0] ? [bounds[1].origin.x, bounds[1].origin.y, bounds[1].size.width, bounds[1].size.height] : null }
      const outside = bounds?.[0] && (decoration === 'default'
        ? bounds[1].origin.y + bounds[1].size.height <= 0 || bounds[1].origin.y >= window.get_height()
        : bounds[1].origin.x + bounds[1].size.width <= 0 || bounds[1].origin.x >= window.get_width())
      const actualVisibility = control.get_mapped() && control.get_width() > 0 &&
        control.get_height() > 0 && bounds?.[0] && (hidden ? outside : !outside)
      const foreignColor = [17, 34, 51].every((value, index) => Math.abs(observed.color[index] - value / 255) < 0.001)
      if (!actualVisibility || !foreignColor) return
      print(`GTK_STYLE_CLIENT_PASS ${JSON.stringify(observed)}`)
      finishAfterFrame(null)
    } catch (error) {
      finishAfterFrame(error)
    }
  })
  window.queue_draw()
})

await application.runAsync([])
if (failure) throw failure
