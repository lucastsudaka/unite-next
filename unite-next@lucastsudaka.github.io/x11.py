#!/usr/bin/env python3
"""A bounded, compare-and-replace bridge for the owned Motif property only.

The supervising process never opens X11. Its sole child owns the connection,
and is killed/reaped if the local X server does not finish within one second.
This keeps synchronous Shell teardown independent of its blocked main loop.
"""

import ctypes as C
import json
import subprocess
import sys

WORKER_TIMEOUT_SECONDS = 1
MAX_ITEMS = 1024


def snapshot(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"type", "format", "data"}:
        raise ValueError("Invalid Motif snapshot")
    if type(value["type"]) is not int or not 0 < value["type"] <= 0xFFFFFFFF:
        raise ValueError("Invalid X11 type atom")
    if value["format"] != 32 or not isinstance(value["data"], list):
        raise ValueError("Motif hints must have format 32")
    if not 5 <= len(value["data"]) <= MAX_ITEMS:
        raise ValueError("Invalid Motif hint length")
    if any(type(item) is not int or not 0 <= item <= 0xFFFFFFFF for item in value["data"]):
        raise ValueError("Invalid Motif hint value")
    return value


def replace_owned(connection, expected, value):
    """Compare and replace under a short server grab; never overwrite a conflict."""
    connection.grab()
    try:
        current = connection.read()
        if current != expected:
            raise ValueError("Ownership conflict: application changed _MOTIF_WM_HINTS")
        if current == value:
            return False
        connection.write(value)
        return True
    finally:
        connection.ungrab()


class XError(C.Structure):
    _fields_ = [("type", C.c_int), ("display", C.c_void_p),
                ("resourceid", C.c_ulong), ("serial", C.c_ulong),
                ("error_code", C.c_ubyte), ("request_code", C.c_ubyte),
                ("minor_code", C.c_ubyte)]


class Connection:
    def __init__(self, xid):
        # The supported Linux libX11 ABI avoids discovery subprocesses escaping
        # the sole worker's deadline (ctypes.util.find_library may launch tools).
        self.x = C.CDLL('libX11.so.6')
        definitions = {
            "XOpenDisplay": ([C.c_char_p], C.c_void_p),
            "XCloseDisplay": ([C.c_void_p], C.c_int),
            "XInternAtom": ([C.c_void_p, C.c_char_p, C.c_int], C.c_ulong),
            "XGrabServer": ([C.c_void_p], C.c_int),
            "XUngrabServer": ([C.c_void_p], C.c_int),
            "XSync": ([C.c_void_p, C.c_int], C.c_int),
            "XFree": ([C.c_void_p], C.c_int),
            "XGetWindowProperty": ([C.c_void_p, C.c_ulong, C.c_ulong, C.c_long,
                                    C.c_long, C.c_int, C.c_ulong,
                                    C.POINTER(C.c_ulong), C.POINTER(C.c_int),
                                    C.POINTER(C.c_ulong), C.POINTER(C.c_ulong),
                                    C.POINTER(C.POINTER(C.c_ubyte))], C.c_int),
            "XChangeProperty": ([C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong,
                                 C.c_int, C.c_int, C.c_void_p, C.c_int], C.c_int),
            "XDeleteProperty": ([C.c_void_p, C.c_ulong, C.c_ulong], C.c_int),
        }
        for name, (arguments, result) in definitions.items():
            function = getattr(self.x, name)
            function.argtypes, function.restype = arguments, result
        self.errors = []
        callback_type = C.CFUNCTYPE(C.c_int, C.c_void_p, C.POINTER(XError))

        def on_error(_display, event):
            self.errors.append(f"X11 error {event.contents.error_code} for window {xid:#x}")
            return 0

        self.error_callback = callback_type(on_error)
        self.x.XSetErrorHandler.argtypes = [callback_type]
        self.x.XSetErrorHandler.restype = C.c_void_p
        self.x.XSetErrorHandler(self.error_callback)
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("Cannot connect to the XWayland display")
        self.xid = xid
        self.atom = self.x.XInternAtom(self.display, b"_MOTIF_WM_HINTS", False)

    def sync(self):
        self.x.XSync(self.display, False)
        if self.errors:
            raise RuntimeError("; ".join(self.errors))

    def grab(self):
        self.x.XGrabServer(self.display)

    def ungrab(self):
        self.x.XUngrabServer(self.display)
        self.sync()

    def read(self):
        actual_type, count, remaining = C.c_ulong(), C.c_ulong(), C.c_ulong()
        actual_format = C.c_int()
        data = C.POINTER(C.c_ubyte)()
        status = self.x.XGetWindowProperty(
            self.display, self.xid, self.atom, 0, MAX_ITEMS, False, 0,
            C.byref(actual_type), C.byref(actual_format), C.byref(count),
            C.byref(remaining), C.byref(data))
        try:
            self.sync()
            if status != 0 or remaining.value:
                raise RuntimeError("Cannot read the complete Motif property")
            if actual_type.value == 0:
                return None
            if actual_format.value != 32 or count.value < 5:
                raise ValueError("Refusing to modify malformed Motif hints")
            # Xlib stores format-32 wire values in native unsigned long slots.
            values = C.cast(data, C.POINTER(C.c_ulong))
            return snapshot({"type": actual_type.value, "format": 32,
                             "data": [values[i] & 0xFFFFFFFF for i in range(count.value)]})
        finally:
            if data:
                self.x.XFree(data)

    def write(self, value):
        if value is None:
            self.x.XDeleteProperty(self.display, self.xid, self.atom)
        else:
            values = (C.c_ulong * len(value["data"]))(*value["data"])
            self.x.XChangeProperty(self.display, self.xid, self.atom, value["type"],
                                   32, 0, values, len(values))
        self.sync()

    def close(self):
        self.x.XCloseDisplay(self.display)


def worker(request):
    if request.get("operation") not in {"read", "replace"}:
        raise ValueError("Invalid Motif operation")
    xid = int(request["xid"], 0)
    if not 0 < xid <= 0xFFFFFFFF:
        raise ValueError("Invalid X11 window ID")
    expected = snapshot(request.get("expected"))
    value = snapshot(request.get("value"))
    connection = Connection(xid)
    try:
        if request["operation"] == "read":
            return {"value": connection.read(), "type": connection.atom}
        return {"changed": replace_owned(connection, expected, value)}
    finally:
        connection.close()


def main():
    request = sys.stdin.buffer.read(65537)
    if len(request) > 65536:
        raise ValueError("Motif request is too large")
    if sys.argv[1:] == ["--worker"]:
        print(json.dumps(worker(json.loads(request))))
    elif not sys.argv[1:]:
        result = subprocess.run([sys.executable, __file__, "--worker"], input=request,
                                capture_output=True, timeout=WORKER_TIMEOUT_SECONDS)
        sys.stdout.buffer.write(result.stdout)
        sys.stderr.buffer.write(result.stderr)
        return result.returncode
    else:
        raise ValueError("Invalid arguments")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Unite Motif operation failed: {error}", file=sys.stderr)
        sys.exit(1)
