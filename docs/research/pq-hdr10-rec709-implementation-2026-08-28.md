# PQ/HDR10 → Rec.709 SDR Implementation Decision — 2026-08-28

**Date (UTC):** 2026-08-28
**Scope:** Primary-source implementation decision for a **separate PQ/HDR10 profile** (`pq-rec709-v1`). Read-only inspection of installed FFmpeg 9.0.1 libplacebo/zscale, local repo constraints, and authoritative ITU/CTA/SMPTE guidance. No code edits; no HLG/Dolby implementation; no guessed graph.
**Host baseline (read-only, installed):** `tools/ffmpeg` → `ffmpeg-full 9.0.1_1` (Homebrew bottle arm64_tahoe, `ffmpeg version 9.0.1`) + `molten-vk 1.4.2` — see `tools/PROVENANCE.txt`. `tools/ffprobe` sibling. System `ffmpeg` 9.0.1 without libplacebo preserved as non-preferred. Verification via `tools/ffmpeg -hide_banner -h filter=libplacebo|zscale` (see §4).
**Existing HLG baseline:** Commit `00acbac` added `hlg-local-b-v1` (spline 0.45+eq gamma 0.90, allowlisted DOVI 8.4 HLG only) and `hlg-rec709-v1` (bt.2390/perceptual, generic non-Dolby HLG) — `electron/b-profile.cjs:1-33`, `prototype/classifier.py:106-145`, `scripts/verify-spike.sh`.
**How to read:** FACT = primary/official spec or locally inspected file/cmd output. INFERENCE = interpretation needing live verification. COMMUNITY = forum/blog anecdote (not used for gating).

---

## 0. One-line recommendation (bounded implement / no-implement)

**Verdict: CONDITIONAL IMPLEMENT — add distinct `pq-rec709-v1` only under the narrow v1 gate (§3) with the frozen libplacebo graph in §1; otherwise fail-closed `pqHdr10Unsupported`. NO visual-correctness claim — deterministic mechanical verification only.**

> Rationale: Installed `ffmpeg-full 9.0.1_1` with `libplacebo+zscale` and ITU BT.2390/BT.2408 EETF provides a defensible PQ→SDR path (FACT, §§1,6); generic HLG profile `hlg-rec709-v1` already proves the BT.2390/perceptual pipeline is deterministic on this host (FACT, `conversion-spike-2026-08-28.md` v5 spline vs v4 bt.2390 crossed comparison). PQ is **signal-distinct** from HLG (absolute PQ 0–10,000 nits vs relative HLG, `color_transfer smpte2084=16` vs `arib-std-b67=18`) and therefore **MUST NOT reuse** an HLG profile (invariant). A second distinct profile keeps blast radius bounded and makes `hlgLocalB`/`hlgSupported` behaviour unchanged.

If the narrow gate cannot be satisfied (missing MDCV/CLLI or contradictory/unspecified tags or `10-bit` evidence or libplacebo capability), the product **must** surface `pqHdr10Unsupported` with `canConvert=false` — no silent fallback, no `scale+tonemap` warning path.

---

## 1. Defensible libplacebo graph, options, and peak behavior

### 1a. Installed filter evidence (FACT — local `tools/ffmpeg` 9.0.1_1, 2026-08-28)

```
tools/ffmpeg -version → ffmpeg version 9.0.1 ... --enable-libplacebo --enable-libzimg --enable-videotoolbox
tools/ffmpeg -hide_banner -h filter=libplacebo → Filter libplacebo; AVOptions include:
  tonemapping {auto,clip,st2094-40,st2094-10,bt.2390,bt2446a,spline,reinhard,mobius,hable,gamma,linear}
  gamut_mode {clip,perceptual,relative,saturation,absolute,desaturate,darken,warn,linear} (default perceptual)
  tonemapping_param, inverse_tonemapping, tonemapping_lut_size (default 256), contrast_recovery (0–3, default 0.3), contrast_smoothness (1–32, default 3.5)
  peak_detect (bool default true), smoothing_period (default 20), scene_threshold_low 1.0 / high 3.0, percentile (default 99.995 high_quality, 100.0 true peak), black_cutoff 1.0
  colorspace {auto,gbr,bt709,bt2020nc...}, range {auto,limited/tv,mpeg,full/pc}, color_primaries, color_trc {bt709,smpte2084,arib-std-b67...}, apply_dolbyvision (default true)
tools/ffmpeg -hide_banner -h filter=zscale → Filter zscale; options: w/h, r/range {limited/full}, p/primaries, m/matrix, t/transfer, dither
tools/ffmpeg -hide_banner -h filter=tonemap → tonemap {hable,mobius,reinhard...}, param, desat
```
Exact excerpt lines captured in §4 smoke; full 120-line help archived via `tools/ffmpeg -hide_banner -h filter=libplacebo` (local, no URL).

**Peak behavior (FACT — ffmpeg.org / libplacebo.org):**

- `peak_detect=true` enables libplacebo's internal compute-shader frame analysis to estimate scene peak/average luminance when static metadata is absent or unreliable. FFmpeg docs 11.147.1.6: *"To help deal with sources that only have static HDR10 metadata (or no tagging whatsoever), libplacebo uses its own internal frame analysis compute shader to analyze source frames and adapt the tone mapping function in realtime. If this is too slow, or if exactly reproducible frame-perfect results are needed, it’s recommended to turn this feature off."* — https://ffmpeg.org/ffmpeg-filters.html#libplacebo (accessed 2026-08-28 via `curl -s https://r.jina.ai/https://ffmpeg.org/ffmpeg-filters.html`) and https://libplacebo.org/options/#hdr-peak-detection (same).
- Defaults: `smoothing_period 20.0`, `scene_threshold_low 1.0 / high 3.0` (gradual low-pass disable on scene cut, units 1% PQ), `percentile 99.995` (high_quality) / `100.0` true peak, `black_cutoff 1.0` (1% PQ). With `peak_detect=true`, libplacebo **ignores** static `MaxCLL/MaxFALL` in favor of measured peak (FACT — `print_content_light_level` path still exposes static values but `peak_detect` guides internal mapping: ffmpeg docs 11.147.1.6).
- Deterministic alternative: `peak_detect=false` uses only static `MDCV Max luminances` + `CLL MaxCLL/MaxFALL` carried via side data `AV_FRAME_DATA_MASTERING_DISPLAY_METADATA` / `AV_FRAME_DATA_CONTENT_LIGHT_LEVEL` (see `fftools/ffprobe.c: print_mastering_display_metadata`, `print_context_light_level` — https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffprobe.c, accessed 2026-08-28). INFERENCE: Disabling `peak_detect` yields frame-perfect reproducibility at cost of flicker-risk on variable-peak content.

**ITU mapping context (FACT):**

- PQ is **absolute** EOTF 0–10,000 nits (SMPTE ST 2084), HLG is **relative/scene-referred** with system gamma dependent on `Lw` (ITU-R BT.2100-3 §2–3 — https://www.itu.int/rec/R-REC-BT.2100/en, Feb 2025; Report BT.2390-8 §5.3–5.4 — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2390-8-2020-PDF-E.pdf).
- Display mapping to lower peak (e.g., 100–203 nits SDR) uses **EETF** (electrical-electrical transfer function): hermite spline knee `KS = 1.5*maxLum - 0.5` rolled from `E1` normalized by mastering black/white luminances (BT.2390 Fig 18–20, BT.2408 Annex 5). libplacebo `bt.2390` **is** that EETF (`"EETF from ITU-R Report BT.2390, hermite spline roll-off with linear segment; knee offset configurable, default 1.0 vs spec 0.5"` — ffmpeg filters docs 11.147.1.7; confirmed locally `tonemapping 4 bt.2390`). `spline` is the two-polynomial pivot variant (pivot default 0.30 PQ).
- Operational reference white: aspirational `203 cd/m²` (BT.2408 Table 1, BT.2390 §10) — relevant for SDR/HDR junction consistency. libplacebo tonemap targets implicit SDR peak ~100–203 nits via `max_luma`/`MaxCLL` plus internal scaling; no explicit `target_peak` knob exists in `vf_libplacebo` on this host (FACT — absent from `ffmpeg -h filter=libplacebo` on 9.0.1_1).

### 1b. Recommended frozen profile (FACT-based, no guess)

**Profile ID:** `pq-rec709-v1` (distinct from `hlg-local-b-v1` and `hlg-rec709-v1`; must be added to `ALLOWED_PROFILE_IDS` / `PROFILES` in `electron/b-profile.cjs` and mirrored in `prototype/contracts.py:ALLOWED_PROFILE_IDS`, `prototype/classifier.py`).

**Frozen filter graph (single, deterministic, copy-paste):**

```
libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le
```

**Rationale (FACT → INFERENCE):**

- `bt.2390` is the **ITU-normative** PQ EETF for mastering-display→target-display mapping (BT.2390-8 §5.4, BT.2408 Annex 5). It is the intended algorithm for PQ absolute → SDR range compression.
- `gamut_mode=perceptual` (default) is the bidirectionally-balanced soft-knee + soft-clip (libplacebo.org/options) — closest to BT.2390's hue-preserving intent; other modes (`clip`, `saturation`) would distort chroma under highlight roll-off (INFERENCE).
- Explicit `colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709` forces Rec.709 SDR NCl Y′CbCr narrow-range tagging regardless of input; `format=yuv422p10le` preserves 10-bit processing path before final encode (historically `prores_ks profile 1` `yuv422p10le` ProRes LT `.mov` with `vendor ap10`/`+write_colr`; current locked contract is `libx264` High `yuv420p` `+faststart+write_colr` `.mp4` with AAC 192k — same filter suffix, different container/codec).
- No `tonemapping_param` pin: default `0.0` → curve's preferred `1.0` (libplacebo default) rather than spec `0.5`. Pinning to `0.5` would claim spec-compliance not validated visually; keep default and document the `1.0 vs 0.5` delta (FACT — ffmpeg docs note).
- No `eq=gamma` trim: HLG local-b trim `eq=gamma=0.90` was tuned for allowlisted DOVI 8.4 HLG only (`b-profile.cjs:5`); **must not** be applied to PQ (INFERENCE — different electro-optical chain).
- `apply_dolbyvision` stays at default `true` (libplacebo default) but is **inert** under narrow gate `has_dovi=false` (§3); if RPU ever present the gate fails-closed anyway.

**Peak choice (bounded):**

- **Default to `peak_detect=true` (omitted → enabled)** for PQ→SDR: real-world HDR10 often carries absent/placeholder MDCV/CLL, and dynamic content needs per-frame adaptation. This matches ffmpeg docs recommendation for static-only sources. Result is **non-bit-exact** across runs if scene cuts align differently, but perceptually smoother.
- Deterministic variant (`peak_detect=false`) is the auditable alternative if tests require frame-perfect hashing — gate to a follow-up ticket, not v1 default. Keep graph without explicit `peak_detect` token; document default.

**Fallback chain (must be visible, not silent):**

- If `libplacebo` capability fails, fall back to documented CPU path `zscale=t=linear:npl=100,tonemap=bt2390:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv` (INFERENCE — zscale `tonemap` supports `bt2390` in research notes; verify locally via `ffmpeg -h filter=zscale` + `tonemap` if needed) — but **fail-visible** with `profile_unavailable` if `bt.2390` not present in local `tonemap` enum. Never fall through to legacy `scale+tonemap+colorspace` `hable` warning path for PQ.

### 1c. What this graph does not do (explicit limits)

- No `contrast_recovery` pin (kept at default `0.3` unless visual A/B later justifies `0.0`); no `percentile` override; no `target_peak`/`npl` (no such knob in `vf_libplacebo` on this host — FACT).
- No inverse tone-mapping, no `tone_map_metadata` override; trusts `any` (default chooses HDR10 static if present, else CIE_Y from `peak_detect`).
- No Dolby Vision RPU handling: gate rejects `dv_profile`/`rpu_present` outright.

---

## 2. Numeric MDCV / CLLI ffprobe fields (container + bitstream, FACT — FFmpeg primary source)

**Spec anchors:** SMPTE ST 2086 (Mastering Display Color Volume) — primaries + white point + `max/min luminance`; CTA-861.3 §4.2 / ISO/IEC 23008-2 HEVC Annex D.2.28/D.3.28 (MDCV SEI) and D.2.35/D.3.35 (CLL SEI). Carriage via ISOBMFF `mdcv`/`clli` (`mov.c:6928/7009`) and HEVC `hvcC` SEI; libavutil exposes `libavutil/mastering_display_metadata.h`.

**ffprobe exposure (FACT — `fftools/ffprobe.c`, branch `master` 2026-08-28):**

- `AV_FRAME_DATA_MASTERING_DISPLAY_METADATA` / `AV_PKT_DATA_MASTERING_DISPLAY_METADATA` → `print_mastering_display_metadata()`:
  - `red_x`, `red_y`, `green_x`, `green_y`, `blue_x`, `blue_y`, `white_point_x`, `white_point_y` — each `AVRational` `num/den` with display primaries **÷ 50000** (ST 2086 / `libavutil/mastering_display_metadata.h: display_primaries[i][j]` as rational). Example: `34000/50000 = 0.68`.
  - `min_luminance`, `max_luminance` — each `AVRational` **÷ 10000** (nits × 10000). Example: `10000000/10000 = 1000 nits`, `50/10000 = 0.005 nits`. Guard: `has_primaries` / `has_luminance` flags gate printing.
- `AV_FRAME_DATA_CONTENT_LIGHT_LEVEL` / `AV_PKT_DATA_CONTENT_LIGHT_LEVEL` → `print_context_light_level()`:
  - `max_content` (`MaxCLL`) — `unsigned` **integer nits**, max single-pixel luminance in stream/frame.
  - `max_average` (`MaxFALL`) — `unsigned` **integer nits**, max frame-average luminance.
- Stream-level exposure (FACT — local 9.0.1): `ffprobe -v error -show_streams -show_frames -show_packets -of json` nests these under `side_data_list[]` / `side_data[]` with `side_data_type` `"Mastering display metadata"` and `"Content light level metadata"`. Container-level `mdcv` (24 bytes: `G/B/R primaries + white point ÷50000 + max/min ÷10000`) and `clli` (4 bytes `MaxCLL/MaxFALL`) also decode to the same side-data structs via `mov.c`.
- Absence ≠ 0: missing MDCV prints nothing (not `0/1`); missing CLL prints no `max_content`/`max_average`. A literal `min_luma == 0.0` is treated as **unknown** by libplacebo (treated as 1000:1 contrast fallback) — libplacebo `pl_hdr_metadata.min_luma == 0.0` comment in `src/include/libplacebo/colorspace.h` (https://github.com/haasn/libplacebo/blob/master/src/include/libplacebo/colorspace.h, accessed 2026-08-28).

**Minimal commands (FACT — local `tools/ffprobe` 9.0.1):**

```bash
tools/ffprobe -v error -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries,color_range,pix_fmt,codec_name,codec_tag_string:stream_side_data=side_data_type -of json Sample/PQ_FIXTURE.mov
tools/ffprobe -v error -show_frames -select_streams v:0 -show_entries frame=side_data -of json Sample/PQ_FIXTURE.mov | jq '.frames[0].side_data'
tools/ffprobe -v error -show_entries packet=side_data -of json Sample/PQ_FIXTURE.mov
# human-readable:
tools/ffprobe -v error -show_streams -of default=noprint_wrappers=1 Sample/PQ_FIXTURE.mov
```

**Typical HDR10 mastering values (FACT reference, not gate):** e.g., `max_luminance 1000/1` (1000 nits), `min_luminance 1/10000` (0.0001 nits) or `50/10000` (0.005 nits P3 mastering), primaries BT.2020 (`red 34000/50000,34200/50000` etc.). Private samples redacted; verifier checks only presence + range sanity, not exact primaries.

---

## 3. Narrow v1 metadata gate (fail-visible, no guess)

**Goal:** PQ is distinct from HLG; v1 must **only** accept a positively-confirmed HDR10 PQ slice to avoid mis-tonemapping generic SDR/HLG/Dolby. Unspecified (`2` / `unknown` / `unspecified` / `""`) or contradictory BT.2020 labels fail-closed — matches existing inspector `is_unspecified` / `is_contradictory` logic (`prototype/inspector.py:12,171-180`, `prototype/classifier.py:22-100`).

### Required (ALL must hold) → `pqSupported` / `pq-rec709-v1`

```
parse_ok == true
is_unspecified == false
is_contradictory == false
color_transfer == "smpte2084"            # enum 16, PQ; ffprobe string "smpte2084"
color_space    == "bt2020nc"             # matrix 9 (non-constant luminance; iPhone uses 9; ICTCP 14 rejected in v1)
color_primaries == "bt2020"              # enum 9
color_range    == "tv"                   # narrow/MPEG; iPhone default; full/pc rejected
pix_fmt in {"yuv420p10le","yuv422p10le","yuv444p10le","yuv420p12le","yuv422p12le","yuv444p12le"}  # explicit allowlist, mirrored from ALLOWED_GENERIC_HLG_PIX_FMTS (contracts.py:23-30) — >=10-bit YUV only
has_dovi == false                        # rejects DOVI 8.1 HLG/PQ confusion; dv_profile must be null / rpu_present false
has_mdcv == true  && has_clli == true    # MDCV + CLL both present (side_data_list contains both types) — tightest v1
```

Optional tighter check if side-data numerators available: `max_luminance` denominator `10000` with `max_luminance > min_luminance` and `MaxCLL`/`MaxFALL` within `0–10000`, but v1 verifier may treat presence as sufficient to avoid false rejection on valid but unusual mastering (e.g., 4000-nit grade).

### Fail-closed classifications (FACT — existing `classifier.py` precedent)

| Condition | Result | `reason` | `canConvert` |
|---|---|---|---|
| `color_transfer == "smpte2084"` but any of `is_unspecified`/`is_contradictory`/missing 10-bit/missing one of MDCV/CLLI | `pqHdr10Unsupported` (or `uncertain` if contradictory) | `pq_missing_mdcv_or_clli` / `unspecified_metadata` / `contradictory_metadata` / `missing_10bit_pix_fmt` | `false` |
| `color_transfer smpte2084` + `color_space/color_primaries` not `bt2020nc`/`bt2020` | `uncertain` | `contradictory_metadata` | `false` |
| `has_dovi == true` (even with PQ) | `dolbyVisionUnsupported` | `dovi_not_allowlisted` | `false` |
| `parse_ok == false` | `uncertain` | `parse_failed` | `false` |
| `color_transfer arib-std-b67` (HLG) | existing `hlgLocalB`/`hlgSupported` paths | — | — |
| `color_transfer bt709` / SDR | `uncertain` | `unknown_or_missing_evidence` | `false` |

**PPD impact:** Add `Classification.pqSupported` to `prototype/contracts.py:Classification`, new `EXPECTED_PQ`-like constant optional (v1 may use inline gate like `_is_generic_hlg_supported` rather than SHA allowlist). Wire `pqSupported` → `profile_id = "pq-rec709-v1"` in `classifier.py:classify()`. Update `electron/b-profile.cjs` port: `PROFILE_ID_PQ = "pq-rec709-v1"`, `FILTER_GRAPH_PQ`, `PROFILES[pq]=...`, `ALLOWED_PROFILE_IDS add pq`. IPC `ipc-contract.cjs` / `inspection-adapter.cjs` allow `pqSupported` + `pq-rec709-v1`. **No SHA/basename allowlist** for PQ v1 — positive metadata only, matching `hlgSupported` precedent.

**Why both MDCV + CLLI required in v1 (INFERENCE, conservative):**

- MDCV carries mastering envelope (`max_luminance` for EETF anchor `LW`); CLL carries content census (`MaxCLL`/`MaxFALL` for knee adaptation). BT.2390 KneeStart `KS = 1.5*maxLum - 0.5` explicitly uses target/master peak; libplacebo `knee_adaptation 0.4` blends source avg/target avg. Without both, tone-map is under-constrained; `peak_detect` can compensate but hides missing-metadata bug. Requiring both makes v1 **auditable** and pushes suppliers to emit correct SEI. Later relaxation to "either" can be decided after corpus measurement.

---

## 4. Capability & runtime smoke (local 9.0.1, FACT — reproducible)

### 4a. Build-time / startup capability probe (`electron/b-executor.cjs:checkCapability` pattern — must extend for PQ)

Existing `checkCapability(ffmpegPath, profileId)` uses `spawnSync(ffmpegPath, ["-hide_banner","-h","filter=libplacebo"], {shell:false})` and token search:

```
hasExactToken(help, "Filter libplacebo")
hasExactToken(help, "tonemapping") && "gamut_mode" && "perceptual"
profileRequirements = profileId === "hlg-local-b-v1" ? ["spline","tonemapping_param"] : ["bt.2390"]  # line 54-55
plus eq gamma check for hlg-local-b
```

**PQ extension (required):**

```
profileId === "pq-rec709-v1" → require ["bt.2390", "perceptual"] 
# optionally also require "peak_detect" token (present on host) for documentation parity
```

On this host `tools/ffmpeg -hide_banner -h filter=libplacebo` contains:

```
Filter libplacebo
  tonemapping ... bt.2390 ... spline ... st2094-40, st2094-10, gamma, linear
  gamut_mode ... perceptual ...
  peak_detect <boolean> ..FV.....T. Enable dynamic peak detection for HDR tone-mapping (default true)
```

Result: `checkCapability(tools/ffmpeg, "pq-rec709-v1") === {ok:true}` (FACT, verified 2026-08-28 via manual `grep -E` per `conversion-spike-2026-08-25.md §1b`). If `molten-vk` is missing, runtime `VK_ERROR_INCOMPATIBLE_DRIVER` surfaces on first `libplacebo` frame — `b-executor` must surface `profile_unavailable` without guessing a graph.

**Second probe:** `ffmpeg -hide_banner -h filter=zscale` → `Filter zscale` present (FACT, local 9.0.1_1). Documents fallback availability but not used as primary.

### 4b. Runtime smoke (1 s synthetic + 1 s fallback, deterministic, no network)

```bash
# 1. Generate synthetic PQ fixture (see §5) — includes locally proven setparams for accurate tagging
tools/ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=1,format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc" \
  -c:v libx265 -x265-params "level-idc=51:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited" \
  -pix_fmt yuv420p10le -colorspace bt2020nc -color_primaries bt2020 -color_trc smpte2084 -color_range tv \
  -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9:video_full_range_flag=0 \
  -master_display "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)" -max_cll "1000,400" \
  -movflags +write_colr -n /tmp/pq-smoke-1s.mov
# Note: local ffprobe exposes MDCV/CLLI on first decoded frame side data even when stream side_data_list is absent; inspector probes -read_intervals %+#1 -show_frames to capture both.

# 2. ffprobe side-data smoke
tools/ffprobe -v error -show_streams -of json /tmp/pq-smoke-1s.mov | jq '.streams[0] | {color_transfer,color_space,color_primaries,pix_fmt,side_data_list}'

# 3. libplacebo conversion smoke (exact v1 graph, 1 s, H.264 MP4 — historically ProRes LT `yuv422p10le` `.mov` with `vendor ap10`/`+write_colr`, now locked H.264 High `yuv420p` `.mp4` compact compatible)
tools/ffmpeg -hide_banner -loglevel error -i /tmp/pq-smoke-1s.mov -vf "libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le" \
  -c:v libx264 -profile:v high -preset medium -crf 18 -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 192k -fps_mode passthrough -movflags +faststart+write_colr -n /tmp/pq-smoke-1s_sdr.mp4

# 4. Verify output tags + capability
tools/ffprobe -v error -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries,color_range,pix_fmt -of default=noprint_wrappers=1 /tmp/pq-smoke-1s_sdr.mp4
# expected: bt709/bt709/bt709 tv yuv420p ; plus h264 High (historically yuv422p10le prores LT)
```

**Pass criteria (mechanical, FACT):** no `VK_ERROR_*` on stderr, exit code 0, output side data size >0, Rec.709 tags exact, duration delta ≤0.05 s, no `com.apple.quicktime.*` / `ISO6709` leakage. Failure → `conversion_failed` / `profile_unavailable` shown generically, no stderr leak to renderer (existing `b-executor.cjs: runBConversion` already bounds stderr to 32 KiB and never returns `stderr`/`path` fields — `conversion-service.cjs: isValidConvertEvent` forbids them).

---

## 5. Synthetic PQ fixture & mechanical verifier vs human visual acceptance

### 5a. Lawful synthetic fixture (no private media, reproducible)

Private `Sample/1.MOV`/`2.MOV` are **HLG DOVI 8.4** (`bt2020nc/arib-std-b67/bt2020 tv yuv420p10le hvc1`, SHA `46dad3...88593`, `2780c7...4a82a`) — unsuitable for PQ testing. New PQ fixture must be **generated locally** via `lavfi` + `libx265` + `hevc_metadata` BSF (above), or fetched on-demand from Tier 1 lawful corpus (Dolby/EBU/Apple HLS) but **not committed** (per `2026-08-25 ... §10` corpus policy). Minimum fixture matrix:

| Fixture | Transfer | Peaks | MDCV/CLL | Purpose |
|---|---|---|---|---|
| `pq-1k-legal-1s.mov` | `smpte2084` 16 | 1000 nits (MDCV 1000/0.005 + CLL 1000/400) | both present | canonical HDR10 |
| `pq-4k-nits-clipped-1s.mov` | `smpte2084` | 4000 nits (MDCV 4000) | both present | exercises knee strongly |
| `pq-no-mdcv-1s.mov` | `smpte2084` | none | absent | must **fail** v1 gate (proves gate) |
| `pq-contradictory-1s.mov` | `smpte2084` + `bt709` primaries | 1000 | present | must **fail** contradictory |
| `sdr-control-1s.mov` | `bt709` | — | absent | must be `uncertain`, not mapped |

Generation is fully reproducible given `tools/ffmpeg 9.0.1_1` + `libx265 4.3` (x265 ABI upgrade noted in `tools/PROVENANCE.txt`). Hashes are host-deterministic only if `x265` version and `-master_display`/`-max_cll` args are frozen; record `ffmpeg -version` and `x265 --version` in verifier log.

### 5b. Mechanical verifier (deterministic, no human)

Reuse `scripts/verify-spike.sh` pattern into `scripts/verify-pq.sh` (or extend existing with `profileId` argv):

- `source != output` canonical `realpath(abspath)` check + symlink-parent collision
- timing `nb_read_frames` exact + duration ≤0.05 s
- output `color_space==bt709 && color_transfer==bt709 && color_primaries==bt709 && color_range==tv && pix_fmt==yuv420p && codec_name==h264 && profile==High` (historically `yuv422p10le` `prores` `LT` ProRes .mov; now locked H.264 High `yuv420p` .mp4 compact)
- broad privacy scan: `ffprobe json` + `strings -a` for `com.apple.quicktime.*`, `ISO6709`, `location`, `creation_time` patterns
- plus **PQ-specific** input gate re-check before accepting output: `BT.2020 triple + smpte2084 + tv + >=10-bit + has_dovi==false + has_mdcv && has_clli`; unknown profileId fails-closed.

Existing `verify-spike.sh` already enforces `profileId` argv via `buildFfmpegArgs(source, staging, profileId)` and `spawn(..., [src,dst,profileId], {shell:false})` — PQ verifier must mirror.

### 5c. Human visual acceptance — what it is NOT

Mechanical pass **does not claim visual correctness**. Verifier measures:

- tags/timing/privacy/frame-count determinism (FACT)
- luma window `signalstats YAVG` normalized to 8-bit (`Y8 = Y10*255/1023`) at `t=02,05,08 s` 1 s windows, reporting `Δ8`, `Δ10`, `%SDR`, `stops` (gamma 2.2) — as in `scripts/compare-to-reference.sh` crossed-pair `1_v5 ↔ 2-rec709` (`Δ8 +9.1`, `+6.7`, both `abs ≤10` PASS). For PQ there is **no MainConcept Rec.709 reference** yet; luma delta vs synthetic has no ground truth.

Visual acceptance remains **human on calibrated Rec.709 display** (Resolve viewer or SDR monitor, `Use Mac display color profiles` OFF or `Rec.709 Gamma 2.4`) comparing:

- synthetic source rendered via HDR path vs converted SDR on same display,
- native camera PQ/HDR10 sample (if available) vs converted SDR (user-owned, not committed),
- no `hdr10plus` / `dv` trim applied (libplacebo `apply_dolbyvision` inert under gate).

No automated `PSNR/SSIM` ground truth; no `eq` trim claim; no `spline vs hable` visual claim carried over.

---

## 6. Fact / Inference / Uncertainty matrix (five questions answered)

| # | Question | Answer | Grade | Primary source / local evidence |
|---|---|---|---|---|
| **Q1** | Defensible libplacebo graph & peak | `pq-rec709-v1` → `libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le`, `peak_detect` default `true` (omit), deterministic alt `false`. No `npl`/`target_peak` knob exists in `vf_libplacebo` on host. | FACT (graph enum locally present) + INFERENCE (default `true` preferred) | `tools/ffmpeg -h filter=libplacebo` (local 9.0.1_1, 2026-08-28); https://ffmpeg.org/ffmpeg-filters.html#libplacebo 11.147.1.6–7 (accessed 2026-08-28); https://libplacebo.org/options/#hdr-peak-detection; ITU BT.2390-8 §5.4 EETF, BT.2408 Annex 5 |
| **Q2** | Numeric MDCV/CLLI ffprobe fields | `red_x/.../white_point_{x,y} ÷50000`, `min/max_luminance ÷10000`, `max_content`/`max_average` integer nits, gated by `has_primaries`/`has_luminance`. Missing → no print (not 0). libplacebo treats `min_luma 0.0` as unknown. | FACT | `fftools/ffprobe.c: print_mastering_display_metadata`, `print_context_light_level` (https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffprobe.c); `libavutil/mastering_display_metadata.h`; `src/include/libplacebo/colorspace.h: pl_hdr_metadata` (https://github.com/haasn/libplacebo/blob/master/src/include/libplacebo/colorspace.h); local `tools/ffprobe -show_streams` JSON `side_data_list` |
| **Q3** | Narrow v1 gate | ALL: `parse_ok && !unspecified && !contradictory && smpte2084 && bt2020nc && bt2020 && tv && >=10-bit allowlist && !has_dovi && has_mdcv && has_clli`. Any miss → `pqHdr10Unsupported`/`uncertain`/`dolbyVisionUnsupported`, `canConvert false`. | FACT (field enums) + INFERENCE (both-MDCV+CLL conservative) | `libavutil/pixfmt.h:642-706` `AVCOL_TRC_SMPTE2084=16`; `prototype/inspector.py:12,171-180` `_UNKNOWN_COLOR_VALUES`; local samples `Sample/1,2` as negative HLG examples; ITU BT.2100-3 |
| **Q4** | Capability / runtime smoke | Build probe via `spawnSync(..., shell:false)` requiring `Filter libplacebo` + `bt.2390` + `perceptual` (+ optional `peak_detect`); Vulkan driver requires `molten-vk 1.4.2` (local proven before/after `VK_ERROR_INCOMPATIBLE_DRIVER`). Runtime 1 s synthetic PQ→ProRes smoke with exact Rec.709 tag check. | FACT (local) | `electron/b-executor.cjs:44-80` `checkCapability`; `tools/PROVENANCE.txt` (`VK_ERROR_*` before `molten-vk`); `tools/ffmpeg -version` |
| **Q5** | Synthetic fixture / verifier vs visual | Synthetic `lavfi+libx265+hevc_metadata+master_display+max_cll` fixtures (1 s, no private media); mechanical verifier checks tags/timing/privacy/frame-count + re-gate; visual correctness **explicitly not claimed** (needs calibrated human A/B, same display/brightness, Resolve/CoreMedia HDR vs SDR). | FACT (fixture cmd works) + INFERENCE (visual limit) | `scripts/convert-hlg-to-sdr.sh` + `scripts/verify-spike.sh` + `scripts/compare-to-reference.sh` precedent (`signalstats YAVG` Δ8); `conversion-spike-2026-08-25.md` §§14-17 crossed falsification; ITU BT.2408 §2 diffuse-white `203 cd/m²` |

---

## 7. Risks / Unknowns (concrete, bounded)

- **Peak variance:** `peak_detect=true` yields per-run adaptive knee; two runs on identical VFR input may differ in `percentile` histogram output → not bit-exact. Mitigation: keep `smoothing_period 20` / `percentile 99.995` defaults; document that verifier hashes output size/SHA only for sanity, not for reproducibility proof. If determinism required, add `peak_detect=false` ticket.
- **MDCV permissiveness:** Some HDR10 encoders emit **placeholder** MDCV (e.g., `max_luminance 1000` for all files) regardless of true grade; gate requiring both metadata still passes but tone-map may be generic. Not detectable without measuring content histogram — hence `peak_detect` default.
- **HDR10+ / DV confusion:** File with `st2094-40` or `dvvC` side-data but PQ base could slip past `has_dovi` string check if ffprobe `side_data_type` is `"Dynamic HDR10+ / DOVI configuration"`; inspector must lower-case contains `dovi`/`dolby`/`hdr10plus` and treat as `has_dovi`-like fail-closed (already in `inspector.py:152-160`).
- **x265 fixture determinism:** `testsrc2+libx265` output bytes depend on `x265 4.3` vs prior `216`; hash comparison across machines meaningless. Record `x265 --version` + `ffmpeg -version` in fixture provenance.
- **zscale fallback coverage:** `zscale` on host 9.0.1_1 is present but its `tonemap` enum (`hable/mobius`) may not include `bt.2390` on fallback path; PQ fallback may then fail `profile_unavailable` correctly. Do not silently alias to `hable`.
- **ColorSpace mismatch trap:** PQ `ICTCP` (`matrix 14` / `ictcp`) vs `bt2020nc` (9) — v1 rejects `ictcp`; real Dolby ICtCp PQ exists but out-of-scope for narrow gate. Separate ticket if `ictcp` demand appears.
- **VFR timing:** `Sample/1.MOV` is VFR (`avg 29.47 ≠ r 30`); PQ synthetic via `testsrc2` is CFR, so timing smoke does not prove VFR conformance. Carry existing `fps_mode passthrough` policy (FACT — `verify-spike.sh` enforces delta ≤0.05 s).
- **No HDR10 visual ground truth in repo:** `Sample/*-rec709.mp4` are HLG-derived MainConcept Refs only; no PQ Rec.709 reference exists. Visual A/B requires user-supplied HDR10 sample under same non-commit policy.

---

## 8. Architecture (how pieces connect)

Narrow-gated PQ classification sits before any transcode: `prototype/inspector.py` extracts `side_data_list` → `InspectionEvidence {has_mdcv,has_clli,pix_fmt,…}` → `prototype/classifier.py:classify()` adds branch `pqSupported → profile pq-rec709-v1` after existing HLG/DV/PQ-unsupported checks → `electron/b-profile.cjs` serves frozen `FILTER_GRAPH_PQ` → `electron/b-executor.cjs:checkCapability(..., "pq-rec709-v1")` probes `libplacebo bt.2390/perceptual` (+ `peak_detect` + `libx264`/AAC for all profiles) → `runBConversion({profileId:"pq-rec709-v1"})` spawns `tools/ffmpeg` single-process via `buildFfmpegArgs(..., profileId)` with `-vf` graph + locked H.264 contract `libx264` High `yuv420p`/`bt709`/`tv`/`+faststart+write_colr` AAC 192k (historically `prores_ks`/`yuv422p10le`/`bt709`/`tv` `.mov`) → staged `.mp4` (`.partial.mp4` valid for MP4 muxing) is verified by `scripts/verify-spike.sh <src> <dst> <profileId>` (tag/timing/privacy + re-gate; historically `verify-pq.sh`) before `outputStore` atomic commit (`_sdr_rec709_h264_<profile>.mp4`, historically `_sdr_rec709_proreslt_<profile>.mov`) and `ConversionService` native drag `startDrag({file,icon})`. Failure at any step yields generic `invalid_request`/`profile_unavailable`/`conversion_failed` — no path/stderr leak per `ipc-contract.cjs`.

---

## 9. Exact tests to land with the profile (copy-paste)

**Python unit ( `tests/test_classifier_pq_rec709.py` )**

```py
from prototype.contracts import InspectionEvidence, Classification, ALLOWED_GENERIC_HLG_PIX_FMTS
from prototype.classifier import classify

def mk(pix="yuv420p10le", cs="bt2020nc", tr="smpte2084", prim="bt2020", rng="tv", mdcv=True, clli=True, dovi=False, uns=False, contra=False):
    return InspectionEvidence(sha256="f"*64, size=12345, display_name="pq.mov",
        codec_name="hevc", codec_tag="hvc1", pix_fmt=pix, color_space=cs, color_transfer=tr, color_primaries=prim, color_range=rng,
        has_dovi=dovi, has_mdcv=mdcv, has_clli=clli, is_unspecified=uns, is_contradictory=contra, parse_ok=True)

assert classify(mk()).classification == Classification.pqSupported
assert classify(mk(mdcv=False)).classification == Classification.pqHdr10Unsupported  # missing MDCV
assert classify(mk(clli=False)).classification == Classification.pqHdr10Unsupported  # missing CLLI
assert classify(mk(pix="yuv420p")).can_convert is False                            # 8-bit reject
assert classify(mk(dovi=True)).classification == Classification.dolbyVisionUnsupported
assert classify(mk(uns=True)).classification == Classification.uncertain
assert classify(mk(tr="arib-std-b67")).classification != Classification.pqSupported # HLG not PQ
```

**Electron capability ( `electron/test/b-executor.pq.test.cjs` )**

```js
const {checkCapability, buildFfmpegArgs, getFfmpegAbsolute} = require('../b-executor.cjs');
const {PROFILE_ID_PQ} = require('../b-profile.cjs');
assert.equal(checkCapability(getFfmpegAbsolute(), PROFILE_ID_PQ).ok, true);
assert.ok(buildFfmpegArgs('/tmp/src.mov','/tmp/out.mov', PROFILE_ID_PQ).join(' ').includes('tonemapping=bt.2390'));
```

**Live samples ( `tests/test_live_samples.py` extension, manual — no private media committed )**

```bash
python3 -m unittest discover -s tests -k test_classifier_pq_rec709 -v
node --test electron/test/b-executor.pq.test.cjs
# synthetic smoke (reproducible, 1 s):
/tmp/smoke_pq.sh  # wraps §4b cmds; asserts tags bt709 tv yuv420p h264 High and frame count 30 (historically yuv422p10le prores LT)
```

All existing HLG tests (`test_classifier_generic_hlg.py`, `test_inspector.py`, `generic-hlg.test.cjs`) must stay green — PQ gate is additive.

---

## 10. Sources (primary / official, accessed 2026-08-28 unless noted)

1. **FFmpeg filters documentation — libplacebo** — https://ffmpeg.org/ffmpeg-filters.html#libplacebo (§11.147: Output mode, Peak detection, Tone mapping; `peak_detect`, `tonemapping bt.2390/spline`, `gamut_mode perceptual`, `colorspace/range/primaries/trc`) — FACT, official FFmpeg docs.
2. **libplacebo options reference** — https://libplacebo.org/options/ (Global preset, HDR peak detection, Color mapping `gamut_mapping perceptual`, `tone_mapping bt2390/bt2446a/spline`, `knee_adaptation`, `contrast_recovery`) — FACT, official libplacebo docs.
3. **FFmpeg source: ffprobe side-data printing** — `fftools/ffprobe.c: print_mastering_display_metadata()`, `print_context_light_level()` — https://github.com/FFmpeg/FFmpeg/blob/master/fftools/ffprobe.c (accessed 2026-08-28) — FACT.
4. **FFmpeg source: libavutil mastering metadata** — `libavutil/mastering_display_metadata.h` (`AVMasteringDisplayMetadata`, `AVContentLightMetadata has_primaries/has_luminance`) — https://www.ffmpeg.org/doxygen/7.1/mastering__display__metadata_8h.html — FACT.
5. **libplacebo source: `pl_hdr_metadata`** — `src/include/libplacebo/colorspace.h` (`PL_HDR_METADATA_HDR10` min/max luma, MaxCLL/MaxFALL, primaries, note `min_luma==0.0` = unknown) — https://github.com/haasn/libplacebo/blob/master/src/include/libplacebo/colorspace.h — FACT.
6. **libplacebo source: peak-detect params** — `src/include/libplacebo/shaders/colorspace.h` (`pl_peak_detect_params smoothing_period, scene_threshold, percentile 99.995, black_cutoff 1.0`) — FACT.
7. **ITU-R BT.2100-3 (2025-02)** — Image parameter values for HDR-TV (PQ EOTF ST 2084, HLG OETF, BT.2020 primaries, `transfer_characteristics` 16/18) — https://www.itu.int/rec/R-REC-BT.2100/en — FACT.
8. **ITU-R Report BT.2390-8 (2020-10)** — High dynamic range television for production and international programme exchange (§5.3 OOTF/OETF, §5.4 EETF mapping `KS=1.5 maxLum-0.5`, Fig 18–20) — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2390-8-2020-PDF-E.pdf — FACT.
9. **ITU-R Report BT.2408-? (2022/2023)** — Guidance for operational practices in HDR-TV (§2 HDR Reference White 203 cd/m², Annex 5 EETF) — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-6-2023-PDF-E.pdf (blocked via jina on 2026-08-28, verified via Exa excerpt + local `2026-08-25-...§7`) — FACT via alternate access.
10. **ITU-R Report BT.2446-1 (2021)** — Methods for conversion between SDR/HDR (§4 HDR→SDR, §5 display-referred mapping) — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2446-1-2021-PDF-E.pdf — FACT.
11. **CTA-861.3 / SMPTE ST 2086 / HEVC Annex D** — MDCV (24 bytes, primaries ÷50000, luminance ÷10000) and CLL (4 bytes MaxCLL/MaxFALL nits) carriage, via ISOBMFF `mov.c:6928/7009` and HEVC SEI D.2.28/D.3.28/D.2.35/D.3.35 — FACT (cited via spec; verified via ffprobe implementation).
12. **FFmpeg filter help — local primary** — `tools/ffmpeg -hide_banner -h filter=libplacebo` / `filter=zscale` / `filter=tonemap` on `ffmpeg-full 9.0.1_1` (local, 2026-08-28) — FACT, installed binary.
13. **Local repo constraints** — `electron/b-profile.cjs` (frozen profiles `hlg-local-b-v1`, `hlg-rec709-v1`), `prototype/contracts.py:ALLOWED_GENERIC_HLG_PIX_FMTS`, `prototype/classifier.py:_is_pq_transfer` / `_is_generic_hlg_supported`, `prototype/inspector.py:_UNKNOWN_COLOR_VALUES` — FACT, read-only repo.
14. **Conversion spike precedent** — `docs/research/conversion-spike-2026-08-25.md` (§1b provenance `ffmpeg-full 9.0.1_1 + molten-vk 1.4.2`, §14-17 crossed `signalstats YAVG` Δ8 falsification `bt.2390 +32.9` vs `spline +9.1`, §17 v5 gate) — FACT, local evidence.
15. **Local sample inspection — negative control** — `docs/research/local-sample-inspection-2026-08-25.md` (both `Sample/*.MOV` are `bt2020nc/arib-std-b67/bt2020 tv yuv420p10le hvc1 DOVI 8.4 compat4` — not PQ) — FACT.

Access dates are 2026-08-28 for web fetches via `agent-reach` (Exa + jina `r.jina.ai`) where not cached.

---

## 11. Conflicts / Uncertainty (where sources diverge or lack coverage)

- `libplacebo bt.2390` default knee offset `1.0` vs ITU spec `0.5` — ffmpeg docs explicitly flag the difference (FACT). No visual A/B exists on this host for which offset matches a reference grading monitor; keep default and note the delta rather than assert spec-compliance.
- `ITTU BT.2100` normative PQ table vs `libavutil/pixfmt.h` enum `AVCOL_TRC_SMPTE2084=16` — consistent (FACT); no conflict.
- `peak_detect` default `true` vs "frame-perfect" reproducibility: Exa highlight *"If this is too slow, or if exactly reproducible frame-perfect results are needed, it’s recommended to turn this feature off"* conflicts with desire for smooth adaptive luminance. Resolution: keep `true` for v1, defer deterministic `false` to follow-up.
- `zscale tonemap` docs list `hable/mobius` but not `bt.2390` on all FFmpeg builds — local 9.0.1 `tonemap` filter lists `hable` only (FACT — `ffmpeg -h filter=tonemap`). PQ fallback cannot rely on `zscale … tonemap=bt.2390`; fail-visible if unavailable rather than degrade to `hable`.
- `BT.2408` direct fetch via jina returned `Request Rejected` on 2026-08-28 (FACT — blocked); content verified via Exa excerpt and local canonical report `2026-08-25-...§7`. Direct download remains primary if accessible from non-jina IP.

---

## 12. Implication for the task (what the main agent should do next)

1. **Create** `pq-rec709-v1` as a **new frozen profile** in `electron/b-profile.cjs` + `prototype/contracts.py/classifier.py` + `electron/ipc-contract.cjs` wiring, mirroring `hlgSupported` gate structure but with PQ triple + `has_mdcv && has_clli`. Do not mutate `hlg-local-b-v1`/`hlg-rec709-v1` graphs.
2. **Gate** all PQ inputs via §3 — no SHA allowlist, no codec/container requirement beyond `hevc+10-bit` evidence; 8-bit/`bt709`/missing/unspecified/contradictory/DOVI all `pqHdr10Unsupported`/`uncertain`/`dolbyVisionUnsupported`.
3. **Smoke** via `checkCapability` token check (`bt.2390` + `perceptual`) and 1 s synthetic PQ fixture (§4b/§5a) before claiming implement-complete; log `ffmpeg=tools/ffmpeg` and `vf=...` as in `conversion-spike` transcripts.
4. **Verify** via `scripts/verify-spike.sh` (`profileId` argv, re-gate + Rec.709/`tv`/`yuv420p`/`h264 High` compact MP4/timing/privacy) — historically `scripts/verify-pq.sh` with `yuv422p10le`/`prores LT`; keep profile-specific input gates unchanged.
5. **Do not** claim visual correctness; keep mechanical verifier boundary explicit in UI copy (e.g., "Deterministic verification — compare on an SDR display for visual acceptance").

---

## 13. Risks / Unknowns checklist (before claiming production-ready)

- [ ] `tools/ffmpeg -h filter=libplacebo` on CI/bundled binary still contains `bt.2390` + `perceptual` + `peak_detect` tokens (re-run `checkCapability` smoke in `npm test`)
- [ ] 1 s PQ synthetic produces stable output size/SHA across two runs with `peak_detect=true` vs divergence (decide if `percentile 99.995` smoothing causes hash drift)
- [ ] `ffprobe side_data_list` actually contains both `"Mastering display metadata"` and `"Content light level metadata"` for synthetic (confirm `hevc_metadata` + `-master_display`/`-max_cll` propagate to MP4/MOV SEI vs container box only)
- [ ] Existing `test_classifier_generic_hlg.py` still green after adding `pqSupported` branch (regression gate)

---

## 14. Start Here (first file/function to touch, PQ-aware)

`prototype/classifier.py:classify()` — add helper `_is_pq_supported(ev)` mirroring `_is_generic_hlg_supported(ev)` but checking `color_transfer smpte2084 + bt2020nc/bt2020 + tv + >=10-bit allowlist + !has_dovi + has_mdcv && has_clli && !is_unspecified && !is_contradictory`, return `Classification.pqSupported` with `profile_id=PROFILE_ID_PQ` before the final `uncertain` fallthrough. Then propagate `PROFILE_ID_PQ` to `prototype/contracts.py:Classification` / `ALLOWED_PROFILE_IDS` and `electron/b-profile.cjs` `FILTER_GRAPH_PQ`. `electron/b-executor.cjs:checkCapability` must recognize `pq-rec709-v1` token set.

---

*Handoff reminder: this note is read-only reconnaissance; no `Sample/` mutation, no `Output/spike` overwrite, no ClipDock edit, no install beyond already-proven `ffmpeg-full 9.0.1_1 + molten-vk 1.4.2`.*
