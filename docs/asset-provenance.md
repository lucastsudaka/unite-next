# Asset provenance

Unite Next derives from [hardpixel/unite-shell at commit
7a67cecf52a543c3620a3859b909cc81e9204894](https://github.com/hardpixel/unite-shell/tree/7a67cecf52a543c3620a3859b909cc81e9204894).
The upstream project distributes its sources under GPLv3. The retained license
is [LICENSE](../LICENSE), and [NOTICE](../NOTICE) preserves the upstream project,
inspiration credits, translator attribution and dated fork modification notice.

## Inherited resources

On 2026-10-29 a byte comparison against that exact upstream commit verified all
330 inherited image resources: 327 window-control SVG files, `logo.svg`,
`screenshot.png` and `settings.png`. Every file matched. The original upstream
paths are used below as source locators; they are not the fork's installation
identity.

The upstream `unite@hardpixel.eu/themes/` tree contains 26 theme directories:
adwaita, ambiance, arc, arrongin, breeze, canta, catppuccin, default, dracula,
flat-remix, materia, mcmojave, nordic, osx-arc, pop, prof-gnome, qogir, radiance,
sweet, telinkrin, united, vertex, vimix, whitesur, windwood and yaru. Its 327 SVG
files retain their inherited artwork. Theme manifests and CSS are executable
configuration and styling; their fork modifications are reviewed as source
changes rather than presented as unchanged artwork.

The original resource fingerprints are:

| Upstream resource | SHA-256 |
| --- | --- |
| `logo.svg` | `bbb896027c1528afe6d7dc1b27bd5846cbcb817341c4cc30b5aed9692b29440d` |
| `screenshot.png` | `9cc9bd8cdeee3fedd0d5af25b0676acbcbee32184249921f571ab6080a55de06` |
| `settings.png` | `dee4d76b7622131e59bc9862e4daf8ca4dbf0c38fb45a751f83b6317a461c3af` |
| `LICENSE` | `589ed823e9a84c56feb95ac58e7cf384626b9cbf4fda2a907bc36e103de1bad2` |

For a reproducible aggregate, select those three root image files and every
`.svg` below the original theme directory. Sort their original repository
relative POSIX paths lexicographically. For each, append its lower-case SHA-256,
two spaces, the path and one LF newline. SHA-256 of this UTF-8 manifest is
`f3408634a68fed113f67b4a8b88f160f585ba8c785e0a4cea1b1ba1eaead5f44`.
This identifies the original inherited set, including the historical upstream
screenshots; it is not a fingerprint of later fork screenshots or branding.

## Theme attribution and recovered sources

The following inventory was checked on 2026-11-03 against the supplying Unite
Shell commit above. All 327 SVG files in all 26 families remain byte-identical
to that commit. A manifest containing only those SVGs, constructed by the same
method as the aggregate above with the original `unite@hardpixel.eu/themes/`
paths, has SHA-256
`56feed1f961d5efa55ecf2136c1324e6fedd9cebe337d5a7305803b3ef066831`.
CSS and theme manifests are outside this unchanged-artwork claim.

The inventory distinguishes the contributor who supplied a theme to Unite
Shell from the author of an original theme project. A contribution's Git
author is not, by itself, proof that they created all its artwork. A **declared
source** is identified in an upstream contribution or discussion. An
**associated project** has recoverable authors/license records but no recovered
extraction record tying every bundled SVG to a particular original revision.
**Unite only** means that the supplying Unite commit and its GPLv3 distribution
are established, while an independent original artwork grant has not been
established. Neither a shared name nor generic SVG metadata closes that gap.

| Family | SVGs | Supplying Unite record / contributor | Further lineage and evidence |
| --- | ---: | --- | --- |
| Adwaita | 18 | [Initial dark variant](https://github.com/hardpixel/unite-shell/commit/33be7837647b31fe9d4037db464e703063b2c55d), aiosadchy; later updates by jonian | Unite only; [PR 229](https://github.com/hardpixel/unite-shell/pull/229) does not identify an original artwork revision or license. |
| Ambiance | 9 | [Introduction](https://github.com/hardpixel/unite-shell/commit/4e8ec567c10f118c0d0bb1845fc4078ec030d510), Jonian Guveli / jonian | Unite only; no original artwork revision or separate grant recovered. |
| Arc | 18 | [SVG conversion](https://github.com/hardpixel/unite-shell/commit/09fc8d2), Jonian Guveli / jonian | Associated project: [horst3180/arc-theme](https://github.com/horst3180/arc-theme), GPLv3; exact extraction revision unrecorded. |
| Arrongin | 9 | [PR 78](https://github.com/hardpixel/unite-shell/pull/78), btd1337 | PR names the family and links [its GNOME-Look page](https://www.gnome-look.org/p/1215199/). Associated [paullinuxthemer/Arrongin-GTK](https://github.com/paullinuxthemer/Arrongin-GTK) publishes GPLv2 and a GPLv2-or-later stylesheet notice; exact extraction revision unrecorded. |
| Breeze | 9 | [Introduction](https://github.com/hardpixel/unite-shell/commit/85ea3b6d8d1d7e6b21a7bcc993f40eb088684732), Jonian Guveli / jonian | Commit identifies KDE Breeze; no original artwork revision or per-file grant recovered. The license of unrelated current KDE files is not assigned to these SVGs. |
| Canta | 9 | [PR 231](https://github.com/hardpixel/unite-shell/pull/231), TheLastZombie | Declared source: [vinceliuice/Canta-theme](https://github.com/vinceliuice/Canta-theme); Vince Liuice, based on nana-4's Materia. Its `COPYING` is GPLv2. |
| Catppuccin | 18 | [PR 349](https://github.com/hardpixel/unite-shell/pull/349), 42willow | [Issue 348](https://github.com/hardpixel/unite-shell/issues/348) explicitly describes WhiteSur recolored with the Macchiato red, green and yellow values. This establishes the Unite WhiteSur relationship, not an independent GTK-port author or license. |
| Default | 18 | [Dark introduction](https://github.com/hardpixel/unite-shell/commit/703ba013295212fb7ffac7f69a6da43a26fb10ad) and [light introduction](https://github.com/hardpixel/unite-shell/commit/4763e1655b147630697140ac616ba10cdf55d934), Jonian Guveli / jonian | Unite only; no separate original artwork grant recovered. |
| Dracula | 9 | [PR 259](https://github.com/hardpixel/unite-shell/pull/259), gbegkas; later [PR 381](https://github.com/hardpixel/unite-shell/pull/381), jonian | Declared source: [dracula/gtk](https://github.com/dracula/gtk), maintained by Eliver Lara, GPLv3. |
| Flat Remix | 9 | [PR 169](https://github.com/hardpixel/unite-shell/pull/169), rohanmohapatra | Declared source: [daniruiz/flat-remix-gtk](https://github.com/daniruiz/flat-remix-gtk), daniruiz, GPLv3. The [SVG-source comment](https://github.com/hardpixel/unite-shell/pull/169#issuecomment-617110422) identifies the asset sprite; the contributor confirms SVG extraction and optimization. |
| Materia | 18 | [Introduction](https://github.com/hardpixel/unite-shell/commit/8c037081c358414751916a2e2e36730d2b8a79ba), Jonian Guveli / jonian | Associated project: [nana-4/materia-theme](https://github.com/nana-4/materia-theme), GPLv2-or-later; exact extraction revision unrecorded. |
| McMojave | 9 | [PR 249](https://github.com/hardpixel/unite-shell/pull/249), SlyDeath | Associated project: [vinceliuice/Mojave-gtk-theme](https://github.com/vinceliuice/Mojave-gtk-theme), Vince Liuice, GPLv3; exact extraction revision unrecorded. |
| Nordic | 6 | [PR 238](https://github.com/hardpixel/unite-shell/pull/238), Simon-L | Declared source: Eliver Lara's [Nordic](https://github.com/EliverLara/Nordic), GPLv3. Simon-L reports obtaining the author's permission; the record is that contributor's statement, not a separately recovered statement from the author. |
| OSX Arc | 9 | [Introduction](https://github.com/hardpixel/unite-shell/commit/0133196bb1e7fbe5e040ad2f7d145f8df42dced4), Jonian Guveli / jonian | Unite only; no original artwork revision or separate grant established. A similarly named theme or its later fork is not sufficient evidence. |
| Pop | 18 | [Dark](https://github.com/hardpixel/unite-shell/commit/5e64fa8391acce1cc95392d0f99111bd578fa641) and [light](https://github.com/hardpixel/unite-shell/commit/f75a660002e348d5dc6374d9584fd6733cbf3455) additions, mrprobot | Associated project: System76's [pop-os/gtk-theme](https://github.com/pop-os/gtk-theme), with mixed licensing including an explicit CC BY-SA 4.0 SVG statement. Exact extraction revision unrecorded. |
| Prof-Gnome | 18 | [PR 157](https://github.com/hardpixel/unite-shell/pull/157), btd1337; dark variant by jonian | Associated project: [paullinuxthemer/Prof-Gnome](https://github.com/paullinuxthemer/Prof-Gnome), whose root license is GPLv2; exact extraction revision unrecorded. |
| Qogir | 18 | [Introduction](https://github.com/hardpixel/unite-shell/commit/1662af31d4070b597a11f40d39df4304b4892d5c), jonian | Associated project: [vinceliuice/Qogir-theme](https://github.com/vinceliuice/Qogir-theme), Vince Liuice, based on horst3180's Arc, GPLv3; exact extraction revision unrecorded. |
| Radiance | 9 | [Introduction](https://github.com/hardpixel/unite-shell/commit/5b587068f82d839e8b1abf8f5c799f82daddb521), Jonian Guveli / jonian | Unite only; no original artwork revision or separate grant recovered. |
| Sweet | 9 | [PR 263](https://github.com/hardpixel/unite-shell/pull/263), gbegkas; later [PR 380](https://github.com/hardpixel/unite-shell/pull/380), jonian | Declared source: Eliver Lara's [Sweet](https://github.com/EliverLara/Sweet), GPLv3. |
| Telinkrin | 9 | [PR 78](https://github.com/hardpixel/unite-shell/pull/78), btd1337 | Associated project: [paullinuxthemer/Telinkrin-GTK](https://github.com/paullinuxthemer/Telinkrin-GTK), GPLv2 `COPYING`; exact extraction revision unrecorded. |
| United | 18 | [Introduction](https://github.com/hardpixel/unite-shell/commit/faf6a286c9600f772649623c741aacfd0781f36e), Jonian Guveli / jonian | Associated project: [godlyranchdressing/United-GNOME](https://github.com/godlyranchdressing/United-GNOME), GPLv3-or-later, crediting Flat-Plat, Arc and Material Design icons; exact extraction revision unrecorded. |
| Vertex | 9 | [Introduction](https://github.com/hardpixel/unite-shell/commit/921794bb23259197f8b88253d011b10067845e90), Jonian Guveli / jonian | Associated project: [horst3180/vertex-theme](https://github.com/horst3180/vertex-theme), GPLv3 `COPYING`; exact extraction revision unrecorded. |
| Vimix | 9 | [Introduction](https://github.com/hardpixel/unite-shell/commit/b2b3673c8e5efce55238b44a0a1b94e0c1ad4cdb), mrprobot | Associated project: [vinceliuice/vimix-gtk-themes](https://github.com/vinceliuice/vimix-gtk-themes), Vince Liuice, based on nana-4's Flat-Plat/Materia, GPLv3; exact extraction revision unrecorded. |
| WhiteSur | 18 | [Introduction](https://github.com/hardpixel/unite-shell/commit/ca867b62cd279df20c3e04e15555a2259c9618c2), jonian | Associated project: [vinceliuice/WhiteSur-gtk-theme](https://github.com/vinceliuice/WhiteSur-gtk-theme), Vince Liuice / WhiteSur Developers. The recovered MIT notice predates the Unite addition; exact extraction revision unrecorded. |
| Windwood | 6 | [PR 325](https://github.com/hardpixel/unite-shell/pull/325), natewind | Contribution explicitly describes an Ambiance-based flat icon theme. No separate original grant beyond the supplying Unite GPLv3 distribution was recovered. |
| Yaru | 18 | [Introduction](https://github.com/hardpixel/unite-shell/commit/da93bee10537ae8342a289841ce8ac3d9ec1e942) and later [PR 382](https://github.com/hardpixel/unite-shell/pull/382), jonian | Associated project: [ubuntu/yaru](https://github.com/ubuntu/yaru), Canonical and contributors. Its copyright manifest distinguishes the GPLv3-or-later general files from the CC BY-SA icon subset; exact control-asset extraction revision unrecorded. |

## Recovered license and author records

These are records published by the identified projects, not a claim that every
SVG was independently traced to its ultimate copyright holder. They supplement
the supplying Unite Shell GPLv3 record rather than replacing all artwork
licenses with one blanket grant. Current project links were consulted on
2026-11-03; historical pins are supplied where recovered.

- Canta's [AUTHORS](https://github.com/vinceliuice/Canta-theme/blob/master/AUTHORS)
  credits Vince Liuice and nana-4's Materia. Its [GPLv2 COPYING at the historical
  commit](https://github.com/vinceliuice/Canta-theme/blob/3d055af60365c525c1466e7bf179588d6f2114f6/COPYING)
  is reproduced verbatim in [LICENSES/GPL-2.0.txt](../LICENSES/GPL-2.0.txt).
  A GPLv2 license-text file alone is not presented here as a separate,
  asset-specific "or later" declaration.
- [Nordic LICENSE](https://github.com/EliverLara/Nordic/blob/master/LICENSE),
  [Sweet LICENSE](https://github.com/EliverLara/Sweet/blob/master/LICENSE) and
  [Dracula LICENSE](https://github.com/dracula/gtk/blob/master/LICENSE) contain
  GPLv3. [Dracula's README](https://github.com/dracula/gtk/blob/master/README.md)
  identifies maintainer Eliver Lara.
- [Flat Remix LICENSE](https://github.com/daniruiz/flat-remix-gtk/blob/master/LICENSE)
  contains GPLv3; the contribution links the source project's
  `src/assets-renderer/gtk3/assets.svg` and records optimization before merge.
- [WhiteSur's historical COPYING](https://github.com/vinceliuice/WhiteSur-gtk-theme/blob/f42a270fb55e2572c5c47fec7d79d2a3ae46cf45/COPYING)
  is MIT, copyright 2021 WhiteSur Developers. That 2021-06-07 record predates
  Unite's 2021-09-16 WhiteSur addition. The complete notice is retained in
  [NOTICE](../NOTICE) with the associated WhiteSur and derived Catppuccin
  attribution records, without claiming an unrecovered per-file extraction
  revision.
- [Pop's README](https://github.com/pop-os/gtk-theme/blob/master/README.md)
  states mixed licensing: most files GPLv3-or-later, upstream Adwaita LGPLv2.1,
  and SVG files CC BY-SA 4.0. Its [copyright
  manifest](https://github.com/pop-os/gtk-theme/blob/master/debian/copyright)
  credits System76, Canonical, Red Hat, Intel and Ruslan Izhbulatov for general
  files. Those project notices and the CC BY-SA license URL are retained in
  NOTICE; the precise original revision of the bundled Pop controls remains
  unestablished.
- [Yaru's copyright manifest](https://github.com/ubuntu/yaru/blob/master/debian/copyright)
  credits Canonical, Red Hat, Intel and Ruslan Izhbulatov for general files under
  GPLv3-or-later. The historical [2018 manifest](https://github.com/ubuntu/yaru/blob/4a6b9b7131da01f159c5314cf1c1b9d8f66ef5d9/debian/copyright)
  makes the same general-file/icon distinction. Sam Hewitt's CC BY-SA icon
  credit applies to `icons/*`; it is not evidence that he authored these GTK
  title buttons. This document does not classify all Yaru SVGs as that subset.
- [Materia's README](https://github.com/nana-4/materia-theme/blob/master/README.md)
  explicitly grants GPLv2-or-later. [United's
  README](https://github.com/godlyranchdressing/United-GNOME/blob/master/README.md)
  explicitly grants GPLv3-or-later. [Arc's
  README](https://github.com/horst3180/arc-theme/blob/master/README.md) states
  GPLv3. Vince Liuice's [Vimix AUTHORS](https://github.com/vinceliuice/vimix-gtk-themes/blob/master/AUTHORS),
  [Qogir AUTHORS](https://github.com/vinceliuice/Qogir-theme/blob/master/AUTHORS)
  and [Mojave AUTHORS](https://github.com/vinceliuice/Mojave-gtk-theme/blob/master/AUTHORS)
  retain their Materia/Flat-Plat or Arc lineage; each project includes GPLv3.
- The `paullinuxthemer` account's [Arrongin COPYING](https://github.com/paullinuxthemer/Arrongin-GTK/blob/master/COPYING),
  [Telinkrin COPYING](https://github.com/paullinuxthemer/Telinkrin-GTK/blob/master/COPYING)
  and [Prof-Gnome LICENSE](https://github.com/paullinuxthemer/Prof-Gnome/blob/master/LICENSE)
  contain GPLv2. The [Arrongin stylesheet
  notice](https://github.com/paullinuxthemer/Arrongin-GTK/blob/master/Arrongin-Buttons-Right/gtk-3.0/gtk.css)
  explicitly permits version 2 or later. That stylesheet statement is not
  generalized into an independently verified grant for every copied SVG.

## Remaining attribution limits

The supplying upstream tree has no complete per-theme attribution ledger. The
records above recover several original-source declarations, related-project
licenses and named contributors, but do not establish every original asset
revision, every author or a complete permission chain for all 327 SVGs. In
particular, the Adwaita, Ambiance, Breeze, Default, OSX Arc and Radiance rows do
not establish a separate original artwork grant; Windwood retains its stated
Ambiance dependency. This is an explicit evidence limit, not a finding that
those files are unlicensed or that additional permission has been granted.
Unite Next does not claim that these records constitute EGO approval.

Existing translator and language-team headers remain in `translations/*.po`;
their historical project names and external identifiers are attribution, not
fork settings namespaces. Unite Shell's credits name [Pixel
Saver](https://github.com/deadalnix/pixel-saver), [TopIcons
Plus](https://github.com/phocean/TopIcons-plus) and [Extend Left
Box](https://github.com/StephenPCG/extend-left-box) as inspiration. That wording
does not assign authorship of every bundled icon to those projects.

## Native fork captures

The optional `tools/test-desktop.py --screenshots-dir NEW_DIRECTORY` path records
the actual isolated native primary monitor and the actual installed fork
preferences. It publishes `screenshot.png`, `settings.png` and `captures.json`
only after full desktop acceptance succeeds. The manifest identifies the tested
archive, native Shell version, dimensions and SHA-256 of both PNGs. Captures use
the private test compositor and its private settings; they do not capture the
user's active desktop. Historical upstream screenshot fingerprints above remain
source attribution when the fork replaces the public screenshots with these
verified native captures.

The current root PNGs were captured on 2026-10-30 in GNOME Shell 50.5 after the audit corrections and the complete normal desktop journey passed. The desktop image includes the native
GNOME performance-test client; the preferences image shows the installed fork.
They illustrate the isolated acceptance session, with no user data or mockup.

| Capture | Dimensions | SHA-256 |
| --- | --- | --- |
| `screenshot.png` | 2560 × 1440 | `e93f63eced50305e1cd31b9bcc1cd8d78c03143f0ec97f8cbec390bc51675d96` |
| `settings.png` | 670 × 710 | `36898386d2d827fab70ada8667f95ba4de288f800c2cec13a2ffd84d4e8d1683` |

Capture input installation ZIP SHA-256: `2969175dda52f7bb0093d8a61b4ef7c2228140c94cb7f5f41c2b9a984914c5f2`.
This identifies the capture input; the final released CI artifact has its own
accepted digest recorded in its release notes. The runtime payload is checked
against its corresponding source independently of ZIP container timestamps.
