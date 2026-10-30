"""Assert actual Gtk3 CSD rendering in an explicitly private native session."""
import argparse
import json
import os

import gi

gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk

if os.environ.get('UNITE_PRIVATE_TEST') != '1':
    raise SystemExit('Private session required')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('side', choices=['left', 'right'])
parser.add_argument('hidden', choices=['true', 'false'])
parser.add_argument('maximized', choices=['true', 'false'])
args = parser.parse_args()
hidden = args.hidden == 'true'
maximized = args.maximized == 'true'
Gtk.init(None)
Gtk.Settings.get_default().set_property('gtk-enable-animations', False)
window = Gtk.Window(title='Unite GTK 3 CSD', default_width=480, default_height=320)
window.set_wmclass('unite-acceptance', 'org.unite.Acceptance')
header = Gtk.HeaderBar(show_close_button=True)
header.set_decoration_layout('minimize,maximize,close:' if args.side == 'left' else ':minimize,maximize,close')
window.set_titlebar(header)
label = Gtk.Label(label='Foreign CSS sentinel')
label.get_style_context().add_class('unite-acceptance-probe')
window.add(label)
window.show_all()
if maximized:
    window.maximize()
clock = window.get_frame_clock()
observed = None
failure = None
completed = False
deadline = 0
signal = 0


def descendants(widget):
    result = [widget]
    if isinstance(widget, Gtk.Container):
        widget.forall(lambda child: result.extend(descendants(child)))
    return result


def finish(error):
    global failure, deadline, signal
    failure = error
    if deadline:
        GLib.source_remove(deadline)
        deadline = 0
    if signal:
        clock.disconnect(signal)
        signal = 0
    window.destroy()
    Gtk.main_quit()
    return GLib.SOURCE_REMOVE


def timeout():
    global deadline
    deadline = 0
    return finish(RuntimeError(f'Native Gtk3 styling deadline: {observed}'))


def frame(_clock):
    global observed, completed
    if completed or not window.get_mapped() or (maximized and not window.get_property('is-maximized')):
        return
    try:
        control = next(widget for widget in descendants(header)
                       if widget.get_parent() == header and widget.get_style_context().has_class(args.side))
        context = control.get_style_context()
        opacity = context.get_property('opacity', control.get_state_flags())
        margin = context.get_margin(control.get_state_flags())
        color = label.get_style_context().get_color(label.get_state_flags())
        observed = {'version': '3', 'side': args.side, 'hidden': hidden,
                    'maximized': window.get_property('is-maximized'), 'mapped': control.get_mapped(),
                    'opacity': opacity, 'margin': getattr(margin, args.side),
                    'color': [color.red, color.green, color.blue]}
        foreign_color = all(abs(actual - expected / 255) < 0.001
                            for actual, expected in zip(observed['color'], [17, 34, 51]))
        if not control.get_mapped() or opacity != (0 if hidden else 1) or not foreign_color:
            return
        print('GTK_STYLE_CLIENT_PASS ' + json.dumps(observed), flush=True)
        completed = True
        GLib.idle_add(finish, None)
    except Exception as error:
        completed = True
        GLib.idle_add(finish, error)


signal = clock.connect('after-paint', frame)
deadline = GLib.timeout_add(5000, timeout)
window.queue_draw()
Gtk.main()
if failure:
    raise failure
