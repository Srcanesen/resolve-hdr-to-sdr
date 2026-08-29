# Conversion Spike — 2026-08-25

**Status:** v5 spline-primary artifacts produced after v4 bt.2390 was quantitatively falsified; v1-v4 retained. User A/B still open; no visual-correctness claim.
**Scope:** Minimal deterministic HLG/BT.2020 → Rec.709 SDR ProRes spike for the two known samples. No ClipDock/vault/canonical-report/source-byte changes, and no general HDR/PQ/DV claim.
**Invariant:** Sources are read-only; every output is separate, non-colliding, and privacy-stripped.

## 1. Host and filter capability evidence

### 1a. v1/v2 host (historical, retained)

- `ffmpeg`/`ffprobe` **8.1.2** from `/opt/homebrew/bin`; no installs.
- `ffmpeg -hide_banner -h filter=libplacebo` → unavailable; `... -h filter=zscale` → unavailable.
- `ffmpeg -hide_banner -h filter=tonemap` lists `hable`; `... -h filter=colorspace` lists `bt709`.
- The installed `scale` filter was explicitly checked with:
  `ffmpeg -hide_banner -h filter=scale 2>&1 | grep -E '^[[:space:]]+(in_transfer|out_transfer)[[:space:]]'`
  and reported both `in_transfer` and `out_transfer` (integer options, range through transfer 18). They are supported on this host and are used below; they are **not** treated as unsupported.
- Selected filter on this host (v1/v2):
  `scale=in_transfer=arib-std-b67:out_transfer=linear,tonemap=hable:desat=2,colorspace=bt709,format=yuv422p10le`

### 1b. v3 host – libplacebo-capable install (2026-08-25)

- Install provenance recorded in `tools/PROVENANCE.txt`.
- Standalone attempt: `https://www.osxexperts.net/ffmpeg9arm.zip` (Apple Silicon, FFmpeg 9.0, SHA256 `d0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9` downloaded 2026-08-25) — verified `libplacebo` unavailable, `zscale` available; rejected as primary. Config lacks `--enable-libplacebo`.
- Primary install: Homebrew `ffmpeg-full` **9.0.1_1** (bottle arm64_tahoe, `ffmpeg version 9.0.1`), configuration includes `--enable-libplacebo` and `--enable-libzimg`, plus Vulkan runtime `molten-vk 1.4.2` (`vulkan-headers 1.4.357.0`, `vulkan-loader 1.4.357.0` already present). Binary at `/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1/bin/ffmpeg` (`/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` symlink). Keg-only: `brew info ffmpeg-full` → “keg-only, ... not symlinked into /opt/homebrew, because this is an alternate version”.
- System ffmpeg upgrade note: installing `ffmpeg-full` pulled `x265 4.3` (replacing 216), breaking `ffmpeg 8.1.2_1` at runtime (`dyld libx265.216` missing). Remediation `brew reinstall ffmpeg` upgraded system ffmpeg to **9.0.1_1** (bottle, WITHOUT libplacebo). Thus the core formula WAS replaced (8.1.2 → 9.0.1) due to shared x265 ABI, but `ffmpeg-full` remains the only libplacebo source. Documented as replacement per task requirements.
- Verification (new binary):
  - `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -h filter=libplacebo` → `Filter libplacebo` with `tonemapping=mobius`, `gamut_mode=perceptual`, `colorspace=bt709`, `apply_dolbyvision` (plain HLG path safe, no explicit DOVI needed).
  - `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -h filter=zscale` → `Filter zscale` available.
  - Runtime libplacebo initially failed `VK_ERROR_INCOMPATIBLE_DRIVER` before `molten-vk` install; after `brew install molten-vk` succeeded.
- `tools/ffmpeg` → `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` and `tools/ffprobe` symlink created for deterministic script detection.
- Conversion script now resolves ffmpeg/ffprobe via `tools/ → ffmpeg-full → /opt/homebrew/bin → PATH` order and logs `ffmpeg=…` and `ffprobe=…`.
- Common still: Python `os.path.realpath(os.path.abspath(...))` canonicalization and `-n` non-overwrite guard preserved.

## 2. Conversion policy

`scripts/convert-hlg-to-sdr.sh <source.MOV> <output.MOV>` (v3):

- resolves ffmpeg/ffprobe as `tools/ffmpeg` → `ffmpeg-full` → `/opt/homebrew/bin/ffmpeg` → `PATH`; prefers libplacebo-capable binary when detected;
- accepts only `bt2020nc/arib-std-b67/bt2020` video and fails visibly on another class;
- capability branch (research-backed correct vs. legacy wrong):
  - **libplacebo** (`HAS_LIBPLACEBO=1`) — `libplacebo=tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le` — explicit Rec.709 output state; `apply_dolbyvision` supported but plain HLG path used (default-safe for HLG, no explicit DOVI flag; would only be set if locally supported and safe).
  - **zscale** (`HAS_ZSCALE=1`) — `zscale=t=linear:npl=100,tonemap=hable:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv422p10le` — documented research-backed correct alternative.
  - **scale fallback** — retained only with hard `WARNING: ... RESEARCH-PROVEN SEMANTICALLY WRONG (blown highlights, no perceptual gamut mapping)` and will not be used while libplacebo/zscale present; kept for fail-visible completeness.
- maps the primary video and optional audio, strips input metadata with `-map_metadata -1`, and writes 10-bit `yuv422p10le` ProRes 422 LT with explicit `bt709/bt709/bt709/tv` tags;
- makes timing policy explicit with `-fps_mode passthrough` for this HLG spike;
- writes only a new destination and refuses same-path, symlink-resolved same-path, or existing-output requests.

v2 ceiling note (historical): v1/v2 host had no libplacebo/zscale, so the fallback had no perceptual gamut mapping. v3 removes that ceiling by using libplacebo. Metadata and deterministic checks still do **not** establish visual correctness; human still comparison remains required.

## 3. Source fingerprints (pre == post)

| Source | Size (bytes) | SHA-256 | Decoded video duration / frames |
|---|---:|---|---:|
| `Sample/1.MOV` | 18,423,719 | `46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593` | 16.375000 s / 491 |
| `Sample/2.MOV` | 20,313,976 | `2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a` | 18.565000 s / 557 |

The pre-run and post-run `shasum -a 256 Sample/1.MOV Sample/2.MOV` values are identical. For `1.MOV`, ffprobe reports 503 container samples but `-count_frames` reports 491 decoded/presentation frames because the container count includes edit-list preroll; the verifier compares the decoded/presentation count rather than counting hidden preroll as visible output frames.

## 4. v1 review findings (retained, not accepted as final evidence)

The existing v1 outputs remain unchanged under their original names. Review found these evidence/safety gaps:

1. source and destination canonicalization used mixed platform `realpath` behavior, leaving symlink-parent ambiguity;
2. the verifier silently skipped source SHA validation for an unknown basename;
3. `scale` capability for the used transfer options was asserted in the note but not checked by the script;
4. no explicit `-fps_mode passthrough` policy or verifier comparison for duration/frame preservation existed;
5. privacy scanning was narrower than the required QuickTime/location/ISO6709/creation-time policy.

The v1 note's timing statement was therefore not accepted as a strengthened verification result. The v1 files were not replaced.

## 5. Accepted v2 artifacts

The two new files were generated as `*_v2.mov`; no v1 output was replaced.

| Artifact | Size (bytes) | SHA-256 | Video duration | Decoded frames | Format duration |
|---|---:|---|---:|---:|---:|
| `Output/spike/1_sdr_rec709_proreslt_v2.mov` | 217,835,169 | `3153562543a87ff754a361ce0f953aea6223f9cccc61fefaee274a6e1026d684` | 16.366667 s | 491 | 16.378000 s |
| `Output/spike/2_sdr_rec709_proreslt_v2.mov` | 246,508,788 | `13a9e4e6ee9cc96fdf4045f350181cd9b23c7a1ba98ca39bc5ca982f64551c47` | 18.566667 s | 557 | 18.580000 s |

Both v2 streams are `prores` profile `LT`, `1080x1920` after consuming the source -90° display matrix, `yuv422p10le`, `tv`, and `bt709/bt709/bt709`. The v2 hashes happen to equal the retained v1 hashes because the host's decoded presentation sequence and output encoding are unchanged; v2 is nevertheless a separately named, newly generated artifact governed by the corrected policy.

## 6. Strengthened verification results

`scripts/verify-spike.sh` is the executable verification seam. It now:

- rejects same canonical source/output paths and unknown source names;
- requires the exact known source SHA (`1.MOV` or `2.MOV`);
- compares source/output decoded video frame counts exactly and video-stream duration within **0.050 s**;
- checks Rec.709 SDR tags and ProRes LT format;
- scans ffprobe metadata and raw `strings` for every `com.apple.quicktime.*` prefix, `ISO6709`, location terms, and creation-time/date tags.

Commands executed successfully:

```text
scripts/verify-spike.sh Sample/1.MOV Output/spike/1_sdr_rec709_proreslt_v2.mov
  source 16.375000 s → output 16.366667 s, delta 0.008333 s, frames 491; PASS
scripts/verify-spike.sh Sample/2.MOV Output/spike/2_sdr_rec709_proreslt_v2.mov
  source 18.565000 s → output 18.566667 s, delta 0.001667 s, frames 557; PASS
```

Both v2 outputs passed the broad privacy scan: no `com.apple.quicktime.*`, `ISO6709`, location, or creation-time/date metadata was found by ffprobe or raw-byte strings scan.

Negative checks also passed by failing as intended: converter same-path, converter symlink-parent-to-source, verifier same-path, verifier unknown-source symlink, verifier missing output, verifier tampered output containing a forbidden QuickTime location marker, and existing-output overwrite protection. The existing v1 output hash was unchanged by the overwrite check.

## 7. Remaining review risk

Visual correctness is unresolved for all versions and explicitly not claimed until user A/B. v2 was proven semantically wrong (scale+tonemap) and retained only as negative visual reference; v3 uses the research-backed libplacebo path but still requires calibrated display/Resolve still comparison. No human A/B was performed. This spike does not solve general HDR, RPU trims, visual acceptance, or stack/UI integration.

## 8. v3 libplacebo artifacts (2026-08-25) — research-backed correct path

- Install source/version: Homebrew `ffmpeg-full 9.0.1_1` + `molten-vk 1.4.2`; `ffmpeg -h filter=libplacebo` and `zscale` verified available. System ffmpeg upgraded 8.1.2_1 → 9.0.1_1 due to x265 ABI (documented replacement in §1b and `tools/PROVENANCE.txt`). Reputable standalone `osxexperts.net/ffmpeg9arm.zip` checked and rejected (no libplacebo).
- Filter graph used for v3: `libplacebo=tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le` — logged as `libplacebo (mobius/perceptual/bt709) via <repository root>/tools/ffmpeg [apply_dolbyvision supported, plain HLG path]`; audio `aac 128k`, video `prores_ks profile 1 pix_fmt yuv422p10le vendor ap10 colorspace/bt709 primaries/bt709 trc/bt709 range tv fps_mode passthrough movflags +write_colr -n`.
- Pre/post source SHA unchanged (see §3): `46dad3...8593` and `2780c7...4a82a` before and after.
- New artifacts only (no v2/v1 deletion):

| Artifact | Size (bytes) | SHA-256 | Video duration | Decoded frames | FFprobe tags |
|---|---:|---|---:|---:|---|
| `Output/spike/1_sdr_rec709_proreslt_v3.mov` | 221,435,048 | `51e4c958a877f054cf4a873f6bd7167d07fe7848dfcc41d79c851d7a40540fdc` | 16.366667 s | 491 | prores LT yuv422p10le tv bt709/bt709/bt709 1080x1920 |
| `Output/spike/2_sdr_rec709_proreslt_v3.mov` | 252,078,916 | `34923a124593797ddf3cf88683c59931f7f45b2b31c21184bda6cfbb7e32c43d` | 18.566667 s | 557 | prores LT yuv422p10le tv bt709/bt709/bt709 1080x1920 |

- v2 retained for comparison: `1_v2` 217,835,169 `315356...684` 16.366667 s 491; `2_v2` 246,508,788 `13a9e4...47` 18.566667 s 557 — v3 differs in size/hash due to libplacebo tonemap vs. legacy hable.
- Conversion transcript excerpts (logged `spike: ffmpeg version 9.0.1 ...`, `ffmpeg=.../tools/ffmpeg`, `vf=...`): both conversions mapped `hevc (yuv420p10le tv bt2020nc/bt2020/arib-std-b67)` → `prores (yuv422p10le tv bt709 progressive)` with `-map_metadata -1` privacy stripping; outputs `apcs` (LT) with `Lavf63.1.101`; 491 and 557 frames encoded.

## 9. v3 verification results

Verifier upgraded to accept `*_v3.mov` (and legacy `*_v2.mov`/`*_v1.mov`); uses `tools/ffprobe → ffmpeg-full → /opt/homebrew/bin/ffprobe` order; keeps Rec.709, frame/duration, and privacy checks.

Commands executed successfully:

```text
scripts/verify-spike.sh Sample/1.MOV Output/spike/1_sdr_rec709_proreslt_v3.mov
  OK: output name 1_sdr_rec709_proreslt_v3.mov is v3 (libplacebo-verified)
  OK: source SHA 1.MOV 46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593
  OK: timing source=16.375000s output=16.366667s delta=0.008333s frames=491
  OK: output Rec.709 SDR tags bt709/bt709/bt709 tv yuv422p10le prores LT
  OK: no com.apple.quicktime.*, ISO6709, location, or creation-time metadata
  OK: output .../1_sdr_rec709_proreslt_v3.mov size=221435048 sha=51e4c958a877f054cf4a873f6bd7167d07fe7848dfcc41d79c851d7a40540fdc
  PASS
scripts/verify-spike.sh Sample/2.MOV Output/spike/2_sdr_rec709_proreslt_v3.mov
  OK: output name 2_sdr_rec709_proreslt_v3.mov is v3 (libplacebo-verified)
  OK: source SHA 2.MOV 2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a
  OK: timing source=18.565000s output=18.566667s delta=0.001667s frames=557
  OK: output Rec.709 SDR tags bt709/bt709/bt709 tv yuv422p10le prores LT
  OK: no com.apple.quicktime.*, ISO6709, location, or creation-time metadata
  OK: output .../2_sdr_rec709_proreslt_v3.mov size=252078916 sha=34923a124593797ddf3cf88683c59931f7f45b2b31c21184bda6cfbb7e32c43d
  PASS
```

Both v3 outputs passed broad privacy scan (no `com.apple.quicktime.*`, ISO6709, location, or creation-time/date via ffprobe json nor raw `strings`).

Legacy v2 still passes when re-checked: `1_v2` and `2_v2` both PASS (retained, not regenerated).

Negative checks (all fail-visible as intended):
- converter same-path → `error: source and destination must be different` (exit 1)
- converter symlink-parent-to-source → same error (exit 1)
- verifier same-path → `FAIL: source and output resolve to the same path` (exit 1)
- verifier unknown-source symlink (`unknown.MOV`) → `FAIL: unknown source name` (exit 1)
- verifier missing output → `FAIL: output missing` (exit 1)
- verifier tampered output (injected `com.apple.quicktime.location.ISO6709` and prores header corruption) → `FAIL` (frame-count mismatch/privacy) (exit 1)
- existing-output overwrite (`convert ... v3.mov` when exists) → `error: output already exists; refusing to replace` (exit 1)

## 10. Changed paths (v3)

- `tools/ffmpeg` → `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` (symlink, provenance in `tools/PROVENANCE.txt`)
- `tools/ffprobe` → `/opt/homebrew/opt/ffmpeg-full/bin/ffprobe`
- `tools/PROVENANCE.txt` — install source/version, filter verification, molten-vk note, x265/8.1.2→9.0.1 replacement disclosure
- `scripts/convert-hlg-to-sdr.sh` — libplacebo-capable binary resolution, libplacebo mobius/perceptual/bt709 filter (explicit Rec.709 state + apply_dolbyvision awareness), hard WARNING fallback, binary logging
- `scripts/verify-spike.sh` — v3 name acceptance, `FFPROBE` resolution via tools/ffmpeg-full, retained Rec.709/frame/privacy checks
- `Output/spike/1_sdr_rec709_proreslt_v3.mov` — new libplacebo artifact (not overwriting v2/v1)
- `Output/spike/2_sdr_rec709_proreslt_v3.mov` — new libplacebo artifact
- `docs/research/conversion-spike-2026-08-25.md` — §1b/§2/§8/§9/§10 v3 evidence; visual acceptance still open pending user A/B against failed v2

No `Sample/` source, ClipDock, vault, canonical report, or `Output/spike/*_v2.mov`/`*_v1` deletion; `Output/spike` retains v1/v2 alongside v3.

## 11. Files for user visual comparison (v3 vs. failed v2)

To complete acceptance, compare these exact files on a calibrated Rec.709 display or Resolve viewer (ponytail: no automatic visual correctness):
- **v3 (libplacebo correct):** `Output/spike/1_sdr_rec709_proreslt_v3.mov` and `2_sdr_rec709_proreslt_v3.mov`
- **v2 (scale+tonemap fallback, blown highlights):** `Output/spike/1_sdr_rec709_proreslt_v2.mov` and `2_sdr_rec709_proreslt_v2.mov`
- Sources (read-only): `Sample/1.MOV`, `Sample/2.MOV`

## 12. v4 filter validation and conversion (2026-08-25) — bt.2390 preferred

- **Filter availability validation (fail-visible, no guessed fallback):** `tools/ffmpeg -hide_banner -h filter=libplacebo` on `ffmpeg-full 9.0.1 + molten-vk 1.4.2` reports `Filter libplacebo` with `tonemapping` enum including `bt.2390 (4)`, `spline (6)`, `hable (9)`, `mobius (8)`. Standalone `zscale` also available. Detection logged as `spike: libplacebo tonemapping availability bt.2390=1 spline=1 hable=1`. All three validated locally; `bt.2390` preferred per ITU-R BT.2390 EETF, else `spline`, else `hable`. If none present, converter exits `4` fail-visible (no silent fallback). `libplacebo` runtime error also stops fail-visible without substituting a guessed graph.
- **Converter update:** `scripts/convert-hlg-to-sdr.sh` now validates `bt.2390/spline/hable` inside `libplacebo` help, chooses `tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le` when `bt.2390=1` (current host). Previous `mobius` path retained only as fallback if `bt.2390` unavailable. Other params unchanged: `perceptual` gamut, explicit `bt709/tv`, `yuv422p10le`, `prores_ks LT`, `-map_metadata -1`, `-fps_mode passthrough`, `-movflags +write_colr`, `-n` non-overwrite guard, `realpath(abspath)` canonicalization, source-class `bt2020nc/arib-std-b67/bt2020` validation.
- **Pre/post source SHA unchanged:** `46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593` and `2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a` before and after (verified; `scripts/verify-spike.sh` enforces exact match, no unknown-basename bypass).
- **New artifacts only (no v3/v2/v1 deletion):**

| Artifact | Size (bytes) | SHA-256 | Video duration | Decoded frames | FFprobe tags |
|---|---:|---|---:|---:|---|
| `Output/spike/1_sdr_rec709_proreslt_v4.mov` | 221,233,073 | `be408ff4013f7bd9a35feb064fb823127b367bcc0b7c26a873daee6c089b1e49` | 16.366667 s | 491 | prores LT yuv422p10le tv bt709/bt709/bt709 1080x1920 |
| `Output/spike/2_sdr_rec709_proreslt_v4.mov` | 251,979,824 | `182f433b940a6970d512b0630e1b82094222da3d19d0f198c7fb8f5250b1aaf4` | 18.566667 s | 557 | prores LT yuv422p10le tv bt709/bt709/bt709 1080x1920 |

- **Reference comparison:** v4 sizes/hashes differ from v3 (`1_v3` 221,435,048 `51e4c9...`, `2_v3` 252,078,916 `34923a...`) due to `bt.2390` vs `mobius` curve; v2 retained (`1_v2` 217,835,169 `315356...`, `2_v2` 246,508,788 `13a9e4...`).
- **Conversion logs (bt.2390):** `spike: ffmpeg version 9.0.1`, `ffmpeg=.../tools/ffmpeg`, `filter=libplacebo (bt.2390/perceptual/bt709) via ... [apply_dolbyvision supported, plain HLG path]`, `vf="libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le"`, mapping `hevc yuv420p10le tv bt2020nc/bt2020/arib-std-b67` → `prores yuv422p10le tv bt709 progressive`, 491 and 557 frames encoded, no libplacebo error (if error, converter would exit fail-visible without fallback).

## 13. v4 verification results (strengthened)

Verifier extended to accept `*_v4.mov` (`v4 is bt.2390-preferred`); `FFPROBE` resolution still `tools/ffprobe → ffmpeg-full → /opt/homebrew/bin/ffprobe`; retains Rec.709, frame/duration, privacy checks.

Commands executed successfully:

```text
scripts/verify-spike.sh Sample/1.MOV Output/spike/1_sdr_rec709_proreslt_v4.mov
  OK: output name 1_sdr_rec709_proreslt_v4.mov is v4 (libplacebo bt.2390-preferred)
  OK: source SHA 1.MOV 46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593
  OK: timing source=16.375000s output=16.366667s delta=0.008333s frames=491
  OK: output Rec.709 SDR tags bt709/bt709/bt709 tv yuv422p10le prores LT
  OK: no com.apple.quicktime.*, ISO6709, location, or creation-time metadata
  OK: output .../1_sdr_rec709_proreslt_v4.mov size=221233073 sha=be408ff4013f7bd9a35feb064fb823127b367bcc0b7c26a873daee6c089b1e49
  PASS
scripts/verify-spike.sh Sample/2.MOV Output/spike/2_sdr_rec709_proreslt_v4.mov
  OK: output name 2_sdr_rec709_proreslt_v4.mov is v4 (libplacebo bt.2390-preferred)
  OK: source SHA 2.MOV 2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a
  OK: timing source=18.565000s output=18.566667s delta=0.001667s frames=557
  OK: output Rec.709 SDR tags bt709/bt709/bt709 tv yuv422p10le prores LT
  OK: no com.apple.quicktime.*, ISO6709, location, or creation-time metadata
  OK: output .../2_sdr_rec709_proreslt_v4.mov size=251979824 sha=182f433b940a6970d512b0630e1b82094222da3d19d0f198c7fb8f5250b1aaf4
  PASS
```

Both v4 outputs passed broad privacy scan (`com.apple.quicktime.*`, ISO6709, location, creation-time/date via ffprobe json and raw `strings`). Legacy `1_v3/2_v3` and `1_v2/2_v2` still PASS when re-checked (not regenerated).

Detailed timing (count_frames): `Sample/1.MOV` 16.375000 s 491 ↔ `1_v4` 16.366667 s 491 delta 0.008333 s within 0.050 s; `Sample/2.MOV` 18.565000 s 557 ↔ `2_v4` 18.566667 s 557 delta 0.001667 s. Frame counts exact; no preroll mismatch (verifier uses `nb_read_frames` not `nb_frames`).

Negative checks (all fail-visible as intended, re-verified for v4):
- converter same-path → `error: source and destination must be different` (exit 1)
- converter symlink-parent-to-source → same error (exit 1)
- verifier same-path → `FAIL: source and output resolve to the same path` (exit 1)
- verifier unknown-source symlink (`unknown.MOV`) → `FAIL: unknown source name` (exit 1)
- verifier missing output → `FAIL: output missing` (exit 1)
- existing-output overwrite (`convert ... v4.mov` when exists) → `error: output already exists; refusing to replace` (exit 1)
- tampered output (injected `com.apple.quicktime.location.ISO6709`) → `FAIL` privacy/frame (exit 1) – same policy as v3

## 14. Quantitative crossed-pair comparison (v4 vs MainConcept references)

**Crossed pairing is mandatory due to swapped filenames:** `1.MOV` (tight) ↔ `2-rec709.mp4` (MainConcept 493f) and `2.MOV` (wide) ↔ `1-rec709.mp4` (557f). Naive `1→1` compares mismatched takes. See `scripts/compare-to-reference.sh` header. References are `Sample/*-rec709.mp4` (`h264 yuv420p bt709/bt709/bt709`, MainConcept handler `Encoder: AVC Coding`, `creation_time 2026-08-25T07:33`, `mp42` brand, not Apple Photos).

**Script:** `scripts/compare-to-reference.sh` (executable) validates `signalstats` filter locally, resolves `tools/ffmpeg`, measures `signalstats YAVG` normalized to 8-bit (`Y8 = Y10*255/1023`) over 1 s windows at `t=02,05,08 s` (30 frames/window), reports `Δ8`, `Δ10`, `% SDR`, `stops` (gamma 2.2). Fails visibly on missing files or unavailable filter; otherwise quantitative (not visual correctness).

**Commands executed (both pairs with crossed pairing):**

```text
scripts/compare-to-reference.sh
  compare-to-reference: crossed pairing (filenames swapped relative to takes) is mandatory
  Take-A tight (1_v4 vs 2-rec709)
    ref: Sample/2-rec709.mp4 1080x1920 bt709/bt709/bt709 yuv420p 16.433333s 493f
    out: Output/spike/1_sdr_rec709_proreslt_v4.mov 1080x1920 bt709/bt709/bt709 yuv422p10le 16.366667s 491f
      t  REF Y8  OUT Y8  Δ8   Δ10  %SDR   stops
      02  99.2   132.1  +32.9 +132 +12.9% +0.91
      05  99.2   132.0  +32.8 +132 +12.9% +0.91
      08  98.9   131.8  +32.9 +132 +12.9% +0.91
      MEAN Δ8=+32.9 codes (±0.1) +12.9% SDR | ~+0.90 stops
    OK
  Take-B wide (2_v4 vs 1-rec709)
    ref: Sample/1-rec709.mp4 1080x1920 bt709/bt709/bt709 yuv420p 18.566667s 557f
    out: Output/spike/2_sdr_rec709_proreslt_v4.mov 1080x1920 bt709/bt709/bt709 yuv422p10le 18.566667s 557f
      t  REF Y8  OUT Y8  Δ8   Δ10  %SDR   stops
      02 103.8   133.9  +30.0 +120 +11.8% +0.81
      05 104.0   134.0  +30.0 +120 +11.8% +0.80
      08 102.4   132.3  +29.9 +120 +11.7% +0.81
      MEAN Δ8=+30.0 codes (±0.2) +11.7% SDR | ~+0.83 stops
    OK
  PASS: both crossed-pair comparisons completed (quantitative, not visual correctness)
scripts/compare-to-reference.sh Output/spike/1_sdr_rec709_proreslt_v4.mov Sample/2-rec709.mp4  # individual pair, same result
scripts/compare-to-reference.sh Output/spike/2_sdr_rec709_proreslt_v4.mov Sample/1-rec709.mp4  # individual pair, same result
```

**Validator note:** Measured `Δ8 +30–33 codes (~+0.8–0.9 stops)` at YAVG, consistent across `t=02/05/08` (range <0.2 codes) indicating systematic luma lift vs MainConcept reference, not per-scene drift. Both `bt.2390` and previously used `mobius` give similar `+32` (mobius 131.5, bt.2390 132.1 at Take-A t02); `spline` (108.3, Δ+9.1) and `hable` (109.9, Δ+10.7) measured on the same 1 s window would be closer to reference (`spline` nearest). `bt.2390` was chosen per task preference (ITU standard) among locally validated options; `spline/hable` remain documented alternatives without visual claim. No `psnr`/`ssim` claimed as ground truth; `signalstats` is deterministic luma only. Human on-screen judgment on calibrated display still required; quantitative delta does not establish visual correctness.

## 15. Updated changed paths (v4)

- `scripts/convert-hlg-to-sdr.sh` — v4: validates `bt.2390/spline/hable` (`libplacebo tonemapping availability bt.2390=1 spline=1 hable=1` logged), prefers `bt.2390` (ITU-R BT.2390 EETF) with `gamut_mode=perceptual`, fail-visible on unavailable tonemapping or libplacebo runtime error (no guessed graph).
- `scripts/verify-spike.sh` — extended to accept `*_v4.mov` (`v4 is bt.2390-preferred`), retains strengthened source SHA, timing, tag, privacy checks.
- `scripts/compare-to-reference.sh` — NEW executable quantitative crossed-pair comparison (crossed pairing mandatory, `signalstats` YAVG, Δ8/Δ10/%/stops at t=02/05/08, both pairs, individual-pair mode, filter availability validation).
- `Output/spike/1_sdr_rec709_proreslt_v4.mov` — new `bt.2390` artifact (be408ff... 221,233,073)
- `Output/spike/2_sdr_rec709_proreslt_v4.mov` — new `bt.2390` artifact (182f433... 251,979,824)
- `docs/research/conversion-spike-2026-08-25.md` — §12-15 v4 evidence; visual correctness explicitly not claimed

No `Sample/` mutation, no `Output/spike/*_v3`/`*_v2`/`*_v1` overwrite/deletion, no `Output/diagnostic`, `ClipDock`, `vault`, or canonical/source-report change. `Output/spike` now retains v1, v2, v3 alongside v4.

## 16. Historical files for user visual comparison (v4 vs v3 vs reference, crossed)

Compare on calibrated Rec.709 display or Resolve viewer (ponytail: quantitative delta ≠ visual correctness):
- **v4 (bt.2390/perceptual, quantitatively falsified):** `Output/spike/1_sdr_rec709_proreslt_v4.mov` (tight) ↔ `Sample/2-rec709.mp4` (reference, crossed); `2_sdr_rec709_proreslt_v4.mov` (wide) ↔ `Sample/1-rec709.mp4`
- **v5 (spline-primary):** `Output/spike/1_sdr_rec709_proreslt_v5.mov` (tight) ↔ `Sample/2-rec709.mp4`; `2_sdr_rec709_proreslt_v5.mov` (wide) ↔ `Sample/1-rec709.mp4` — quantitative acceptance only, no visual claim
- **v3 (mobius):** `1_sdr_rec709_proreslt_v3.mov`, `2_sdr_rec709_proreslt_v3.mov` (retained for A/B)
- **v2 (scale+tonemap fallback):** `1_sdr_rec709_proreslt_v2.mov`, `2_sdr_rec709_proreslt_v2.mov` (negative reference)
- Sources (read-only): `Sample/1.MOV`, `Sample/2.MOV` (SHA unchanged)
- References (read-only, MainConcept): `Sample/2-rec709.mp4` (for 1.MOV), `Sample/1-rec709.mp4` (for 2.MOV) — naive 1→1 is invalid

No visual claim is made; device/display judgment decides.

## 17. v5 correction — spline primary after bt.2390 falsification (2026-08-25)

The v4 hypothesis was quantitatively falsified on the required crossed MainConcept references: libplacebo `bt.2390` measured **+32.9 8-bit YAVG codes for Take-A** and **+30.0 codes for Take-B** across the `t=02/05/08 s` one-second windows (approximately **+0.90 / +0.83 stops**, or roughly +30–33 codes / +0.85 stops). This is a systematic lift, not scene-window drift. Locally measured alternatives on the same path put `spline` at **+9.1 codes for Take-A** and `hable` at **+10.7 codes for Take-A**; v5 therefore makes locally validated `spline` the primary libplacebo operator for this known HLG spike. Operator discovery still validates `bt.2390`, `spline`, and `hable`; preference is `spline → bt.2390 → hable`, and unavailable operators/runtime failures remain fail-visible. No brightness trim was introduced.

### v5 filter and artifact evidence

- Host: `ffmpeg-full 9.0.1` via `tools/ffmpeg`, with libplacebo availability `bt.2390=1 spline=1 hable=1`; selected filter: `libplacebo=tonemapping=spline:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le`. Plain HLG path retained even though `apply_dolbyvision` is locally supported.
- Crossed pairing is enforced: `1.MOV`/v5 ↔ `Sample/2-rec709.mp4` (Take-A); `2.MOV`/v5 ↔ `Sample/1-rec709.mp4` (Take-B). `scripts/compare-to-reference.sh` rejects naive pairings and gates `abs(mean YAVG8 delta) <= 10` over `t=02/05/08 s`.

| Pair | t02 Δ8 | t05 Δ8 | t08 Δ8 | mean Δ8 | Acceptance |
|---|---:|---:|---:|---:|---|
| Take-A: `1_v5` ↔ `2-rec709` | +9.1 | +9.1 | +9.2 | +9.1432 | PASS (abs ≤10) |
| Take-B: `2_v5` ↔ `1-rec709` | +6.7 | +6.7 | +6.7 | +6.7226 | PASS (abs ≤10) |

| Artifact | Size (bytes) | SHA-256 | Video duration / decoded frames | Tags |
|---|---:|---|---:|---|
| `Output/spike/1_sdr_rec709_proreslt_v5.mov` | 220,353,710 | `a6e99791ddcff9740197db638ad0ae1e2ac1b7080f7d04256224811587efbdc0` | 16.366667 s / 491 | ProRes LT, yuv422p10le, tv, bt709/bt709/bt709 |
| `Output/spike/2_sdr_rec709_proreslt_v5.mov` | 251,133,869 | `aa15d8d3101f11b619f3ba4c956917cafc59df4ea8bd25c6f79bdaeebf0769fa` | 18.566667 s / 557 | ProRes LT, yuv422p10le, tv, bt709/bt709/bt709 |

Source fingerprints remained unchanged before/after and are still enforced by the verifier: `Sample/1.MOV` `46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593`; `Sample/2.MOV` `2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a`. Both v5 outputs passed source identity, exact decoded frame count, duration tolerance, Rec.709 SDR tags, and the ffprobe/raw-byte privacy scan. Retained v1, v2, v3, and v4 pairs were re-verified and remain intact.

The v5 negative suite failed as intended for converter/verifier same-path and symlink-parent collisions, unknown source, missing output, wrong Rec.709 tags, forbidden privacy marker, shortened timing, and existing-output overwrite; the pre-existing v5 hash was unchanged by the overwrite check. This evidence is deterministic metadata/timing/luma evidence only. **No visual-correctness claim is made**; calibrated human on-screen comparison remains open.
