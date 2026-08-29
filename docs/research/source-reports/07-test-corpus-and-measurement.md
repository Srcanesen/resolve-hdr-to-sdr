# Lawful, Reproducible Diagnostic Corpus for iPhone HDR → Resolve Investigation
**Date:** 2025-08-25 (access) • **Scope:** No private user media; official / public samples only • **Mode:** read-only research

## Executive Summary
A reproducible corpus can be built without collecting user media by combining: (1) Dolby Laboratories public DV test streams (Profiles 5 / 8.1 / 8.4 — the latter is iPhone 8.4 HLG), (2) EBU HLG Tech 3373 reference bars (QT v210 / TIFF), (3) Apple HLS example streams + Apple-Log reference frames generated via Apple/BMD Camera apps on-device, and (4) synthetic edge-cases generated with ffmpeg/dovi_tool. Distinguished measurements separate **metadata-only** errors (wrong NAL SEI / dvcC/dvvC box, color primaries/transfer, HDR10 vs DV signaling) from **pixel** errors (clipping, tone-map/gamut mismatch) using ffprobe/MediaInfo + frame-hash + signalstats/histogram.

---

## 1. Ranked Corpus — Provenance, Expected Metadata, License, Size, Usable Measurements

### Tier 1 — Authoritative, must-include (public, versioned)

| # | Sample | Provenance / Format | Expected ffmpeg/MediaInfo (key fields) | License / Commit? | Size | Deterministic measurements |
|---|--------|----------------------|----------------------------------------|-------------------|------|----------------------------|
| 1 | **Dolby Vision profile 8.4 — Glass Blowing etc.** — `developer.dolby.com/tools-media/sample-media/video-streams/dolby-vision-streams` (login-gated) — also mirrored as `DolbyLaboratories/dolby-vision-contents` on GitHub: `BL_RPU_dvhe-08-84_1920x1080@24fps`, `...3840x2160@24fps` | HEVC Main10, `hvc1`/`dvh1` + `dvcC`/`dvvC` box, `HDR format: Dolby Vision, dvhe.08.06, BL+RPU, HLG compatible` (profile 8 = cross-compatible ID 4 = HLG base). Transfer `ARIB STD-B67 (HLG)`, primaries `BT.2020`, matrix `BT.2020nc`. ffprobe: `color_primaries=bt2020`, `color_trc=arib-std-b67`, `color_space=bt2020nc`, `codec_tag_string=dvhe/dvh1`, RPU present per frame (dovi_tool info shows profile 8.4, BL+RPU, mapping polynomial+MMR). | **Dolby Developer site: account ToS — personal/evaluation use; NOT redistributable**. GitHub mirror: repo appears without explicit LICENSE file; treat as **reference only — do NOT commit**. Strategy: **download on demand + local cache, document URL+date+hash, reference only**. Validated via jina + exa search 2025-08-25: DV streams page requires free account; GitHub repo updated 2022-09-21. | 10–60 MB/clip (FHD/UHD) | **Metadata check:** `ffprobe -show_streams` (profile/level/codec_tag), `mediainfo --Inform="Video;%HDR_Format%"`, `dovi_tool info --summary` (profile, RPU count). **Pixel check:** `signalstats` YMAX/YMIN (detect clipped superwhite/subblack), `histogram` + `psnr/ssim` vs SDR transcoded variant distinguishes tone-map. |
| 2 | **EBU HLG Tech 3373 Colour Bars — QT v210 (v2.0, 2020-07-03)** — `tech.ebu.ch/publications/tech3373-v210` + TIFF variant `tech3373-tiff` | QT `v210` 10-bit `YCbCr 4:2:2` narrow-range (64-940/960) carrying ITU-R BT.2100 HLG. Expected: `color_primaries=bt2020`, `color_trc=arib-std-b67`, `color_space=bt2020nc`, `pix_fmt=yuv422p10le` (v210 → FFmpeg decodes as `v210`). Includes superblack (-7% HLG) / superwhite (109% HLG) patches, 75%/100% HLG bars, BT.709-equivalent bars (DL/SL). Reference levels per ITU BT.2111 + BT.2408 Table 1: 18% grey card ≈ 38% HLG, 100% diffuse white ≈ 75% HLG (narrow-range code values documented in spec). | **EBU Tech open download** — free for testing/manufacturers; **PDF/spec CC-like permissive for internal reproduction; binary test files implicitly free to download/use, not explicitly licensed for redistribution**. Conservative rule: **do NOT commit binaries; host as on-demand download via `curl -L https://tech.ebu.ch/files/...zip`** with hash cache. Cited: `EBU_Tech3373_HLG_Colour_Bars_as_v210_QT_v20200703.zip` (23.2 MB zip, 2 rasters), `..._TIFFs_...zip` (2 MB). Verified live via jina 2025-08-25 (HTTP 200). | 23 MB zip (QT), 2 MB zip (TIFF) | **Metadata:** ffprobe validates primaries/transfer/matrix. **Pixel:** decode to raw & check per-patch 10-bit YCbCr values vs Table 3 in tech3373.pdf; `signalstats` reports BRNG=0 if import correct, BRNG>0 if NLE clipped legal range; vectorscope/waveform `waveform` filter or deferred Resolve vectorscope. Scene-light vs display-light bars should land on BT.709 targets after correct BT.2100→709 conversion — hue/saturation error quantifiable. |
| 3 | **Apple HLS Example Streams** — `developer.apple.com/streaming/examples/` | HLS multivariant: AVC / HEVC / **DolbyVision5**, **HDR10**, AAC/AC-3/Atmos, WebVTT. Playlist uses `CODECS="hvc1..."` + `VIDEO-RANGE=SDR/HLG/PQ` + `SUPPLEMENTAL-CODECS="dvh1.08.09"` for DV 8.x. Best for **player/ingest pipeline test**, not iPhone-specific, but proves Resolve/HLS import handling. | **Apple Sample Code License** (as-is, permits use/reproduce/modify/redistribute with retention of notice; no patent grant; trademark restriction). Streaming `.m3u8/.ts` segments are **public for testing**; treat as **on-demand, not committed** (no explicit redistribution grant for media). Verified: Apple HLS page + sample-code license PDF dated 2020. | Tiny (.m3u8) + few MB segments per rendition | ffprobe on segments shows `color_trc`/`VIDEO-RANGE`; `mediastreamvalidator` (Apple HLS Tools). Compare VIDEO-RANGE vs actual stream metadata. |

### Tier 2 — High-value, small/on-demand (Apple-Log & SDR control)

| # | Sample | Provenance / Format | Expected metadata | License / Commit? | Size | Measurements |
|---|--------|----------------------|-------------------|-------------------|------|---------------|
| 4 | **Apple Log (Apple ProRes Log) — captured on-device** | Shoot 1–2 s on **iPhone 15 Pro+** (or later) via stock Camera or **Blackmagic Camera** app: `ProRes 422 HQ`, `Log`, 3840x2160 or 1920x1080, 10-bit. Transfer via AirDrop/`Image Capture`. Also: community free downloads (e.g., Christian Maté Grab ProRes Log test footage 5 GB, Prolost Apple Log LUT pack) — but **prefer self-captured** for lawful, traceable chain-of-custody. | MOV QTFF, `codec_name=prores`, `pix_fmt=yuv422p10le`, **no** HDR signaling (`color_primaries=bt709`/unspecified by default; Log is scene-referred, requires LUT: Apple Log → Rec.709/2020). `com.apple.quicktime.color-parms` atom present. No dvcC/RPU. | **Self-captured = fully ownable, commit-allowed** (keep ≤5 s, <200 MB). Community clips: **only reference with URL** unless creator grants CC0/MIT; do not commit. Gumroad/CC downloads are personal-use. | 150–400 MB per 5 s (ProRes HQ) | **Metadata:** verify `color_range=tv`, no `HDR format`. **Pixel:** apply official Apple Log→Rec709 LUT (free from Apple/Prolost) + compare to SDR grade; `signalstats` checks no clipping introduced; `psnr` vs LUT-applied reference checks pipeline linearity. |
| 5 | **SDR control (Rec.709 8-bit)** | Same device: Settings > Camera > Record Video > **HDR Video OFF**, HEVC 8-bit, or export SDR via `AVAssetExportSession` H.264 preset (HDR→SDR tone-mapped) or compressor. Also synthesize: `ffmpeg -f lavfi -i testsrc2=s=3840x2160:r=30:d=2 -vf format=yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709` | `color_primaries=bt709`, `color_trc=bt709`/bt470bg, `color_space=bt709`, `pix_fmt=yuv420p`, no HDR format, 8-bit. | Fully synthetic = MIT-able, **commit-allowed**. Device SDR clip = ownable. | <20 MB | Baseline for tone-map validation: histograms should show no 10-bit-extended highlights vs HDR; compare Resolve import color-space auto-detection. |
| 6 | **Dolby Vision Profile 5 & 8.1 variants (streaming references)** | Same Dolby source as #1: `BL_RPU_dvhe-05_...` and `BL_RPU_dvhe-08-mapDynamic1000-81_...` (HDR10-compatible). Profile 5 = IPT-PQ-c2 proprietary space (no HDR10 fallback — SDR decoder shows garbled color). Profile 8.1 = HDR10 base + RPU (PQ + BT.2020 + SMPTE ST 2086 static metadata). | P5: `color_trc=smpte2084`, `color_primaries=bt2020` (but IPT-PQ-c2 payload), `HDR format: dvhe.05.09, BL+RPU` — **no** HDR10 fallback. P8.1: `dvhe.08.06, BL+RPU, HDR10 compatible`, `Mastering display metadata` + `MaxCLL/FALL`. | Same as #1 (login/mirror). | 10–60 MB | Tests fallback logic: non-DV decoder should fall back to HDR10 (P8.1) vs tinted failure (P5); useful to prove iPhone 8.4 → Resolve mis-tag shows HLG vs PQ divergence. |

### Tier 3 — Metadata edge-cases (synthesized, zero-privacy, fully reproducible)

| Edge | How to synthesize (ffmpeg/dovi_tool) | Expected signal | Measurement that distinguishes it |
|------|--------------------------------------|----------------|----------------------------------|
| **A. Stripped RPU (metadata-only error)** | `dovi_tool extract-rpu in.mov -o RPU.bin` then `ffmpeg -i in.mov -c:v libx265 -pix_fmt yuv420p10le -bsf:v hevc_metadata=... -an stripped.mov` OR `dovi_tool convert --discard in.hevc -o stripped.hevc` then mux to MP4 | Video stream still **HEVC 10-bit HLG base layer**, but **no dvcC/dvvC / SEI RPU**. MediaInfo drops from `Dolby Vision, BL+RPU, HLG` → `HDR format: HLG / BT.2020` or nothing. ffprobe `side_data` without `DOVI configuration record`. Pixels unchanged. | **Metadata fails, pixels pass:** `dovi_tool info` = 0 RPUs; `ffprobe -show_streams` no dvcc/dvvc; `signalstats` YAVG histogram **identical** to source (e.g., `ffmpeg -i src -i stripped -lavfi ssim -f null -` → SSIM 1.0, hist diff ~0). Proves bug is metadata signaling, not grade shift. |
| **B. Corrected-tag (matrix/primaries mismatch)** | Remux with wrong color tags: `ffmpeg -i src.mov -c copy -bsf:v h265_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coeffs=1 fixed_tags.mov` (force bt709 instead of bt2020/HLG) | `color_primaries=bt709`, `color_trc=bt709` while RPU still declares BT.2020/HLG → Resolve shows washed/desaturated import. | Metadata diverges: `mediainfo --Inform="Video;%colour_primaries%"` ≠ RPU's declared gamut. Pixel hash still matches source (ffmpeg `hash=murmur3`). |
| **C. Resolution/level edge** | Transcode iPhone 4K60 HLG sample to 1080p25 vs 2160p60 with `libx265 -x265-params level-idc` variations | level 5.1 vs 5.2 signaling | Check `level` in ffprobe; Resolve sometimes rejects non-standard level → metadata error not pixel. |
| **D. CM v2.9 vs v4.0 RPU** | `dovi_tool generate --xml cmv29.xml` vs `--json cmv40.json` vs `dovi_tool editor --add_cmv4_default_metadata` | L1/L2/L5/L6 (v2.9) vs +L3/L8/L9/L10/L11 (v4.0). Resolve 18+ may strip v4.0 levels on import. | `dovi_tool info --summary` + `export --levels` JSON diff. |
| **E. HLG vs PQ HLS signaling** | Package same base with `hls.js` SUPPLEMENTAL-CODECS variant playlist `CODECS="hvc1.2.4.H153.b0" VIDEO-RANGE=HLG,SUPPLEMENTAL-CODECS="dvh1.08.09"` vs `PQ / dvh1.08.06` | `VIDEO-RANGE` attribute must match `color_trc` (HLG ↔ arib-std-b67, PQ ↔ smpte2084). Mismatch → Resolve/HLS player falls back to SDR/HDR10 incorrectly. | Validate playlist parser vs segment `hvcC+dvvC` — `dovi_tool` or `mp4box -info`. |

All Tier 3 artifacts are **generatable at CI time from Tier 1 source + open tools** → **no binary to commit**, reproducible by hash of source + command line.

---

## 2. Camera Chart / Reference Material

- **EBU Tech 3373 HLG Colour Bars (normative):** Defined in `tech3373.pdf` (1.2 MB) via ITU-R BT.2111-2 colour-bar test pattern + BT.2408. Includes quantitative 10-bit `R'G'B' / Y'CbCr` code values for 75%/100% HLG, Display-Light (DL) and Scene-Light (SL) BT.709 equivalents, saturation sweeps (JzAzBz scaling), staircase/ramp, text-safe area. Provided as **C source (`EBU_bars.c`)** in the PDF — compile with `gcc -o EBU_bars EBU_bars.c -lm` to regenerate TIFFs deterministically (no binary redistribution needed).
- **ITU-R BT.2111-2 & BT.2408:** Reference signal levels for narrow-range HLG/PQ (e.g., Table 2/3: 75% HLG narrow-range Y=560 etc.) and camera line-up reflectances (18% grey ≈ 38% HLG, 90% white ≈ 73% HLG). Useful as scalar assertions even without an image.
- **Dolby / EAC test sequences:** `2160p/100 HLG` Sony HDC4300 uncompressed/XAVC (29 sequences, Olympic Stadium 2018) — **order on SSD via tech@ebu.ch** (not direct download, membership-gated, not committable). Mentioned for completeness; not required for corpus.
- **SRI Visualizer HDR+WCG pattern** (`sri.com/.../Visualizer_Test_Pattern.pdf`): Synthetic chart with linear-light stairstep (10k→0.01 nits), gamut patches (±5 ΔE), bit-depth bursts, waveform/histogram targets — validates tone-map headroom clipping (107% vs 100% vs 99%) and bit-depth detection. Available as HEVC/H.264/MPEG-2 streaming or uncompressed.

**Recommendation:** Commit only **hashes + generation recipe** for EBU bars; download on-demand. For Resolve pipeline, the EBU bars are superior to ad-hoc phone footage because every patch has a known numeric value enabling **pixel-value assertions**.

---

## 3. Expected ffmpeg / MediaInfo Outputs (canonical examples)

### iPhone Dolby Vision 8.4 (HEVC + HLG HLS base, 10-bit, .mov)
```
# ffprobe -v error -select_streams v:0 -show_streams -of json source_iphone84.mov
{
  "codec_name": "hevc", "profile": "Main 10",
  "width": 3840, "height": 2160, "pix_fmt": "yuv420p10le",
  "color_range": "tv", "color_space": "bt2020nc",
  "color_primaries": "bt2020", "color_transfer": "arib-std-b67",
  "field_order": "progressive",
  "side_data_list": [{ "side_data_type": "DOVI configuration record" }]
}
# ffmpeg -i source_iphone84.mov 2>&1 | grep -i dolby
  Stream #0:0(und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160 ...
  Metadata: creation_time, com.apple.quicktime.color-parms
# mediainfo --Inform="Video;%HDR_Format% / %colour_primaries% / %transfer_characteristics% / %matrix_coefficients% / %BitDepth% / %CodecID%"
Dolby Vision, Version 1.0, dvhe.08.06, BL+RPU, HLG compatible / BT.2020 / HLG / BT.2020 non-constant / 10 / hvc1
# dovi_tool info -i RPU.bin --summary
{"profile": "8.4", "level": 9, "rpu_count": <frames>, "cm_version": "V2.9", "mapping": {"polynomial+mmr": true}}
```

### Plain HLG (no DV) — EBU bars or transcoded iPhone HLG base
```
HDR format: HLG / BT.2020  (no "Dolby Vision" line)
color_transfer: arib-std-b67 ; color_primaries: bt2020 ; fits ITU BT.2100
```

### HDR10 / Profile 8.1 fallback
```
HDR format: Dolby Vision, dvhe.08.06, BL+RPU, HDR10 compatible / SMPTE ST 2086, HDR10 compatible
HDR_Format_Compatibility: HDR10
Mastering display luminance: min: 0.0050 max: 1000 cd/m2
Maximum Content Light Level: 820 cd/m2 ; MaxFALL: 330 cd/m2 (varies)
color_transfer: smpte2084
```

### Apple ProRes Log
```
codec_name: prores (apcn/hq), pix_fmt: yuv422p10le, width: 3840, height: 2160
color_space/color_primaries/color_transfer: unspecified or bt709 (Log is scene-referred; LUT required)
No HDR format line, No DOVI side data
```

### SDR 8-bit control
```
pix_fmt: yuv420p, bits_per_raw_sample: 8, color_primaries: bt709, color_transfer: bt709, color_space: bt709
HDR format: (absent)
```

**Note on ffprobe color fields:** Values come from VUI (`colour_primaries`, `transfer_characteristics`, `matrix_coeffs`) + container `colr` box. Always check both `color_primaries/color_trc/color_space` and container `TAG:com.apple.quicktime.color-parms`. For DV, also inspect `extradata` `dvcC`/`dvvC` via `ffprobe -show_packets` or `mp4box -diso`.

---

## 4. Deterministic Measurements Separating Metadata-Only Errors from Pixel Clipping / Tone-Map

### Decision matrix
| Symptom | Metadata-only error | Pixel clipping | Tone-map / gamut difference |
|---------|---------------------|----------------|-----------------------------|
| File still decodes to same YCbCr | **Yes** (bit-identical after stripping RPU → SSIM=1.0) | No — YMAX clipped to 235 / 940 or YMIN crushed | No — histogram stretched/compressed but extrema preserved or shifted |
| HDR metadata | Missing/wrong `dvhe`/`dvvC` / `bt2020`→`bt709` tag error | Correct but luma truncated | Correct but transfer changes histogram shape |

### Concrete checks (all deterministic, scriptable, no display required)

1. **Metadata vs payload identity:**  
   `ffmpeg -i src.mov -c:v rawvideo -pix_fmt yuv420p10le -f framemd5 src.framemd5` vs same for `stripped.mov` → `diff` = 0 proves metadata-only. Pair with `dovi_tool extract-rpu` RPU presence/absence. Combine: `ffmpeg -i src -i stripped -lavfi ssim=stats_file=- -f null - 2>&1 | grep SSIM` → `All:1.000000`.

2. **Range/clipping detection:**  
   `ffprobe -f lavfi -i "movie=clip.mov,signalstats=stat=brng" -show_frames -show_entries frame_tags=lavfi.signalstats.YMIN,lavfi.signalstats.YMAX,lavfi.signalstats.BRNG`  
   - Legal narrow-range 10-bit: Y in [64, 940] (8-bit 16–235 equivalent scaled). `YMAX==940` or `YMIN==64` sustained → headroom clipped (superwhite/subblack lost). EBU bars intentionally exercise -7%/109% → correct pipeline shows `YMIN <64` and `YMAX >940` before legalization.
   - `BRNG` fraction >0 indicates out-of-range pixels clipped downstream.

3. **Luma histogram / waveform divergence:**  
   `ffmpeg -i clip.mov -vf histogram=mode=levels,signalstats -f null - 2>&1` + `ffprobe -f lavfi ...` per-channel `HUE/SATAVG`. For metadata-only error, histograms overlay exactly; for tone-map, histogram is compressed (e.g., HLG→SDR down-mapping preserves mids but compresses >75% HLG highlights — verifiable vs EBU Tech 3373 tables).

4. **Bit-depth / chroma subsampling preservation:**  
   `ffprobe -show_streams -select_streams v:0 | grep bits_per_raw_sample,pix_fmt,chroma_location` — metadata error leaves `bits_per_raw_sample=10`, `pix_fmt=yuv420p10le`, `chroma_location=left`; pixel error shows `bits_per_raw_sample=8` or `pix_fmt=yuv420p` after SDR conversion.

5. **Resolve round-trip fidelity (metadata-sensitive):**  
   Import corpus into empty Resolve timeline (DaVinci YRGB Color Managed, timeline color space BT.2100 HLG vs Rec.709). Export via Deliver `H.265` with `Dolby Vision 8.4` vs `HLG` vs `HDR10`. Re-extract metadata: if input was 8.4 but export shows `HDR format: HLG` only, metadata was discarded (preview/edit pipeline drops RPU by default per Apple `AVVideoComposition` HLG fallback). Pixel check still passes. See `forum.blackmagicdesign.com/viewtopic.php?f=21&t=216263` (Resolve maps Mastering Display to BT.2020 container even for P3 sources — metadata bucket, not pixel).

6. **Gamut error:** saturation sweep from EBU bars / JzAzBz-generated patches: vectorscope `waveform` filter — hue drift >5 ΔE or `signalstats.SATMAX` compression indicates gamut mapping, not metadata tag.

**Recommended CI gates for later validation:**
- `assert ffprobe_color == expected` (strict string compare on `color_primaries|transfer|space`)
- `assert dovi_tool_rpu_count > 0` for DV; `==0` for stripped variant (metadata edge)
- `assert framemd5_match(src, stripped) == true` (pixel identity)
- `assert YMIN/YMAX within EBU-published tolerance ±2 code values`
- `assert brng == 0` on EBU bars pre-pipeline, `brng>0` post-clipping pipeline
- `assert ssim(src, toneMappedSDR) < 0.98` but `histogram intersection` shows highlight compression (distinguishes tone-map from clipping)

---

## 5. Licensing & Redistribution — Can It Be Committed, Downloaded on Demand, or Only Referenced?

| Source | License terms (verbatim summary, 2025-08-25) | Commit to repo? | Download on demand? | Only reference? | Evidence |
|--------|---------------------------------------------|-----------------|---------------------|-----------------|----------|
| **Dolby developer sample streams** (`developer.dolby.com`) | Gated behind **free Dolby Developer account**; site ToS: for evaluation/testing, **not granted for redistribution**. Some assets carry **Dolby Vision Standard Support Terms** (licensee-gated). | **No** | **Yes** (cache locally, git-lfs ignored) | Fallback: link + hash | Page: `Login Required — You must have a Dolby Developer or Dolby Games account` (jina, 2025-08-25) |
| **GitHub `DolbyLaboratories/dolby-vision-contents`** | No `LICENSE` file at root (as of 2022-09-21 commit history); repo is public test content. **Absence of license ≠ permission** — treat as **all rights reserved by Dolby**. | **No** (or request clarification) | **Yes, for testing** | **Preferred: reference + on-demand fetch** | Repo description lists 6 files, no license badge; check `github.com/.../LICENSE` 404 |
| **Dolby code repos** (`dlb_mp4base`, `pmd_tool`, `Mobile-Media-Live-Processor`) | **BSD-3-Clause** (explicit) — commit-friendly for code, not for video media | Code: yes; media: n/a | yes | — | `github.com/DolbyLaboratories/dlb_mp4base#LICENSE` BSD-3 |
| **`quietvoid/dovi_tool`** | **MIT** (`Copyright (c) 2023 quietvoid`) — permits commit of tool/binary/scripts | **Yes** (tool) | yes | — | Verified via `github.com/quietvoid/dovi_tool` tab, `LICENSE` raw |
| **EBU HLG bars** (`tech.ebu.ch/...Tech3373...v210_QT_...zip`, `...TIFF...zip`, `tech3373.pdf`) | **Free to download and use for testing/broadcast engineering**; spec PDF says *generally freely distributable on request*; media download is **direct HTTP 200 without auth**. **No explicit OSS license** — conservative = not MIT, but **internal use + testing permitted**; redistribution via repo is not explicitly allowed. | **Avoid committing binaries** (23 MB) | **Yes — recommended** `curl -L -o /tmp/ebu.zip https://tech.ebu.ch/files/...` | Document URL + SHA256 + date | Verified live 2025-08-25 (jina shows `Open file (zip, 23.2 MB)` link) |
| **Apple HLS examples** (`developer.apple.com/streaming/examples/`) | Public streaming segments for compatibility testing; `Apple Sample Code License` (personal, non-exclusive, allow use/reproduce/modify/redistribute *Apple Software* with retained notice — but media may be covered by separate Apple Media Services ToS). | **No for media** | **Yes** (stream) | **Reference playlist URLs** | `Apple-Sample-Code-License.pdf` (2020) + `developer.apple.com/streaming/` |
| **Apple iPhone captured MOV** (self-shot) | **You own copyright**; no third-party license needed. | **Yes** (keep short) | yes | — | — |
| **Community Apple-Log downloads** (Gumroad etc.) | Typically **personal-use, no redistribution** unless creator states CC0/MIT (e.g., Prolost LUTs are free-to-use but check per-product page) | **No unless CC0 confirmed** | Link only | **Yes** | e.g., `mikebsalazar.gumroad.com/l/iphone15-applelogfootage`, `alessiolr.gumroad.com/l/FreeAppleLogLUT` |
| **BBC WHP 309, ITU BT.2100/2111, EBU Tech docs** | **Copyrighted but free to read**; BBC: *grants permission to make copies of entire document for own internal use; no publication/distribution to third parties without prior written permission*. ITU: purchase/free via ITU library; reference allowed with citation. | **Reference only** | Download PDF for local cache | **Cite, link** | `downloads.bbc.co.uk/rd/pubs/whp/WHP309.pdf` notice + `tech.ebu.ch/docs/tech/tech3373.pdf` |
| **Tooling: ffmpeg, MediaInfo, mp4box** | ffmpeg **LGPL/GPL**, MediaInfo **BSD-2-Clause**, GPAC **LGPL** — all commit-friendly | Orchestration scripts: yes | yes | — | — |

**Practical policy for the planned plugin repo:**
- **Commit:** synthetic generators, `EBU_bars.c`-derived generator script, `ffprobe`/`dovi_tool` wrapper scripts, **hash manifest** (`corpus_manifest.json` with URL, date, sha256, expected metadata), small **self-captured** SDR/HDR clips (<30 s total, <200 MB, git-lfs if needed, with consent log).
- **On-demand (CI fetch, .gitignore):** Dolby samples, EBU zips, Apple HLS segments, ProRes Log captures >200 MB. Cache key = `sha256(url+date)`. CI downloads to `$CORPUS_DIR` and validates hash manifest before tests.
- **Only reference (no fetch):** Large EAC 2160p100 uncompressed sets, paid ITU PDFs, community clips without explicit license.

---

## 6. What to Fetch First (minimal viable corpus — ~100 MB download on demand)

1. `EBU_Tech3373_HLG_Colour_Bars_as_v210_QT_v20200703.zip` (23.2 MB) + TIFF zip (2 MB) — deterministic reference
2. One Dolby 8.4 FHD clip from `dolby-vision-contents` FHD 1080p (smaller than UHD; sufficient for metadata test; ~15 MB via raw GitHub LFS or Dolby portal)
3. One Apple HLS DV manifest (`devstreaming-cdn.apple.com/videos/ ...` from `developer.apple.com/streaming/examples/`) — playlist-only, no download
4. Self-capture 2 s ProRes Log + 2 s SDR on same iPhone 15 Pro (on-device, ~300 MB before trim; trim to 2 s)
5. Synthesize stripped/metadata-mismatch variants locally (no download)

**Total committed to repo:** <5 MB (manifest + scripts); **total CI-downloaded:** 40–80 MB; **fully lawful and reproducible** without any user-provided private media.

---

## 7. Limitations & Open Questions

- **iPhone exact HLG mapping variant:** Stocks use HLG per BT.2100 but with Dolby Vision RPU dynamic metadata at 60 fps vs 30 fps may differ; RPU `source_min_pq`/`source_max_pq` (e.g., 62/3079 per dovi_tool profile 8.4) may vary by iOS version — corpus should record iOS/Device/Settings in manifest.
- **Apple Log 2:** iPhone 17 Pro introduces Apple Log 2 (LUT not backward-compatible) — no public small sample yet beyond community Gumroad packs; prefer self-capture.
- **Resolve version drift:** DV import behavior changed between Resolve 18.0.2 beta (P5 vs P8.1 handling) and 19.1.3 (Mastering Display bug BT.2020 vs P3). Lock Resolve version in manifest.
- **EBU zip content-change:** Files have two versions (2020-05-18 no metadata vs 2020-07-03 with metadata); pin to v2.0 URL and record SHA256.

---

## 8. Sources (accessed 2025-08-25)

1. Apple — *Incorporating HDR video with Dolby Vision into your apps* (PDF) — iPhone 12+ DV 8.4 = HLG cross-compatible ID 4, export preservation — `developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf`
2. Apple — *Streaming Examples* / *HLS Authoring Spec* / *Sample Code License PDF* — DV 5/HLG/HDR10 variants, SUPPLEMENTAL-CODECS — `developer.apple.com/streaming/examples/` + `.../support/downloads/terms/apple-sample-code/Apple-Sample-Code-License.pdf`
3. Dolby — *Dolby Vision streams* (+ developer.dolby.com sample media) & *Using iPhone 12 captured Dolby Vision as source* — Profile 8.4 HEVC Main10 HLG — `developer.dolby.com/tools-media/sample-media/video-streams/dolby-vision-streams` + `professional.dolby.com/s/article/Using-an-Apple-iPhone-12-captured-Dolby-Vision-content-as-a-source-in-a-Dolby-Vision-production`
4. GitHub — `DolbyLaboratories/dolby-vision-contents` (2022-09-21, 6 files: dvhe.05/08.06/08.06 mapped) + `quietvoid/dovi_tool` (MIT) — RPU extraction/inspection — `github.com/DolbyLaboratories/dolby-vision-contents` / `github.com/quietvoid/dovi_tool`
5. EBU — Tech 3373 + `tech3373-v210` (QT v210, 2020-07-03, 23.2 MB) + TIFF + Tech 3373 PDF — HLG narrow-range code values, DL/SL conversion targets — `tech.ebu.ch/publications/tech3373{,-v210,-tiff}` + `tech.ebu.ch/docs/tech/tech3373.pdf`
6. ITU — BT.2111-2 (HLG/PQ narrow-range signal levels) + BT.2408 (operational practices, line-up levels 38% HLG grey, 75% white) — `itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2111-2-202012-S!!PDF-E.pdf` + `.../R-REP-BT.2408-2017-PDF-E.pdf`
7. Community references (non-authoritative, for provenance only) — iPhone 15 Pro Apple Log self-capture via Blackmagic Camera app + free LUT packs — `provideocoalition.com/qa-shooting-in-prores-log...` / `prolost.com/blog/applelog` (verified but not relied on for licensing)

---

## 9. Implication for Next Step

The main agent should **not collect user media**. Instead, create `corpus_manifest.json` with the 3–5 on-demand URLs above, pin SHA256 + access date, and add `scripts/fetch-corpus.sh` (on-demand, git-ignored cache) plus `scripts/verify-metadata.sh` (ffprobe/mediainfo/dovi_tool assertions, histogram/signalstats gates) implementing the decision matrix in §4. Start with EBU bars as **Tier 1 truth** for pixel assertions, Dolby 8.4 FHD as **metadata truth** for iPhone-equivalent DV signaling.

## 10. Risks / Concrete Unknowns

- Dolby portal streams are **login-gated** — CI must use stored creds or fall back to GitHub mirror (which lacks versioned hashes).
- EBU binaries lack an explicit redistribution license — committing them risks copyright breach; mitigate by on-demand fetch.
- `dovi_tool` RPU parsing for profile 8.4 assumes HEVC annex-B input (`hevc_mp4toannexb`) — piping `.mov` directly may miss RPU; verify with `ffmpeg -c:v copy -bsf:v hevc_mp4toannexb`.
- ffprobe `color_transfer` naming varies (`arib-std-b67` vs `bt2020-10` vs `hlg`) across ffmpeg versions — pin `ffmpeg >= 6.0` and normalize aliases.
