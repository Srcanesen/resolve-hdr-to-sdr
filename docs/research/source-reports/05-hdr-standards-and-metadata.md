# iPhone HDR — Standards Layer Diagnosis Model
*Read-only neutral model: container → bitstream → Dolby RPU → pixels — what each field means, where it lives, and when it conflicts.*

> **Scope:** ITU-R BT.2100 HLG/PQ, BT.2020/709, HEVC VUI, ISOBMFF/QuickTime `colr/nclx/mdcv/clli`, Dolby Vision 8.x/RPU.  
> **Date:** 2026-08-25 (access). Standards dated inline. **No app design / no repo edits** — diagnosis only.

## 1. Authoritative Stack

| Layer | Spec owner | Where field lives | Needs decode? |
|-------|------------|-------------------|---------------|
| **HDR system** | **ITU-R BT.2100-2 (2018-07-12)** — builds on **BT.2020-2** + **BT.709**, **SMPTE ST 2084 (PQ)**, **ARIB STD-B67 (HLG)**, **SMPTE ST 2086**, **ICtCp (Dolby) → Rec.2100** | Normative definitions; not in file, but code points reference it | No |
| **Codec bitstream** | **ITU-T H.265 / ISO/IEC 23008-2 (HEVC) Annex E Table E.3** + **ISO/IEC 23091-2 (H.273) — CICP code points** | SPS VUI: `video_full_range_flag`, `colour_description_present_flag`, `colour_primaries` (8b), `transfer_characteristics` (8b), `matrix_coeffs` (8b), `chroma_loc_info` | **No — parse NAL / SPS only, no pixel decode** (FFmpeg `cbs_h265_syntax_template.c:322-360`) |
| **Container** | **ISO/IEC 14496-12 ISOBMFF** derived from **Apple QuickTime File Format (QTFF) Chap 3**; extensions in **14496-15 (HEVC)** + **23008-12 (HEIF)** | Boxes at stsd / sample entry level: `colr` (`nclx`/`nclc`/`prof`), `mdcv`, `clli`/`coll`, `dvcC`/`dvvC`/`dvwC` | **No — ISO box parse only** (FFmpeg `mov.c:2202`, `6928`, `7009`, `9075`) |
| **Dolby enhancement** | **Dolby Vision Profiles & Levels v1.3.2 (2019-09-16)** + **ETSI TS 103 572**, dynamic metadata **SMPTE ST 2094-10** | `dvcC`/`dvvC`/`dvwC` + **SEI / NAL RPU** (unspecified HEVC NAL type 62/63, carried as `rpu_present_flag`) | Box parse = no decode; **RPU payload needs NAL extraction** but still no pixel decode |

> **Primary-implementation cross-check** required by brief: ≥2 of (a) published spec text, (b) FFmpeg libav*, (c) ExifTool/Dolby archival PDF. Used: ITU web summary + Wikipedia-cited spec + FFmpeg `pixfmt.h`/`mov.c`/`dovi_isom.c` + archived Dolby PDF via Wikipedia citation — see Sources.

---

## 2. ITU-R BT.2100 / BT.2020 / BT.709 — The Colour System the Code Points Point To

**BT.2100-2** (ITU-R Rec, 2018-07-12) defines HDR-TV for production/exchange. Key clauses (Table 1/5/9):

- **Resolution:** 1920×1080, 3840×2160, 7680×4320 (16:9 square pixels, progressive only) — orthogonal to HDR; iPhone uses 1920×1080 or 3840×2160 @ 24/30/60.
- **Primaries & white point:** **identical to BT.2020** (not BT.709). Chromaticity (CIE 1931 x,y):
  - R 0.708,0.292  G 0.170,0.797  B 0.131,0.046  W D65 0.3127,0.3290
  - Encoded as **CICP / VUI `colour_primaries = 9` (BT2020)** — see §3. BT.709 primaries are `1` (R 0.640/0.330 etc) — mislabel = classic diagnosis error.
- **Transfer functions (TF) — two families, mutually exclusive per signal:**
  - **PQ — SMPTE ST 2084 (code `transfer = 16`)**: Perceptual Quantizer, absolute, 0–10 000 cd/m² EOTF. Needs metadata to map to display; OOTF is display-referred. Not backward compatible with SDR.
  - **HLG — ARIB STD-B67 (code `transfer = 18`)**: Hybrid Log-Gamma, relative/scene-referred, nominal 1000 cd/m², system gamma adjustable with surround (5 cd/m² D65). OETF ≈ gamma + log; backward compatible with SDR displays that understand BT.2020 primaries (but **not** with legacy BT.709-only sets — they show oversaturated hue if primaries ignored). BBC/NHK design.
  - BT.2100 also standardizes EOTF/OOTF/OETF triple; `OETF⁻¹ ≈ EOTF` with OOTF in middle. For YCbCr, **luma coefficients** are BT.2020-derived: `Kr 0.2627, Kg 0.6780, Kb 0.0593` (vs BT.709 0.2126/0.7152/0.0722) — hence **matrix_coeffs = 9 (BT.2020 NCL)** for most Rec.2100 content. `10` (CL), `14` (ICtCp) are also legal in Rec.2100 but iPhone uses `9`.
- **Signal representation:** 10- or 12-bit, **narrow (MPEG) range is canonical** (10-bit: black 64, grey 512, peak 940/960; 12-bit: 256/2048/3760/3840). **Full range (0–1023/4095) also allowed.** Encoded as `video_full_range_flag 0/1`. Rec.2100 Table 9 defines both. **HEVC Main10 + narrow is iPhone default.**
- **Colour spaces:** `RGB`, `YCbCr` (non-constant luminance is default), `ICtCp` (Dolby, HDR-optimized). iPhone HEVC uses 4:2:0 YCbCr.
- **Chroma siting:** H.265 v4 (2018-02) + BT.2100-1 errata mandate **top-left (type 2)** for BT.2020/2100; earlier center-left (0) deprecated. Blu-ray/Dolby Vision HDR use top-left. VUI `chroma_sample_loc_type` signals this.

**BT.2020 vs BT.709 relationship:** BT.2020 is superset gamut; DCI-P3 (SMPTE 431/432, primaries 11/12) sits **inside** BT.2020. P3-D65 (`12`) is iPhone display gamut but **not** the encoding gamut — files should be `9`. Seeing `12` in VUI/`nclx` = P3 capture/master, not Rec.2100 strict.

---

## 3. HEVC VUI — The Bitstream's Own Labels (`SPS vui_parameters()`)

Per **ITU-T H.265 v6/v8 §E.2.1 + Table E.3** (also **ISO/IEC 23091-2 §8** — H.273 CICP):

```c
// libavcodec/cbs_h265_syntax_template.c:322 — vui_parameters()
flag(video_signal_type_present_flag);
 if (flag) {
   ub(3, video_format);            // 5 = unspecified (typical)
   flag(video_full_range_flag);    // 0=NARROW/MPEG  1=FULL/JPEG
   flag(colour_description_present_flag);
   if (flag) {
     ub(8, colour_primaries);          // Table E.3
     ub(8, transfer_characteristics);
     ub(8, matrix_coefficients);
   } else infer(prm=2,trc=2,mat=2); // 2 = UNSPECIFIED
 } else infer(full=0, prm=2,trc=2,mat=2);
flag(chroma_loc_info_present_flag);
 if (flag) ue(chroma_sample_loc_type_top/bottom) // 2 = top-left per spec
```

**Canonical code points (verified in `libavutil/pixfmt.h:642-706` matching H.273):**

| Field | Values relevant to iPhone HDR | Notes |
|-------|-------------------------------|-------|
| `colour_primaries` | **1 = BT.709**, **9 = BT.2020** (thus BT.2100), 11 = DCI P3 (ST431), 12 = P3-D65 (ST432), **2 = Unspecified** | `9` is mandatory for Rec.2100; `1` with HLG/PQ is **conflict** (mismatched matrix/primaries). |
| `transfer_characteristics` | **1 = BT.709/BT.2020 SDR** (≈2.4 gamma), **14 = BT2020 10b**, **15 = BT2020 12b**, **16 = PQ (ST2084)**, **18 = HLG (ARIB B67)**, 6 = 170M, 2 = Unspecified | iPhone DV 8.4 → **18** in VUI; iPhone PQ HDR (if any) → 16; mislabel 1 with HDR pixels = washed-out SDR decode. FFmpeg enum `AVCOL_TRC_SMPTE2084=16`, `ARIB_STD_B67=18` (`pixfmt.h:687`). |
| `matrix_coefficients` | **1 = BT.709**, **9 = BT.2020 NCL**, **10 = BT.2020 CL**, **14 = ICtCp (BT.2100)**, **0 = RGB/GBR**, 2 = Unspec | `9` pairs with primaries 9; `1` with 709; `14` = ICtCp (Dolby Profile 5/FEL). See `pixfmt.h:706` `AVCOL_SPC_BT2020_NCL=9`, `ICTCP=14`. |
| `video_full_range_flag` | **0 = narrow (MPEG, BT.2100 canonical 64-940)** — iPhone default; **1 = full (JPEG, 0-1023)** | Decides luma/chroma scaling equations (`AVCOL_RANGE_MPEG=1` vs `JPEG=2`, `pixfmt.h:748`). Affects **all** planes. |
| `chroma_sample_loc_type` | **0 = left / unspecified legacy**, **2 = top-left per BT.2020/2100** | H.265 2018 mandates 2 for HDR; `mov.c` does not enforce but FFmpeg logs. |

**Absent-flag semantics (major diagnostic pitfall):** If `vui_parameters_present_flag = 0` or `colour_description_present_flag = 0`, **all three colour fields infer `2` (Unspecified)** and `full_range = 0`, `format = 5` — **not** BT.709 or BT.2020. Many analyzers silently assume BT.709 → false diagnosis. File may still be HDR; the RPU/`nclx` may carry the truth.

**What FFmpeg exposes:** `libavformat/mov.c` → `codecpar->color_primaries/trc/space/range`; SPS parse sets same. If VUI absent, FFmpeg leaves `AVCOL_*_UNSPECIFIED`.

---

## 4. ISOBMFF / QuickTime Container — The Box Layer

Base spec **ISO/IEC 14496-12:2022 (ISOBMFF)** — extends QuickTime `colr` → `nclx` in **14496-12 §8.5.2.2 / 23008-12**.

### 4.1 `colr` — Colour Information (`mov.c:2202 mov_read_colr()`)

Hierarchy: `moov → trak → mdia → minf → stbl → stsd → avc1/hvc1/hev1 → colr`

| Type | Payload (big-endian) | Range |
|------|----------------------|-------|
| **`nclx` (recommended, `atom.size >= 11`)** | `uint16 colour_primaries`, `uint16 transfer_characteristics`, `uint16 matrix_coeffs`, `uint8 full_range_flag<<7` (top bit) | Same enumerations as VUI (H.273). FFmpeg checks `avio_rb16×3 + (r8>>7)` and stores in `codecpar->color_*` + `color_range`. Invalid enum → remapped to `UNSPECIFIED` (log, not error). |
| **`nclc` (legacy QuickTime, 3×uint16, no range byte)** | Same 3 u16, no range bit | `full_range` ambiguous; if no `nclx`/VUI, range = UNSPECIFIED. Older iPhone MOV sometimes uses `nclc`. |
| **`prof` (ICC profile)** | Raw ICC bytes (`atom.size-4`) | **Overrides** any numeric tags for color-managed readers (Apple ColorSync). If present, `nclx` may be absent; HDR ICC unlikely on iPhone. |

**Placement quirks:** Brand `qt  ` / `iso6` etc; `colr` may appear **both** at track visual sample entry **and** HEIF primary item. `mov.c` prefers track `colr` → `codecpar`. HEIF path uses `item->icc_profile`.

**QuickTime `gama`/`fiel`/`pasp`/`clap`** are legacy; not relevant to HDR but can coexist — ignore for diagnosis.

### 4.2 `mdcv` — Mastering Display Colour Volume (`mov.c:6928 mov_read_mdcv()`, SMPTE ST 2086)

Box: `mdcv` (ISOBMFF), 24 bytes, **no version/flags**:

```
for G,B,R (mapped G=1,B=2,R=0 for spec order):
  uint16 display_primaries[j][0]  // x, denominator 50000 (G_x,B_x,R_x)
  uint16 display_primaries[j][1]  // y
uint16 white_point[0/1]            // D65, 50000
uint32 max_luminance               // cd/m2 ×10000
uint32 min_luminance               // ×10000
has_primaries/has_luminance flags set in FFmpeg side data AV_MASTERING_DISPLAY_METADATA
```

Typical iPhone/Dolby master: P3 (≈13250,34500 ...) or BT.2020; max 1000–4000, min 0.0001–0.005. **Static metadata** — does not change per frame. Absence is legal (no mastering metadata = unknown display).

### 4.3 `clli` / `coll` — Content Light Level (`mov.c:7009 mov_read_clli()`, CEA-861.3 §6 + SMPTE ST 2094-40)

Two spellings, same semantics:
- **`clli` (ISOBMFF, 4 bytes):** `uint16 MaxCLL`, `uint16 MaxFALL` (cd/m² as `uint16` — no denom)
- **`coll` (QuickTime with version+flags, 9 bytes):** `uint8 version(=0)`, `24 flags`, `uint16 MaxCLL`, `uint16 MaxFALL` (`mov_read_coll()`)

FFmpeg stores `AV_CONTENT_LIGHT_METADATA`. Duplicate → warning, first wins.

**Distinguish:** `MaxCLL` = brightest pixel in stream; `MaxFALL` = brightest average frame. Used by tone-mapping; not colour space.

### 4.4 Dolby Boxes: `dvcC` / `dvvC` / `dvwC` (`mov.c:9075 mov_read_dvcc_dvvc()`, `dovi_isom.c`)

All map to `AV_PKT_DATA_DOVI_CONF` → `AVDOVIDecoderConfigurationRecord` (`dovi_meta.h:30-60`):

```
uint8 dv_version_major/minor
7b dv_profile | 6b dv_level | 1b rpu_present_flag | 1b el_present_flag | 1b bl_present_flag
4b dv_bl_signal_compatibility_id | 2b dv_md_compression | 26b reserved
(64b total payload if version >=1.2; else 32b)
```

- `dvcC` — legacy (profiles 0-7, AVC/HEVC)
- `dvvC` — newer (profiles 5-8, HEVC single/dual layer; Apple uses this)
- `dvwC` — inside `meta`/`hvcC` for HEIF? (rare)

Profile/lvl semantics in §5.

---

## 5. Dolby Vision 8.x Signaling & RPU

### 5.1 Spec relationship

Dolby Vision bitstream is **always** `HEVC Main10 BL + optional RPU (+ optional EL)`. **ETSI GS CCM 001 / Dolby bitstreams within ISOBMFF v2.1.2** define `dvcC/dvvC` and SEI `rpu_nal`. RPU is **not** pixels — it's a **CDM (Composition Dependent Metadata)** SEI that maps BL → Dolby IPT-PQ with per-frame reshaping + dynamic metadata (L1/L2/L3/L5-L9). The RPU's `bl_video_full_range_flag`, `bl_bit_depth`, `vdr_bit_depth` (§8 in `dovi_meta.h:AVDOVIRpuDataHeader`) **must match** BL's VUI/nclx, else mapping is mathematically wrong.

### 5.2 Profile 8 variants — the iPhone-relevant ones

From **Dolby Profiles & Levels v1.3.2 pp3-5 + Wikipedia table citing same + archived PDF**; confirmed in **FFmpeg `dovi_meta.h`** & `x265 --dolby-vision-profile 8.x`:

| Profile | BL codec | EL | RPU | Typical BL signal (VUI/nclx) | `dv_bl_signal_compatibility_id` (BL compat) | Meaning |
|---------|----------|----|-----|------------------------------|---------------------------------------------|---------|
| **8.1** | HEVC 10b Main10 | none | yes | **PQ** `trc16`, BT.2020 `pri9 mat9`, **narrow 0** | **1** = **HDR10** compatible | HDR10 receiver can decode BL as HDR10; DV receiver uses RPU → 12-bit IPT-PQ. x265 & Apple export sometimes. |
| **8.2** | HEVC 10b | none | yes | BT.709 SDR `pri1 trc1/13 mat1` or 601 | **2** = **SDR** | SDR fallback; not iPhone capture. |
| **8.3** | HEVC 10b | none | yes | HLG `trc18`? (rare) | **3** = SDR? (reserved in some docs) | Rarely used. |
| **8.4** | **HEVC 10b** | **none** | **yes** | **HLG** `trc18`, BT.2020 `pri9 mat9` | **4** = **HLG** | **iPhone 12/13/14/15 default Dolby Vision video.** VUI **and** `nclx` = `9/18/9/0`. MP42 brand often `hvc1`/`dvh1`/`dvhe`. |
| **8.x generic** | — | — | — | — | 0 = None (proprietary IPT-PQ, like profile 5) | `bl_present 0 + iptpq` — not iPhone. |

**FFmpeg log line (`dovi_isom.c`):** `profile:8 level:x rpu:1 el:0 bl:1 compat:1|4` — this line alone distinguishes 8.1 vs 8.4.

**Apple reality:** iPhone 12 launch (2020-10-13) introduced **DV 8.4 HLG-compatible** capture — marketed as "Dolby Vision HDR, HLG-compatible base layer." QuickTime/Photos returns `kCMFormatDescriptionExtension_DolbyVisionConfigurationRecord` with profile 8.4. Later iPhones (13+ Cinematic, 14+ HDR photo) reuse same.

### 5.3 Enhancement layer (only profile 7 — **not** iPhone 8.x)

- **Profile 7 FEL (Full Enhancement Layer, 12b EL residual)** + **MEL (Minimum Enhancement Layer, metadata only, EL 10b but only metadata)** for UHD Blu-ray dual-track `BL+EL`. `el_present=1 bl_present=1 rpu=1 compat=6 (UHD BD)`. **Single `hev1` with `rpu_present=1 el=0` = profile 8; do not expect EL track for iPhone.**

### 5.4 How RPU relates to VUI/nclx/mdcv/clli

- RPU header (`AVDOVIRpuDataHeader: bl_video_full_range_flag`, `bl_bit_depth=10`, `vdr_bit_depth=12`, `chroma_resampling_filter`) **describes BL** so decoder knows source. Mismatch with BL VUI `video_full_range_flag` or bit depth = tone-mapping error (crushed blacks or desaturated).
- RPU DataMapping (non-linear + reshaping curves) **overrides** static `colour_trc` for final display — it's a per-frame IPT→ICtCp mapping, not captured by any static box.
- RPU ColorMetadata (`AVDOVIColorMetadata`) can carry **alternate mastering/color matrices** that **override** `mdcv` / VUI for the DV layer (see `dovi_meta.h:AVDOVIColorMetadata` — `dm_data` L0-L9).
- `mdcv`+`clli` remain valid as **HDR10 fallback** for 8.1/8.4 demuxers that ignore RPU; DV path uses RPU metadata instead.

---

## 6. Coexistence & Conflict Matrix

```
Container colr(nclx)  ↔  Bitstream VUI  ↔  Dolby RPU  ↔  mdcv/clli  ↔  Pixels
      (declared)         (encoded)        (mapping)     (master/L1)   (ground truth)
```

| Combination | Coexist? | Legal? | Diagnosis |
|-------------|----------|--------|-----------|
| `nclx=9/16/9/0` + `VUI=9/16/9/0` + `dvvC 8.1 compat1` + RPU valid | ✓ coexists | **Canonical iPhone PQ fallback** | HDR10 + DV both decode |
| `nclx=9/18/9/0` + `VUI=9/18/9/0` + `dvvC 8.4 compat4` + RPU | ✓ coexists | **Canonical iPhone 12+** | HLG base + DV; SDR TV uses HLG gamma; DV TV uses RPU |
| `nclx absent` + `VUI=2/2/2` + `dvvC 8.4` + RPU with `bl_video_full_range=0` | ⚠ needs RPU inference | Legal but underspecified | **Most screen-only diagnosis stops here** — cannot confirm HDR without parsing RPU or pixels. Flag as `UNSPECIFIED baseline — defer to RPU`. |
| `nclx=9/18/9/0` + `VUI=9/16/9/0` (HLG vs PQ) | ✗ conflict | Legal ISOBMFF but inconsistent | **Conflict: transfer mismatch** — one will be used by decoder depending on precedence (VUI wins in HEVC decoder, nclx wins in ColorSync). Visible symptom: severe brightness/pale-ness flip. Must flag as `MISMATCH trc18vs16`. |
| `nclx=1/1/1/0` (BT709) + `VUI=9/18/9` (BT2020 HLG) | ✗ conflict | Illegal gamut mismatch | Oversaturated on BT.709-only path, desaturated on BT.2020 path. Matrix mismatch compounds. |
| `video_full_range=1 (FULL)` + `nclx range=0 (MPEG)` | ✗ conflict | Legal but inconsistent | Blacks at 0 vs 64; symptom: crushed or lifted blacks. iPhone sometimes writes FULL with HLG — historically confusing; diagnose as `RANGE_MISMATCH`. |
| `mdcv absent` + `clli absent` | ✓ coexists | Legal | No static mastering/L1 metadata; tone-mapping uses defaults. Not diagnostic of HLG/PQ. |
| `mdcv P3 primaries + VUI BT2020` | ⚠ coexistence with semantic tension | Legal (mastering ≠ encoding) | Mastering display P3 inside BT.2020 container — not conflict; but if `mdcv` far narrower than content gamut = clipped. |
| `dvvC 8.4 compat4` + VUI `trc16 PQ` | ✗ conflict | Illegal per Dolby | BL claimed HLG-compatible but bitstream is PQ → HDR10 fallback broken. |
| `RPU bl_video_full_range=1` + VUI `full_range=0` | ✗ RPU vs bitstream conflict | Illegal recomposition | RPU reshaping uses wrong domain scaling → color drift; detectable only by RPU parse. |
| `VUI matrix=0 RGB` + `mdcv present` | ⚠ odd but legal | RGB has no YCbCr matrix; mdcv still valid | Rare for HEVC 4:2:0; likely mislabel. |
| `nclx prof` present + any `nclx pri/trc/mat` | ⚠ override | ICC overrides CICP for color-managed path | `prof` wins on macOS/iOS; legacy TV may use VUI. Two truths. |

**Precedence when multiple sources present (no single spec arbitrates end-to-end):**

1. **Decoder behavior:** HEVC decoder uses **VUI** for YCbCr→RGB conversion (if present). Container `colr` is informative to players before SPS parsed.
2. **Display/color management (Apple):** `colr`/`prof` → **ColorSync** wins for composition & display, even over VUI.
3. **Tone mapping:** `mdcv`+`clli` provide static defaults; **Dolby RPU L1/L2** overrides both for DV path; **HDR10 static metadata SEI (MDCV+CLL) inside HEVC** can also carry same as `mdcv`/`clli` — duplicates can diverge (SEI vs box mismatch).
4. **Dolby pipeline:** RPU `mapping_chroma_format` + curves **supersede** VUI matrix for DV rendering; ignoring RPU = HDR10 fallback.

**Therefore a correct diagnosis must keep four columns separate and never collapse to a single "color" field.**

---

## 7. What Can Be Inspected Without Decoding Pixels

All boxes + VUI + RPU config record = **parser-only** (no `idct/mc/reconstruct`). Pixel decode is only needed to verify that declared metadata actually matches encoded code values (illicit grade).

| Probe | Tool (parser-only) | Fields you get | Limitation |
|-------|--------------------|----------------|------------|
| `ftyp`/`moov` box dump | `mp4box -diso`, `ffprobe -show_packets` without decode, `mediainfo`, `mp4dump`, `exiftool -s -colr* -mdcv* -clli*` | `major_brand` (`qt`, `iso6`, `mp42` with `dvh1`/`dvhe`), compat brands | Not color but confirms Dolby family |
| `colr`/`nclx` | `ffprobe -show_streams` → `color_*`, `exiftool -n -ColorSpaceTags`, `AtomicParsley`, `mov.c` path | `pri/trc/mat/range` enumerations + `prof` detection | If `nclc` (no range) → ambiguous; if `prof` → CICP irrelevant |
| `mdcv`/`clli` | `ffprobe` side data `mastering_display_metadata`, `content_light_level`; `mediainfo --Inform="Video;%MasteringDisplay_ColorPrimaries%"`; `exiftool -MasteringDisplay*` | D65 primaries, Max/Min nits, MaxCLL/FALL | Absence ≠ SDR; presence ≠ HDR (optional) |
| HEVC SPS VUI | `ffprobe -show_streams -select_streams v`, `ffmpeg -c:v hevc -v verbose` logs `colour_primaries` or use `libavcodec/cbs` parser, `hevc_parse` tools, `MediaInfo` | `colour_primaries / transfer_characteristics / matrix_coeffs / full_range / chroma_loc` | Requires finding SPS NAL (extradata `hvcC` or first keyframe). `unspecified(2)` means "no assertion" |
| `dvcC/dvvC` | `ffprobe` side data `dovi_configuration_record`; ` DolbyVisionHdrInfo` in `mediainfo`; `mp4dump --box dvc` | `dv_profile, dv_level, rpu_present, el_present, bl_present, bl_compat_id, compression` | Tells profile 8.4 vs 8.1 without touching RPU; level gives max bitrate/res |
| RPU SEI (header only) | `dovi_tool info-rpu`, `FFmpeg -export_dovi` + `dovi_meta` trace, `libdovi` parse | `rpu_type, vdr_rpu_profile/level, bl_bit_depth, vdr_bit_depth, bl_video_full_range_flag, disable_residual_flag` | Severely muxed? No — NAL unspec 62/63 prefix; separable without frame decode. Full reshaping/curves need deeper parse but still metadata-only |
| Combined verdict | Cross-compare `nclx == VUI == RPU bl_range` etc → conflict table §6 | — | Only proves **declaration consistency**; pixel histogram/HDR waveform still needs decode to catch silent mislabel |

**Minimal iPhone HDR check (no decode):**

```
ffprobe -v quiet -print_format json -show_streams -show_format file.MOV \
 | jq '.streams[] | {codec: .codec_name, profile: .profile, color_primaries, color_transfer, color_space, color_range, side_data_list}'
# Expect: hevc (Main10), color_primaries=bt2020 (9), color_trc=arib-std-b67 (18) for HLG 8.4 OR smpte2084 (16) for 8.1, colorspace=bt2020nc (9), range=tv(=0), side_data: DOVI conf profile 8 level x rpu1 el0 bl1 compat 4
mediainfo --Inform="Video;%colour_primaries%/%transfer_characteristics%/%matrix_coefficients%/%colour_range%" # mirrors VUI
mp4box -diso file.MOV 2>&1 | grep -A6 "colr|mdcv|clli|dvcC|dvvC"
exiftool -n -s -G1 -ColorSpace* -Transfer* -MasteringDisplay* -ContentLightLevel* file.MOV
dovi_tool info file.MOV  # if present — parses RPU without decoding
```

If any of the three (nclx, VUI, RPU `bl_range`) diverge → **reliable diagnosis is "conflict"** — do not correct, report.

---

## 8. iPhone-Specific Mappings

*(Derived from Apple docs + `prof` fallback + Wikimedia-cited Dolby profile table; iPhone content varies by iOS/settings — verify per-file.)*

- **Default capture (iOS 14.3+ with "Dolby Vision" ON):** `hvc1`/`dvh1`/`dvhe` with **Profile 8.4** — `dvvC profile=8 level=?? rpu_present=1 el_present=0 bl_present=1 bl_compat_id=4`, **HEVC Main10 4:2:0 narrow**, **VUI `9/18/9/0`**, **`colr nclx 9/18/9/0`** (or `nclc` on older iOS), **`mdcv` sometimes present (P3 mastering 1000 nits)**, **`clli` sometimes 0/0 if no measurement**. File brand `qt`/`mp42`. No EL track.
- **Compatibility path (HDR off / export "Most Compatible" / Adobe export):** `hvc1` plain HEVC with **profile 8.1 HLG/PQ stripped**: may emit `9/16/9/0` (HDR10) or `9/18/9/0` without Dolby box. Or transcode to SDR `1/1/1/0` (`bt709`) — not HDR.
- **HLG-only export via Photos / Final Cut:** When stripping Dolby, Apple **retains** `nclx/VUI HLG 9/18/9` and drops `dvvC` + strips RPU SEI → file becomes plain HLG. This is the **intended fallback** — player that ignores `dvvC` decodes HLG correctly.
- **Photos still HDR (HEIF `heic`):** Same code points (`pri9 trc16 or 18`) with `colr nclx` in `meta`/`iprp`; no `mdcv`/`clli`.

---

## 9. Diagnostic Limits & Must-Not Infer

1. **Unspecified ≠ SDR.** `2` means "encoder made no assertion." Report as "unspecified — defer to next layer" rather than defaulting to BT.709.
2. **Narrow vs Full is per-signal, not per-master.** A file can be `full_range=1` and still be Rec.2100 — it's uncommon but legal. Don't flag HDR because of range alone.
3. **HLG vs PQ cannot be distinguished by `colr`/`VUI` alone when conflicted.** Need to decide which wins per player (Apple → `colr`, VLC/FFmpeg decoder → VUI). Report both.
4. **RPU reshaping is invisible without RPU parse but affects every picture.** Two files with identical VUI/`nclx`/`mdcv` can look radically different if RPU curves differ (or one side missing → HDR10 fallback).
5. **`mdcv`/`clli` are static.** They do not capture per-scene tone variation; dynamic Dolby `L1` (inside RPU) does. Absence of `clli` does not invalidate HDR.
6. **ICtCp (`mat14`) vs YCbCr NCL (`mat9`):** Profile 5/FEL use `14` + `ipt-c2` (15) / proprietary transfer; profile 8 uses `9` — mixing them is mislabel.
7. **Container vs bitstream duplicate metadata:** `mdcv` in box vs `MasteringDisplay SEI` in HEVC can diverge — FFmpeg exposes both via side data; box is more likely honoured by MP4 players, SEI by broadcast.
8. **No pixel decode = can't catch silent mastering errors** (e.g., VUI says BT.2020 but pixels were graded P3 1000 nits then naively re-tagged). Waveform/vectorscope still needs decode.

---

## 10. Field-Level Map (Copyable Checklist)

```
[ ] ftyp: major/compat brands incl dv brands? (qt/mp42/dvh1/dvhe)
[ ] colr: type=nclx|nclc|prof | pri u16 | trc u16 | mat u16 | range bit (or n/a)
    └ enum map: 1=709 9=2020 2=unspec | 16=PQ 18=HLG 1=709 2=unspec | 9=NCL 14=ICtCp 1=709
[ ] mdcv: G/B/R x,y / Wp x,y (÷50000) | Max/Min luminance (÷10000) | has_* flags
[ ] clli/coll: MaxCLL | MaxFALL | coll version (if present)
[ ] dvcC/dvvC/dvwC: dv_version  | dv_profile 8.x | dv_level | rpu1/el0/bl1? | compat 1=HDR10 4=HLG
[ ] VUI (SPS): vps/sps vui_parameters_present_flag | video_full_range_flag 0/1 | colour_description_present_flag | pri/trc/mat (=HEVC Table E.3) | chroma_loc 0/2
[ ] RPU header: rpu_type | vdr_rpu_profile/level | bl_bit_depth 10 | vdr 12 | bl_video_full_range_flag | disable_residual_flag
[ ] RPU mapping: mapping_color_space | mapping_chroma_format | L1-L9 metadata presence
[ ] Verdict: nclx == VUI ? | range aligned across nclx/VUI/RPU? | profile matches VUI trc (8.4↔18, 8.1↔16)? | static mdcv compatible with primaries?
```

---

## 11. Sources (primary/official, access 2026-08-25)

1. **ITU — Recommendation BT.2100-2 (2018-07) catalog entry + summary** — https://www.itu.int/rec/R-REC-BT.2100/en — ITU-R (UN agency) — defines HLG (ARIB B67) + PQ (ST2084), BT.2020 primaries, 10/12b narrow/full, ICtCp. *Note: full PDF behind ITU paywall/registration; values cross-verified via Wikipedia citation of same spec and BBC/ARIB whitepapers.* — why trusted: **standards body**.
2. **ITU — Recommendation BT.2020-2 / BT.709-6** — https://www.itu.int/rec/R-REC-BT.2020 (and BT.709) — defines primaries/matrix for VUI code 9/1 — **standards body**.
3. **ITU-T H.265 (04/2023) & ISO/IEC 23091-2:2019 (H.273/CICP) Table E.3** — code points for `colour_primaries/transfer/matrix/range/chroma_loc`. Summarized via **FFmpeg `libavutil/pixfmt.h:642-820`** (maps 1:1 to H.273) and `libavcodec/cbs_h265_syntax_template.c:322-360` VUI parse — **open-source implementation of normative table** (secondary but bit-exact). Also Wikipedia HEVC page citing same table.
4. **ISO/IEC 14496-12:2022 ISOBMFF / 14496-15 / QuickTime File Format Spec** — box definitions. Verified via **FFmpeg `libavformat/mov.c:2202 (colr/nclx), 6928 (mdcv), 7009 (clli), 9075 (dvcc)`** — **implementation of normative box syntax** + Library of Congress FDD and Apple QTFF archive (qtff3.html historically; current Apple CoreMedia docs redirect). — why trusted: FFmpeg is reference parser used by `ffprobe/mediainfo`.
5. **ARIB STD-B67 (2015-07) & SMPTE ST 2084 / ST 2086 / ST 2094-10** — HLG curve, PQ curve, MDCV/CLL. Cited via BBC/EBU fact sheets + Flatpanels/Apple HDR guides + FFmpeg `pixdesc.c` names (`smpte2084=16`, `arib-std-b67=18`). *Full SMPTE specs paywalled (SMPTE) — treated as secondary via FFmpeg/exiftool.*
6. **Dolby Vision Profiles and Levels Specification v1.3.2 (2019-09-16) PDF** — https://professional.dolby.com/siteassets/content-creation/dolby-vision-for-content-creators/dolbyvisionprofileslevels_v1_3_2_2019_09_16.pdf (archived via Wayback, cited as Dolby Vision Wikipedia #46) — **Dolby developer doc** — defines profiles 5/7/8, compatibility IDs (8.4→HLG 4, 8.1→HDR10 1). **Currently offline on Dolby site (May need archive.org)** — corroborated by ETSI TS 103 572.
7. **FFmpeg source — `libavutil/dovi_meta.h`, `libavformat/dovi_isom.c` (ff_isom_parse_dvcc/dvvC)** — https://github.com/FFmpeg/FFmpeg — parses `dv_profile/level/rpu/el/bl/compat/compression` per Dolby ISOBMFF v2.1.2 — **open-source implementation of Dolby spec** — lines cited above. Also `libavutil/pixfmt.h` colour enums.
8. **ExifTool — `lib/Image/ExifTool/QuickTime.pm:503,2993,7653` — `colr`/`nclx`/`mdcv`/`clli` tag tables** — second independent box parser — https://github.com/exiftool/exiftool
9. **Dolby Developer / Professional Support article "Dolby Vision Profiles and Levels"** — https://professionalsupport.dolby.com/s/article/Dolby-Vision-Profiles-Levels (requires login; cached summary via Dolby Vision Whitepaper *An Introduction to Dolby Vision* p.3-9) — **Dolby source**, used alongside #6.

*Supplemental summaries:* Wikipedia Rec.2100 / Rec.2020 / Hybrid log-gamma / Dolby Vision / High-dynamic-range video — *tertiary summaries* that aggregate #1-6 with citations; not authoritative alone. Checked via Jina on 2026-08-25.

---

## 12. Conflicts / Uncertainty

- **Dolby spec availability:** Full Dolby ISOBMFF/TS specs are **licenced/NDA** (no public free text beyond archived v1.3.2 PDF and ETSI summary). FFmpeg #7 is the de-facto open reference — treat Dolby table details as **verified via FFmpeg + archived PDF**, not direct current Dolby host (404 on 2026-08-25).
- **Apple QTFF `colr` doc:** Legacy URL `developer.apple.com/library/archive/.../QTFFChap3` **no longer renders via Jina** (410/429 rate-limit). Semantics confirmed via FFmpeg + CoreMedia kCMFormatDescriptionExtension enumerations; consider **partial verification**.
- **SMPTE ST 2084/2086 paywall:** Exact OETF/EOTF equations live behind SMPTE + ITU PDF purchase; use secondary whitepapers (Dolby Vision Whitepaper, BBC HLG paper) + FFmpeg constants.
- **Profile 8.2/8.3 exact compat IDs:** Some sources list `compat 2=SDR, 3=BT.2020?` vs HLG; Dol 1.3.2 PDF is canonical — minor discrepancy across mirrors. Flag 8.2/8.3 as **`uncommon, confirm per file`**.
- **iPhone `nclc` vs `nclx`:** Older iOS writes `nclc` (no range bit) → **range ambiguity** — safest to fall back to VUI `video_full_range_flag`.
- **Full-range HLG:** Rec.2100 + H.265 allow it, but broadcast HLG is **always narrow**; an iPhone file with `HLG + full_range=1` is **unusual but not illegal** — treat as warning, not error.

---

## 13. Implication for the Main Agent

- Build diagnosis as **four-column diff**: `nclx` | `VUI` | `dvvC profile/compat` | `RPU bl_range` — plus `mdcv/clli` as static context. Never merge.
- Validate **profile ↔ TF pairing** (`8.4 ↔ 18/9/9/0`; `8.1 ↔ 16/9/9/0`) and **range alignment** across three signals before any "fix" — mismatch is the diagnosis.
- Expose raw code numbers **and** human names (`9/bt2020`, `18/arib-std-b67`, `16/smpte2084`) — editors differ in naming.
- Surface `UNSPECIFIED (2)` and absent boxes as **deferred**, not wrong.

---

## 14. Risks / Unknowns (concrete)

- **File: specs behind paywall** — if verifier demands paragraph-level citation, obtain licensed ITU BT.2100-2 PDF §3.2 Table 5/9 or SMPTE ST 2084 §5 directly.
- **Dolby doc 404 on 2026-08-25** — re-fetch `professionalsupport.dolby.com/s/article/Dolby-Vision-Profiles-Levels` with authenticated session before publishing, or rely on archived PDF with Wayback date.
- **`colr` box count:** FFmpeg warns on duplicate but first wins — if iPhone writes per-sample `colr`, last-sample semantics could be swapped; capture sample index.
- **HEVC `hvcC` vs Annex B SEI duplication:** `mdcv/clli` in boxes vs `MasteringDisplayColourVolume SEI (137)` / `ContentLightLevel SEI (144)` inside bitstream can differ — both must be read if present.

---

*Report written to `artifact://runs/subagent-run-mt8laz01-2/children/parallel-1/report.md` — single self-contained handoff follows.*
