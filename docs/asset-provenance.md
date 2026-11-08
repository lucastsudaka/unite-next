# Artwork provenance

Unite Next derives from [Unite Shell at supplying commit
7a67cecf52a543c3620a3859b909cc81e9204894](https://github.com/hardpixel/unite-shell/tree/7a67cecf52a543c3620a3859b909cc81e9204894).
[LICENSE](../LICENSE) and [NOTICE](../NOTICE) retain the project license, code/CSS
contributors, translator attribution and dated fork changes.

## Current artwork inventory

The 2026-11-03 selective clearance retains 78 control SVGs from seven families
with applicable source/grant evidence and replaces the other 249 control SVGs
with original geometry created for Unite Next. The 26 existing theme IDs, both
variants, action/state mappings and user settings remain available. The project
logo is retained under its supplying Unite project grant.

[tools/artwork.json](../tools/artwork.json) is the reviewed file-by-file inventory:
327 controls and the source logo, with SHA-256, original/inherited classification,
license, source and attribution. It also binds the applicable distribution
notices. `tools/build.py check` and both package commands reject unadmitted SVGs,
changed admitted bytes, missing original SPDX notices or changed distribution
notices. An inventory entry records a review decision; a hash or SPDX label alone
is not proof of permission. Build data stays outside the installation ZIP.

## Original Unite Next controls

Copyright 2026 Unite Next contributors. The 249 replacement SVGs are licensed
under **GPL-3.0-or-later**, with explicit SPDX copyright/license comments in each
source. They use newly constructed lines and rectangles for close, minimize
and maximize/restore controls, with original palettes and state treatments. No
inherited SVG path data was reused in those replacements. Canvas dimensions
and existing resource paths remain compatible with the theme stylesheets.

The compatibility theme IDs with replacement artwork are:
`adwaita`, `ambiance`, `arc`, `arrongin`, `breeze`, `default`, `materia`, `mcmojave`, `osx-arc`, `pop`, `prof-gnome`, `qogir`, `radiance`, `telinkrin`, `united`, `vertex`, `vimix`, `windwood`, `yaru`.

These selectors retain existing preferences and automatic theme matching. The
replacement images are Unite Next designs; their historic selector names do
not assert authorship or endorsement by similarly named theme projects.

## Retained control artwork

A project-wide applicable grant can cover an artwork set; a separate letter or
extraction commit for every SVG is not required. The records below combine
declared content lineage or direct content comparison with the actual supplying
project license. A project with a similar name alone is insufficient. All 78
retained control files remain byte-identical to the supplying Unite commit.

| Family | SVGs | Content/source evidence | Applicable grant and attribution |
| --- | ---: | --- | --- |
| canta | 9 | [Supplying record](https://github.com/hardpixel/unite-shell/pull/231); [original project at reviewed revision](https://github.com/vinceliuice/Canta-theme/tree/45cc14efa515a5a615f360571bc3868998b18470) | [GPL; original COPYING supplies GPLv2 text, with no inferred only/or-later expression](https://github.com/vinceliuice/Canta-theme/blob/45cc14efa515a5a615f360571bc3868998b18470/COPYING); Vince Liuice; nana-4/Materia as credited by upstream AUTHORS. |
| nordic | 6 | [Supplying record](https://github.com/hardpixel/unite-shell/pull/238); [original project at reviewed revision](https://github.com/EliverLara/Nordic/tree/e79a3bd076906fb6dbfd0abf0fef18e6be9151d0) | [GPLv3 (original project LICENSE)](https://github.com/EliverLara/Nordic/blob/e79a3bd076906fb6dbfd0abf0fef18e6be9151d0/LICENSE); Eliver Lara and contributors. |
| dracula | 9 | [Supplying record](https://github.com/hardpixel/unite-shell/pull/259); [original project at reviewed revision](https://github.com/dracula/gtk/tree/a6984923939114ec53b42d79c902790d2938f358) | [GPLv3 (original project LICENSE)](https://github.com/dracula/gtk/blob/a6984923939114ec53b42d79c902790d2938f358/LICENSE); Eliver Lara and contributors. |
| sweet | 9 | [Supplying record](https://github.com/hardpixel/unite-shell/pull/263); [original project at reviewed revision](https://github.com/EliverLara/Sweet/tree/7ea1219289e544ad30f0f1c71f2b05e0ec07bc47) | [GPLv3 (original project LICENSE)](https://github.com/EliverLara/Sweet/blob/7ea1219289e544ad30f0f1c71f2b05e0ec07bc47/LICENSE); Eliver Lara and contributors. |
| flat-remix | 9 | [Supplying record](https://github.com/hardpixel/unite-shell/pull/169); [original project at reviewed revision](https://github.com/daniruiz/flat-remix-gtk/tree/0d76504e944ee67be84cb3b5e98fd6751e4f58e3) | [GPLv3 (original project LICENSE)](https://github.com/daniruiz/flat-remix-gtk/blob/0d76504e944ee67be84cb3b5e98fd6751e4f58e3/LICENSE); daniruiz and Flat Remix contributors. |
| whitesur | 18 | [Supplying record](https://github.com/hardpixel/unite-shell/commit/ca867b62cd279df20c3e04e15555a2259c9618c2); [original project at reviewed revision](https://github.com/vinceliuice/WhiteSur-gtk-theme/tree/943685a2fbce677758fa16f75e45f8451cc333bb) | [MIT](https://github.com/vinceliuice/WhiteSur-gtk-theme/blob/943685a2fbce677758fa16f75e45f8451cc333bb/COPYING); WhiteSur Developers; Vince Liuice identified by project AUTHORS. |
| catppuccin | 18 | [Supplying record](https://github.com/hardpixel/unite-shell/pull/349); [original project at reviewed revision](https://github.com/vinceliuice/WhiteSur-gtk-theme/tree/943685a2fbce677758fa16f75e45f8451cc333bb) | [MIT (WhiteSur base); GPLv3 (Unite Shell contribution)](https://github.com/vinceliuice/WhiteSur-gtk-theme/blob/943685a2fbce677758fa16f75e45f8451cc333bb/COPYING); 2021 WhiteSur Developers;42willow and Unite Shell contributors for modifications. |

Canta's source contribution explicitly identifies the Canta project. Its
historical COPYING supplies the GPLv2 text, preserved in
[LICENSES/GPL-2.0.txt](../LICENSES/GPL-2.0.txt). This document does not infer an
unrecovered “only” or “or later” suffix from that text alone. The original
[AUTHORS](https://github.com/vinceliuice/Canta-theme/blob/45cc14efa515a5a615f360571bc3868998b18470/AUTHORS)
credits Vince Liuice and nana-4/Materia.

Nordic's contribution identifies Eliver Lara, states that the supplied SVGs
remain under the original GPL and reports obtaining the author's permission.
That last statement is contributor testimony; the pinned original project GPL
is the directly recoverable grant. Dracula and Sweet have explicit original
project links in their contributions and retain their project GPL records.
Flat Remix's [review discussion](https://github.com/hardpixel/unite-shell/pull/169)
identifies the original SVG sprite and confirms cleaned SVG extraction.

For WhiteSur, the 18 corresponding titlebutton vector path sets match the
historical original assets at the reviewed revision after normalizing relative,
absolute and shorthand path commands. This is a content-lineage comparison,
not a claim that all XML metadata and rendering attributes are byte-identical.
The original MIT notice is retained verbatim in NOTICE.

Catppuccin's [contribution](https://github.com/hardpixel/unite-shell/pull/349)
links [issue 348](https://github.com/hardpixel/unite-shell/issues/348), which
explicitly derives its artwork from WhiteSur. The adaptation contains path
edits as well as recoloring. WhiteSur's MIT grant permits modification; the
supplying Unite contribution provides the GPLv3 modification record. Both the
WhiteSur copyright/permission notice and the contributor attribution remain.

## Project logo

The root `logo.svg` retains SHA-256 `bbb896027c1528afe6d7dc1b27bd5846cbcb817341c4cc30b5aed9692b29440d`.
It was supplied by the Unite project in [this revision](https://github.com/hardpixel/unite-shell/blob/706c52b09fa1ab5d14dc1aaf4d355ffaaf0eff14/logo.svg),
whose [README](https://github.com/hardpixel/unite-shell/blob/706c52b09fa1ab5d14dc1aaf4d355ffaaf0eff14/README.md) explicitly distributes
its project under GPLv3. The supplying maintainer/project attribution remains
in NOTICE. This is a project-supplied resource with an applicable grant, rather
than a license inferred from an unrelated similarly named project.

## Historical artwork and review limits

The earlier inherited-artwork inventory and screenshots remain inspectable in
[the previous reviewed public source](https://github.com/lucastsudaka/unite-next/tree/628d36eb3ae1b3f59f9e6bd655bf4098b76791fb).
The 249 replaced images did not reach the same demonstrated coverage in the
directed review. That evidence limit is not a finding that the earlier artwork
was unlicensed. The original published release and its artwork are unchanged.
Current images are identified by the current inventory, not by historical
upstream resource fingerprints. No record here claims EGO approval.

Existing source and translation notices remain applicable. Translator and
language-team headers stay in `translations/*.po`; their historical project
names are attribution rather than fork settings namespaces.

## Native fork captures

The current root PNGs were captured on 2026-11-08 in an isolated GNOME Shell
51.0 session. The desktop shows the official GNOME Settings application on its
Apps page (`gnome-control-center applications`), with Unite Next's window title
and controls in the top panel. The preferences capture shows the actual installed
fork. Native `Shell.Screenshot` output is published unchanged.

The session used disposable settings, private buses and the existing GNOME 51.0
image. Its window-button layout matched GTK's right-hand layout; the fork's
titlebar policy was `maximized`, primary-monitor restriction was off, and panel
titles and controls were enabled. Capture automation in a disposable source copy
opened the real Settings application instead of the performance-test client,
waited for its painted frame and closed it after capture. The capture journey
completed with no unexpected diagnostics or remaining descendants. This records
image provenance; the unchanged installation ZIP retains its separate canonical
GNOME 50/51 acceptance at source revision `fc7c941046bf0db8bd1152c32ccafd78d5cf516f`.

The capture input installation ZIP SHA-256 is
`4499d9ca1def6c8caeb1a127abefdeb71f0f2b89ef878700bc7113d26c22609a`,
the accepted EGO artifact from CI run `41775272457`. Only presentation PNGs and
their documentation changed; the submitted runtime package remains identical.

| Capture | Dimensions | SHA-256 |
| --- | --- | --- |
| `screenshot.png` | 2560 × 1440 | `c73ec11cfb060c1d69f68ae9c8309a2f9565daacffba63e39e5e96f1020d235b` |
| `settings.png` | 670 × 710 | `ed5de05ab7ca5b7408ce3073bb4556653dc8722c7d77a5935ae6daf341c4b765` |
