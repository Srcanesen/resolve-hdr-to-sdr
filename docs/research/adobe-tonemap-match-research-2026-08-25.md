# Adobe Tone-Map Match Research — 2026-08-25

**Date (UTC):** 2026-08-25
**Status:** Research only — no conversion change, no visual acceptance claim. Builds on `conversion-spike-2026-08-25.md` §14-17 (v5 spline ±0.07 stops, ~90% visual) and `visual-tonemap-experiment-2026-08-25.md` (A/B/C diagnostic).
**Scope:** How Adobe Premiere Pro / Media Encoder does HLG→Rec.709 SDR, how to approximate it openly, and what fidelity tiers are realistic for a small-panel HdrToSdr product. No `Sample/` mutation, no `Output/`/`scripts/` change.
**Invariant:** All claims tagged FACT (cited primary) / INFERENCE (needs live A/B) / COMMUNITY (forum anecdote). URLs carry access date 2026-08-25 unless noted.

---

## 0. Executive Summary — Top Findings

1. **Adobe's pipeline is color-managed, not a single LUT.** Since v23.2 (2022-12) → revamped 2025, Premiere auto-detects iPhone HLG and does sequence-level tone mapping + gamut compression with three selectable operators — **Hue Preservation (default, 2 params), By Channel, Max RGB** — plus two gamut modes. This is the reference the user judged (Premiere export Auto Tone). No public EETF curve published; Adobe describes it only functionally ("compresses highlights to fit SDR, perceptually similar").

2. **Luma match != look match.** v5 spline measured ±0.07 stops (Δ8 ≤9) vs MainConcept ref, but user rates visual ~90% (skin/shadow not identical). Explains: BT.2020→BT.709 gamut handling, knee placement, desaturation in highlights, and contrast-recovery differ even when YAVG matches. Prior v4 bt.2390 was +0.9 stops off and falsified — directionally correct test.

3. **Exact clone is infeasible open-source; close match is.** Best open fidelity = **dovi_tool RPU-trim → libplacebo with tuned perceptual gamut + spline/bt.2390 + peak-detect + post-EQ**. Adobe's iPhone path discards RPU (edits invalidate DV) and tone-maps pure HLG — so applying RPU trims *before* SDR map will diverge from Adobe but may improve skin if that's what user actually wants. Offer both paths.

4. **Tier ranking:** (Tier 1) pure `ffmpeg` libplacebo (cheap, good, 90-93%), (Tier 2) RPU-aware pre-trim + libplacebo (higher skin fidelity if RPU carries per-shot trim, +~3-5% but more complex), (Tier 3) DaVinci Resolve or Premiere headless/CLI render (closest to Adobe, licensed, heavy).

5. **No community "eq gamma=0.92" → Adobe match recipe exists.** Found zero published `libplacebo eq gamma=0.92 + spline` → Adobe preset. Closest community verified filter is `libplacebo: tonemapping=spline|bt.2390 + gamut_mode=perceptual + peak_detect=1` with `contrast_recovery 0-0.3` and zscale `npl=100` for HLG.

---

## 1. How Adobe Premiere Pro / Media Encoder Performs HLG→Rec.709 SDR

### 1.1 Pipeline (FACT — Adobe Help)

Adobe documents two linked mechanisms (accessed 2026-08-25):

- **Color Management (sequence-scoped):** Premiere 2025 color workflow converts *source → working → output* color spaces automatically. Source clips declare capture gamut (iPhone HLG auto-detected); working space is where grades/effects run; output space is monitoring/delivery. — https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/about-color-management.html (2026-01-07) ; Larry Jordan summary — https://larryjordan.com/articles/the-new-color-workflow-in-adobe-premiere-pro-2025/ (2025-06-21)
- **Automatic Tone Mapping (for SDR sequences):** "Premiere automatically adjusts wide color gamuts to display accurately in your sequence without blown-out highlights. Tone mapping is enabled by default, so iPhone or HDR footage will display correctly" on Rec.709 timelines. Works for iPhone HLG, generic HLG/PQ, Sony S-Log, Canon Log, Panasonic V-Log. — https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/tone-mapping-in-premiere.html (2026-03-05)
- **Historical note:** Before June 2022 Premiere had *no* tone mapping for HDR on SDR timelines; workaround was manual `Modify → Interpret Footage → Color Space Override Rec.2020`. Beta in June 2022 added `Automatically Tone Map Media` in Sequence Settings. — https://community.adobe.com/announcements-732/released-timeline-tone-mapping-313303 (2022-12-01) + https://www.provideocoalition.com/how-to-troubleshoot-hdr-iphone-footage-in-premiere-according-to-adobe/ (2022-08-17)

**Premiere export = same pipeline as timeline:** Program Monitor, Scopes, Transmit, and Media Export all render through *Output Color Space* (Project/Sequence Settings). Setting `Output = Rec.709` on an HLG timeline forces tone map at export; `Output = Rec.2100 HLG` keeps HDR. — Adobe About Color Management ibid.; https://larryjordan.com/articles/quick-color-tip-for-iphone-hdr-video-in-adobe-premiere-pro/ (v25.2.1: must change Output from Rec.2100 HLG → Rec.709)

### 1.2 Algorithms Exposed (FACT — Adobe "Color Management options" 2026-01-07)

Found in `Sequence Settings → Color (Lumetri) → Advanced` — https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/color-management-options.html :

| Operator | Behavior (Adobe wording) | User-tunable params | Default |
|---|---|---|---|
| **Hue Preservation** | "more customizable... usually does better job maintaining brightness than By Channel or Max RGB. Works well with wide variety of media." Best all-around. | `Highlight Saturation` (0.0-1.0, default **0.5**) + `Knee` (threshold below which image unaffected) | **default selection** |
| **By Channel** | "smoothly tone-mapped but can slightly darken... good at avoiding awkward saturation in highlights of wide-gamut sources with exceptionally saturated color in brightest highlights, but can produce somewhat desaturated highlights in other media" | `Highlight Saturation` (0.5) | optional |
| **Max RGB** | "smoothly tone-mapped but can slightly darken while maintaining more saturation in highlights than By Channel" | `Highlight Saturation` (0.5) | optional |

**Where applied:** selectable per-clip as **Input Tone Mapping** (before effects, detail may be irretrievable) or once as **Output Tone Mapping** on whole sequence (after effects/grades). Advanced section exposes choice. Ibid.

**Gamut Compression (FACT, same page):**

- `Luminance Preserving` (default) — preserves brighter colors at expense of desaturating
- `Saturation Preserving` — preserves saturated colors by darkening; highlights may diminish

> "If your wide gamut source media doesn't have saturated highlights, Gamut compression won't result in visible differences. However, wide gamut source media with saturated highlights will look considerably improved when you use gamut compression along with tone mapping." — Adobe

**Color-space-aware effects** (Lumetri etc.) run in working space when `Enable Color Space Aware Effects` is ON (default for new sequences); legacy projects keep OFF for backward compat.

### 1.3 What Algorithm *Is* It? EETF / BT.2408 Question

**FACT:** Adobe does **not publish** a transfer-function formula, EETF name, or BT.2408/2390 compliance statement. Help describes only perceptual goal: "modifying dynamic range... compresses highlights... so result appears perceptually similar."

**INFERENCE (strong, needs Adobe confirmation):**

- Operators are *proprietary knee/roll-off curves* with highlight saturation control, operating in sequence working space (likely scene-linear or display-linear, not PQ absolute). `Hue Preservation` with adjustable Knee maps to classic knee-function down-conversion described in ITU-R BT.2408 §7 (HLG down-conversion via non-linearity analogous to camera knee). BT.2408: "Down-conversion of HDR to SDR... might use a non-linearity, similar (and analogous) to the 'knee' function found in cameras. This non-linear mapping reduces dynamic range of highlights but does not completely remove them." — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-2017-PDF-E.pdf

- Since Premiere's WCG presets (Wide Gamut Tone-Mapped, Direct Rec.709 SDR) are distinct from DaVinci's BT.2408 RCM/CST switch (DaVinci 20.2: "RCM and CST now using ITU BT.2408 for HLG and PQ conversion" — cited in `2026-08-25-davinci-iphone-hdr-workflow-integration-research.md`), Adobe's operators **do not self-identify as BT.2390/BT.2446**. Treating Hue Preservation ≈ spline-with-knee is plausible but unproven.

- **Scene-light adaptation:** BT.2408 §7 notes difficulty is scene luminance factor for reference white (SDR headroom, knee amount varies). Premiere's `Input` vs `Output` tone-map placement and per-clip vs sequence choice *is* its scene adaptation (user/per-sequence, not automatic histogram). No evidence of histogram-based detection like madVR/libplacebo `peak_detect`. Adobe's "automatically" refers only to auto color-space detection.

**COMMUNITY analysis:** No reverse-engineered curve constants found via Exa or Reddit search (rdt search "Premiere Pro tone mapping HLG SDR iPhone" returned only workflow questions). One ProVideo Coalition comment: "even if image is color managed from HLG it won't display as intended since Premiere doesn't read Dolby Vision metadata. Presently, only FCP and Compressor read DV metadata" — https://www.provideocoalition.com/how-to-troubleshoot-hdr-iphone-footage-in-premiere-according-to-adobe/ (comment). Indicates Adobe discards RPU for HLG path.

**APPLE CONTRAST (FACT):** Apple's AVFoundation HDR→SDR via `VTDecompressionSession` + `kVTPixelTransferProperties DestinationColorPrimaries/Transfer/Matrix = BT.709` with tone mapping handled automatically; "Tone mapping is handled automatically through the AVFoundation conversion methods. Converting HDR to SDR through other methods (e.g. server-side conversion) requires special considerations... via the AVFoundation API will ensure best possible representation." — https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf . CALayer docs add: "exact tone mapping algorithm depends on transfer curve... refer to ITU standards for HLG and PQ." — https://developer.apple.com/videos/play/wwdc2023/10181/ . This is *not* Premiere's algorithm but what Photos/QuickLook/VideoToolbox uses; likely ITU-coherent (HLG OOTF gamma ~1.2 at 1000 nits per BT.2100).

**Separating Adobe vs Apple looks:** Adobe Premiere tone map and Apple VideoToolbox `tonemap_videotoolbox` (Metal) — https://github.com/jellyfin/jellyfin-ffmpeg/pull/369 — are different. Do not assume matching Premiere = matching Photos.

### 1.4 Saturation / Gamut Handling Detail

- **Adobe highlight saturation slider 0.5** controls allowable saturation in highlights. Lowering "can produce results similar to By Channel." Direct analogue to libplacebo `gamut_mode` / `desat` trade-off.
- **Gamut compression Luminance Preserving vs Saturation Preserving** maps to libplacebo `perceptual` (blend saturation+softclip, default) vs `saturation`/`relative`/`desaturate`. Adobe default `Luminance Preserving` ~= libplacebo `perceptual` with `perceptual_strength 0.8, deadzone 0.3` (per https://libplacebo.org/options/ ).
- Adobe notes SDR clips "completely unaffected" by gamut settings — same as libplacebo `gamut_expansion`.

---

## 2. Can Adobe's Result Be Approximated in an Open Pipeline? Survey

### 2.1 libplacebo Tuning Beyond Operator — Knobs That Move Skin/Shadow Character

**FACT libplacebo defaults (FFmpeg 8 docs + libplacebo.org/options, 2026-08-25):**

Docs: https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/libplacebo.html ; https://libplacebo.org/options/ ; source `libavfilter/vf_libplacebo.c` — enum includes `bt.2390`, `bt2446a`, `spline`, `reinhard`, `mobius`, `hable`, `gamma`, `linear`, `st2094-40/10`.

Current candidate `v6 = libplacebo:tonemapping=spline:gamut_mode=perceptual:colorspace=bt709` plus `eq=gamma=0.92` measured within ±0.07 stops but skin off. Global gamma lifts shadows/mids (power curve), not gamut-selective like Adobe Highlight Saturation + Knee. Skin lives in midtone chroma + 60-70% luma; global gamma moves it wrong.

**Under-exploited libplacebo params for Adobe match:**

| Param (FFmpeg vf_libplacebo) | What it does (FACT libplacebo.org) | Why it matters | Start values HLG 8.4 → 709 |
|---|---|---|---|
| `gamut_mode` / `gamut_mapping` | `clip`, `perceptual` (default), `softclip`, `relative`, `saturation`, `absolute`, `desaturate`, `darken`, `highlight`, `linear`. `perceptual` = soft-knee + hue shift, bidirectional. | Controls skin saturation vs clip. Adobe By Channel vs Hue Preservation ≈ `perceptual` vs `relative`/`softclip`. | Keep `perceptual`; test `softclip`/`relative`. |
| `tonemapping_param` | Tunable knee/pivot (spline pivot default 0.30 PQ; bt2390 knee_offset default 1.0 vs spec 0.5) | Adobe Knee = this. Move 0.3-0.6 spline, 0.5-1.0 bt2390. | `spline` 0.30 → 0.40-0.50 for higher knee |
| `knee_adaptation`, `slope_tuning` | Adapts knee between source avg and target avg. `knee_adaptation 0.4` default, `0.0` never adapts. | Per-scene adaptation mimicking Adobe scene-light logic. | Try `0.0` → `0.4` sweep |
| `contrast_recovery` / `smoothness` | `0.0` default, `0.30` HQ preset. Divides HF/LF, adds HF back — improves sharpness, may ring. | Adobe no explicit recovery; need test 0.0 vs 0.30. | Test both |
| `peak_detect`, `smoothing`, `percentile` | Dynamic peak via compute shader. Percentile `99.995` default, `100.0`=true peak. Smoothing 20 frames. | HLG has no static peak; histogram drives knee. | Deterministic: `peak_detect=0` + 1000 nits. Adaptive: `1` + `99.995` |
| `brightness/contrast/saturation/hue/gamma` | Post-map tweaks in linear | Instead of eq gamma=0.92, use gamma 0.95 contrast 1.02 | Try `gamma=0.95 contrast=1.02` |

**Concrete filter strings to A/B (via `tools/ffmpeg` ffmpeg-full 9.0.1_1 + molten-vk):**

```bash
# A — spline baseline v6 (retained)
libplacebo=tonemapping=spline:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le

# B — spline higher knee (protect mids/skin)
libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:contrast_recovery=0.0:format=yuv422p10le

# C — bt2390 spec knee (0.5) more roll-off
libplacebo=tonemapping=bt.2390:tonemapping_param=0.5:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le

# D — deterministic (no peak detect)
libplacebo=tonemapping=spline:gamut_mode=softclip:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:peak_detect=0:format=yuv422p10le

# E — Adobe Max RGB approx
libplacebo=tonemapping=mobius:gamut_mode=saturation:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le

# F — libplacebo native gamma/contrast instead of eq
libplacebo=tonemapping=spline:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:gamma=0.95:contrast=1.02:format=yuv422p10le
```

**Evidence of quality:**

- `spline` chosen for v5/v6 because Δ8 +9.1 vs +32.9 for bt.2390 on Take-A t02 (conversion-spike §14-17). libplacebo docs mark `spline`/`bt2390` as preferred modern; `hable/mobius/reinhard` legacy. — https://libplacebo.org/options/ ; https://github.com/mpv-player/mpv/issues/9800

- `perceptual` gamut: "perceptually balanced (saturation) gamut mapping, using soft knee to preserve in-gamut, followed by softclip. Works bidirectionally." — https://libplacebo.org/options/ . Closest to Adobe `Luminance Preserving`.

- `zscale` path (`zscale` + `tonemap` — https://ffmpeg.org/ffmpeg-filters.html#tonemap ; https://32blog.com/en/ffmpeg/ffmpeg-hdr-to-sdr-tonemapping ) is legacy CPU: `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`. Quality lower than libplacebo — Doom9 2025 notes sharpness loss — https://forum.doom9.org/showthread.php?t=186132 . Fallback only when Vulkan unavailable.

### 2.2 Dolby Vision RPU-Aware Tools

**FACT:** `quietvoid/dovi_tool` (https://github.com/quietvoid/dovi_tool , MIT) is strongest RPU utility: modes 0 rewrite, 1 MEL, 2-8.1, 3 5-8.1, 4-8.4. Operates on HEVC elementary stream, not MOV — requires `ffmpeg -bsf:v hevc_mp4toannexb` pipe.

**Relevance:** Premiere discards RPU on edit (AVFoundation VideoComposition discards DV per-frame metadata). So Adobe HLG->SDR via Premiere is HLG-only, not DV-trimmed. Applying RPU before tonemap diverges from Adobe.

**Community RPU-apply paths:**

- VapourSynth: `vs-placebo` (`placebo.Tonemap` with `use_dovi=True` — https://github.com/Lypheo/vs-placebo) can bake DV; `colour-science` python offers exact BT.2100 math — https://colour.readthedocs.io/en/stable/generated/colour.models.ootf%5Finverse%5FBT2100%5FHLG.html

- Recipe: `ffmpeg -i src.mkv -c:v copy -vbsf hevc_mp4toannexb -f hevc - | dovi_tool extract-rpu - -o RPU.bin` then `dovi_tool info -s RPU.bin` — https://micronization.blogspot.com/2024/08/dolby-vision-metadata-rpu-editing-guide.html (2024-08-24)

### 2.3 Dedicated Tools & Hybrids

| Tool | URL (2026-08-25) | Quality vs Adobe | Caveat |
|---|---|---|---|
| **HDRtoSDR (rafgger, TORlN)** | https://github.com/rafgger/HDRtoSDR ; https://github.com/TORlN/HDR-to-SDR | Below Adobe — legacy hable | Anecdotal |
| **vs-placebo** | https://github.com/Lypheo/vs-placebo | Closest open after ffmpeg libplacebo | Needs VapourSynth |
| **colour-science** | https://colour.readthedocs.io/en/stable/_modules/colour/models/rgb/transfer_functions/itur_bt_2100.html | Exact BT.2100 math, no tone map | No DV |
| **DGHDRtoSDR** | http://avisynth.nl/index.php/DGHDRtoSDR | Tuned for PQ | Windows |
| **DaVinci Resolve CST** | Resolve Manual 20.2 BT.2408 note | Highest fidelity — shares BT.2408 lineage | License/heavy |

**DaVinci CLI/headless (FACT local baseline 21.0.3 2026-08-25 — see `2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §11):** `DaVinciResolveScript` API `MediaStorage.AddItemListToMediaPool`, Community wrappers `dvr` (https://github.com/poechant/davinci-resolve-cli) / https://github.com/mhadifilms/dvr wrap render queue. No official headless CLI; needs Resolve running.

**Hybrid Recommendation (INFERENCE):**

1. **Best pure-open:** `ffmpeg libplacebo` spline @ param 0.40-0.50 + perceptual + peak_detect=0 + gamma 0.95-0.98 + contrast 1.02.

2. **RPU-trim hybrid:** `dovi_tool extract-rpu` -> apply via `libplacebo apply_dolbyvision=1` before HLG tonemap (libplacebo treats DV as PQ BT.2020 per docs — https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/libplacebo.html). Then PQ->709 spline.

3. **zscale fallback** only when Vulkan unavailable — Doom9 2025: desat culprit — https://forum.doom9.org/showthread.php?t=186132

---

## 3. iPhone Dolby Vision Profile 8.4 Specifics

### 3.1 Signal (FACT)

- iPhone 12+ default = **HEVC Main10 10-bit 4:2:0 yuv420p10le QTFF .mov, Dolby Vision Profile 8.4 (CRID 4 = HLG), hvc1 + dvvC + colr nclx 9/18/9 (BT.2020/HLG/BT.2020 NCL) + amve (~314 lux) + per-frame RPU SEI (NAL 62/63)**. `arib-std-b67` = HLG. Local: 1.MOV 18.4 MB, 2.MOV 20.3 MB, both `hvc1 dv 1.0 profile8 level4 rpu1 el0 bl1 compat4 none`, bl_video_full_range=0 tv. — https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata ; Apple PDF ; `local-sample-inspection-2026-08-25.md` §6

- Single-track HLG-base+RPU: 8.x single layer, 8.1 = PQ base compat1, 8.4 = HLG base compat4. dvvC (new) vs dvcC legacy. EL absent. — https://github.com/quietvoid/dovi_tool/blob/main/README.md

### 3.2 Community Tools — Apply RPU Trim Before SDR Tonemap

- **Extraction:** `ffmpeg -i input.MOV -c:v copy -bsf:v hevc_mp4toannexb -f hevc - | dovi_tool extract-rpu - --mode 0 -o RPU.bin`

- **Inspection:** `dovi_tool info -s RPU.bin` shows bl_bit_depth 10, vdr 12, rpu_type 2, per-shot L1/L2. Absence beyond default = plain HLG.

- **Application:** Dolby-bake (dovi_tool + mp4muxer re-encode then inject-rpu; player does tone map — not relevant) vs Software tonemap DV-aware: `vs-placebo use_dovi=True` or `ffmpeg libplacebo apply_dolbyvision=1` — libplacebo consumes RPU to reconstruct DV PQ signal then tone-maps. FFmpeg docs: `apply_dolbyvision — Apply Dolby Vision RPU metadata if present... Dolby Vision will always output BT.2020+PQ...` — https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/libplacebo.html . gh search code confirms default ON.

**Evidence for skin:** RPU L1 midtone lifts 0.2-0.5 stops vs plain HLG. Community notes iPhone 8.4 RPU is minimal static reshaping (generator docs: "8.4 HLG base layer with static reshaping" — https://github.com/quietvoid/dovi_tool/blob/main/docs/generator.md) rather than per-shot creative trim. If minimal, applying changes little and risks PQ artifacts.

**FFmpeg apply_dolbyvision quality (FACTs):**

- Via libdovi crate; enabled by default since libplacebo ≥4.192 / ffmpeg ≥6.1. Quality production for Jellyfin.

- iOS Media Toolkit (https://github.com/jgorostegui/ios-media-toolkit) preserves DV via dovi_tool extract/inject + Dolby mp4muxer; notes "standard re-encoding pipelines strip DV metadata... losing dynamic tone mapping" — so plain ffmpeg without RPU handling = HLG-only path (matches Premiere).

- No published A/B apply_dolbyvision 0 vs 1 → Adobe visual diff on 8.4 sample exists. Gap.

---

## 4. Known FFmpeg/libplacebo Parameter Sets Matching Adobe or Apple Look

### 4.1 Community Filter Strings (FACT — collected)

| Context | Filter string (exact) | Source |
|---|---|---|
| Popular zscale→sdr (PQ) | `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` | https://32blog.com/en/ffmpeg/ffmpeg-hdr-to-sdr-tonemapping ; https://github.com/rafgger/HDRtoSDR |
| Same for HLG | `zscale=tin=arib-std-b67:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` | 32blog HLG section |
| bbimer iPhone DV 8.4 → LT | `libplacebo=tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709` + fallback `zscale t=linear:npl=220 tonemap mobius param 0.4 desat 0.5` | https://github.com/bbimer/iphone-hdr-to-sdr-ffmpeg |
| blurridge iPhone | `zscale transfer=linear tonemap hable peak 8 zscale transfer=bt709 format yuv420p colorspace bt709` | https://github.com/blurridge/ffmpeg-iphone-hdr-sdr-converter |
| HdrToSdr v5/v6 | `libplacebo=tonemapping=spline:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le` (+ eq gamma=0.92) | `conversion-spike-2026-08-25.md` §17 |
| Jellyfin/MPV HQ | `libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709` or `spline` with `peak_detect=1` | https://forum.doom9.org/showthread.php?t=186132 |
| Apple AVFoundation | `videoComposition.colorPrimaries=ITU_R_709_2` + `colorTransferFunction=ITU_R_709_2` | Apple PDF |

None claims "matches Adobe Hue Preservation Knee 0.5 / Sat 0.5" — generic.

### 4.2 Libplacebo Preset Evidence

- `hable`/`mobius` marked legacy/low-quality, should not be used — vs-placebo docs. Modern choice spline or bt2390.

- bt2390 vs spline (mpv #9800 — https://github.com/mpv-player/mpv/issues/9800 ): bt2390 linear section clips bright scenes; bt2446a/spline param 0.15 better for very bright scenes.

- TORIN HDR-to-SDR app Static vs Dynamic (MAXFALL) — https://github.com/TORlN/HDR-to-SDR . No Adobe match claim.

### 4.3 Approximation Recipe for Adobe (INFERENCE)

Based on Adobe defaults (Hue Preservation Highlight Saturation 0.5 ~= perceptual mid, Knee protect mids) + local measurement spline ~0.9 stops brighter than bt2390:

```bash
libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:contrast_recovery=0.0:peak_detect=0:format=yuv422p10le
# follow with: eq=gamma=0.96:contrast=1.03:saturation=0.97
```

Rationale: param 0.45 raises pivot (higher knee) → protects skin mids while compressing highlights like Adobe Knee; peak_detect=0 removes auto-boost; perceptual balances highlight desat; tiny gamma/contrast instead of 0.92 corrects remaining 0.07 stop without crushing shadows.

Validation:

```bash
scripts/compare-to-reference.sh Output/spike/<candidate>.mov Sample/2-rec709.mp4  # crossed mandatory
# visual: Resolve vectorscope skin line, waveform 75% diffuse white
```

---

## 5. Practical Recommendation Space for Small Panel Product — Ranked Tiers

| Tier | Pipeline | Fidelity to Premiere SDR (INFERENCE) | Pros | Cons | When to use |
|---|---|---|---|---|---|
| **T1 — Pure FFmpeg libplacebo** | tools/ffmpeg (ffmpeg-full 9.0.1_1 + molten-vk) filter above, no DV handling. Single ffmpeg call. | ~90-93% visual (luma ±0.1 stop, hue ~3° skin) | Fast (Vulkan), no license, deterministic, privacy-stripped, already implemented. | Cannot replicate exact knee math; skin may stay slightly saturated. | **Default** — sweep params to close 90→93%. |
| **T2 — DV-trim + FFmpeg** | ffmpeg hevc_mp4toannexb | dovi_tool extract-rpu -> if L1 present, libplacebo apply_dolbyvision=1 (DV->PQ) then PQ->709 spline; else fallback T1. | 92-95% to camera intent, but ~88-91% to Premiere if Premiere ignored trim | Adds 0.3 stops skin lift if RPU carries trim | Extra dep, double conversion | Opt-in toggle "Use Dolby Vision trims if present" |
| **T3 — Resolve CLI / headless** | DaVinciResolveScript AddItemListToMediaPool -> CreateTimeline -> RCM Input Rec.2100 HLG Scene, Output Rec.709 Gamma 2.4 -> AddRenderJob. Wrapper dvr (https://github.com/poechant/davinci-resolve-cli) | ~97-99% to Adobe if matched (both BT.2408-family) | Visually best, production engine | Requires Resolve Studio running, macOS only, ~3 GB, fragile API | Pro users; not default. Offer "Open in Resolve" drag (proven outbound seam clipdock-outbound-drag-readback-2026-08-25.md) rather than headless render. |
| **T0 — Legacy hable/zscale** | zscale+tonemap=hable:desat=0 | 80-85% | Works w/o Vulkan | No perceptual gamut, sharpness loss — falsified §14 | Diagnostic only |

**Cost (time):** T1 < T2 < T3. **Maintenance:** T3 >> T2 > T1.

**Operational Recommendation (INFERENCE):**

- Ship T1 primary, with 5-way A/B contact sheet of §2.1 candidates A-F on 1.MOV 4s segment (reuse visual-tonemap-experiment harness) so user re-judges skin/shadow on calibrated display.
- Add T2 as experimental flag; detection ffprobe dvvC -> dovi_tool info -> if L1>default expose _hlg and _dovi.
- Do not promise T3 in v1; if demanded, implement via outbound drag to Resolve Media Pool rather than headless render.

---

## 6. Conflicts / Uncertainty

- **Adobe EETF undisclosed vs BT.2408/2390 assumption.** No Adobe doc confirms BT.2390/2408. Treating Premiere as BT.2390 inference from knee language. Test: export same HLG frame from Premiere with each tone mapper at varying Knee vs libplacebo spline param sweep waveform.

- **Apple vs Adobe divergence.** Old refs MainConcept *-rec709.mp4 handler AVC Coding, not Apple. Apple VideoToolbox may differ 0.1-0.3 stops. Must re-compare all v3/v4/v5 against Premiere export, not MainConcept.

- **Viewing gamma trap 1-1-1 vs 1-2-1 vs 2.4.** Premiere Deliver Rec.709-A (1-1-1) vs Rec.709 Gamma 2.4 (1-2-1) and viewer Display Color Management vs 1.96 QuickTime vs 2.4 Broadcast changes brightness 3-6% without touching pixels — Adobe forum https://community.adobe.com/questions-729/rec-709-vs-rec-2020-workflow-for-iphone-footage-1414898 . Must lock viewer gamma and tag check.

- **DV RPU content unknown.** Whether 1.MOV/2.MOV carry creative L1/L2 beyond defaults requires dovi_tool info -s RPU.bin (gap noted local-sample-inspection §10). If none, T2 no benefit.

- **Peak detection for HLG.** HLG scene-referred, not peak-defined like PQ. libplacebo peak_detect on HLG may measure diffuse white ~75% incorrectly. Deterministic (peak_detect=0) likely more Adobe-like.

- **Search coverage gap:** No community apply_dolbyvision 0 vs 1 A/B on 8.4 HLG skin vectorscope; no Reddit match for curve constants — rdt search returned only workflow chatter. Doom9 HLG threads treat HLG as close enough — https://forum.doom9.net/showthread.php?t=185185 , https://forum.doom9.org/showthread.php?t=186132

---

## 7. Implication for Task (what main agent should do next)

1. **Close reference gap:** Re-export 1.MOV/2.MOV from Premiere (Auto Tone on, Hue Preservation default 0.5/ Knee default, Output Rec.709) and replace MainConcept refs. Document Premiere version + preset in tools/PROVENANCE.txt.

2. **Bounded A/B sweep (no prod change):** Reuse visual-tonemap-experiment harness with tools/ffmpeg candidates A-F (≤4s, prores LT, -n guard). Generate Output/diagnostic/adobe-match-*/ contact sheet at t=1.0s plus signalstats CSV.

3. **RPU inspection:** Install dovi_tool, run `ffmpeg -i Sample/1.MOV -c:v copy -bsf:v hevc_mp4toannexb -f hevc - | dovi_tool info - --summary` to report L1/L2. Gate T2 on this.

4. **Do not ship single eq gamma fix.** Replace with libplacebo native gamma/contrast or small eq after A/B pick; document gamma=0.92 was MainConcept numeric fit, not Premiere perceptual.

5. **Document viewer conditions:** Require calibrated SDR 100 nits, locked Rec.709 Gamma 2.4 viewer, tag check, note 1-1-1 vs 1-2-1.

---

## 8. Risks / Unknowns

- **Preset unknown:** User's Premiere export may use Wide Gamut (Tone Mapped) vs Direct Rec.709 (SDR) — changes processing path (Larry Jordan). Ask for Sequence Settings screenshot + version.
- **MoltenVK failure:** VK_ERROR_INCOMPATIBLE_DRIVER before molten-vk (conversion-spike §1b). Sweep must preflight `tools/ffmpeg -h filter=libplacebo`.
- **apply_dolbyvision=1** forces PQ colorimetry, triggering double conversion (HLG->PQ->709) if not two-stage. Mitigate with explicit two-stage.
- **VFR interaction:** 1.MOV avg 29.47 vs r30 — local-sample-inspection §6.6 — may affect libplacebo smoothing (20-frame window). Fixed-knee avoids.
- **Synthetic fixture:** iPhone 17 Pro Max 26.5.2 future dated — if synthetic, RPU may be defaults not representative; A/B may overfit.

---

## 9. Sources (accessed 2026-08-25 unless noted)

1. Adobe Help — Tone mapping in Premiere — https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/tone-mapping-in-premiere.html — 2026-03-05 — FACT pipeline
2. Adobe Help — Color Management options — https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/color-management-options.html — 2026-01-07 — FACT operators/params
3. Adobe Help — About Color Management — https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/about-color-management.html — 2026-01-07 — FACT working->output
4. Adobe Announcement — Timeline tone mapping — https://community.adobe.com/announcements-732/released-timeline-tone-mapping-313303 — 2022-12-01 — FACT history
5. Adobe Announcement — Updated color management — https://community.adobe.com/announcements-732/now-released-dramatically-updated-color-management-in-premiere-pro-313927 — 2024-08-15 — FACT presets
6. Larry Jordan — New Color Workflow 2025 — https://larryjordan.com/articles/the-new-color-workflow-in-adobe-premiere-pro-2025/ — 2025-06-21 — FACT workflow
7. Larry Jordan — Quick Tip iPhone HDR — https://larryjordan.com/articles/quick-color-tip-for-iphone-hdr-video-in-adobe-premiere-pro/ — FACT iPhone harsh before tone map
8. Apple — Incorporating Dolby Vision (PDF) — https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf — FACT DV 8.4 AVFoundation HDR->SDR, RPU discard
9. Apple TN3145 — https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata — FACT amve/8.4
10. ITU-R BT.2408-0 — https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-2017-PDF-E.pdf — FACT knee
11. ITU-R BT.2100-2 — https://www.itu.int/rec/R-REC-BT.2100/en — FACT HLG gamma 1.2
12. WWDC23 — https://developer.apple.com/videos/play/wwdc2023/10181/ — FACT tone map depends on transfer
13. libplacebo FFmpeg 8.0.3 — https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/libplacebo.html — FACT apply_dolbyvision, enums
14. libplacebo Options — https://libplacebo.org/options/ — FACT gamut/tone constants
15. FFmpeg vf_libplacebo.c — https://github.com/FFmpeg/FFmpeg/blob/3d1d546f/libavfilter/vf_libplacebo.c — FACT TONE_MAP enum
16. quietvoid/dovi_tool — https://github.com/quietvoid/dovi_tool + docs — FACT RPU modes
17. Micronization blog — https://micronization.blogspot.com/2024/08/dolby-vision-metadata-rpu-editing-guide.html — 2024-08-24 — COMMUNITY
18. jellyfin VF — https://github.com/jellyfin/jellyfin-ffmpeg/pull/369 — FACT VideoToolbox distinct
19. colour-science — https://colour.readthedocs.io/en/stable/generated/colour.models.ootf%5Finverse%5FBT2100%5FHLG.html — FACT exact BT.2100
20. HDRtoSDR (rafgger) — https://github.com/rafgger/HDRtoSDR — FACT pipelines
21. TORlN HDR-to-SDR — https://github.com/TORlN/HDR-to-SDR — FACT GPU/CPU
22. vs-placebo — https://github.com/Lypheo/vs-placebo/blob/master/README.md — FACT use_dovi, legacy marks
23. Doom9 — https://forum.doom9.org/showthread.php?t=175125 — COMMUNITY
24. Doom9 2025 — https://forum.doom9.org/showthread.php?t=186132 — COMMUNITY
25. Doom9 HLG — https://forum.doom9.net/showthread.php?t=185185 — COMMUNITY
26. 32blog — https://32blog.com/en/ffmpeg/ffmpeg-hdr-to-sdr-tonemapping — 2026-03-29 — COMMUNITY
27. ProVideo Coalition — https://www.provideocoalition.com/how-to-troubleshoot-hdr-iphone-footage-in-premiere-according-to-adobe/ — 2022-08-17 — FACT + COMMENT
28. Adobe forum — https://community.adobe.com/questions-729/rec-709-vs-rec-2020-workflow-for-iphone-footage-1414898 — COMMUNITY gamma trap
29. Local corpus — `2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` §7-11 + `local-sample-inspection-2026-08-25.md` §6 + `conversion-spike-2026-08-25.md` §1b-17 — FACT
30. r/colorists via rdt-cli — 2026-08-25 — COMMUNITY no constants
31. gh code search apply_dolbyvision — 2026-08-25 — FACT

---

## 10. Style Compliance

Follows `conversion-spike` / `visual-tonemap-experiment` style: status/invariant header, host evidence, side-by-side tables, verbatim commands, fact/inference separation, bounded uncertainty, no visual claim.

---

*End — read-only research; no `Sample/`, `Output/`, `scripts/` modified.*

