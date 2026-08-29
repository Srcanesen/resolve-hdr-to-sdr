# Evidence Report: iPhone HDR Auto Diagnosis/Correction — Resolve Developer Capability

**Date:** 2026-08-25 (UTC)
**Local Resolve:** Studio 21.0.3 bundle 21.0.30007 — `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Info.plist`
**WorkflowIntegration bridge:** 21.0.3.7 — `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node` (1,730,064 bytes)
**Primary SDK docs inspected:**
- `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt` (Last Updated: 15 Jul 2026, 1145 lines, 113,935 bytes)
- `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/CHANGELOG.txt` (Last Updated: 5 May 2026)
- `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/README.txt` (Updated: 3 Oct 2024, 352 lines)
- `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/CHANGELOG.txt` (Last Updated: 28 Jul 2025)
- Sample code: `SamplePlugin/main.js`, `preload.js`, `renderer.js`; `Scripts/*.js`; `Scripting/Examples/*.py`
**Manual PDF probed:** `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Resources/DaVinci Resolve.pdf` (189,826,649 bytes) via `strings` — no extractable HDR/Color Management index without PDF parser (PyMuPDF/pdfminer absent).

## Verdict: No documented automatic iPhone HDR correction API

Local SDK provides **generic** clip/project/timeline property mutation, LUT-per-node, and transcode-on-demand, but **no first-class iPhone HDR (HLG/PQ/Dolby Vision/Rec.2020/Rec.2100) auto-detect, Input Color Space assignment, CST/OFX parameter, or import-hook**. Any HDR fix must be inferred from undocumented `GetSetting`/`GetClipProperty` key snapshots and fails closed where documented.

---

## 1. Workflow Integration

| Area | Evidence |
|------|----------|
| Module API | `WorkflowIntegration.Initialize(pluginId):Bool`, `InitializePromise`, `GetResolve():Resolve`, `GetResolvePromise`, `RegisterCallback(name,func):Bool`, `DeregisterCallback`, `CleanUp():Bool`, `SetAPITimeout(secs):Bool`, `GetInfo():{version}` — `Workflow Integrations/README.txt:89-113` |
| Callbacks supported | Only `RenderStart`, `RenderStop`, `ResolveQuit` — `Workflow Integrations/README.txt:115-121`. No `MediaPoolItemAdded`, `ClipImported`, `TimelineChanged` event. |
| Electron model | Studio 19.0.2+ enforces `sandbox:true`, `contextIsolation:true`; `WorkflowIntegration.node` must be copied from `Help > Documentation > Developer > Workflow Integrations/Examples/SamplePlugin/` — same README lines 10-16 and macOS install path in task context. Linux not supported for plugins. |
| Implication | No automatic trigger on iPhone file import; Workflow Integration is Electron UI host, not media-import interceptor. Polling is only option (not documented). |

**Sources cited:** `README.txt` quoted verbatim; `main.js` samples confirm `require('./WorkflowIntegration.node')` pattern.

## 2. Scripting API Surface (Resolve/Py/Lua/JS identical via bridge)

### 2.1 Project / Timeline settings
- `Project.GetSetting(name):string` / `SetSetting(name,value):Bool` — `Scripting/README.txt:195-196`
- `Timeline.GetSetting` / `SetSetting` — lines 432-433
- Docs state: *"These functions are used to get and set properties otherwise available to user through Project Settings and Clip Attributes dialogs. Keys/values designed to correlate with UI. Call without params for full snapshot; invalid key returns trivial result. Check return value."* — lines 677-693
- Explicitly enumerated only: `superScale`, `timelineFrameRate`, `timelineSampleRate` — lines 695-709. **No enumerated color-science keys documented locally** (e.g., `colorScienceMode`, `isColorManaged`, `timelineColorSpace`, `inputColorSpace`). Must discover via snapshot `GetSetting()` diff after manually toggling UI; unsupported keys fail silently (`false` return, trivial string).
- Color management mismatch note: *"custom colorspaces in an ACES workflow ... may be read only / disabled"* — lines 683-684.

**Capability:** Can script DaVinci YRGB / YRGB Color Managed / ACES project/timeline settings **only if** correct undocumented key names are discovered per version; no official list in 21.0.3 README. Version caveat: `colorAcesODT` fix addressed in 20.2.1 CHANGELOG — keys are version-sensitive.

### 2.2 Media Pool clip properties
- `MediaPoolItem.GetClipProperty(name?)` / `SetClipProperty(name,value):Bool` — lines 331,333
- `GetMetadata(type?)` / `SetMetadata` and `GetThirdPartyMetadata` — lines 305-308
- Docs: Clip Properties section lists only `Super Scale` and `Cloud Sync` enumerations (lines 711-732). **Input Color Space, Gamma, Color Space Tag are NOT enumerated locally**; they appear only as *render* settings, not clip properties.
- Sample: `5_get_project_information.py:49` demonstrates `clip.GetClipProperty("File Name")` and `project.GetSetting("timelineFrameRate")`.
- `MediaPool.ImportMedia` / `MediaStorage.AddItemListToMediaPool` — lines 262-227. Returns `MediaPoolItem[]`. No `input color space` parameter.
- `Folder.GetClipList()`, `MediaPool.GetCurrentFolder()/SetCurrentFolder()` — lines 248-252 — allow post-import enumeration.

**Gap:** No documented `SetClipProperty("Input Color Space", "Rec.2020 HLG")` etc. UI field *Clip Attributes > Color > Input Color Space* exists in Resolve manual (strings probe hit `ACES` but not color-space table), but programmatic assignment via `SetClipProperty` is **undocumented, requires snapshot discovery, and may be read-only when project is in ACES or auto-managed** (per 683-684). The local repo's `transfer.ts:85,140` only uses `GetClipProperty('File Path')` and `GetClipProperty('Frames')` — no color-space usage — reinforcing absence.

**Metadata access:** `GetMetadata()` without args dumps dict (lines 305); third-party metadata via `GetThirdPartyMetadata`. iPhone HDR detection would need e.g., `Gamma Tag`, `Color Space`, but no iPhone-specific keys documented; must rely on `ffprobe` externally (as `src/media-prep.ts:parseFfprobe` already does for `pix_fmt`, `codec`, `cfr`) or empirical metadata dump.

### 2.3 Timeline insertion
- `MediaPool.AppendToTimeline(clip…)` / `AppendToTimeline([{mediaPoolItem,startFrame,endFrame,mediaType,trackIndex,recordFrame}])` — lines 236-238
- `CreateTimelineFromClips` — lines 239-241
- `InsertAudioToCurrentTrackAtPlayhead` — line 201
- `Timeline.GetCurrentTimecode/SetCurrentTimecode`, `GetTrackCount`, `GetItemListInTrack` — lines 409-397
- No `InsertVideoAtPlayhead` for video; video insertion requires `recordFrame` trick via clipInfo (as in `src/transfer.ts:456-468` using `GetSetting('timelineFrameRate')` + frame math, best-effort overwrite, no ripple guarantee).

## 3. Color correction levers

| Lever | API | Evidence | iPhone HDR relevance / Gap |
|-------|-----|----------|----------------------------|
| **LUT per node** | `Graph.SetLUT(nodeIndex,lutPath):Bool` / `GetLUT` / `Project.RefreshLUTList()` — lines 584-587, 204 | Requires LUT file already discovered via custom/master LUT path; `lutPath` may be absolute or relative. `nodeIndex` is 1-based since 16.2.0. | Can apply static transform LUT after import, but not auto-select per-clip HDR; needs pre-made HLG→Rec.709 or PQ→709 LUTs and node existence. |
| **CDL per timelineItem** | `TimelineItem.SetCDL({NodeIndex,Slope,Offset,Power,Saturation})` — lines ~612+ in file | Limited to slope/offset/power/saturation. | Insufficient for HDR gamut/tone mapping. |
| **Grade from DRX still** | `Graph.ApplyGradeFromDRX(path,gradeMode)` / `ApplyArriCdlLut()` — lines 589-595 | Requires DRX file. | Could reapply grade but not HDR-aware auto. |
| **Node graph** | `TimelineItem.GetNodeGraph(layerIdx)` / `Timeline.GetNodeGraph()` / `ColorGroup` Pre/Post graphs — lines 541-603 | Allows programmatic node graph access. | No API to insert *Color Space Transform* (ResolveFX/OFX) with parameter control; CST is ResolveFX, not script-exposed. `InsertOFXGeneratorIntoTimeline` (line 437) inserts generators, not per-clip OFX filters with params. OpenFX `GainPlugin` samples exist in `Developer/OpenFX/GainPlugin/` — writing custom OFX is out-of-scope SDK path, not part of scripting bridge. |
| **OFX** | `Developer/OpenFX/README.txt` and examples (`GainPlugin`, `DissolveTransitionPlugin`) | Requires compiling C++ plugin against `OpenFX-1.4/include/ofx*`. Not scriptable per-clip injection. | Cannot auto-inject CST/Dolby Vision OFX via scripting. |
| **TimelineItem properties** | `SetProperty(Pan,Tilt,Zoom,CompositionMode,Opacity et al)` — lines 907-945 | Geometry/composite only. | No color space keys. |
| **Render/Transcode** | `Project.SetRenderSettings({ColorSpaceTag,GammaTag,FormatWidth,EncodingProfile,…})` — lines 850-851; `SetCurrentRenderFormatAndCodec` | Export-time tags only (`ColorSpaceTag` e.g. `Same as Project`, `AstroDesign`; `GammaTag` e.g. `ACEScct`). | Can force export gamut/gamma on deliver, not fix timeline monitoring. `MediaPrep` (`src/media-prep.ts:109-130`) already uses `ffmpeg` ProRes/H264 externally for compatibility, independent of Resolve. |

**CST/OFX summary:** No `SetInputColorSpace`, `SetCSTParams`, or `AddOFXEffect(name, params)` on `MediaPoolItem`/`TimelineItem` exists in `README.txt` 21.0.3 (search `grep -i "ColorSpaceTag|GammaTag|CST|OFX"` only hits render settings and `InsertOFXGenerator`). Forum consensus (outside local docs) confirms CST via API unavailable — treat as hard gap.

## 4. Official sources cross-check (version caveat)

- **Local is primary:** `Help > Documentation > Developer` bundle matches installed Studio 21.0.3.308? Actually app reports bundle 21.0.3 21.0.30007 — changelog 5 May 2026 covers up to 21.0 Beta. Blackmagic public site currently lists Resolve 20.1/19.1 scripting PDFs with **identical** API tables (no HDR additions); public Support page & 19.x Manual chapter *Project Settings > Color Management* documents YRGB/YRGB Color Managed/ACES selection and Input Color Space per-clip UI, but not API mapping. No new iPhone HDR scripting API announced in 20.1/21.0 Beta changelogs (21 Beta adds only audio/intellisearch/slate/GenerateSpeech). Therefore **absence evidence is consistent upstream**.
- **Access dates:** Local docs inspected 2026-08-25; PDF timestamp inside Assets: 2024-07-04 `DIAG_ACES signal` variant. Official docs URL corresponds to `https://www.blackmagicdesign.com/support/family/davinci-resolve-and-fusion` manual + `Developer/Scripting/README.txt` bundled — no newer published scripting PDF beyond 21.0 Beta per site history.

## 5. iPhone HDR specific — hard gaps

1. **No iPhone detection flag** — `GetClipProperty`/`GetMetadata` return generic file props; HDR subtype (HLG vs HDR10 vs Dolby Vision profile 8.4) not enumerated locally. Would require external `ffprobe` (`color_primaries`, `color_transfer`, `color_space`, `side_data` Dolby Vision) or Resolve UI inspection — not script-queryable HDR enum.
2. **No Input Color Space write API documented** — fixing Rec.2020 HLG > Rec.709 timeline requires per-clip Input Color Space. Not listed under clip-property enumerated values; subject to read-only/ACES-context disablement (683-684). Must empirically test `SetClipProperty('Input Color Space', 'Rec.2020 (Scene)')` etc. per version, and expect `false` in color-managed projects.
3. **No auto Color Management switch** — `SetSetting('colorScienceMode', …)` etc. undocumented keys; changing project from `DaVinci YRGB` to `DaVinci YRGB Color Managed` (which could auto tag HLG) is not officially supported via scripting guarantee.
4. **No import-hook / metadata-trigger** — cannot auto-run on `AddItemListToMediaPool`; only callbacks are render lifecycle.
5. **No timeline CST injection** — cannot programmatically add/manipulate *Color Space Transform* ResolveFX to tone-map HDR per clip/timeline.
6. **No Dolby Vision analysis for import correction** — `Timeline.AnalyzeDolbyVision([items], analysisType)` (line 451) analyzes timeline clips for Dolby metadata post-placement; not an import fixer and requires Studio.

## 6. What *is* controllable (cited)

- Enumerate clips/folders: `GetClipList`, `GetSubFolderList`, `GetRootFolder`, `GetCurrentFolder/SetCurrentFolder` — see 2.2
- Read/write generically: `Get/SetMetadata`, `Get/SetClipProperty` (with snapshotting), `Get/SetSetting` (project/timeline)
- Apply LUT per node via `GetNodeGraph` → `SetLUT` (+ `RefreshLUTList`)
- Apply grade/ARRI LUT: `ApplyGradeFromDRX`, `ApplyArriCdlLut`
- Manage timeline: `AppendToTimeline` (end or playhead via `recordFrame`), `CreateTimelineFromClips`, `SetCurrentTimeline`, track queries
- Deliver: `SetRenderSettings` with `ColorSpaceTag`/`GammaTag`, render queue control
- Diagnostics: `GetClipProperty('File Name'/'Frames'/'File Path')`, `GetMetadata()` dump, `TimelineItem.GetProperty` for geometry, `Fusion()` bridge for Fusion OFX if needed
- Pre-transcode fallback: **outside Resolve** — `ffmpeg/ffprobe` as used in `src/media-prep.ts` (H264/aac direct/remux/audio-remux/transcode; ProRes LT for editing)

## 7. Local paths for main agent follow-up

- Scripting surface: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt:161-650, 675-825`
- Workflow surface: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/README.txt`
- Native bridge sample: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/main.js` and `SamplePromisePlugin/main.js`
- Repo current fallback: `<external ClipDock checkout>/src/transfer.ts:12, 63, 85, 140, 274, 456` and `<external ClipDock checkout>/src/media-prep.ts:60-130, 161-210`

## Risks / Unknowns (evidence-bound)

- Undocumented key names for color management (`colorScienceMode`, `timelineColorSpace`, `inputColorSpace`, `gammaTag` etc.) may exist but are **version/build-specific** and not guaranteed by Blackmagic; returns `False`/trivial on invalid key — requires runtime snapshot testing per Studio 21.0.3 vs 20.3.2 (README warns "Check the section below for more information" and "troubleshoot by comparing snapshots before/after UI change" — lines 692-694).
- PDF manual extraction blocked (no `PyMuPDF`), so UI description of YRGB Color Managed auto-detection remains indirectly evidenced via forum/manual narrative, not citable local page.
- `SetClipProperty` for Input Color Space may silently succeed on `DaVinci YRGB` but be **disabled in DaVinci YRGB Color Managed / ACES** (683-684 caveat) — exactly the projects where HDR auto-management is desired.
- `Graph.SetLUT` latency: LUT must already be discovered via `RefreshLUTList`; relative-path resolution depends on host LUT directories — may fail in sandboxed plugin until restart.
- iPhone Dolby Vision 8.4 (HLG+DV) vs pure HLG distinction not script-visible; external ffprobe needed; `AnalyzeDolbyVision` API requires timeline placement and extras.

## Implication for main agent

Do NOT promise automatic iPhone HDR fix inside Resolve via documented scripting. Evidence supports only **post-import, best-effort, generic-property + LUT/grade + external ffmpeg transcode** workflows, each requiring empirical key discovery and user-visible failure handling. Design must remain read-only or explicitly flag hard gaps (input color space, CST, import hook) as unsupported.
