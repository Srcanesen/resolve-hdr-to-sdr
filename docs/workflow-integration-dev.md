# Workflow Integration — Developer Bundle (HdrToSdr)

> Developer-only, no auto-install. Not a production release. The npm Electron runtime is pinned exactly to `41.10.3`.

## Plugin Identity

- **Id** `com.hdrtosdr.app`
- **Name** `HdrToSdr`
- **Version** `0.1.0`
- **Description** `Verified HDR to Rec.709 SDR conversion`
- **FilePath** `main.js`

Manifest is generated exactly with those values. Any divergence fails the build.

## Build (reproducible, portability-gated)

The SDK provenance manifest is `scripts/workflow-integration-provenance.json`.
It pins the Resolve **21.0.3** WorkflowIntegration SDK node, SHA-256
`91705298c56b649a75bf76be101fea28fbe41b1e88adf4778490ce8b2d14b3e2`,
`Identifier=com.blackmagic-design.WorkflowIntegration`, and
`TeamIdentifier=9ZGFBWLSYP`. On Darwin, both the official source and the
bundled copy must pass `codesign --verify --deep --strict` and the parsed
`codesign -dv --verbose=4` identity check before the copy is accepted.

```bash
npm run bundle:resolve
```

Output on a passing build:

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

- `WorkflowIntegration.node` is copied **only** from the pinned official
  Resolve 21.0.3 SDK path in the provenance manifest. The source and bundle
  must match the manifest SHA-256, and the Darwin source/bundle provenance
  checks must pass. No ClipDock source.
- `tools/ffmpeg` and `tools/ffprobe` are dereferenced (symlink resolved, file copied, `chmod 755`), not symlinks, and remain executable regular files in the bundle.
- On Darwin, the bundle audit runs bounded `file -b`, `lipo -archs`, and
  `otool -L` calls via `execFileSync` argument arrays with no shell against
  `WorkflowIntegration.node`, `tools/ffmpeg`, and `tools/ffprobe`; the native
  node also gets the manifest hash and codesign identity checks.
- Each inspected runtime binary must be Mach-O and contain both `x86_64` and `arm64` slices. Every dylib dependency must be `/usr/lib`, `/System/Library`, or an `@rpath/`, `@loader_path/`, or `@executable_path/` reference; other absolute paths fail the build.
- Only the runtime allowlist in `scripts/bundle-audit.cjs` is copied; tests, caches, web assets, and unrelated scripts are excluded.
- `scripts/verify-spike.sh` is included as executable regular.
- No file in the bundle is a symlink (walk with `lstat` fails if any symlink, including a cycle).
- Bundle hashes are computed in bounded chunks; no whole-file hash buffer is loaded into memory.
- No file contains the source repository absolute path (e.g., `/Users/.../HdrToSdr`).
- Missing inputs, non-executable tools, non-Darwin hosts, non-universal Mach-O inputs, disallowed dylib dependencies, or failed file/dir checks fail visibly (`BUILD FAILED` + non-zero exit).
- The current local tools are known not to pass this gate: the SDK node is universal and Developer ID signed, while both Homebrew `ffmpeg`/`ffprobe` inputs are arm64-only/ad-hoc and link to absolute `/opt/homebrew/...` dylibs. Do not call the bundle self-contained until replacement universal, relocatable tools are provisioned.
- Build **does not** auto-install to `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/`. Manual copy is required only after a passing build for host smoke (see below).

### Intentional SDK upgrades

Do not update the native node by copying a convenient local file. For an
intentional Resolve SDK upgrade, first install and inspect the official SDK for
the target Resolve version, then update `resolveVersion`, `sdkPath`, `sha256`,
and (only if the vendor changes them) `identifier`/`teamIdentifier` in
`scripts/workflow-integration-provenance.json`. Re-run the source and bundle
provenance tests, `npm run check`, and the Darwin audit; keep
`releaseEnabled: false` until the separate binary release gates pass.

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

## Opt-in Real-Media Integration Harness

```bash
npm run test:media:integration
```

This is separate from `npm run check` and is the only command in this scope that
runs real transcodes. For this opt-in local test it resolves repo-local
`tools/ffmpeg` and `tools/ffprobe` with `realpath` and requires the canonical
target to be a regular executable (mirroring `tool-doctor`; broken or
non-regular targets remain `not_regular`), then runs the existing capability
checks (`libx265`/`hevc_metadata`) and reports `portable:false` and
`resolved_external_tool:true` without exposing the real path. It
creates/chmods all synthetic fixtures under one `0700` owned temp directory
(`0600` files). Every child is spawned with an argv array, `shell:false`,
bounded stdout/stderr, a hard timeout, and owned process-group cleanup. The
generated generic HLG and static PQ/HDR10 fixtures exercise the real inspector,
`b-executor`, and verifier. The attached-picture/audio-first fixture requires
first-real-video frame evidence and records the `0:V:0` mapping, presentation
dimensions, and audio policy. Rotation and VFR are read back mechanically; an
unsupported MP4 rotation is `not_run` with its exact reason, not a pass. Dolby
Vision and HDR10+ are never PASS: without an already verified repo-local
`dovi_tool`/`hdr10plus_tool`, each is `not_run`/`tool_unavailable`. The command
emits one sanitized JSON summary and removes its temp directory in a `finally`
path; it never writes `Sample/` or `Output/` and does not download media or
tools. Bundle/runtime portability gates are unchanged — `npm run
bundle:resolve` still rejects symlink/dynamic thin tools.

Actual local run (2026-08-29): **PASS via safe canonicalized local-dev tools.**
Repo-local symlinks (`tools/ffmpeg`/`ffprobe` → `ffmpeg-full 9.0.1` with
`libplacebo`/`molten-vk`) were resolved with `realpath` to regular executable
targets, capability probes passed, and the harness executed. Sanitized summary:
`portable:false` `resolved_external_tool:true`, `genericHlg`/`staticPq`/
`attachedPictureAudioFirst`/`vfr` `pass`, `rotation`
`not_run`/`rotation_metadata_not_preserved_by_ffmpeg_mp4` (acceptable edge),
dynamic `dolbyVision`/`hdr10Plus` `not_run`/`tool_unavailable`, cleanup
`pass` residue `0`; no path was exposed and no media was written to
`Sample/`/`Output/`.

## Host Lifecycle (inside Resolve)

When `WorkflowIntegration.node` is present next to `main.js`, `electron/main.cjs` runs in host mode:

- `startApp(options)` is the exported guarded entry; standalone auto-starts only when `require.main === module`. It reuses a single `BrowserWindow` / `bootstrap` / `ConversionService`.
- Ordered lifecycle: `Initialize('com.hdrtosdr.app')` → `SetAPITimeout(10)` → `RegisterCallback('ResolveQuit', quit)`. Any failure fails closed with generic startup failure (`Startup failed`) and quits.
- `CleanUp` is called exactly once during `before-quit`; if initialization succeeds but a later lifecycle call fails, partial host state is cleaned up once before fail-closed exit.
- Window `close` quits the app.
- `before-quit` calls `event.preventDefault()` once, awaits bounded `ConversionService.dispose()`, calls host `CleanUp()` once, removes only its own listener, and resumes `app.quit()` without recursion. `ConversionService` disposes inspection, conversion, verifier, capability-probe, and thumbnail work; active jobs terminalize as cancelled. Disposal and terminal cleanup are idempotent.
- Inspection and conversion share one heavy-operation reservation, so neither can begin while the other is active. Conversion reserves synchronously before source revalidation; accepted starts return before queued/terminal events are deferred to the next turn.
- Inspector, converter, verifier script, capability probes, and thumbnail decoders use `detached:true`, `shell:false`, and bounded stdio. The coordinator records detached POSIX group ownership, sends one group SIGTERM, waits configurable bounded grace, then sends group SIGKILL only if the group remains alive; unsafe/unproven groups use direct-child TERM/KILL fallback without negative PIDs. Total/stall watchdogs and abort signals share that cleanup path. Safe timeout/stall event reasons are `conversion_timeout`, `conversion_stalled`, `verification_timeout`, and `verification_stalled`; the renderer maps them to the existing generic failure copy.
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
  - Kept in `PROFILES` / `ALLOWED_PROFILE_IDS` with `isKnownProfileId(profileId)` and `getFilterGraph(profileId)`; unknown `profileId` fails closed at IPC (`isValidConvertStartRequest`/`isValidConvertEvent`/`validateCliResponse`), at `ConversionService` (`revalidateSourceToken` enforces classification↔profile pairing: `hlgKnownLocal`↔`hlg-local-b-v1`, `hlgSupported`↔`hlg-rec709-v1`, `pqSupported`↔`pq-rec709-v1` with `sha256`/`size` re-check), and at executor (`buildFfmpegArgs(..., profileId)` / `runBConversion({..., profileId})` throws/`invalid_request` on unknown, reuses single `spawn` path). Inspector detects `MDCV`/`CLLI` from stream side_data_list AND a bounded initial probe interval (`-read_intervals 0%+1 -show_frames` within existing single argv/no-shell call and timeout/identity checks) and `has_hdr10plus` separately from Dolby; boolean presence sufficient for v1 (no broad numeric claim, no raw frame/path leak).
- **Python classification (`prototype/classifier.py` + `contracts.py`):** `hlgKnownLocal` unchanged allowlist; `hlgSupported` is generic HLG only when `parse_ok` && not `unspecified`/`contradictory` && exact `bt2020nc`/`arib-std-b67`/`bt2020` + `tv` && known ≥10-bit YUV `pix_fmt` via explicit small allowlist && `has_dovi==false`. `pqSupported` is narrow static HDR10 only when `parse_ok` && not `unspecified`/`contradictory` && exact `bt2020nc`/`smpte2084`/`bt2020` + `tv` && `≥10-bit` allowlist && `has_dovi==false` && `has_hdr10plus==false` && `has_mdcv && has_clli` (both MDCV+CLLI). No SHA/codec/container gate. PQ missing either metadata remains `pqHdr10Unsupported`/`canConvert:false` with safe reason; DOVI takes precedence (`dolbyVisionUnsupported`); HDR10+ (`hdr10plus`/`st2094-40`) remains unsupported/fail-closed; HLG behavior and frozen graphs unchanged. No SHA/basename/codec/container required for generic/PQ.
- **Renderer / IPC (`electron/ipc-contract.cjs` → `inspection-adapter.cjs` → `renderer/app.js`):** `isValidResponse`/`validateCliResponse` now allow `hlgSupported`/`pqSupported` + all three `profileId`s; eligibility (`isEligibleResult`) considers `hlgKnownLocal`/`hlgSupported`/`pqSupported` with `canConvert:true` + non-empty `sourceId`/`profileId` (main validates literals, renderer stays generic to avoid embedding frozen IDs); technical `Format` shows `HLG` for HLG, `PQ / HDR10` for `pqSupported`/`pqHdr10Unsupported` (PQ-supported can convert and format says `PQ / HDR10`; missing metadata stays unsupported); no visual redesign. `ConversionService.createSourceToken` mints opaque `sourceId` for all three; reinspection re-validates classification↔profile and `sha256`/`size` and enforces `profileId` pairing/token minting.
- **Executor / verifier generalization:** `b-executor.cjs` routes strictly by `profileId` (centralized map, no duplicate process logic; `checkCapability` uses asynchronous `spawn(..., {shell:false})` probes coalesced and cached per executable identity/profile, and for PQ requires `bt.2390`+`perceptual`+`peak_detect` and for all profiles requires `libx264`+AAC via argv/no-shell probes; capability failure → `profile_unavailable`); `b-executor.cjs` builds locked H.264 MP4 contract: `libx264` High preset medium CRF 18 `yuv420p` with explicit `bt709`/`tv`, AAC 192k `-map 0:a?`, `-movflags +faststart+write_colr`, `-fps_mode passthrough`, metadata/chapters stripped, `-n`; conversion and thumbnail mapping use `0:V:0`, the first real non-attached video. `conversion-service.cjs` allocates `buildDisplayName(base, profileId)` → `_sdr_rec709_h264_<profile>.mp4` (staging `_*.partial.mp4` valid for MP4 muxing) and spawns `verify-spike.sh <src> <dst> <profileId>` with `spawn(..., [src, dst, profileId], {shell:false})` (argv-safe, profile routing/capability). `prototype/evidence.py` is the shared pure selector/normalizer used by inspection and `electron/verify_contract.py`: first file-order `codec_type=video` with strict `attached_pic != 1`, selected-stream frames only; generic HLG and PQ re-gates reject selected-frame `DOVI`/`HDR10+`, with PQ requiring both `MDCV`+`CLLI`. `scripts/verify-spike.sh` uses uppercase `V:0` for real video and delegates source evidence to the shared helper; it also retains `source!=output`, timing/frame/presentation-dimension checks, the documented audio policy (all source audio streams retained in order as AAC, or no audio track when absent), Rec.709 H.264 High tags (`bt709`/`tv`/`yuv420p`/`h264`/`High`), bounded HDR side-data evidence, semantic privacy-tag checks (`com.apple.quicktime.*`/`ISO6709`/creation-time), and atomic no-clobber commit. Verified final outputs are fingerprinted and revalidated before drag/thumbnail. `outputStore.allocateUniqueFinalPath` collision loops remain bounded and `buildDisplayName(..., profileId)` includes profile suffix.
- **Visual-validation limit (truthful):** Generic BT.2390 and narrow static HDR10 mechanical support are implemented and metadata-gated, but visual correctness still requires real HDR10 human A/B on a calibrated Rec.709 display and is not claimed (narrow static HDR10 mechanical support implemented; visual correctness still requires real HDR10 human A/B and is not claimed).

## Bounded Resolve `-nogui` API Smoke

The live smoke is explicit and separate from the normal offline checks:

```bash
npm run test:resolve:headless
```

It refuses any already-running `Resolve` or `fuscript`, generates a one-frame
fixture using repo-local `tools/ffmpeg`, launches the exact Resolve bundle binary
directly with `-nogui`, and sets the official scripting environment variables.
Only a uniquely named scratch project is created; only the owned fixture is
imported with `MediaStorage.AddItemListToMediaPool`, then one timeline is created
with `MediaPool.CreateTimelineFromClips`. The worker reads only bounded version,
clip/property, and timeline evidence, proves the Resolve child PID before each
mutation and before `Quit`, closes/deletes the scratch project in `finally`, and
removes the temporary media. Cleanup is bounded TERM→KILL and the command fails
on any project, media, Resolve, or fuscript residue. It never uses `open -a` and
is not part of `npm run check`.

Approved local run result: **PASS** — Resolve `21.0.3.7`; imported clip count `1`,
name `hdrtosdr_resolve_smoke_fixture.mp4`, duration `00:00:01:00`, resolution
`16x16`, codec `H.264 High L1.0`, fixture path match `true`; timeline count `1`,
item count `1`; project closed/deleted, media deleted, owned quit requested,
PID proofs `true`, Resolve residue `0`, fuscript residue `0`.

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
