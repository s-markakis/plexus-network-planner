# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Circuits, reworked into an as-built record:**
  - in every mode (was Simulate only), plus *Record a circuit…* / *Circuits
    through this* in a device's right-click menu and a circuits line in its panel;
  - **Create for all devices** fills a circuit per AP and camera from the plan;
  - a new hop goes between the end device and its switch, any row can insert
    below it, and label fields suggest panels/outlets/cables already used;
  - **conflicts**: one patch position, outlet port or cable label on two
    circuits is flagged on both and in Validate (labels compared loosely);
  - **Update from plan** for a circuit that has drifted, keeping passive hops;
  - **⌖ Map** traces a circuit on the plan;
  - **photos** per hop, inlined into the saved file so they travel with it;
  - **exports**: `circuits.csv`, `patch-schedule.csv` (also in the handover
    pack), a circuits table in the technical PDF, printable **cable labels**.
- Circuit edits are undoable; a deletion can be undone from the dialog.

## [3.8.2] — 2026-11-20

### Fixed
- **macOS: the downloaded app opens.** Earlier macOS builds carried a broken
  code signature, so macOS called the app *"damaged"* and offered no way to
  open it. The app is now ad-hoc signed: macOS still asks once (it isn't
  signed by an Apple developer ID), then **Privacy & Security → Open Anyway**
  lets it run. Install notes in the README are updated for macOS 15+.
- The source repository no longer carries macOS `._*` metadata files (they
  were never packaged into the app).
- Selecting a device in the list no longer zooms out (an AP's coverage radius
  was fitted, often larger than the room); it keeps the zoom and only pans.
- Escape closes an open menu before it deselects, and a right-click closes an
  open menu, so a dropdown and the context menu are never open together.
- The plan re-fits when the window or map area resizes (or keeps its centre if
  you had zoomed in), and is no longer drawn under the floating tool palette.
- Packet-simulation buttons wrap instead of being cut off at the panel edge.
- Toolbars stay on one row from 1024 px up: the top-bar counts hide below
  1560 px and secondary buttons go icon-only (names kept for screen readers,
  tooltips on all).
- The heatmap has smooth edges instead of an 8 px staircase.
- Keyboard help: Shift+click adds to / removes from the selection (it never
  duplicated); Ctrl+D and Ctrl+L are listed.
- An empty map no longer shows a broken-image icon.
- Policies: the form starts with two different groups, the port field looks
  disabled for "any traffic", and Re-check is disabled until a policy exists.
- Settings: the opacity value sits beside its slider; languages show by name.

## [3.8.1] — 2026-11-20

### Fixed
- macOS and Linux installers for 3.8.0 were not built: the universal macOS
  build rejected an unused native canvas module (now left out of the app), and
  a slow CI runner timed out a long test. No app changes since 3.8.0.

## [3.8.0] — 2026-11-20

Circuits, a full security/robustness audit, and app.js split into tested
modules — with the bugs that surfaced along the way.

### Added
- **Circuits**: record the path each connection takes — end device, switch
  port, uplinks, plus patch panels, wall outlets, converters and cable labels
  the plan doesn't draw — with technician and date. The path auto-fills from
  the plan; search finds a circuit by anything on it (accent-insensitive), a
  device hop jumps to it on the map, and a circuit that no longer matches the
  plan is flagged.
- **Desktop project files**: File menu with New / New from Template / Open /
  Open Recent / Save / Save As; the title shows the file and unsaved state.
- **Plan → device dry run**: "Dry-run with rosconf" hands the generated RouterOS
  script to `rosconf` without `--apply`. The last drift-check outcome is kept
  per device.
- **Client report** (English / Greek): coverage, equipment, cabling, storage
  and sign-off — no addresses, VLANs, notes or credentials.
- **Site templates**: villa, hotel, restaurant — VLAN plan, policies, naming.
- **Routers with built-in WiFi** get coverage, heatmap and a share of the
  coverage percentage (UniFi UDM / Dream Router / Dream Router 7, MikroTik hAP
  family, RB4011 WiFi, L009 2HaxD), with a per-device radio switch.
- **Multi-floor heatmap**: every other floor reaches through the slabs between,
  with one slab loss per level and the 3-D path length.

### Security
- Share links carry the design only: no credentials (at any depth), UniFi
  controller URL/user/site, MACs, serials, asset tags or firmware.
- Opening a project that loads images from other servers asks first; Cancel
  opens it without them. Plain-http images are no longer allowed (CSP).
- Without a passphrase, device passwords are kept out of the autosave, Save
  asks once per session before writing them in plaintext, and the desktop app
  writes project files owner-only (0600).
- Desktop: only the main window's top frame can use native features; report
  and print popups get no bridge and open sandboxed. A plain-http UniFi
  controller needs an explicit yes before the password is sent.
- Electron 42.11.18, electron-builder 26, electron-updater 6.8.11, vite 8,
  vitest 5 (npm audit 34 → 6 moderate, build tooling only).
- Release: tests and type-check gate every tag, actions pinned by commit,
  downloaded fonts pinned by SHA-256.

### Changed
- Building and testing need Node 22.22+ (the desktop app ships its own runtime).
- strictNullChecks for `files/src`, enforced by `npm run typecheck`.
- **New look**: system font, neutral greys with a green accent, a two-row
  translucent toolbar, floating drawing tools and floor tabs over the map, one
  line-icon set, and a sectioned settings dialog. Dark theme reworked.
- The toolbar always says Plexus; the Company setting brands reports only.

### Fixed
- Cameras had no marker, outline or name on the map and could not be clicked
  or dragged there since 2.0.0 (thanks @saschbe, #1); a click on a camera in an
  add mode no longer places a device.
- Saving Project Settings re-applied the architect scale preset, resetting a
  floor's ruler-calibrated scale.
- Cable lengths, coverage % and airtime for floors other than the one on
  screen used the on-screen plan's pixel size.
- Auto-power dropped APs with no neighbour to overlap to 5 dBm.
- Live survey recorded macOS's "0 dBm" non-reading as a sample.
- Roaming overlap and survey predictions ignored routers with built-in WiFi.
- Auto-place: the result was hidden behind the switch-capacity warning, and
  its coverage % disagreed with the readout.
- Validate missed duplicate IPs on other floors and double-escaped names; a
  subnet with one free address read "full" (the gateway was counted as used).
- Revision diff paired floors by position and missed Tx-power/width changes;
  "Diff last two" stacked results; deleting a revision now asks first.
- BoM and PoE checks used different wattage for unknown AP models; an AP with
  0 expected clients counted as 25.
- Inventory progress didn't follow inline status changes.
- UniFi controller data is treated as untrusted (text only, length-capped).
- Opening the app and not answering "Restore previous session?" (or quitting)
  lost that session: the autosave wrote the empty startup plan over it.
- A session with only cameras, walls or labels was not offered for restore.
- A dialog opened over a pending question dropped the question's answer
  handlers; it now comes back when the newer dialog closes.
- Templates, labs and share links now apply the project's language (all
  loaders share one code path).
- SSH: IPv6 hosts and Windows key paths (C:\...) are accepted.
- An AP without a position or radius produced NaN signal instead of no
  coverage; the device-config dialog threw if its switch was deleted.
- Scale could not go below 1 m / 100 px, so calibrating a high-resolution plan
  read back wrong; device ranges now keep their metres when the scale changes.
- The ruler label is a constant, readable size on screen at any zoom.
- Encrypted credentials were lost when a vault was left locked and the project
  saved; the autosave dropped credentials whenever a passphrase was set.
- Undo history and the credentials passphrase leaked into the next project;
  images were deleted while undo entries or revisions still referenced them.
- Text labels and new revisions could not be created in the desktop app.
- Wide dialogs (device config, policies) were clipped at their edges.

## [3.6.0] — 2026-07-05

The "pro RF" release: interference-aware modelling, a worker-driven heatmap,
CV wall detection, DORI camera planning, Ekahau/DXF interop, and live
controller + survey integration in the desktop app.

### Added
- **SINR heatmap mode**: per-pixel signal-to-interference-plus-noise — every
  co-channel AP whose spectrum overlaps the serving AP now counts as
  interference, so "coverage is green but the RF is contested" finally shows
  up on the map.
- **Channel width per AP** (20/40/80/160/320 MHz): widens the noise floor
  (+3 dB per doubling), scales throughput by real OFDMA tone ratios, drives
  spectrum-true channel-overlap warnings, and makes ⌁ Auto-channel
  width-aware (a 40 MHz pair on 36/40 now counts as the conflict it is).
- **Airtime estimates**: per-AP expected clients × per-client Mbps (Settings →
  Cabling & capacity) vs the cell's *average* deliverable throughput; the AP
  panel shows live utilization and ✓ Validate flags cells near or past
  saturation.
- **Worker-based heatmap engine**: the per-pixel heatmap now computes in a Web
  Worker (inline-bundled, still works from `file://`), with stale-job dropping
  and a synchronous fallback — dragging an AP no longer janks the UI.
- **▦ Detect walls**: classical-CV wall detection from the floor-plan bitmap
  (Otsu binarization + Hough transform, zero dependencies) with a dashed-blue
  preview and accept/discard confirm.
- **DORI bands** (IEC 62676-4): camera cones now show Identify / Recognize /
  Observe / Detect pixel-density zones from the model's resolution + FoV and
  the floor scale; per-tier distances listed in the camera panel.
- **Camera storage calculator**: per-camera bitrate (auto from resolution ×
  codec, or manual override), project-wide retention + H.264/H.265 setting;
  NVR sizing appears in the camera panel, ✓ Validate and the BoM CSV.
- **DXF wall import** (↺ DXF): LINE / LWPOLYLINE / legacy POLYLINE entities
  become walls, Y-axis flipped and extents fitted to the plan — or onto a
  generated blank canvas when no plan is loaded yet.
- **Ekahau interop**: import `.esx` projects (⇊ ESX — floors with plan images
  and scale, walls with material mapping, AP positions/names/channels/tx) and
  export a best-effort `.esx` (⇈ ESX). Powered by a new dependency-free zip
  *reader* (STORE + DEFLATE via `DecompressionStream`).
- **UniFi controller sync** (desktop app, ⇅ UniFi): pull the device list from
  a UniFi OS console or legacy controller (self-signed certs OK) to fill in
  as-built IP / firmware / serial and flip connected devices to Live; push
  the planned channel / width / Tx-power to matching APs after a confirm.
- **Live survey mode** (desktop app, 📶): click where you're standing and the
  app samples the machine's current WiFi RSSI (macOS `system_profiler`,
  Windows `netsh`, Linux `iw`) into a survey point — predicted-vs-measured
  with no CSV round-trip.
- Project schema v10 (`chanWidth` on APs, `bitrateMbps` on cameras, airtime /
  DORI / storage / UniFi settings); older files migrate automatically.

### Changed
- Throughput heatmap and SNR/MCS modes respect each AP's channel width.
- Channel-overlap pills (⚡) use occupied-spectrum overlap instead of the
  channel-number heuristic.

## [3.5.0] — 2026-06-20

Organization tools — Plexus as the system of record for the install, not just
the coverage picture.

### Added
- **Inventory & rollout view** (▤ Inventory): a flat, searchable table of every
  AP/camera/switch across floors with serial, asset tag, firmware and IP, plus
  per-device **install status** (planned → ordered → installed → tested → live)
  editable inline. Status shows as a colored dot in the sidebar list, and a
  sidebar filter dims non-matching devices on the map.
- **IPAM upgrades**: Validate now flags IPs outside their VLAN's subnet and
  warns when a subnet pool is ≥90 % full; "IP+ all" bulk-fills every empty IP
  from its VLAN subnet; new **IP plan CSV** export.
- **Port map CSV**: one row per switch port — free ports included — with the
  connected device, IP, VLAN and PoE draw.
- **Naming convention**: set a pattern like `{site}-F{floor}-{type}{nn}` in
  Settings → Organization; Validate flags violations and one click renames
  the whole building to match.
- **Design baseline & as-built diff**: mark any revision as the ★ baseline and
  diff it (or any revision) against the *current* state — now including field
  changes (status, IP, VLAN, port, model, serial, channel, Tx) rather than
  only adds/removes/moves.
- **Handover pack** (⇩ Handover): one zip with an HTML summary plus the
  inventory, IP plan, port map, BoM and cable-schedule CSVs — built by a
  dependency-free STORE zip writer.
- Install sheets now carry serial, asset tag and install status.
- Project schema v9 (status/serial/assetTag/firmware/mac on devices, baseline
  flag on revisions, siteCode/namePattern settings); older files migrate
  automatically and the sample project demos the new fields.

### Changed
- Demo GIF re-captured at 2× pixel density — sharper and 60 % smaller.

### Fixed
- Windows taskbar showed the generic Electron logo instead of the Plexus icon:
  the app now sets its AppUserModelID (matching the installed shortcut) and an
  explicit window icon, so Windows ties the running window to the shortcut.

## [3.4.0] — 2026-06-10

Live demo, real physics, security hardening.

### Added
- **Live demo on GitHub Pages** — the production build now deploys to
  <https://sp1r4.github.io/plexus-network-planner/> on every push to `main`
  (`.github/workflows/pages.yml`).
- **Load sample project** button on the empty state: a bundled 48×32 m office
  (floor-plan SVG, walls, 3 APs, 2 cameras, PoE switch, dead zone) generated
  from one data source in `files/src/sampleProject.js`, so the picture and the
  RF model can't drift apart.
- **Physical path-loss model.** When a floor has a real-world scale, heatmap /
  SNR / throughput values use real FSPL at the band's carrier frequency plus a
  per-model exponent (log-distance n=2.2, ITU-R P.1238 n=3.0, COST-231
  multi-wall n=2.0) and explicit per-wall losses, seeded from the AP's EIRP.
  Unscaled projects keep the previous per-radius heuristic, so old files
  render unchanged.
- **Scenario E2E test** covering the full editing loop: load sample → place
  AP → draw wall → coverage re-clips → export → re-import.
- **README media pipeline** — `scripts/capture-media.mjs` regenerates the
  demo GIF and gallery screenshots from the sample project via Playwright.
- **Accuracy methodology** (`docs/accuracy.md`): how to validate predictions
  against a real survey with the built-in CSV import, plus the model's known
  error sources.

### Changed
- PBKDF2 iterations for credential encryption raised 150k → 600k (OWASP
  2023+ floor). Old blobs still decrypt — the iteration count is stored per
  blob.
- Electron 31 → 42 for current Chromium security patches.
- Release and Pages builds now run `bundle:fonts` first, so shipped apps no
  longer fall back to system fonts (font binaries are gitignored).
- `pdfjs-dist` moved from devDependencies to dependencies (it ships in the
  bundle), excluded from electron-builder's node_modules packaging since Vite
  inlines it.

## [3.3.1] — 2026-06-05

### Fixed
- **Windows app icon.** The `.ico` only contained a 256² image, so Windows fell
  back to the default Electron icon in the taskbar/title bar. It now packs the
  standard sizes (256/128/64/48/32/24/16) for a crisp icon everywhere.

## [3.3.0] — 2026-06-05

Rebrand release.

### Changed
- **Renamed to Plexus** (Network Site Planner) — the tool now spans WiFi, IP
  cameras, switches/PoE, topology and cabling, so the name reflects the full
  scope. New app name, window title, report/export branding, and a new
  node-mesh app icon. Internal storage keys are unchanged, so existing
  autosaves and saved projects open exactly as before.
- Repository renamed to `plexus-network-planner`; auto-update and download
  links point at the new home.

## [3.2.0] — 2026-06-05

Quality-of-life and distribution release.

### Added
- **PDF floor-plan import.** Upload a `.pdf` and its first page is rendered to
  a crisp image — no more exporting plans to PNG first. (Worker bundled inline
  so the portable build still runs fully offline.)
- **Scale by known dimension.** "⇲ Calibrate": draw a line over a known length
  on the plan, type its real-world distance, and the m/100px scale is derived.
- **Credential encryption.** An optional project passphrase (Settings →
  Security) AES-256-GCM-encrypts device credentials in saved project files and
  keeps them out of autosave and Share links; loading prompts to unlock.

### Changed
- **macOS app is now a universal binary** (Intel + Apple Silicon).
- **Auto-update** (Windows/Linux) via GitHub Releases; the release also ships
  the portable browser zip and update metadata.
- **Hardened desktop build**: navigation guard, Content-Security-Policy, and the
  (file://-only) Share button hidden in the app.

### Internal
- Pure network logic extracted to `files/src/network.js` with unit tests; added
  `npm run verify` and a pre-push hook mirroring CI.

## [3.1.0] — 2026-06-05

The "network + desktop" release. Switches/routers become first-class
(port mapping, PoE realism, topology, auto-cabling, validation), devices
gain management credentials, and Plexus ships as native desktop apps for
macOS, Windows and Linux alongside the portable browser build.

### Added
- **Switch/router planning.** Per-switch port counts with a switch-side
  port map and numbered port pickers on devices (kept in sync), PoE
  budget + PoE-class (af/at/bt) awareness with headroom, and a filled-out
  switch PoE/port catalog.
- **Topology & cabling.** Inter-floor riser uplinks, a building-wide
  uplink-tree + rack/port-usage view (also in the PDF/HTML report),
  auto-assign devices to the nearest switch, a Manhattan cable-routing
  factor, and total cable length + box count in the BoM.
- **VLAN planning.** A VLAN registry (id/name/colour/subnet) with map
  legend, colour-by-VLAN, per-VLAN suggest-IP, and a VLAN plan table in
  the report.
- **Network validation panel.** One pass flagging over-budget/over-port
  switches, PoE-class mismatches, runs > 90/100 m, duplicate IPs/ports,
  unknown VLANs and client-capacity shortfalls.
- **Device credentials.** Per-device management login (protocol / host /
  port / user / password) — stored locally, stripped from Share links and
  omitted from reports.
- **Desktop apps.** Electron-wrapped native installers (macOS dmg/zip,
  Windows NSIS exe, Linux AppImage/deb) built by a GitHub Actions matrix
  on each version tag, with a Plexus-branded app icon.

### Fixed
- Custom vendor catalog now supports switch ports/PoE/class, dedups
  re-applies, and actually persists across reloads.
- Tall dialogs (Settings, vendor catalog) scroll within the viewport
  instead of pushing their buttons off-screen.
- Auto-assign is now undoable; suggest-IP can't hang on huge subnets.

## [3.0.0] — 2026-05-20

The "professional tool" release. Plexus gains a physically grounded RF
engine (SNR / throughput / capacity, selectable propagation models,
regulatory regions, antenna fidelity, floor-to-floor leakage), survey
import for predicted-vs-measured validation, design-review workflow
(revisions, diff, per-device comments, annotations), professional
deliverables (BoM / cable-schedule CSV, per-AP install sheets, branded
exports), and an engineering baseline (JSDoc type-checking, Playwright
E2E, i18n, a plugin API). Still a zero-dependency static browser app.

### Added
- **RF realism.** Per-pixel SNR, MCS index, and estimated throughput
  in addition to RSSI. Heatmap can render any of the four metrics, and
  a capacity-per-AP client estimate informs planning.
- **Selectable propagation models.** Log-distance, ITU-R P.1238 indoor,
  and COST-231 multi-wall — pick the model that matches the building.
- **Regulatory regions.** FCC (US), ETSI (EU), Japan, Australia/NZ,
  India, and Brazil presets constrain channels, EIRP, and DFS.
- **Antenna fidelity.** Per-AP antenna gain, cable loss, mount height,
  and downtilt feed an effective-EIRP calculation.
- **Floor-to-floor RF leakage.** Optional layer shows neighbouring
  floors' signal bleeding through the slab (configurable attenuation).
- **Per-band heatmap + roaming overlap.** Filter the heatmap by band
  (2.4 / 5 / 6 GHz) and highlight where ≥2 APs deliver ≥ -67 dBm so
  clients can roam.
- **Auto channel + Tx-power planning.** Graph-colouring channel
  assignment and greedy per-AP power tuning, region-aware.
- **Survey CSV import.** Import measured RSSI samples; dots are colour-
  coded and flagged red where measured deviates materially from
  predicted.
- **AP-on-stick live mode.** Drag a candidate AP and read live
  coverage / overlap feedback before committing.
- **Annotation layer.** Text labels, arrows, and dimension lines with
  live metre readouts.
- **Revisions + diff.** Snapshot the project and compare any two
  revisions to see what changed.
- **Per-device comments.** Every AP, camera, switch, dead zone, and
  wall carries a free-text note that flows into exports.
- **BoM + cable-schedule CSV export.** One-click bill of materials and
  cable schedule for procurement and installers.
- **Per-AP install sheets.** A printable per-AP sheet (location,
  radio config, switch port, comment) for the field team.
- **Customer branding.** Project logo, company / tagline / footer line,
  and architect's-scale presets carried into HTML and PDF exports.
- **i18n framework.** All UI strings routed through a no-dependency
  `t()` helper with an English bundle; new languages drop in as bundles.
- **Plugin API for vendor catalogs.** Paste a custom AP / switch /
  camera catalog to extend the model lists without a code change.
- **Playwright E2E.** A smoke suite boots the app and exercises mode
  switching, the settings modal, heatmap pills, and the help dialog.

### Changed
- Project schema bumped to **v8**. The migrator seeds antenna /
  radio / comment fields on devices and adds `ANNOS`, `SAMPLES`, and
  project-level `revisions`. Old projects (v1–v7) open cleanly.
- **Type-checked.** Pure modules in `files/src/` are checked with
  `tsc --checkJs` via JSDoc annotations (no `.ts` rename); `npm run
  typecheck` runs in CI.
- CI matrix expanded: unit tests on Node 18/20/22, plus dedicated
  type-check, Playwright E2E, and production-build jobs.
- Accessibility: modals are `role="dialog"` with focus capture /
  restore and a Tab trap; live regions announce hints and toasts.

[Unreleased]: https://github.com/SP1R4/plexus-network-planner/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/SP1R4/plexus-network-planner/releases/tag/v3.0.0

## [2.0.0] — 2026-05-19

A meaty release that pushes Plexus from "WiFi coverage planner" into
"network/security planner". Highlights: real signal-strength heatmap, IP
cameras as a first-class item type, directional AP antennas, PoE budget +
cable runs, wall vertex editing, multi-select, SVG wall import, shareable
URLs, and a per-floor PDF report.

### Added
- **IP cameras as a first-class item type.** Place cameras alongside APs
  and switches; render their field-of-view cone (configurable FoV /
  heading / range). Catalog covers UniFi Protect (G3 / G4 / G5 / AI),
  Hikvision, Dahua, Reolink, and Axis with sensible defaults per model.
  New `C` shortcut and toolbar button.
- **Real signal-strength heatmap.** Canvas-based per-pixel dBm rendering
  with banded colours (excellent → unusable). Respects walls, bands,
  and directional antennas.
- **AP antenna patterns.** Omni, ceiling-down, wall-mount, sector 90 /
  60 / 30°. Coverage polygon is masked by the selected pattern around
  the AP's heading. New heading slider in the AP panel.
- **Wall vertex editing.** Drag the endpoints of a selected wall to
  reshape it after placement.
- **Multi-select.** Shift+click to add to selection or marquee-drag in
  select mode. Multi-delete via the Delete key.
- **SVG wall import.** Drop an SVG floor plan and the line / polyline /
  polygon / path elements become walls automatically.
- **Shareable URL.** A 🔗 Share button copies a gzip+base64-encoded link
  that re-opens the project on any browser. Floor-plan images are
  stripped (they'd blow past URL length limits).
- **Auto-AP placement.** ✦ Auto-place button greedily drops APs until
  ~92% coverage or 12 APs, whichever comes first. Uses the last-used
  model and respects existing APs / walls / patterns.
- **PoE budget + cable runs.** Each AP / camera can be linked to a
  switch. Toggle the **Cables** view to draw the runs with length
  labels (red when >100 m). The ⚡ PoE button opens a per-switch budget
  summary that flags over-budget switches.
- **Per-floor PDF report.** Cover page with whole-building stats, then
  one section per floor with its own map, coverage %, and AP / camera
  / switch / dead-zone tables.

### Changed
- Project schema bumped to **v7**. Migrator fills `pattern: 'omni'`,
  `heading: 0`, `swId: ''` for existing APs, adds an empty `CAMS` array
  per floor, and sets `poeBudget: 0` per switch. Old projects open
  cleanly.
- `index.html` script tag is now a module; production build still runs
  from `file://` thanks to `vite.config.js` (`base: './'`).
- Bundle size: 121 KB / 36 KB gzipped (was 84 / 26 KB) — +20 KB for
  everything above. Still zero runtime dependencies.

[2.0.0]: https://github.com/SP1R4/plexus-network-planner/releases/tag/v2.0.0

## [1.0.0] — 2026-05-18

First public release.

### Added
- **Band-aware coverage** — wall-loss is multiplied by a per-band factor:
  0.6 for 2.4 GHz, 1.0 for 5 GHz, 1.3 for 6 GHz (WiFi 6E). Coverage
  polygons now reflect that 2.4 GHz penetrates walls noticeably better
  than 5 GHz.
- **Channel overlap indicator** — APs sharing a channel (or sitting on
  adjacent 2.4 GHz channels within 4 of each other) and whose coverage
  areas intersect get a dashed orange link with a ⚡ Ch X pill.
- **Per-floor scale** — each floor stores its own metres-per-100-px,
  letting multi-floor projects mix plans rendered at different
  resolutions.
- **Fractional wall coordinates** — walls store `fx1/fy1/fx2/fy2` in
  `[0,1]` so they survive map-image swaps. Legacy pixel walls still
  load via a transparent fallback.
- **Coverage opacity slider** — Settings → Coverage opacity (20–100%)
  fades the coverage fill for dense maps where the floor plan
  underneath was getting obscured.
- **Last-used AP model memory** — placing a new AP defaults to whichever
  model you last picked instead of always U6 Pro.
- **CI** — GitHub Actions workflow runs the full test suite on every push
  and pull request.
- **Install scripts** — one-line bootstrap for macOS, Ubuntu/Debian, and
  Windows.

### Changed
- `app.js` slimmed from 2707 → ~2400 lines. AP/SW catalogs moved to
  `files/src/constants.js`; IndexedDB image store moved to
  `files/src/imageStore.js`.
- Geometry and migration helpers are now the single source of truth in
  `files/src/`; `app.js` imports them instead of carrying a parallel copy.
- Project schema bumped to **v6**. Migrator upgrades anything v1–v5
  automatically; the legacy project-level `scaleM` is propagated into
  every floor and then dropped from the root.

### Fixed
- Walls placed before a floor-plan swap no longer end up off-canvas after
  the swap — they're now anchored to the image, not the pixel grid.

[1.0.0]: https://github.com/SP1R4/plexus-network-planner/releases/tag/v1.0.0
