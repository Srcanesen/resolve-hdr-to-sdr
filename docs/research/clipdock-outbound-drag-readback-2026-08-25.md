# ClipDock Outbound Panel → Resolve Drag — Read-Only Readback (2026-08-25)

> **Read-only declaration:** ClipDock under `<external ClipDock checkout>` was inspected **read-only** on 2026-08-25. No edit, build, install, test mutation, or Resolve execution was performed. Git HEAD `b7268a165b78e89cad023d2e0daffc3260559b1f` (`refs/heads/main`), `git status --porcelain` empty before and after (verified).

> **Scope:** Proven outbound seam only — panel → Resolve Media Pool / timeline via OS native drag + API button fallback. **Does NOT prove inbound Finder → panel drag** (no `drop`/`dragover` handler exists in `src/`; outbound only uses `dragstart` — see Boundaries §7).

> **Separation:** §1–6 are *observed facts* with `path:line` anchors. §7–8 are *reuse candidates / boundaries* requiring independent validation for HdrToSdr. No architecture or code decision is made here.

---

## 1. End-to-End Seam Map

```
renderer draggable row (queue / history / subtitle)
  → renderer startCardDrag(event, cardIds)               [renderer.ts:1698]
  → preload clipdockAPI.startNativeDrag(cardIds)          [preload.ts:30 `ipcRenderer.send`]
  → main ipcMain.on('clipdock:native-drag-start') SYNC  [main.ts:306-311]
  → main-process nativeDragStart validation+resolve       [main-process.ts:184-200]
  → path-boundary isSafeMediaFile per-card + trustedRoot  [path-boundary.ts:54-68]
  → event.sender.startDrag({file|files, icon:DRAG_ICON}) [main.ts:310-311] → OS drop onto Resolve Media Pool/timeline

Fallback (button):
  renderer fallbackTransfer → preload importToMediaPool/addToTimeline (invoke)
  → main registerMainTransferInvokeHandlers               [main.ts:280-285 / main-process.ts:202-214]
  → resolveMainProcessCard + targetBin/placement validation
  → transfer importToMediaPool / addToTimeline            [transfer.ts:…]
  → Resolve scripting API (MediaStorage / MediaPool / Folder / Timeline)
```

Adobe CEP alternative path (same renderer entry) uses `dataTransfer.setData('com.adobe.cep.dnd.file.0', path)` via `getDragFilePath(cardId)` — **Resolve does not use this path** [renderer.ts:1699-1711].

---

## 2. Exact Paths, Functions, IPC Channels

| Concern | File:Line | Symbol / literal |
|---|---|---|
| Canonical IPC map | `scripts/lib/contracts.mjs:13-14` | `nativeDragStart:'clipdock:native-drag-start'`, `importToMediaPool:'clipdock:import-to-media-pool'`, `addToTimeline:'clipdock:add-to-timeline'` |
| Re-export | `src/shared.ts:11-14` | `import {IPC_CHANNELS} from '../scripts/lib/contracts.mjs'` |
| Preload fire-and-forget drag | `src/preload.ts:30-31` | `startNativeDrag:(cardIds)=>ipcRenderer.send('clipdock:native-drag-start',cardIds)` |
| Preload fallback invokes | `src/preload.ts:32-36` | `importToMediaPool:(c,b)=>ipcRenderer.invoke('clipdock:import-to-media-pool',c,b)` / `addToTimeline` |
| Renderer drag entry | `src/renderer.ts:1698-1711` | `function startCardDrag(event:DragEvent,cardIds:string\|string[])` |
| Renderer queue drag wiring | `src/renderer.ts:1755` | `row.addEventListener('dragstart',e=>startCardDrag(e,selectedQueueDragCards(cardId)))` |
| Renderer history drag wiring | `src/renderer.ts:2230` | same `startCardDrag` for `historyList` cards |
| Renderer fallback | `src/renderer.ts:1633` | `async function fallbackTransfer(item,action:'import'\|TimelinePlacement)` |
| Main drag icon | `src/main.ts:191-193` | `const DRAG_ICON=nativeImage.createFromDataURL('data:image/png;base64,iVBOR…32x32')` |
| Main sync drag handler | `src/main.ts:306-311` | `ipcMain.on(IPC_CHANNELS.nativeDragStart,(event,cardIds)=>{…event.sender.startDrag…})` |
| Main transfer registrar | `src/main.ts:280-285` | `registerMainTransferInvokeHandlers(ipcMain,{importToMediaPool,addToTimeline},{requireSender,resolveCard,transfer,invalidTargetBin,invalidTimelinePlacement})` |
| Main-process drag validator | `src/main-process.ts:184-200` | `function nativeDragStart(event,cardIds,startDrag)` + `normalizeNativeDragCardIds` |
| Main-process card resolver | `src/main-process.ts:44-48` | `export function resolveMainProcessCard(cards,cardId)` → `isSafeMediaFile(path,trustedRoot)` |
| Path boundary | `src/path-boundary.ts:54-68` | `export function isSafeMediaFile(filePath,trustedRoot)` (plus `canonicalRoot`, `regularFile`, `contains`) |
| Transfer factory | `src/transfer.ts:120+` | `export function createTransfer(workflowIntegration,pluginId)` returning `{importToMediaPool,addToTimeline}` |
| Transfer internals | `src/transfer.ts:90-230` | `openTargetContext`, `findExistingClip`, `findSubFolder`, `importToMediaPoolTransaction`, `addToTimelineTransaction`, `timecodeToFrames`, `applyAutomation` |
| Type: drag icon | `src/electron.d.ts:45-46` | `startDrag(item:{file\|files,icon:NativeImage\|string})` |

---

## 3. Trust Checks & Path Boundary

- **IPC sender validation — main is authority.** `src/main.ts:60-80` `exactClipdockDocumentUrl` + `isValidatedClipdockFrame` (frame===mainFrame && url===`file://…/index.html`)+ `requireClipdockSender` (`event.sender===mainWindow.webContents && isValidatedClipdockFrame`). Used for every handled channel via `createSensitiveIpcHandler(requireTrustedSender,…)` [main.ts:284 `selectFile`, 326+ all others] and directly for sync drag `try{requireSender} catch return` [main-process.ts:185-187].
- **Card registry — opaque IDs only.** `src/main.ts:90-91` `type Card={path,automation?,historyId?,trustedRoot?}` in `Map<string,Card> cards`; `historyCards:Map<historyId,cardId>` [main.ts:95]. Renderer never sees paths; `getStatus`, `historyList`, `workspaceStatus` never return paths except `DownloadFolderStatus.folder` (display/status only) [shared.ts:40-45].
- **Per-operation revalidation.** `resolveMainProcessCard` → `isSafeMediaFile(card.path, card.trustedRoot)` [main-process.ts:46-48]. Called on every `nativeDragStart` loop and every `import/add` before dispatch. Stored `trustedRoot` is the *captured* canonical managed root at registration time [main.ts:160 `capturedManagedRoot(path)`; main-process handler re-checks with that stored root, not a later folder value — see test `stored-root remains authoritative` in `test/main-process.test.mjs:…`].
- **Path-boundary hardening** [path-boundary.ts]:
  - `canonicalRoot(root)` — `lstatSync` rejects symlink or non-directory; `realpathSync` + second `lstatSync` rejects symlink-escaped directory [ :9-18].
  - `regularFile(p)` — `lstatSync` rejects symlink/`!isFile`; `realpathSync` + `statSync.isFile` single-stat on canonical [ :35-44].
  - `contains(canonical,file)` — both canonicalized, `relative(canonical,resolvedFile)` strict `rel!=='' && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel)` [ :21-31]; root==file => `false` via `contains`, but `isSafeMediaFile` special-cases `rel===''→true` [ :65] (file==root allowed for backwards compat, never true in practice as root is directory).
  - `isSafeMediaFile(path, trustedRoot?)` — fail-closed: requires absolute string, `regularFile` pass; if `trustedRoot===undefined` → true (dialog-picked files); if supplied → must be absolute canonical directory and file strictly inside (or equal) [ :54-68].
  - `capturedManagedRoot(filePath)` [main.ts:204-214] `mkdirSync(managedRoot,recursive)` + `realpathSync(managedRoot)` then `isSafeMediaFile(path,root)` else throw — bounds managed downloads at registration.
  - `selectFile` dialog path also `isSafeMediaFile(filePath)` before card creation, with `+trustedRoot:capturedManagedRoot` only on success [main.ts:287-290].
- **Drag atomicity.** `normalizeNativeDragCardIds` dedupes preserving order, rejects empty / non-string [main-process.ts:176-188]. Loop revalidates every deduplicated card; if any invalid flag set, `return` without calling `startDrag` at all [ :196 `if(!valid) return`]. Valid multi-card → `startDrag(files:paths,icon)`; single → `startDrag(file:path,icon)` [main.ts:310-311 / main-process.ts:200].
- **History drag binding without mutation.** `bindHistoryCard` uses `history.resolve(id)` (validates, never `reuse()` which would mutate `lastUsed/project/order`) then caches `historyCards`→`cards` with `trustedRoot:hit.trustedRoot` [main.ts:248-267]. `historyList` enriches DTO with `cardId` only after `bindHistoryCard`; `pruneHistoryCards` evicts stale entries even when record no longer exists [main.ts:254-260].

---

## 4. Renderer State / Asset Guards & Drag Enablement

- **Selectable guard** [renderer.ts:1610] `isSelectableQueueItem(item)` = `status==='completed' && typeof cardId==='string' && cardId.trim() && !queueDeleteInFlight.has(queueId)`. Used everywhere drag or selection is considered.
- **Host-status guard** [renderer.ts:553-560] `hostActionReason('drag'|'import'|'timeline')` returns `null` only when `hostStatus.phase==='ready'` and project (and for timeline, timeline) loaded; otherwise human string (`Checking host connection`, `Host connection unavailable…`, `Open a project…`, `Open a timeline…`). `renderQueue` computes `dragReason=hostActionReason('drag')` [ :1746] and `canResolveDrag=selectable && !isAdobeRuntime && !dragReason` [ :1747]. When false, `row.draggable=false` and `title/aria-label` explains reason; when true, `draggable=true` and `aria-label` includes `Drag to Resolve` or `Drag N selected` hint [ :1751-1755].
- **Multi-select payload** [renderer.ts:1613-1622] `selectedQueueCardIds:Set<string>` session-only. `pruneQueueSelection` removes IDs whose `isSelectableQueueItem` false. `selectedQueueDragCards(cardId)` returns the full deduplicated selected set when the dragged row is itself selected and `length>1`, otherwise single `cardId` [ :1617-1622]. Renderer renders checkbox per completed row [ :1758] and `dragHintText` reflects payload count [ :1750-1753].
- **Adobe CEP fork** [renderer.ts:1699-1711] `isAdobeRuntime = typeof getDragFilePath==='function'`. When true, `startCardDrag` rejects `Array.length!==1` with `Multiple-file drag is available in the Resolve panel only`, resolves `filePath=resolveCepPath(cardId)` synchronously and does `event.dataTransfer.setData('com.adobe.cep.dnd.file.0',filePath)` / `effectAllowed='copy'`; on miss/empty throws `announceDragFailure` and `event.preventDefault()`. Resolve path is the `else` branch: `event.preventDefault(); window.clipdockAPI.startNativeDrag(cardIds)` [ :1711].
- **Subtitle drag** — same seam: `subtitle.draggable=!isAdobeRuntime && !dragReason` with its own `dragstart` → `startCardDrag(cardId)` [ :1767].
- **History drag** — `hostDragReason=hostActionReason('drag')`; when falsy, `row.draggable=true` + `dragstart→startCardDrag(cardId)` on the opaque `cardId` bound by `historyList` enrichment [renderer.ts:2216-2230]. Individual history actions also disable via `hostActionReason`.

---

## 5. macOS Icon Behaviour

- `src/main.ts:191-193` comment `macOS startDrag REQUIRES a non-empty icon; a 32x32 PNG data URL is a valid NativeImage` and `const DRAG_ICON=nativeImage.createFromDataURL('data:image/png;base64,iVBOR…')` — a 32×32 accent PNG, never empty.
- Electron `startDrag({file|files,icon})` contract documented in `src/electron.d.ts:46`; empty icon silently fails on macOS, Windows/Linux ignore shape but still require value. ClipDock satisfies by always passing `icon:DRAG_ICON` in both overloads [main.ts:310-311]. Main-process callback receives single `string|string[]` and chooses overload [main-process.ts:200].

---

## 6. Error / Fallback Semantics (ImportMedia + AppendToTimeline)

- **Channel split.** Native drag is `ipcMain.on` fire-and-forget **synchronous** — must not `await`; renderer must not await [preload.ts:28-31 comment; main.ts:304-306 comment]. Button fallback is `ipcMain.handle` async returning `TransferResult`.
- **Main-process validation → controlled results** [main-process.ts:140-175]:
  - invalid `cardId` (resolve fails) → `{ok:false,kind:'invalid-card',message:'No valid media card selected.'}`
  - `targetBin!=='active'&&!=='clipdock'` → `{kind:'bin-error',message:'Invalid destination bin.'}`
  - `placement!=='end'&&!=='playhead'` → `{kind:'playhead-unsupported',message:'Invalid timeline position.'}`
  - On success → delegates `transfer.importToMediaPool(path,bin)` / `transfer.addToTimeline(path,bin,placement,card.automation)` and returns its `TransferResult` verbatim.
- **Transfer discriminated results** [transfer.ts:18-29]: `ok:true` → `imported{importedCount,msg}` | `already-imported{msg}` | `timeline-appended{msg}` | `timeline-inserted{msg}`; `ok:false` → `bridge-error|no-project|no-timeline|import-failed|append-failed|bin-error|playhead-unsupported{msg}` — every branch has user-facing `message`.
- **Duplicate control** [transfer.ts:80-115 `findExistingClip` / `instanceFindExistingClip`]: scans **only target bin** (`GetClipList()` on chosen folder) for exact `File Path` match after `normalizeSlash` (backslash→slash) and platform-aware `clipPathsEqual` (`darwin`/`win32` case-fold) — no filename heuristic, no lowercase folding on Linux. Returns `already-imported` with `Already imported to the Active/ClipDock bin — using the existing clip.` instead of re-importing.
- **Destination bin** [transfer.ts:140-180 `openTargetContext`]: `active` → `folder=GetCurrentFolder()`, no `SetCurrentFolder/AddSubFolder`; missing folder ⇒ no scan (import proceeds). `clipdock` → requires `GetRootFolder()`→ `findSubFolder('ClipDock')` by exact `GetName()` → `AddSubFolder(root,'ClipDock')` if absent → `SetCurrentFolder(folder)`; `SetCurrentFolder===false|null` or `GetRootFolder` null/throw ⇒ `bin-error`. Every success/failure **restores** previous folder best-effort when differing [ :152-159].
- **Playhead insertion** [transfer.ts:260-320 `addToTimelineTransaction` playhead branch]: pre-checks `OpenPage`+`GetClipProperty`+`GetStartFrame/StartTimecode/CurrentTimecode`+`GetSetting('timelineFrameRate')` exist else `playhead-unsupported`; requires `OpenPage('edit')!==false/null`, integer `Frames>0`, `timecodeToFrames` valid for both timecodes with nominal frameRate 1–240 and matching dropFrame, `recordFrame = timelineStartFrame + currentFrames - startFrames` integer finite ≥ start; then `AppendToTimeline([{mediaPoolItem:clip,startFrame:0,endFrame:frames-1,recordFrame}])`; empty/null throw → `append-failed`. Standard `end` append is `AppendToTimeline([clip])` with null/empty/array-empty ⇒ `append-failed`.
- **Serialization & dedup** [transfer.ts:340-400]: single `transferTail:Promise<void>` FIFO chain via `enqueueTransfer`; `operationCache Map` `MAX_OPERATION_CACHE=128` keyed by `operationId\u0000filePath\u0000targetBin\u0000placement` dedupes concurrent identical requests (LRU eviction prefers settled entries), failures evicted (not cached), `invalid-card` never cached at transfer layer (main-process layer returns it).
- **Renderer fallback UX** [renderer.ts:1633-1644]: `fallbackTransfer` re-checks `hostActionReason` (again, before API call) and records `item.message/item.transferError` from returned `result.message`; `fallbackBins:Map<queueId,TargetBin>` preserves enqueue-time bin [ :120, :1936] so retry uses original intent; `fallbackInFlight` Set disables buttons during call; UI status toast via `youtube-queue-status`.

---

## 7. Test Coverage Anchors (Observed, Not Executed)

- `test/main-process.test.mjs` — `isSafeMediaFile` (regular, missing, symlink, containment inside/outside/escape, symlinked root, null root), `resolveMainProcessCard` (stored `trustedRoot` authority, dangling/rootless symlinks), `nativeDragStart` (sender-gated, single file, missing card no-op, dedup preserves order, atomic reject on one invalid member, empty array no-op), `Pinterest` snapshot bound (eviction at 3), `provider download handlers` trusted-sender ordering — all via `dist/main-process.js` seam.
- `test/path-boundary.test.mjs` — `canonicalRoot` (real dir ok, symlink/file/relative/missing reject), `regularFile` (symlink/dir/missing reject), `contains` (inside true, outside/symlink-escape/relative root/file false, `..` traversal, root==file false).
- `test/transfer-queue.test.mjs` — FIFO: second `clipdock` transaction (import vs addToTimeline) waits for first import+restore before second `Initialize`/`GetResolve`; queued transfer continues after controlled `import-failed`.
- `test/bugfix-01-transfer-case-insensitive.test.mjs`, `regression-r2-02-casefold.test.mjs` — platform-aware `clipPathsEqual` (darwin/win32 fold, linux strict).
- `test/bugfix-04-transfer-operationid.test.mjs`, `regression-r2-04-opkey.test.mjs`, `regression-r2-01-opcache.test.mjs` — `operationId` dedup, cache key includes args, placement sensitivity, LRU eviction.
- `test/ipc-trusted-sender.test.mjs` — enumerates 42 `ipcMain.handle` registrations in `src/main.ts` and asserts `createSensitiveIpcHandler(requireTrustedSender,…)` or `requireClipdockSender` present; native-drag `ipcMain.on` and transfer registrar are intentionally excluded from count.

---

## 8. Facts vs Reuse Candidates — Strict Separation

**FACT (observed, file:line verifiable):** All names, guards, IPC strings, DRAG_ICON bytes, `TrustedRoot` capture/store/revalidate lifecycle, atomic drag reject, FIFO+operationCache, bin/duplicate/playhead logic exist exactly as cited above in this commit.

**REUSE CANDIDATE (requires independent validation for HdrToSdr):**
- `DRAG_ICON` shape/color and `event.sender.startDrag({file|files,icon})` overload — candidate, depends on HdrToSdr window/sandbox and Resolve version; multi-file `files[]` overload only needed if HdrToSdr supports multi-select drag.
- Card registry shape `Map<cardId,{path,trustedRoot,…}>` and `capturedManagedRoot` — candidate; HdrToSdr managed folder, worker roots, and dialog vs managed file distinction must be re-derived; do not copy `trustedRoot` sentinel verbatim.
- `normalizeNativeDragCardIds` dedup+atomic reject policy — candidate; HdrToSdr may choose different UX (e.g., allow partial valid subset) but then diverges from ClipDock-proven semantics.
- `hostActionReason`/`canResolveDrag` visible guard — candidate; HdrToSdr must re-derive its own project/timeline readiness signal; copying the `hostStatus.phase` enum couples plugins.
- `openTargetContext`/`findExistingClip`/`clipPathsEqual` bin+dedup — candidate; reimplement from Resolve scripting docs, not by copying clipdock bin name `ClipDock` or exact failure strings.
- `operationCache` / `transferTail` — candidate only if HdrToSdr needs idempotent transfer dedup; otherwise independent.
- History `cards`/`historyCards` binding via `resolve` not `reuse`, and `historyList` DTO enrichment `{…record,cardId}` — candidate; HdrToSdr history schema differs.

No code was copied here; candidates are references for HdrToSdr to re-derive under its own plugin ID and roots.

---

## 9. Boundaries That Cannot Carry Over Unchanged (Independent Plugin)

- **Plugin identity.** `PLUGIN_ID='com.clipdock.app'` [scripts/lib/contracts.mjs:5] and `manifest.xml <Id>` must differ; `WorkflowIntegration.Initialize(pluginId)` binds bridge to that ID [transfer.ts:… `Initialize:com.clipdock.test` in tests].
- **Managed-root coupling.** `managedRoot` = user-selected or `Downloads/ClipDock` default [main.ts:95-100, settings.ts]; `capturedManagedRoot` canonicalizes that specific folder; HdrToSdr's output folder (e.g., `HdrToSdr` subfolder or sidecar-next-to-source) and worker `sessionDir` values are disjoint constants in ClipDock [main.ts:99-172] and cannot be reused.
- **History contract.** `download-history.json` path, `MAX_RECORDS=200` (implied by `historyList` batch 20), `StoredRecord.trustedRoot` persistence, `subtitlePath` handling, `projectName` capture via `statusProvider.getStatus()` [history.ts:13-22, main.ts:135-138] — all ClipDock-specific; HdrToSdr history shape or absence thereof is independent.
- **IPC namespace.** `IPC_CHANNELS` literal strings `clipdock:*` [contracts.mjs] — HdrToSdr must use its own channel prefix; preload `clipdockAPI` global name likewise.
- **CEP vs Electron fork.** `getDragFilePath` / `com.adobe.cep.dnd.file.0` / `isAdobeRuntime` [renderer.ts:1699] is Premiere CEP, not Resolve; HdrToSdr for Resolve targets only Electron `startDrag`, but for Premiere target would fork differently.
- **WorkflowIntegration node binding.** `src/main.ts:15` `require('./WorkflowIntegration.node')` injected only into `sharedWorkflowIntegration`/`transfer`; all other modules are Electron-free for testability — HdrToSdr's native module path/name/version will differ.
- **Security posture.** `BrowserWindow` `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` [main.ts:225-230], `webPreferences.partition` for preview [main.ts:…], `exactClipdockDocumentUrl` file URL check — must be re-derived from HdrToSdr's own `index.html` path.
- **UI coupling.** `hostStatus` polling (visible-only 3s `HOST_POLL_MS` [renderer.ts:…]), `fallbackBins` per-queueId preservation, `queueDeleteInFlight`/`fallbackInFlight` Sets, `selectedQueueCardIds` — all renderer-session-only state tied to ClipDock's queue model, not transferable as-is.

---

## 10. What This Does NOT Prove

- **No inbound Finder → panel handler.** `grep -rn drop` finds zero `drop`/`dragover` listeners in `src/`; `src/renderer.ts` only has outbound `dragstart` [ renderer.ts:1682-1711 ]. Selection today is `dialog.showOpenDialog` only [main.ts:290-311]. Empirically possible under Electron `sandbox:true` (`File.path` on `DataTransfer.files[i].path`) per project research doc `docs/research/09-workflow-integration-drag-drop.md:17`, but **not implemented or tested in ClipDock** — must not be cited as proven.
- **Resolve timeline drop precision.** `startDrag` file drop position maps to Resolve-internal playhead/X and is not controllable via `startDrag`; only API `AppendToTimeline` with `recordFrame` is precise [transfer.ts playhead branch; research doc §C].

---

## 11. Minimal Verification

```bash
git -C <external ClipDock checkout> status --porcelain  # empty
git -C <external ClipDock checkout> rev-parse HEAD       # b7268a165b78e89cad023d2e0daffc3260559b1f
ls <repository root>/docs/research/clipdock-outbound-drag-readback-2026-08-25.md
```

No ClipDock file was modified; HdrToSdr note is the only write in this deviation.

---

*Evidence note generated read-only; HdrToSdr must re-derive any reuse under its own plugin ID, channels, roots, and Resolve/Premiere target. No architecture or implementation decision is prescribed herein.*
