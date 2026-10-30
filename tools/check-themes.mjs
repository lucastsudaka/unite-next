#!/usr/bin/gjs -m
// REQ-THEME-001 / REQ-PACK-001: validate the isolated source snapshot, not the desktop.
import Gio from 'gi://Gio'

if (ARGV.length !== 1) {
  printerr('Usage: gjs -m tools/check-themes.mjs <extension-source-directory>')
  imports.system.exit(2)
}

try {
  const source = Gio.File.new_for_path(ARGV[0])
  const { WindowControlsThemes } = await import(source.get_child('theme.js').get_uri())
  const errors = []
  const themes = new WindowControlsThemes({
    directories: [source.get_child('themes').get_path()],
    warn: message => { errors.push(message); printerr(message) }
  })
  if (errors.length) throw new Error(`${errors.length} invalid shipped window controls theme(s)`)
  for (const theme of themes.available) {
    theme.getActionIcons(true)
    theme.getActionIcons(false)
  }
  print(`Validated ${themes.available.length} window controls themes and every variant/action/state`)
} catch (error) {
  printerr(error.message)
  imports.system.exit(1)
}
