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

## Attribution limits

The inspected upstream tree contains no per-theme author, origin or license
notices establishing the complete original artwork attribution chain. Generic
SVG format metadata and theme names do not establish authorship. The fork
therefore identifies the exact supplying upstream source, retains its GPLv3
license and existing credits, and does not claim independently verified
per-theme ownership or permissions beyond those records.

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

The current root PNGs were captured on 2026-10-30 in GNOME Shell 50.5 after the
complete normal desktop journey passed. The desktop image includes the native
GNOME performance-test client; the preferences image shows the installed fork.
They illustrate the isolated acceptance session, with no user data or mockup.

| Capture | Dimensions | SHA-256 |
| --- | --- | --- |
| `screenshot.png` | 2560 × 1440 | `9e75c6ff5a699b5dee6b7debc8e7c1a9348b645b1b6aca1f57b0d6fa41b950a8` |
| `settings.png` | 670 × 710 | `6714e91ab90cd7f8168b288d375a5b8daf013adf6fdac76025681c544745e8ef` |

Capture input installation ZIP SHA-256: `6b2c80862e91a2b3c836c927b45e428b7cfbe80620cf91e6c85624fc4f092284`.
This identifies the capture input; the final released CI artifact has its own
accepted digest recorded in its release notes. The runtime payload is checked
against its corresponding source independently of ZIP container timestamps.
