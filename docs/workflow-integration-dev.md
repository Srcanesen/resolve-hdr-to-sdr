# Workflow Integration — Developer Bundle (HdrToSdr)

> Developer-only, no auto-install. Not a production release. The npm Electron runtime is pinned exactly to `41.10.3`.

## Plugin Identity

- **Id** `com.hdrtosdr.app`
- **Name** `HdrToSdr`
- **Version** `0.1.0`
- **Description** `Verified HDR to Rec.709 SDR conversion`
- **FilePath** `main.js`

Manifest is generated exactly with those values. Any divergence fails the build.

## Build (reproducible, self-contained)

```bash
npm run bundle:resolve
```

Output:

```
build/workflow-integration/com.hdrtosdr.app/
  manifest.xml
  main.js
  package.json
  WorkflowIntegration.node   # official SDK copy, hash-verified
  electron/                  # allowlisted runtime files only
  prototype/                 # allowlisted runtime files only
  scripts/verify-spike.sh    # executable regular
  tools/ffmpeg               # dereferenced executable regular (not symlink)
  tools/ffprobe              # dereferenced executable regular (not symlink)
```

Build invariants (fail visible):

- `WorkflowIntegration.node` is copied **only** from official installed SDK at
  `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node`.
  Hash of source and bundle must match. No ClipDock source.
- `tools/ffmpeg` and `tools/ffprobe` are dereferenced (symlink resolved, file copied, `chmod 755`), not symlinks, and remain executable regular files in the bundle.
- Only the runtime allowlist in `scripts/bundle-audit.cjs` is copied; tests, caches, web assets, and unrelated scripts are excluded.
- `scripts/verify-spike.sh` is included as executable regular.
- No file in the bundle is a symlink (walk with `lstat` fails if any symlink, including a cycle).
- Bundle hashes are computed in bounded chunks; no whole-file hash buffer is loaded into memory.
- No file contains the source repository absolute path (e.g., `/Users/.../HdrToSdr`).
- Missing inputs, non-executable tools, or failed file/dir checks fail visibly (`BUILD FAILED` + non-zero exit).
- Build **does not** auto-install to `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/`. Manual copy is required for host smoke (see below).

Verify locally after build:

```bash
node scripts/bundle-audit.cjs "$PWD/build/workflow-integration/com.hdrtosdr.app"
find build/workflow-integration/com.hdrtosdr.app -type l | wc -l  # must be 0
sha256sum "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node" \
          build/workflow-integration/com.hdrtosdr.app/WorkflowIntegration.node
ls -l build/workflow-integration/com.hdrtosdr.app/tools/  # must be -rwxr-xr-x regular, not l
cat build/workflow-integration/com.hdrtosdr.app/manifest.xml
```

## Tool Doctor and Runtime Configuration

```bash
npm run doctor
```

The doctor checks only repo-local `tools/ffmpeg` and `tools/ffprobe` targets for regular-file and executable properties. It never downloads, installs, or falls back to `PATH`; setup remains an explicit, separately verified provisioning step.

`HDRTOSDR_PYTHON` remains an **explicit runtime configuration**. The Electron main process does not infer a fallback Python. If absent or not an absolute executable, startup shows a generic configuration error (never leaks PATH).

For later host smoke inside DaVinci Resolve, Resolve must be launched with the variable, e.g.:

```bash
HDRTOSDR_PYTHON="$(command -v python3)" open -a "DaVinci Resolve"
# or for the workflow integration host process:
HDRTOSDR_PYTHON=/opt/homebrew/bin/python3 /Applications/DaVinci\ Resolve/DaVinci\ Resolve.app/Contents/MacOS/Resolve
```

Do **not** invent fallback configuration. Verify `HDRTOSDR_PYTHON` is set and points to an absolute executable before host smoke.

## Host Lifecycle (inside Resolve)

When `WorkflowIntegration.node` is present next to `main.js`, `electron/main.cjs` runs in host mode:

- `startApp(options)` is the exported guarded entry; standalone auto-starts only when `require.main === module`. It reuses a single `BrowserWindow` / `bootstrap` / `ConversionService`.
- Ordered lifecycle: `Initialize('com.hdrtosdr.app')` → `SetAPITimeout(10)` → `RegisterCallback('ResolveQuit', quit)`. Any failure fails closed with generic startup failure (`Startup failed`) and quits.
- `CleanUp` is called exactly once during `before-quit`; if initialization succeeds but a later lifecycle call fails, partial host state is cleaned up once before fail-closed exit.
- Window `close` quits the app.
- `ConversionService` disposes inspection, conversion, and verifier work on `before-quit`; tracked child processes are killed and active jobs terminalize as cancelled. Disposal and terminal cleanup are idempotent.
- Inspection and conversion share one heavy-operation reservation, so neither can begin while the other is active. Conversion reserves synchronously before source revalidation; accepted starts return before queued/terminal events are deferred to the next turn.
- Converter and verifier executions use bounded total/stall watchdogs and abort signals. Safe timeout/stall event reasons are `conversion_timeout`, `conversion_stalled`, `verification_timeout`, and `verification_stalled`; the renderer maps them to the existing generic failure copy.
- No Resolve API beyond that lifecycle is called.

`sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true` are preserved via `secure-window.cjs`.

## Native Drag — Verified Output Only

- IPC channel: `hdrtosdr:output-drag:start`, fire-and-forget `ipcRenderer.send({version:1, outputId})`.
- `preload.cjs` exposes only `window.hdrToSdr.startOutputDrag(outputId)` — never paths.
- Drag is permitted only after converter verifier **PASS**. `ConversionService` stores an opaque UUID `outputId` → `{canonicalPath, canonicalOutputRoot, displayName, ownerWebContentsId, verified:true}`.
- Every drag revalidates: same owner (`webContents.id`), canonical non-symlink output root (`lstat`+`realpath` equals stored), direct containment via non-creating `isSafeOutputFile` helper, output `lstat` regular non-symlink, and current `realpath` equals stored canonical (`TOCTOU` check). Output roots are created/hardened to `0700`, committed files to `0600`; unsafe root symlinks return a safe UI error and never redirect output.
- Output thumbnails are bounded, decode-validated before response, deduplicated for concurrent requests, cached by owner and output fingerprint with bounded eviction, and cleared when the owning webContents is destroyed.
- Sender must be exact `BrowserWindow` `webContents` + `mainFrame` + expected `file://.../index.html` URL. Otherwise ignored.
- Main calls `event.sender.startDrag({file, icon})` synchronously; `icon` is a non-empty embedded 32×32 `NativeImage` — drag is ignored if empty or wrong size.
- Renderer never receives filesystem paths or raw errors; success event may carry opaque `outputId` but UI never prints it. A keyboard-accessible draggable control with exact text `Drag to Resolve` appears only after verified success (`draggable="true"`, `tabindex="0"`, `role="button"`). It is cleared on new inspect, error, retry/cancel/new job.

`outputStore` boundary helper `isSafeOutputFile(canonicalPath, canonicalRoot)` is non-creating and reused by drag revalidation; no symlink path component or TOCTOU weakening. Output identities are owner-scoped, bounded, and expire after a fixed TTL; stale records are removed before drag or record lookup. No-overwrite guarantees (`allocateUniqueFinalPath`, `buildDisplayName(..., profileId)` → `_sdr_rec709_h264_<profile>.mp4`, hard-link commit with bounded `EEXIST` retry) are preserved. Output is compact H.264 High `yuv420p` MP4 with `+faststart+write_colr` and AAC 192k for broad compatibility and small size (no ProRes intermediate).

## Conversion Profiles & Verification (generic HLG + narrow PQ slice)

- **Profiles centralized in `electron/b-profile.cjs` (frozen, fail-closed):**
  - `hlg-local-b-v1` — `libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le,eq=gamma=0.90` (local B, allowlisted DOVI 8.4 HLG only)
  - `hlg-rec709-v1` — `libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le` (generic metadata-confirmed non-Dolby HLG, no gamma trim; BT.2390/perceptual/explicit `bt709`/`tv`/`yuv422p10le`)
  - `pq-rec709-v1` — `libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le` (narrow static HDR10/PQ, same text as generic HLG is allowed but distinct profile ID/route; `checkCapability` requires `bt.2390`+`perceptual`+`peak_detect`; Vulkan runtime errors remain generic failure with no fallback; no HLG gamma trim)
  - Kept in `PROFILES` / `ALLOWED_PROFILE_IDS` with `isKnownProfileId(profileId)` and `getFilterGraph(profileId)`; unknown `profileId` fails closed at IPC (`isValidConvertStartRequest`/`isValidConvertEvent`/`validateCliResponse`), at `ConversionService` (`revalidateSourceToken` enforces classification↔profile pairing: `hlgKnownLocal`↔`hlg-local-b-v1`, `hlgSupported`↔`hlg-rec709-v1`, `pqSupported`↔`pq-rec709-v1` with `sha256`/`size` re-check), and at executor (`buildFfmpegArgs(..., profileId)` / `runBConversion({..., profileId})` throws/`invalid_request` on unknown, reuses single `spawn` path). Inspector detects `MDCV`/`CLLI` from stream side_data_list AND a bounded initial probe interval (`-read_intervals %+#1 -show_frames` within existing single argv/no-shell call and timeout/identity checks) and `has_hdr10plus` separately from Dolby; boolean presence sufficient for v1 (no broad numeric claim, no raw frame/path leak).
- **Python classification (`prototype/classifier.py` + `contracts.py`):** `hlgKnownLocal` unchanged allowlist; `hlgSupported` is generic HLG only when `parse_ok` && not `unspecified`/`contradictory` && exact `bt2020nc`/`arib-std-b67`/`bt2020` + `tv` && known ≥10-bit YUV `pix_fmt` via explicit small allowlist && `has_dovi==false`. `pqSupported` is narrow static HDR10 only when `parse_ok` && not `unspecified`/`contradictory` && exact `bt2020nc`/`smpte2084`/`bt2020` + `tv` && `≥10-bit` allowlist && `has_dovi==false` && `has_hdr10plus==false` && `has_mdcv && has_clli` (both MDCV+CLLI). No SHA/codec/container gate. PQ missing either metadata remains `pqHdr10Unsupported`/`canConvert:false` with safe reason; DOVI takes precedence (`dolbyVisionUnsupported`); HDR10+ (`hdr10plus`/`st2094-40`) remains unsupported/fail-closed; HLG behavior and frozen graphs unchanged. No SHA/basename/codec/container required for generic/PQ.
- **Renderer / IPC (`electron/ipc-contract.cjs` → `inspection-adapter.cjs` → `renderer/app.js`):** `isValidResponse`/`validateCliResponse` now allow `hlgSupported`/`pqSupported` + all three `profileId`s; eligibility (`isEligibleResult`) considers `hlgKnownLocal`/`hlgSupported`/`pqSupported` with `canConvert:true` + non-empty `sourceId`/`profileId` (main validates literals, renderer stays generic to avoid embedding frozen IDs); technical `Format` shows `HLG` for HLG, `PQ / HDR10` for `pqSupported`/`pqHdr10Unsupported` (PQ-supported can convert and format says `PQ / HDR10`; missing metadata stays unsupported); no visual redesign. `ConversionService.createSourceToken` mints opaque `sourceId` for all three; reinspection re-validates classification↔profile and `sha256`/`size` and enforces `profileId` pairing/token minting.
- **Executor / verifier generalization:** `b-executor.cjs` routes strictly by `profileId` (centralized map, no duplicate process logic; `checkCapability` uses asynchronous `spawn(..., {shell:false})` probes coalesced and cached per executable identity/profile, and for PQ requires `bt.2390`+`perceptual`+`peak_detect` and for all profiles requires `libx264`+AAC via argv/no-shell probes; capability failure → `profile_unavailable`); `b-executor.cjs` builds locked H.264 MP4 contract: `libx264` High preset medium CRF 18 `yuv420p` with explicit `bt709`/`tv`, AAC 192k `-map 0:a?`, `-movflags +faststart+write_colr`, `-fps_mode passthrough`, metadata/chapters stripped, `-n`; `conversion-service.cjs` allocates `buildDisplayName(base, profileId)` → `_sdr_rec709_h264_<profile>.mp4` (staging `_*.partial.mp4` valid for MP4 muxing) and spawns `verify-spike.sh <src> <dst> <profileId>` with `spawn(..., [src, dst, profileId], {shell:false})` (argv-safe, profile routing/capability). `scripts/verify-spike.sh` enforces: unknown profile fails; `hlg-local-b-v1` → exact SHA gate (two known fingerprints); `hlg-rec709-v1` → exact HLG input metadata check (`bt2020nc`/`arib-std-b67`/`bt2020`/`tv`/allowed `pix_fmt`/`has_dovi==false`) before accepting output; `pq-rec709-v1` → strict input re-gate using stream + bounded initial side-data evidence (requires both `MDCV`+`CLLI`, rejects `DOVI`/`HDR10+`, exact `bt2020nc`/`smpte2084`/`bt2020`/`tv`/allowlist) before accepting output; all retain `source!=output`, timing/frame/presentation-dimension checks, the documented audio policy (all source audio streams retained in order as AAC, or no audio track when absent), Rec.709 H.264 High tags (`bt709`/`tv`/`yuv420p`/`h264`/`High`), bounded HDR side-data evidence, semantic privacy-tag checks (`com.apple.quicktime.*`/`ISO6709`/creation-time), and atomic no-clobber commit. Verified final outputs are fingerprinted and revalidated before drag/thumbnail. `outputStore.allocateUniqueFinalPath` collision loops remain bounded and `buildDisplayName(..., profileId)` includes profile suffix.
- **Visual-validation limit (truthful):** Generic BT.2390 and narrow static HDR10 mechanical support are implemented and metadata-gated, but visual correctness still requires real HDR10 human A/B on a calibrated Rec.709 display and is not claimed (narrow static HDR10 mechanical support implemented; visual correctness still requires real HDR10 human A/B and is not claimed).

## Manual Host Smoke (later, not in build)

1. Build: `npm run bundle:resolve`
2. Launch Resolve with `HDRTOSDR_PYTHON` set (see above)
3. Manually copy `build/workflow-integration/com.hdrtosdr.app` to  
   `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/` (requires admin, not done by build)
4. Open Resolve Studio → `Workspace → Workflow Integrations → HdrToSdr`
5. Verify manifest fields, drag a verified output to Media Pool / timeline with a non-empty icon. Host smoke remains manual and is not part of `npm test`.

Do **not** `sudo`, restart Resolve, or touch ClipDock during build.

## Validation

```bash
npm test          # python + electron IPC tests (includes generic HLG + narrow PQ: parser bounded initial side-data evidence, positive PQ, missing MDCV/CLLI, 8-bit, wrong tags/range, numeric/string transfer 16, DOVI priority, HDR10+ reject, contract pairing, token/reinspection, profile routing/capability, renderer copy/format, verifier argv)
npm run check
npm run doctor
npm run bundle:resolve
git diff --check
find build/workflow-integration/com.hdrtosdr.app -type l  # 0
# Focused additional checks (if needed):
# npm run test:python -- -k test_classifier_pq
# node --test electron/test/b-executor.pq.test.cjs  # (when present)
```

**Remaining real-media visual validation risk:** Generic `hlg-rec709-v1` (BT.2390) tone-mapping and narrow static HDR10 `pq-rec709-v1` (BT.2390/perceptual/peak_detect) are deterministic-metadata-gated and pass frozen-tag/timing/privacy mechanical verification, but **have not been human still-comparison-validated beyond the two local allowlisted HLG samples; narrow static HDR10 mechanical support implemented; visual correctness still requires real HDR10 human A/B on a calibrated Rec.709 display and is not claimed**; this remains an open risk and prevents any visual correctness claim.
