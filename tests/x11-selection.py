"""Independent read-only X11 tray-selection probe for private native acceptance."""
import ctypes
import os


if os.environ.get('UNITE_PRIVATE_TEST') != '1':
    raise SystemExit('Private session required')

xlib = ctypes.CDLL('libX11.so.6')
xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
xlib.XOpenDisplay.restype = ctypes.c_void_p
xlib.XDefaultScreen.argtypes = [ctypes.c_void_p]
xlib.XDefaultScreen.restype = ctypes.c_int
xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
xlib.XInternAtom.restype = ctypes.c_ulong
xlib.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
xlib.XGetSelectionOwner.restype = ctypes.c_ulong
xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
xlib.XCloseDisplay.restype = ctypes.c_int
display = xlib.XOpenDisplay(None)
if not display:
    raise SystemExit('Cannot open private X11 display')
try:
    screen = xlib.XDefaultScreen(display)
    atom = xlib.XInternAtom(display, f'_NET_SYSTEM_TRAY_S{screen}'.encode('ascii'), True)
    print(xlib.XGetSelectionOwner(display, atom) if atom else 0)
finally:
    xlib.XCloseDisplay(display)
