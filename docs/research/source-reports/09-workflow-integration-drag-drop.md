# Bidirectional Drag Workflow — Resolve Workflow Integration Capability Audit
Date: 2026-08-25 | Resolve: 21.0.3 (CFBundleShortVersionString 21.0.30007, LSMinimumSystemVersion 15.0) | Electron 36.3.2 / Node 22.15.1 (per ADR-0003) | Access: 2026-08-25

## Verdict

**Inbound Finder→panel drag is NOT implemented in ClipDock; outbound panel→Resolve drag IS implemented via `webContents.startDrag`; API-button fallback IS implemented. All three seams are technically possible under current sandbox but require distinct validation and have different documentation grades.**

- Seam A (FINDER→PANEL) — HTML5 `drop`+`File.path` is *empirically possible* inside the sandboxed renderer, but blocked by design: no drop handlers exist today, and renderer-supplied paths must be re-validated in main. Documented Electron behavior covers `File.path`; Blackmagic docs do not document inbound drag into a Workflow Integration — only `dialog.showOpenDialog` is in sample code.
- Seam B (PANEL analysis→SDR output) — filesystem/ffmpeg work is isolate-safe in main; no UI drag involvement.
- Seam C (PANEL→RESOLVE Media Pool/timeline) — `webContents.startDrag` outbound is *implemented, tested, and documented by Electron*; Resolve's acceptance as an OS file drop is *empirical* (not in Blackmagic scripting docs) but exercised by ClipDock queue/history rows. macOS icon requirement is documented and satisfied.
- Seam D (API fallback) — `AddItemListToMediaPool` / `AppendToTimeline` fully documented in scripting API and implemented with bin/duplicate/placement logic.

## Capability Matrix

| Seam | Question | Status | Grade | Strongest Local Evidence |
|---|---|---|---|---|
| **A1 Inbound drop plumbing** | Can renderer receive OS file via HTML5 drag? | Possible | **Empirical / Electron-documented** | No handler exists: `grep -rn drop` in `src/` finds zero `drop`/`dragover` listeners (`src/renderer.ts` only has outbound `dragstart` at 1682). `src/main.ts:290-311` comment: selection happens ONLY in main via `dialog.showOpenDialog`. Electron sandbox still exposes `File.path` on `DataTransfer.files[i].path` (Electron ext to Chromium) even with `sandbox:true` — but ClipDock never reads it. |
| **A2 Path access under isolation** | Does renderer learn absolute path? | Yes, via `file.path` (Electron) but **untrusted** | **Documented by Electron, untrusted per ClipDock model** | `src/main.ts:624-633` `webPreferences: {contextIsolation:true, sandbox:true, nodeIntegration:false}`; `src/preload.ts` only whitelists `electron/renderer` + `contextBridge`. README.txt:19-23: v19.0.2 enforces sandbox+contextIsolation; CompatibleSamplePlugin uses `nodeIntegration:true/contextIsolation:false` as NOT-RECOMMENDED workaround. Main re-validates every path. |
| **A3 Main validation** | Can main safely ingest Finder path? | Proven | **Documented+tested** | `src/path-boundary.ts:8-68` `canonicalRoot/contains/regularFile/isSafeMediaFile` — lstat symlink reject, `realpathSync` canonicalize, single `statSync` on canonical, `relative+isAbsolute` containment. `src/main-process.ts:33-61` `resolveMainProcessCard` → `isSafeMediaFile(card.path, card.trustedRoot)`. `src/main.ts:381-420` `capturedManagedRoot` + `isSafeMediaFile`. Tests: `test/path-boundary.test.mjs`, `test/main-process.test.mjs:329-428`, `test/bugfix-10-isSafeMediaFile.test.mjs`. External dialog files validated as `isSafeMediaFile(path)` (no root) — inside accepted, symlink/missing/dir rejected. |
| **A4 TrustedRoot handling** | iPhone MOV `/Users/.../DCIM` vs managed root? | External files = no containment; managed = `trustedRoot` | **Implemented** | `src/main.ts:88-110` `managedRoot` vs external; `completionDeps.isSafeMediaFile = (fp)=>isSafeMediaFile(fp, managedRoot)` for downloads; `selectFile` path has no `trustedRoot`. Inbound HDR would follow external path (no root) but still needs symlink/regular-file checks. |
| **B Conversion** | HDR→SDR ffmpeg in main | Ready | **Implemented** | `src/media-prep.ts:101-130` `decision`/`ffmpegArgs` (remux/audio-remux/transcode, prores_ks/edit-ready), `discoverFfprobe`/`discoverFfmpeg`. No drag dependency. |
| **C1 Outbound native drag** | `webContents.startDrag` from panel | Live | **Documented by Electron + proven in ClipDock** | `src/main.ts:191-193` `nativeImage.createFromDataURL` 32×32 PNG; `src/main.ts:288-311` synchronous `ipcMain.on('clipdock:native-drag-start')` → `event.sender.startDrag({file/files, icon:DRAG_ICON})`. `src/main-process.ts:184-200` resolves opaque cardIds → paths, dedupes, validates per-card `trustedRoot`, then `startDrag(paths.length===1?paths[0]:paths)`. `src/electron.d.ts:45-46` d.ts. `src/preload.ts:23-28` fire-and-forget `ipcRenderer.send`. `src/renderer.ts:1682-1701` `startCardDrag` → `window.clipdockAPI.startNativeDrag`. Tests: `test/main-process.test.mjs:92-115` + `test/renderer-followups.test.mjs:120-367`. |
| **C2 macOS icon** | Non-empty NativeImage required | Satisfied | **Documented Electron, OS-specific** | `src/main.ts:191` comment `macOS startDrag REQUIRES a non-empty icon`; creates from base64 PNG — never empty. Electron docs: icon empty → drag silently fails on macOS. Windows/Linux ignore icon shape but still require value. |
| **C3 Drag payload** | Single vs multi file | Both | **Implemented** | Single: `{file, icon}`; multi: `{files, icon}` (`src/main.ts:310-311`). Renderer queue uses array overload for multi-select (`dist/renderer.js:3065-3101` checks `Array.isArray(cardIds)`; CEP branch caps at 1). History/subtitle stay single. |
| **C4 Drop targets** | Media Pool vs Timeline | **Both empirical — not in SDK docs** | **Empirical** | `src/main.ts:307` comment `drop the real file(s) onto the Resolve Media Pool or timeline`; `src/renderer.ts:1755` aria hints `Drag to Resolve`. No Blackmagic doc lists drag targets; scripting docs only cover API import. Empirical Resolve behavior: Media Pool accepts OS file drops in any page when project open; Timeline accepts when Edit/Cut page active and timeline exists — but this is OS DnD handling by Resolve/Qt, not a Workflow Integration API. Must be live-tested. |
| **C5 Renderer isolation for drag** | Paths never cross to renderer | Enforced | **Implemented** | `src/main.ts:82-85` cards `Map<string,{path,trustedRoot}>`; renderer only sees `cardId`+`fileName` (`src/shared.ts:SelectFileResult`, `DownloadArtifact`). `src/renderer.ts:3099-3100` `event.preventDefault(); window.clipdockAPI.startNativeDrag(cardIds)` — no path in DataTransfer except CEP fallback `com.adobe.cep.dnd.file.0` (`src/renderer.ts:3089`). |
| **D Fallback API** | `AddItemListToMediaPool` / `AppendToTimeline` | Complete | **Official SDK, fully implemented** | `src/transfer.ts:59-89` imports via `GetMediaStorage().AddItemListToMediaPool([path])`; `src/transfer.ts:460-510` `AppendToTimeline` with bin context (`active` vs `ClipDock` via `GetRootFolder/GetSubFolderList/AddSubFolder/SetCurrentFolder`), duplicate scan by normalized `File Path` (`findExistingClip`/`findSubFolder`), restore previous bin. Playhead: `resolve.OpenPage('edit')`, `GetStartFrame/GetStartTimecode/GetCurrentTimecode/GetSetting('timelineFrameRate')`, `timecodeToFrames` (`src/transfer.ts:95-109`) → `{mediaPoolItem:startFrame/endFrame/recordFrame}`. Results typed `TransferResult` (`src/transfer.ts:14-22`). Sample confirms `AddItemListToMediaPool`: `Developer/Workflow Integrations/Examples/SamplePlugin/main.js:150-160`. |
| **E OS/platform/version** | Supported hosts | Constrained | **Official** | README.txt:52-53 `Plugins: Windows, Mac OS X (not supported on Linux)`; ADR-0003 `macOS first, Windows second (Resolve 21 on both)`; `/Applications/DaVinci Resolve.app/Contents/Info.plist` LSMinimumSystemVersion 15.0; Workflow Integration Plugins root `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins` (macOS) vs `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins` (Windows). Requires Studio (free has no Workflow Integrations menu). Workspace→Workflow Integrations menu registers via `manifest.xml` (`dist/manifest.xml:3-7` Id `com.clipdock.app`). |

## What Is Documented vs Empirically Possible

- **Documented (primary/official):**
  - Electron sandbox/contextIsolation enforcement from 19.0.2 (README.txt NOTE, points to https://www.electronjs.org/docs/latest/tutorial/sandbox etc.)
  - `WebContents.startDrag({file/files, icon})` — Electron API doc; macOS icon non-empty required (Electron `startDrag` docs). ClipDock d.ts at `src/electron.d.ts:45-46`.
  - Workflow Integration plugin lifecycle: manifest.xml, `WorkflowIntegration.node` Initialize/GetResolve/CleanUp/RegisterCallback (README.txt: WorkflowIntegration module API), js API `GetMediaStorage/AddItemListToMediaPool`, `Project.GetMediaPool/MediaPool.AppendToTimeline`, `GetCurrentFolder/SetCurrentFolder/AddSubFolder` (Documented in Scripting README + `Examples/SamplePlugin/main.js`).
  - macOS/Linux plugin support boundary (README.txt unsupported on Linux).

- **Empirically possible (not in Blackmagic docs, proven by ClipDock + community):**
  - HTML5 `drop` → `File.path` in sandboxed renderer works (Electron adds `path` property; Chromium alone would not). ClipDock's choice to NOT use it is policy, not technical block. Needs main IPC + revalidation.
  - Resolve Media Pool/timeline as OS file drop targets from `startDrag`. No mention in Workflow Integrations README; relies on Resolve's Qt/OS drag handling. ClipDock `queue` rows (`src/renderer.ts:1767`) and `history` rows (`src/renderer.ts:2230`) do exactly this. Media Pool universally accepts; timeline acceptance varies by page/focus — community reports require Edit page + existing timeline.
  - Windows `%PROGRAMDATA%` vs macOS `/Library/...` path difference (documented short phrase in README.txt but details only in filesystem).

- **Inferred / unproven until live:**
  - Finder HDR video drag preserves path with spaces/unicode correctly through `file.path` + IPC + `realpathSync`. Need LS quarantine/xattr not interfering.
  - Large iPhone .MOV (HEVC HDR 4K 60) not blocked by sandbox `dataTransfer` size — file drag is by-path, not by bytes, so should be fine, but unverified for >4GB.
  - Timeline drop inserts at playhead vs binest — OS drop position mapping is Resolve-internal, not controllable via `startDrag`. API `AppendToTimeline` with `recordFrame` is the only precise placement.

## Renderer Isolation & Security Note

Preserve `sandbox:true, contextIsolation:true, nodeIntegration:false` (`src/main.ts:629-633`). Inbound HDR drop must not `require('fs')` in renderer nor expose raw path to other cards. Pattern: renderer `dragenter/dragover` → `preventDefault`, `drop` → `event.dataTransfer.files[0]?.path` (Electron only), immediately `ipcRenderer.invoke('clipdock:ingest-drop', path)` or `send` — main does `isSafeMediaFile` + `regularFile` + `contains` checks and replies with `cardId|null`. No path returned to renderer. Same as existing `selectFile` flow but triggered by drop instead of dialog.

## Smallest Live Experiments to Close Gaps

Run on **macOS 15 × Resolve 21.0.3 Studio** first, then **Windows 11 × Resolve 21 Studio** (second priority). Each experiment <2 min, reversible, no repo edits.

| # | Title | Steps | Pass | Closes |
|---|---|---|---|---|
| **E1** | Inbound drop plumbing probe | Add temporary drop zone div in dev copy (or inject via DevTools): `el.addEventListener('dragover',e=>e.preventDefault()); el.addEventListener('drop',e=>{e.preventDefault(); console.log([...e.dataTransfer.files].map(f=>({name:f.name,path:f.path})))});` Drag iPhone HDR .MOV from Finder onto panel. Log `file.path`, then IPC it and call `isSafeMediaFile` in main console. | `file.path` present as absolute `/Users/.../*.MOV`; main validates `true` for regular file, `false` for symlink/dir. Link .MOV via symlink correctly rejected. | Confirms A1/A2 without shipping code. |
| **E2** | Outbound to Media Pool (primary) | Queue a completed card (or history card), drag its row to Resolve Media Pool (Media page, project open, active bin). | Clip appears in bin (active or ClipDock per `targetBin` hint is irrelevant for native drag — drop goes to hovered bin). Undo via Delete. | C4 Media Pool target. |
| **E3** | Outbound to Timeline (critical) | Same drag but drop onto Edit page timeline ruler/track (timeline open, playhead visible). Vary: drop on empty track vs existing clip. | Timeline receives clip; if playhead-relative, record position matches drop X (Resolve decides). Document page requirement (Edit vs Media vs Cut). | C4 Timeline target + placement ambiguity. |
| **E4** | macOS icon regression | Temporarily pass `nativeImage.createEmpty()` as icon in dev main, drag to Resolve on macOS. | Drag fails/flies no ghost → icon requirement confirmed. Restore valid icon → succeeds. (Windows expected pass even with empty icon.) | C2 OS-specific. |
| **E5** | Resolve free vs Studio + Linux | Repeat E2 on Resolve Free (same OS) and on Linux Studio if available. | Free: Workflow Integrations menu missing → no panel → blocked as documented. Linux: plugin not loading (expected per README). | E version boundary. |
| **E6** | API fallback parity | Click `Add to Media Pool` and `Add to timeline` buttons for same card; compare with drag result (bin, duplicate handling, playhead vs end). | Buttons succeed with messages `imported/already-imported/timeline-appended/inserted` (`src/transfer.ts` messages); drag has no completion message — user must visually confirm. | D fallback distinct from C. |
| **E7** | Multi-file drag | Select 2-3 queue checkboxes, drag any selected row. | Resolve receives N files (check Media Pool count). Verify `files: string[]` overload. | C3 multi. |
| **E8** | Space/unicode path | Rename/copy HDR to `My HDR (é) 01.MOV` and drag. | Path round-trips through `realpathSync` correctly; duplicate scan (`normalizeSlash` + `clipPathsEqual`) matches regardless of NFC. | A3 robustness. |

If E1 shows `file.path === undefined` (future Electron/Chromium change), fallback is **main `webContents` drop handler** or staying with dialog-only inbound — do not relax sandbox.

## Risks / Unknowns

- No inbound drop code today — HDR workflow step (1) requires net-new UI + IPC + validation; risk of path injection if renderer path trusted.
- Timeline drop target behavior is not contractual; Blackmagic could change Qt DnD handling without notice. Prefer API `AppendToTimeline(playhead)` for precise inserts; keep drag as convenience.
- `File.path` is Electron-specific; a future Electron bump could gate it behind `webSecurity`/`allowFileAccess` or require `nativeWindowOpen` — monitor `electron.d.ts` change.
- Large HDR files >2GB may hit `MediaStorage.AddItemListToMediaPool` Resolve-side transcode delay; native drag has same decode cost but no ClipDock progress.
- Symlinked-DCIM (e.g., Photos library alias) would be rejected by `isSafeMediaFile` — intentional; user must export first.

## Start Here (next implementer)

1. Read `src/main.ts:288-311` (nativeDragStart wiring) + `src/main-process.ts:184-200` (validation) + `src/path-boundary.ts:8-68` (isSafeMediaFile).
2. Add inbound drop: new `drop` listener in renderer (session-only, not persisting path), new IPC `clipdock:ingest-drop` channel validated like `selectFile` (`src/main.ts:270-285`).
3. Keep conversion in main (`src/media-prep.ts`).
4. Run E1→E8 live; do not ship inbound drop until E1 passes on both macOS/Windows.

## Files Retrieved (code mode — bounded)

1. `src/main.ts` (1-650) — BrowserWindow sandbox, DRAG_ICON, nativeDragStart wiring, trustedRoot
2. `src/main-process.ts` (1-211) — isSafeMediaFile, resolveMainProcessCard, nativeDragStart validation
3. `src/path-boundary.ts` (1-61) — canonicalRoot/regularFile/isSafeMediaFile
4. `src/transfer.ts` (1-150, 470-510) — AddItemListToMediaPool / AppendToTimeline fallback, timecodeToFrames
5. `src/preload.ts` — contextBridge expose, fire-and-forget startNativeDrag
6. `src/electron.d.ts:45-46` — startDrag type, `WEBPreferences` sandbox flags
7. `src/renderer.ts:1682-1767,2230` — startCardDrag, outbound drag hooks
8. `docs/adr/0003-resolve-workflow-integration-electron-unchanged.md` — Electron 36.3.2/Node22, macOS-first
9. `/Library/.../Developer/Workflow Integrations/README.txt` (1-80) — sandbox enforcement, plugin roots, API list
10. `dist/manifest.xml` — Plugin Id `com.clipdock.app`
11. `Developer/Workflow Integrations/Examples/SamplePlugin/main.js:1-160` — reference `AddItemListToMediaPool` usage

## Key Symbols

- `isSafeMediaFile` in `src/path-boundary.ts` — lstat→stat→realpath gate; all file ingestion depends on it
- `resolveMainProcessCard` in `src/main-process.ts` — opaque cardId → validated path on every drag/API call
- `nativeDragStart` in `src/main-process.ts` — single-card `file` vs multi-card `files` + icon dispatch
- `DRAG_ICON` in `src/main.ts` — macOS-required NativeImage data URL
- `createTransfer` in `src/transfer.ts` — documented button fallback (MediaStorage + MediaPool)
- `startCardDrag` in `src/renderer.ts` — renderer `dragstart` → `startNativeDrag` (Resolve) vs `com.adobe.cep.dnd.file.0` (Adobe)

## Architecture

ClipDock is Resolve-embedded Electron: sandboxed renderer (`contextBridge`) ↔ preload IPC ↔ main (sole `WorkflowIntegration.node` owner). Renderer never holds paths; `cards: Map<cardId, {path,trustedRoot}>` in main is authority. Outbound drag calls `webContents.startDrag` synchronously on `dragstart`; inbound HDR drop would add `dragover/drop` → `file.path` → IPC → `isSafeMediaFile` → new card. Conversion (`ffmpeg/ffprobe`) runs in main, not in drag path. Button fallback uses official scripting API; native drag uses OS file DnD accepted by Resolve's Media Pool/timeline.

## Sources (web-equivalent, local)

1. Blackmagic Workflow Integrations README.txt — `/Library/Application Support/.../README.txt` — 2024-10-03 — why: official sandbox/contextIsolation + supported platforms
2. SamplePlugin `main.js` — same bundle — why: canonical `GetMediaStorage/AddItemListToMediaPool` reference
3. Electron `sandbox/tutorial/security/tutorial/startDrag` docs (referenced in README) — https://www.electronjs.org/docs/latest/tutorial/sandbox — why: renderer isolation model
4. Electron `WebContents.startDrag` docs — https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragoptions — why: icon requirement, file/files overload
5. ClipDock repo itself (`src/main.ts`, `src/main-process.ts`, tests) — why: concrete GitHub-style implementation proving both seams

## Conflicts / Uncertainty

- Blackmagic scripting docs do not mention OS drag targets; community/Empirical vs Official gap noted.
- Electron docs say `File.path` is available; no Blackmagic doc confirms it inside Workflow Integration — treat as empirical until E1 passes on current Resolve-bundled Electron.

## Implication for the Task

Do not claim inbound HDR drag works out-of-box. Outbound SDR→Resolve drag + API fallback are shippable; inbound needs one small renderer drop zone + main validation seam before architecture is complete. Keep `sandbox:true`.

## Risks / Unknowns

Only those listed above; no hidden blockers beyond timeline drop precision.

## Start Here

`src/main.ts:288-311` + `src/renderer.ts:1682` + `src/path-boundary.ts:8` — add inbound `drop` handler mirroring `selectFile` validation, then re-run E1.

