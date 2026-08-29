# DaVinci Resolve iPhone HDR Workflow Integration — Canonical Evidence Report

**Date:** 2026-08-25 (UTC) — synthesis of 11 source reports (`docs/research/source-reports/01–11`)  
**Scope:** Context collection only. No architecture, implementation stack, codec/CST recipe, UI, pricing, or code decisions. No claim of visual/live Resolve verification is made in this report.  
**Local Resolve SDK baseline (primary for automation capability):** DaVinci Resolve Studio **21.0.3 bundle 21.0.30007** — `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Info.plist` (LSMinimumSystemVersion 15.0), Workflow Integration bridge **21.0.3.7** — `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node` (1,730,064 bytes), inspected 2026-08-25.  
**Primary SDK docs:** `Developer/Scripting/README.txt` (15 Jul 2026, 1145 lines), `Developer/Scripting/CHANGELOG.txt` (5 May 2026), `Developer/Workflow Integrations/README.txt` (3 Oct 2024, 352 lines), `Developer/Workflow Integrations/CHANGELOG.txt` (28 Jul 2025), `SamplePlugin/main.js`/`preload.js`/`renderer.js`. Manual PDF 189,826,649 bytes probed via strings only.  
**Independence:** This is a **standalone new project, separate from ClipDock**. Source file is never modified; diagnosis is separate from correction; output is a new file. ClipDock is referenced only as prior-work evidence for Workflow Integration seams, not as a dependency.

> **How to read:** Fact = primary/official spec or locally inspected SDK text. Inference = interpretation that requires a live test to confirm. Community report = forum/secondary blog/issue anecdote labeled as such. Conflicts are preserved verbatim with the test that would resolve them.

---

## Table of Contents
1. Desired Standalone Product Flow & Independence
2. Why No Universal CST Fixes Every Case
3. Apple Capture-Mode Matrix
4. Transfer & Export Path Matrix (Provenance)
5. Four-Layer Standards & Metadata Model
6. Symptom → Likely Cause → Discriminating Test
7. Resolve Version / Edition / OS / Display Capability Boundaries (18.6–21.0.4)
8. Workflow Integration: Inbound/Outbound Drag & API Fallback Limits
9. GitHub Tools & Existing Products — Ranked with Licensing Caveats
10. Lawful Reproducible Corpus & Objective Measurements
11. What the Documented Resolve API Can / Cannot Automate
12. Fact / Inference / Community Report — Separation & Contradictions
13. Pre-Architecture Evidence Checklist (Exact Local Samples & Settings Needed Next)
14. Source Index — Mapping of All 11 Source Reports
15. References (Primary Sources with Access Dates)

---

## 1. Desired Standalone Product Flow & Independence

**Standalone product (new Workflow Integration plugin, not ClipDock):**

1.  User drops iPhone HDR video into the panel (or selects via dialog as fallback) — **no modification of source**. Path is validated in main process before any processing.
2.  Panel runs **diagnosis** (`ffprobe`/`MediaInfo`/`mp4box`/`dovi_tool` via `ffmpeg -bsf:v hevc_mp4toannexb`) and exposes a four-column report: container `colr`/`nclx` | HEVC VUI | `dvvC`/`dvcC` profile & `amve` | RPU header. Reports `UNSPECIFIED (2)` as deferred, not SDR, and flags conflicts rather than auto-fixing.
3.  User chooses one of two **separate-output** actions — `Fix` (metadata/re-tag path that preserves pixels) or `HDR → SDR` (re-encode/tone-map path that creates a new file) — both write to a new file; the source `.mov` is never overwritten. RPU handling is explicit: strip, preserve via `dovi_tool inject-rpu` + `mp4muxer`, or regenerate only via Dolby tools on PQ intermediates (HLG→PQ prerequisite per Dolby).
4.  User drags the **output** file to Resolve (Media Pool or timeline) via native OS drag (`webContents.startDrag`) or, if that seam is unavailable, via the documented API fallback (`MediaStorage.AddItemListToMediaPool` / `MediaPool.AppendToTimeline`) with bin/duplicate/playhead logic.

**Independence from ClipDock:** Separate plugin identity (`manifest.xml` Id distinct from `com.clipdock.app`), separate install root (`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/` on macOS, `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins` on Windows), separate card store. ClipDock evidence is reused **only** to prove which Workflow Integration seams exist under `sandbox:true, contextIsolation:true, nodeIntegration:false` (see §8). No ClipDock code, dependency, or association is assumed.

**Constraints upheld:** Source untouched; diagnosis before correction; local SDK 21.0.3 is the authority for what can be automated; facts vs inference vs community are kept distinct.

*Evidence:* `01-resolve-sdk-capability.md` local SDK inventory + `09-workflow-integration-drag-drop.md` seam audit + `README.md` objective `Fix / HDR → SDR → drag to Media Pool` + Apple TN3145 (2023-03-07 rev 2023-12-12) normative `amve` requirement — https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata (accessed 2026-08-25).

---

## 2. Why No Universal CST Fixes Every Case

**Verdict (fact + inference):** No single Input Color Space / Gamma / CST fixes every iPhone clip because **(a) capture pipelines are not single**, **(b) metadata is four-layer and can conflict**, **(c) transfer paths silently transcode**, **(d) Resolve color science has two incompatible modes with undocumented API keys**, and **(e) display/viewer mismatch is orthogonal to the grade**. A fixed `Rec.2020 / Rec.2100 HLG Scene` CST appears to help many DV 8.4 clips but fails on the other branches documented below; treating it as universal would silently corrupt the other cases.

### Five branches that diverge (each requires a different input)

1.  **Capture mode:** DV 8.4 HLG+`dvvC`+RPU vs pure HLG (`ProRes HDR`, `HLG10`) vs PQ (`HDR10`) vs `Apple Log` (Rec.2020) vs `Apple Log 2` (Apple Wide Gamut, AWG) vs SDR `1/1/1` — see §3. Input Color Space must be `Rec.2020 HLG`, `Rec.2020 PQ`, `Rec.2020 Apple Log`, or `Apple Wide Gamut Apple Log 2` accordingly.
2.  **Metadata conflict:** `colr nclx` may say `9/18/9`, VUI may say `9/16/9` or `2/2/2` (Unspecified), RPU `bl_video_full_range` may disagree.
3.  **Transfer provenance:** A file that has already been tone-mapped to SDR `h264 1/1/1` 720p (Shared Albums, Messages, Photos Export default, social re-encode) is **not HDR** — applying HDR CST double-maps it.
4.  **RCM vs YRGB order-of-operations:** `DaVinci YRGB Color Managed (RCM)` auto-applies `Input → DWG/Intermediate → Output` before any node CST (manual p.3127, green "2"), so an extra node CST = double transform.
5.  **Levels & viewer vs pixels:** iPhone records full-range `x420` / `yuv420p10le` narrow vs full while Resolve defaults clip Data Levels to Video/legal; mismatch lifts blacks independently of CST.


### Exposure / levels nuance that defeats a static CST

- HLG Scene vs Display (OETF vs EOTF after OOTF) differ by ~1.3–1.7 stops; forum consensus fixes via `Rec.2100 HLG Scene` vs `Rec.2020` vs `Rec.2100 HLG Display` diverge because iPhone LTM/GTM pre-processing varies per shot. Manual exposure trim (-3 to -4 EV reported in t=173188) is sometimes required after any CST, proving the CST alone cannot recover per-shot trim that lives in the RPU.
- `DaVinci` vs `Saturation Compression` vs `None` DRT, and `Apply Forward OOTF` once, alter the same HLG base. Duplicate transforms (RCM Auto + manual CST + Timeline LUT + Output LUT) either crush chroma or appear to do nothing when one compensates the other (§6 failure 7).

**Implication:** The product must be a **symptom picker → test runner** (inspect tags → suggest per-clip Input/CS/Gamma → isolate RCM vs YRGB → levels toggle → viewer LUT → render-tag A/B → exposure-pull check), not a single-button CST.

*Evidence:* `04-failure-taxonomy.md` 8 failures + `05-hdr-standards-and-metadata.md` + `10-transfer-and-export-paths.md` + `11-iphone-capture-mode-matrix.md` + `06-resolve-version-platform-matrix.md` + `01-resolve-sdk-capability.md`. Primary: Blackmagic Resolve 19 Beginners Guide p.222; Resolve 18 Reference Manual Parts 287/298 via VFXPedia mirror; Dolby Professional Support “Using an Apple iPhone 12 captured Dolby Vision content as a source” (accessed 2026-08-25 via https://dolby.my.site.com/professionalsupport), Dolby “Best Practices Create Dolby Vision Profile 8.4 using DaVinci Resolve” 2026-01-08.

---

## 3. Apple Capture-Mode Matrix

Baseline fact (Apple + Dolby + TN3145, all accessed 2026-08-25): iPhone 12 generation+ default = **HEVC Main10 10-bit 4:2:0 `x420` / `yuv420p10le` QTFF `.mov`, Dolby Vision Profile 8.4 (CRID 4 = HLG), `hvc1` + `dvvC` + `colr nclx 9/18/9` (BT.2020 / HLG BT.2100 / BT.2020 NCL) + `amve` (ISO 23008-2 D.2.39, ~314 lux) + per-frame RPU SEI (NAL 62/63).** Legacy non-DV decodes HLG; DV decodes + RPU. Term `arib-std-b67` = HLG, `smpte2084` = PQ.

| # | Mode | Device / OS floor | Codec / container | Bit depth / chroma | Signaled transfer / primaries / matrix | Dolby / HLG signaling | Sidecar / notes | Resolve ingest branch |
|---|---|---|---|---|---|---|---|----------------------|
| 1 | **Native Apple Camera HDR Video (Dolby Vision)** — Video, QuickTake | iPhone 12 generation+ ; iOS 14.1+ ; iPad Pro 12.9" 5th gen+ | HEVC Main10 `.mov` (QTFF) | 10-bit 4:2:0 | `colr` **9/18/9** HLG / BT.2020 ; fallback `9/1/9` + ATC SEI 147=18 in `hvcC` | **DV Profile 8.4 CRID4** — `dvvC` + `hvcC` | `amve` mandatory per TN3145; RPU per-frame | **A: DV 8.4 HLG+RPU** → `Rec.2100 HLG` |
| 2 | **Cinematic Mode** | 13: 1080p ≤30 HDR ; 14/15/16/17(+Pro): **up to 4K ≤30 HDR** ; iOS 15+ | HEVC Main10 `.mov` | 10-bit 4:2:0 | Same 9/18/9 when HDR ON ; 1/1/1 when OFF | Same 8.4 + depth/disparity matte | Not available with ProRes ; edits invalidate RPU | A when HDR ON |
| 3 | **ProRes HDR** (Camera.app Video) | 13 Pro(+Max) iOS 15.1+ through 17 Pro ; storage-gated | **ProRes 422 HQ/422/LT/Proxy** `.mov` (`apcn`/`apch`) | 10-bit 4:2:2 | **HLG 9/18/9** ; SDR variant 1/1/1 on 13/14/15 Pro | **HLG only, no `dvvC`/RPU** ; optional `mdcv`/`clli` | **16 Pro/17 Pro picker: SDR removed — HDR or Log only** ; external SSD ≥220 MB/s (4K60) / ≥440 MB/s (4K120) | **B: pure HLG** |
| 4 | **Apple Log (orig)** flat scene-referred | **15 Pro/Max+** iOS 17+ ; Camera.app only with ProRes ON (HEVC Log via Final Cut/Blackmagic) | ProRes 422 variants or **HEVC Main10** (3rd-party) `.mov` | 10-bit | **Proprietary log** + **Rec.2020** primaries D65 | None — graded to 709/HLG/PQ in post | LUT `AppleLogToRec709-v1.0.cube` at `developer.apple.com/downloads` ; Resolve 18.6+ `Apple Log` gamma | **D: Log Rec.2020** |
| 5 | **Apple Log 2** | **17 Pro/Max** iOS 26 / `appleLog2` | Same as Log ; RAW preview via Log2 | 10-bit | Same gamma, **Apple Wide Gamut (AWG)** wider blues/magentas ; Bradford CAT matrix | None | Needs Log2-specific CST | **E: Log2 AWG** |
| 6 | **SDR** (HDR toggle OFF) | All 12+ when `Settings → Camera → Record Video → HDR Video OFF` | HEVC 8/10-bit or H.264 8-bit `.mov`/`.mp4` | 8-bit 4:2:0 (or 10) | `colr` **1/1/1** BT.709 | None | ISP tone-mapped/sharpened | **SDR bypass** |
| 7 | **ProRes RAW / RAW HQ** sensor RAW | **17 Pro/Max only** + Final Cut/3rd-party ; external SSD exFAT ; iOS 18+ | ProRes RAW/HQ `.mov` Open Gate 4224×3024 (≤60) / 4224×2240 (≤120) | 12-bit Bayer linear | No fixed space/gamma — preview forced Log2→HLG | None at capture | `proRAW` atoms ; Windows needs Apple decoder | RAW pipeline |
| 8 | **Third-party HDR** Blackmagic Camera / Final Cut Camera | Blackmagic free iOS 17+ ; Final Cut Camera iOS 17.4+ | HEVC Max 10-bit / H.264 / ProRes HQ/422/LT/Proxy / RAW + proxy | 10-bit | Explicit override: Rec.709 / Rec.2020 / P3-D65 / **BT2020 HLG10** / **HDR10** / Apple Log/2 / ACES | HLG10 = pure 9/18/9 ; HDR10 = **9/16/9+mdcv/clli** — **no `dvvC`** | Blackmagic: 17/33-pt `.cube` **Display-only** vs **Burn-to-clip** | B or C depending |

**Discriminators (ffprobe / AVFoundation probe):**

- `color_primaries=bt2020 + color_transfer=arib-std-b67 + dvvC + amve + DOVI side_data profile 8` → **DV 8.4 (A)**
- `prores + b67, no dvvC` or `hvc1 + 9/18/9 without dvvC` → **pure HLG (B)**
- `smpte2084 + mdcv/clli` → **PQ / HDR10 (C)**
- `kCVImageBufferLogTransferFunctionKey = appleLog / appleLog2` + primaries Rec.2020 vs AWG → **Log / Log2 (D/E)**
- `1/1/1 + no dvvC/mdcv/amve` → **SDR (F)**

*Primary sources:* Apple Support 109041 — https://support.apple.com/en-us/109041 ; Apple TN3145 — https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata (2023-03-07 rev 2023-12-12) ; Apple “Incorporating HDR Video with Dolby Vision into your apps” PDF — https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf ; Apple `AVCaptureColorSpace` — https://developer.apple.com/documentation/avfoundation/avcapturecolorspace ; Apple TN3104 — https://developer.apple.com/documentation/technotes/tn3104-recording-video-in-apple-prores ; Dolby — https://dolby.my.site.com/professionalsupport ; Blackmagic Camera Tech Specs — https://www.blackmagicdesign.com/products/blackmagiccamera/techspecs

---

## 4. Transfer & Export Path Matrix (Provenance)

**Taxonomy:** (1) Byte-preserving (hash-identical), (2) Container rewrite (rare, may strip `colr`/`dvvC`), (3) Tone-map HDR→SDR to 8-bit H.264 Rec.709 (irreversible), (4) Metadata strip (social). Only (1) is suitable for HDR masters.

| Path | Category | Preserves HEVC 10-bit / DV 8.4 / HLG? | Resolution / cap | Primary citation (accessed 2026-08-25) | Confidence |
|---|---|---|---|---|---|
| **AirDrop Apple→Apple (modern)** | Byte-preserving (conditional) | **Yes** — original `.mov` HEVC 10-bit + `dvvC` if receiver supports HEVC | Original up to 4K60 | Apple HT207022 / 116944 “Using HEIF or HEVC media” (2025-12-05): *might automatically be shared in more compatible format if receiver lacks HEVC* — https://support.apple.com/en-us/116944 | High |
| AirDrop → older/non-Apple | Transcode tone-map | **No** → H.264 8-bit SDR | Preserved res, SDR | Same HT207022 | High |
| **iCloud Photos — Download Originals to this Mac** | Byte-preserving | **Yes** | Original | Apple 108782 “Set up and use iCloud Photos” (2025-12-12) + 111762 “Download iCloud photos” (2026-04-10) | High |
| iCloud — Optimize Storage (local proxy) | Conditional (cloud is original, local is proxy) | Cloud yes, local **no** | Proxy, small | Same 108782 | High |
| **iCloud.com — Unmodified Original** | Byte-preserving | **Yes** (ZIP of `.mov`) | Original | Apple 111762 (2026-04-10) — https://support.apple.com/en-us/111762 | High |
| iCloud.com — Most Compatible / Highest Resolution | Transcode | **No** → H.264/AAC MP4, bakes edits | Original res, SDR | Same 111762 | High |
| **macOS Photos — Export Unmodified Original** | Byte-preserving | **Yes** + `.AAE` sidecar | Original | Photos Guide `pht6dcd5d1a0` (429-blocked 2026-08-25, inferred via HT207022) | High |
| macOS Photos — Export (default) | Transcode + tone-map | **No** | User-chosen, flattened, SDR | Same | High |
| **Finder / Image Capture USB — Keep Originals** | Byte-preserving | **Yes** | Original | Apple HT207022 + HT201302 “Transfer photos to Mac or PC” (2026-05-19) | High (only if Keep Originals) |
| Finder / Image Capture USB — Automatic | Transcode | **No** on-the-fly to H.264/JPEG | SDR | Same HT207022 | High |
| **Shared Albums** | Transcode + downscale + strip | **No** | **≤720p, ≤15 min** | Apple 108916 “Shared Album limits” (2025-02-27) — https://support.apple.com/en-us/108916 | Very High |
| iCloud Drive Shared Folder (file sync) | Byte-preserving (if Unmodified Original saved first) | **Yes if source was Unmodified Original** | Original | iCloud Drive generic file sync | High |
| Messages — iMessage video | Transcode | **No** ≤1080p compressed | Reduced | HT207022 | High |
| SMS/MMS fallback | Heavy transcode | **No** <720p <1 Mbps | Carrier cap ~1–3 MB | Carrier MMS cap | Very High |
| WhatsApp — default Gallery | Transcode + tone-map | **No** H.264 SDR 720–1080p | Capped | WhatsApp auto compression; HD toggle still H.264 SDR (CAPTCHA-blocked 2026-08-25, reproduced via ffprobe) | High |
| **WhatsApp — Send as Document** | Byte-preserving (≤2 GB) | **Yes** | Original | WhatsApp “Send as document to preserve original” | High |
| Telegram — Send as Video | Transcode | **No** | ≤1080p | Re-encodes unless Send as File | High |
| **Telegram — Send as File** | Byte-preserving | **Yes** | Original | File upload preserves bytes | High |
| Instagram / TikTok / Facebook / X / Snapchat re-download | Transcode + tone-map + strip | **No** → H.264/H.265 SDR 8-bit Rec.709 | Platform cap | Meta/TikTok Help recompress uploads | Very High |
| YouTube upload HDR → yt-dlp re-download | Transcode | Partial — serves VP9 HDR but re-encoded, not original DV | Re-encoded | YouTube HDR re-encode | High |
| Google Photos — Original quality | Byte-preserving | **Yes** | Original | Google 6220791 “Choose backup quality” — https://support.google.com/photos/answer/6220791 | High |
| Google Photos — Storage saver / Express | Transcode + downscale | **No** >1080p → 1080p | Cap 1080p | Same 6220791 | Very High |
| **Google Drive / Dropbox / OneDrive / iCloud Drive plain upload** | Byte-preserving | **Yes** | Original | Service help: upload original | High |
| Mail — Actual Size (≤25 MB) | Byte-preserving if Actual Size | **Yes if Actual Size** | Original | Apple Mail Actual Size | Medium-High |

**How to distinguish (objective, reproducible):**

```
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,color_space,color_transfer,color_primaries -show_entries stream_tags=creation_time -of json file.mov
ffprobe -v error -show_entries stream=side_data -of json
mediainfo --Inform="Video;%Format% %BitDepth% %HDR_Format%" file.mov
```

- **Preserved HDR:** `hevc` `yuv420p10le` `bt2020nc` `smpte2084`/`arib-std-b67` + `DOVI configuration record dvhe.08.06` + `dvvC` + `colr 9/18/9` ; ~100–400 MB/min at 4K60.
- **Stripped SDR:** `h264` `yuv420p` `bt709` no DOVI ; 1/5–1/10 size ; Shared Album/iMessage typically `1280×720` or `1920×1080` `h264 bt709`.

**Guardrail for Resolve ingest:** Gate on `ffprobe` — reject `h264/bt709/720p/no-DOVI` unless provenance explicitly claims SDR; re-request via **Unmodified Original / AirDrop (capable) / Keep Originals USB / Drive file / WhatsApp Document**. Verify with `md5`/`sha256`.

**Version caveat:** iOS 17–18, macOS 14–15, Photos 8, iCloud.com 2025-06. iOS 27 beta reported (MacRumors 2026) proposes Shared Albums full-res opt-in counting against storage — not yet in 108916 (2025-02-27). If shipped, the current 720p guarantee is invalidated.

*Evidence:* `10-transfer-and-export-paths.md` full 24-row matrix; primary URLs 111762, 108782, 108916, 116944/HT207022, HT201302, 121029, 6220791 (all accessed 2026-08-25).


---

## 5. Four-Layer Standards & Metadata Model

**Authoritative stack (keep four columns separate — never collapse to single “color”):**

| Layer | Spec owner | Where field lives | Needs pixel decode? |
|---|---|---|---|
| **HDR system** | **ITU-R BT.2100-2 (2018-07-12)** building on **BT.2020-2** + **BT.709**, **SMPTE ST 2084 (PQ)**, **ARIB STD-B67 (HLG)**, **SMPTE ST 2086**, **ICtCp (Dolby) → Rec.2100** | Normative definitions only | No |
| **Codec bitstream** | **ITU-T H.265 / ISO/IEC 23008-2 HEVC Annex E Table E.3** + **ISO/IEC 23091-2 (H.273) CICP code points** | SPS VUI: `video_full_range_flag`, `colour_description_present_flag`, `colour_primaries` (8b), `transfer_characteristics` (8b), `matrix_coeffs` (8b), `chroma_loc_info` | No — NAL/SPS parse only (`cbs_h265_syntax_template.c:322-360`) |
| **Container** | **ISO/IEC 14496-12 ISOBMFF** derived from **Apple QTFF Chap 3**; extensions **14496-15 (HEVC)** + **23008-12 (HEIF)** | Boxes: `colr` (`nclx`/`nclc`/`prof`), `mdcv`, `clli`/`coll`, `dvcC`/`dvvC`/`dvwC` at `moov/trak/mdia/minf/stbl/stsd/avc1/hvc1/colr` | No — box parse only (`mov.c:2202, 6928, 7009, 9075`) |
| **Dolby enhancement** | **Dolby Vision Profiles & Levels v1.3.2 (2019-09-16)** + **ETSI TS 103 572**, dynamic metadata **SMPTE ST 2094-10** | `dvcC/dvvC/dvwC` + SEI/RPU NAL (unspec 62/63) | Box parse = no decode; RPU payload needs NAL extraction (still no pixel decode) |

### ITU-R BT.2100 / BT.2020 essentials

- Primaries identical to BT.2020: R 0.708,0.292 G 0.170,0.797 B 0.131,0.046 W D65 0.3127,0.3290 → `colour_primaries=9` (BT2020). `1`=BT.709 is mislabel if HLG/PQ.
- Two TFs, mutually exclusive: **PQ SMPTE ST 2084 (`transfer=16`)** absolute 0–10 000 nits; **HLG ARIB STD-B67 (`transfer=18`)** relative/scene-referred ~1 000 nits. `transfer=1` ≈ 2.4 gamma, `14`=BT2020 10b, `15`=12b, `2`=Unspecified. Verified in `libavutil/pixfmt.h:642-706` (`AVCOL_TRC_SMPTE2084=16`, `ARIB_STD_B67=18`).
- Luma coeffs YCbCr non-constant luminance: `Kr 0.2627 Kg 0.6780 Kb 0.0593` → `matrix=9` (BT.2020 NCL) pairs with primaries 9. `10`=CL, `14`=ICtCp, `1`=709. iPhone uses `9`.
- Signal: 10/12-bit, **narrow (MPEG) range canonical** (10-bit 64-940/960), full also allowed. `video_full_range_flag 0=narrow (iPhone default)`, `1=full`. `libavutil/pixfmt.h:748` `MPEG=1` vs `JPEG=2`.
- Chroma `top-left type 2` mandated by H.265 v4 (2018-02) + BT.2100-1 errata for BT.2020/2100.

### HEVC VUI (bitstream labels)

```
flag(video_signal_type_present_flag);
  flag(video_full_range_flag); // 0=NARROW 1=FULL
  flag(colour_description_present_flag);
    ub(8, colour_primaries); ub(8, transfer_characteristics); ub(8, matrix_coefficients);
  else infer(2,2,2) // UNSPECIFIED
flag(chroma_loc_info_present_flag); ue(chroma_sample_loc_type) // 2=top-left
```

Pitfall: if flags absent, all three infer `2` (Unspecified) and `full_range=0` — **not** BT.709/BT.2020. Analyzers that silently assume BT.709 give false diagnosis. ffprobe exposes `color_primaries/trc/space/range` from `codecpar`.

### ISOBMFF / QuickTime boxes

- **`colr` (`mov.c:2202`):** `nclx` (11 bytes: 3×u16 + `full_range_flag<<7`) — same enums as VUI; invalid → remapped `UNSPECIFIED`; `nclc` legacy (3×u16, no range → ambiguous); `prof` ICC overrides numeric tags for ColorSync. Older iOS writes `nclc`.
- **`mdcv` (`mov.c:6928`, ST 2086, 24 bytes):** G/B/R primaries + white point `÷50000`, `max/min luminance ÷10000`. Static; absence ≠ SDR.
- **`clli/coll` (`mov.c:7009`, CEA-861.3 §6, ST 2094-40):** 4-byte `clli` (`MaxCLL`/`MaxFALL`) vs 9-byte `coll` (`version+flags+CLL/FALL`). Tonal guidance, not color space.
- **`dvcC/dvvC/dvwC` (`mov.c:9075`, `dovi_isom.c`):** `AVDOVIDecoderConfigurationRecord` — `dv_profile/dv_level/rpu_present/el_present/bl_present/dv_bl_signal_compatibility_id/dv_md_compression`. `dvcC` legacy, `dvvC` new (Apple uses).

### Dolby Vision 8.x signaling (iPhone-relevant)

| Profile | BL codec | EL | RPU | Typical BL signal (VUI/`nclx`) | `dv_bl_signal_compatibility_id` |
|---|---|---|---|---|---|
| **8.1** | HEVC 10b Main10 | none | yes | **PQ** `trc16` BT.2020 `pri9 mat9 narrow 0` | **1 = HDR10** |
| 8.2 | HEVC 10b | none | yes | BT.709 SDR `pri1 trc1` | 2 = SDR |
| 8.3 | HEVC 10b | none | yes | HLG `trc18` (rare) | 3 (reserved) |
| **8.4** | **HEVC 10b** | **none** | **yes** | **HLG `trc18` BT.2020 `pri9 mat9`** | **4 = HLG** — **iPhone 12+** `hvc1`/`dvh1`/`dvhe` |

FFmpeg log `profile:8 level:x rpu:1 el:0 bl:1 compat:1|4` distinguishes 8.1 vs 8.4. RPU header (`AVDOVIRpuDataHeader: bl_video_full_range_flag`, `bl_bit_depth=10`, `vdr_bit_depth=12`) **must match** BL VUI/`nclx`; mismatch = tone-mapping error.

### Coexistence & conflict matrix (selected)

| Combination | Coexists? | Legal? | Diagnosis |
|---|---|---|---|
| `nclx 9/16/9/0` + `VUI 9/16/9/0` + `dvvC 8.1 compat1` + RPU valid | ✓ | Canonical PQ fallback | HDR10 + DV both decode |
| `nclx 9/18/9/0` + `VUI 9/18/9/0` + `dvvC 8.4 compat4` + RPU | ✓ | **Canonical iPhone 12+** | HLG base + DV |
| `nclx absent` + `VUI 2/2/2` + `dvvC 8.4` | ⚠ | Underspecified | Flag `UNSPECIFIED baseline — defer to RPU` |
| `nclx 9/18/9` + `VUI 9/16/9` (HLG vs PQ) | ✗ conflict | Consistent ISOBMFF but inconsistent decode | **MISMATCH trc18vs16** — decoder (VUI) vs ColorSync (colr) will diverge |
| `nclx 1/1/1` + `VUI 9/18/9` | ✗ | Gamut mismatch | Oversaturated vs desaturated depending on path |
| `full_range 1 FULL` + `nclx range 0 MPEG` | ✗ | Inconsistent | `RANGE_MISMATCH` — blacks 0 vs 64 |
| `dvvC 8.4 compat4` + VUI `trc16 PQ` | ✗ | Illegal per Dolby | BL claimed HLG but bitstream is PQ |
| `RPU bl_video_full_range=1` + VUI `full_range=0` | ✗ | Illegal recomposition | Color drift detectable only by RPU parse |

**Precedence when both present:** HEVC decoder uses **VUI** for YCbCr→RGB; Apple ColorSync uses **`colr`/`prof`** for display; `mdcv`+`clli` static → **Dolby RPU L1/L2** overrides for DV path.

**What can be inspected without pixel decode:** `ftyp`/`colr`/`nclx`/`mdcv`/`clli`/`dvcC`/`dvvC` boxes, VUI SPS, RPU config record — all parser-only. Pixel decode only verifies declared metadata matches encoded code values.

**Minimal iPhone check (no decode):**

```
ffprobe -v quiet -print_format json -show_streams -show_format file.MOV \
 | jq '.streams[] | {codec: .codec_name, profile: .profile, color_primaries, color_transfer, color_space, color_range, side_data_list}'
mediainfo --Inform="Video;%colour_primaries%/%transfer_characteristics%/%matrix_coefficients%/%colour_range%"
mp4box -diso file.MOV 2>&1 | grep -A6 "colr|mdcv|clli|dvcC|dvvC"
exiftool -n -s -G1 -ColorSpace* -Transfer* -MasteringDisplay* -ContentLightLevel* file.MOV
dovi_tool info file.MOV
```

*Primary/implementation cross-check (accessed 2026-08-25):* ITU BT.2100-2 — https://www.itu.int/rec/R-REC-BT.2100/en ; ITU-T H.265 + ISO/IEC 23091-2 via `libavutil/pixfmt.h` + `cbs_h265` ; ISOBMFF via `mov.c:2202,6928,7009,9075` + `dovi_meta.h:30-60` ; Dolby Vision Profiles & Levels v1.3.2 PDF via https://professional.dolby.com/siteassets/.../dolbyvisionprofileslevels_v1_3_2_2019_09_16.pdf (archived via Wayback, Dolby site 404 on 2026-08-25) + `dovi_isom.c` + ETSI TS 103 572 ; ExifTool `QuickTime.pm`

---

## 6. Symptom → Likely Cause → Discriminating Test

Eight failures that share the same HEVC 10-bit `.mov` source but have distinct root causes. Each test is the **smallest** that isolates the cause.

| # | Symptom (what looks wrong) | Likely cause | Smallest discriminating test (one-click in product) | Confidence |
|---|---|---|---|---|
| **1** | Entire timeline uniformly washed (SDR output from HDR timeline with no tone-map) **or** uniformly punchy/dark. Waveform lifted flat 70–100%, no clipping flag. CST “does nothing” | **Incorrect project/timeline/output color management** — `DaVinci YRGB` vs `DaVinci YRGB Color Managed (RCM)` | Toggle `Project Settings → Color Management → Color Science` to `DaVinci YRGB` (bypass RCM) with `Timeline Rec.709 Gamma 2.4` and no node CST → add single CST `Input Rec.2020 / Gamma Rec.2100 HLG Scene → Output Rec.709 Gamma 2.4`. If image snaps, root was RCM preset overriding CST. | High (manual + t=193594) |
| **2** | Highlights blown/overexposed **only on HDR clips** by 1–2 stops; SDR clips normal. | **Wrong Input assignment** — `Rec.2020` vs `Rec.2100 HLG Scene` vs `ST2084` `Scene vs Display` | Media Pool List View → enable `Input Color Space` column. Right-click → cycle `Rec.2100 HLG Scene` → `Rec.2020` → `Rec.2100 ST2084` → `Bypass`. Observe waveform peak shift. Correct ≈ diffuse white 75% (203 nits). | High (t=182854, t=193594) |
| **3** | Clip looks flat vs iPhone Photos/QuickTime EDR; static CST/LUT never matches QuickTime frame-for-frame | **Dolby Vision metadata ignored/stripped** — Profile 8.4 HLG base + RPU; Resolve treats as HLG unless DV palette/profile enabled | Play same `.mov` in QuickTime vs Resolve viewer with `Use Mac display color profiles OFF` and no CST. If QuickTime shows punchier adaptive per-cut tone-map, metadata is ignored. Confirm `mediainfo --Inform="Video;%HDR_Format%"` → `Dolby Vision, dvhe.08.06, BL+RPU` | Medium-High (Dolby) |
| **4** | Viewer washed/low-contrast on SDR Mac Studio Display but **correct on MacBook Pro XDR**; scopes correct while viewer not | **Display / viewer mismatch** — HDR timeline on SDR monitor without tone-map/LUT | Check `Use 203 nits reference for Rec.2100 HDR` or apply Viewer LUT `HLG → Gamma 2.4`. Cross-check same frame on XDR vs Studio Display. | High (Beginners Guide + t=215217) |
| **5a** | Timeline and exported QuickTime mismatch; `Rec.709-A` (1-1-1) vs `Rec.709 Gamma 2.4` (1-2-1) swap which matches | **macOS ColorSync / NCLC tagging** — `Use Mac display color profiles` toggles ColorSync; Deliver `Color Space Tag / Gamma Tag` → `1-1-1` vs `1-2-1` | Deliver same 10 s ProRes with tags `Rec.709 Gamma 2.4 (1-2-1)` vs `Rec.709-A (1-1-1)`, check Finder Get Info + `mediainfo`. Open in QuickTime vs Resolve viewer ON/OFF + Firefox vs Safari. | High (PostProcess 2020-03-16 + t=85510) |
| **5b** | Washed blacks (pedestal ~64/1023), blacks clamped ~4% not 0% | **Video Levels vs Full/Data Levels** — iPhone records full-range 0–255 but Resolve defaults clip Data Levels = Video 16–235 | Clip Attributes → toggle `Data Levels: Video vs Full`; watch waveform black point shift. iPhone `.mov` → `Full` per Polo 2025-11-20. | High (Polo + t=85510) |
| **6** | Two copies of “same” clip behave differently: AirDropped via Shared album = 8-bit H.264 Rec.709 clean; original = 10-bit HEVC HLG washed | **Photos-export / AirDrop / Most Compatible altered metadata** | Compare `mdls` / MediaInfo for source vs exported: `BT.2020 HLG 9-18-9` vs `HD 1-1-1`, bit depth 10→8, `HDR_Format` absent. If exported is already `1-1-1` SDR, bypass HDR pipeline. | High (Apple Support + t=186893) |
| **7** | Image either crushed/oversaturated or unchanged when tweaking one CST. Bypass nodes still transformed | **Duplicate transforms** — RCM Auto + manual CST + Timeline LUT + Output LUT (order: Source → Input RCM → Timeline Working → Node CSTs → Output → Display LUT, manual p.3127) | Disable all: `Color Science = DaVinci YRGB`, remove `Video Monitor LUT`, disable all CST nodes → should look flat/washed. Re-enable one at a time. | Medium-High (manual + t=193594) |
| **8** | Detail never returns on exposure -2 stops; zebras >100% flat ceiling at 1023 | **Genuinely clipped / transcoded source** — iPhone HLG auto-exposure overexposure | Color page add gain -2 stops before CST. If detail returns → transform error; if stays clipped → source clipped. Test ProRes Log on same scene (15 Pro+). | Medium |

**CST sub-taxonomy:** `Color Space` (primaries) + `Gamma` (OETF/EOTF) are not interchangeable: `Rec.2020` vs `Rec.2100 HLG` vs `Rec.2100 ST2084`. `HLG Scene` vs `Display` ≈ 1.3–1.7 stops error. Tone-mapping `DaVinci` vs `Saturation Compression` vs `None` and `Levels` full vs video are orthogonal.

**Recommended diagnostic flow:** (1) MediaInfo before Resolve → 9-18-9? dvhe.08.06? 10-bit? (2) Media Pool Input Color Space + Data Levels (3) Toggle RCM Auto vs YRGB + single CST (4) Viewer LUT / 203-nits / XDR vs Studio Display (5) Render two tag variants 1-1-1 vs 1-2-1 (6) DV check + per-shot variability (7) Exposure pull -2 stops.

*Primary:* Dolby Professional Support + Dolby “Best Practices Create Dolby Vision Profile 8.4 using DaVinci Resolve” 2026-01-08 + Blackmagic Resolve 19 Beginners Guide p.222 + Resolve 18 Reference Ch.6 + Resolve Immersive Workflow Guide p.27-28 + Apple Support 102241 + Blackmagic Forum t=182854, t=215217, t=186893, t=173188, t=193594


---

## 7. Resolve Version / Edition / OS / Display Capability Boundaries (18.6–21.0.4)

**Current shipping (accessed 2026-08-25):** Resolve **21.0.4** (2026-08-05), maintenance branch **20.3.3/Studio 20.3.3**. Earlier baselines: 18.6 (2023-09-14), 19.0 (2024-08-22), 19.1 (2024-11), 20.2 (BT.2408 switch), 21.0.1 (HDR metadata fix).

### Condensed OS × capability matrix

| Axis | macOS Intel / Apple Silicon | Windows 10/11 | Linux (Rocky 8.6 CUDA) | Confidence |
|---|---|---|---|---|
| **H.265 10-bit Main10 4:2:0 decode — Free** | **Yes** GPU accelerated (both editions) | **~** 8-bit OS-supported only; 10-bit 4:2:0 often decodes via OS (slow/no HW) or offline | **X Studio Only** (Nvidia) | High (Codec List Aug 2024) → Medium-High Windows anecdote |
| **H.265 10-bit decode — Studio** | **Yes** Apple VideoToolbox / Media Engine auto | **Yes** Nvidia/Intel GPU HW accel | **Yes** Studio + Nvidia | High |
| **H.265 Main10 encode** | **Yes** Studio HW on Intel + Apple Silicon M1+ ; Free 8-bit only. 16.2.2+ HW Main10 Mac ; 17.4.4 Main10 Apple Silicon | **~** Studio Main10 needs adequate Nvidia ; Free Main only (8-bit). **19.1 added Main10 on Windows** | **Yes** Studio + Nvidia | High → Med-High 19.1 |
| **HDR grading base (RCM PQ/HLG, DWG Intermediate)** | Y Free+Studio | Y | Y | High |
| **Professional HDR scopes (nit precision)** | **Studio only** — *Support for HDR video scopes Studio* | Studio only | Studio only | High (Studio Features PDF v20 2025-01-27) |
| **Dolby Vision grading/render (L1, CMU, trim)** | Studio + separate Dolby license for advanced trims ; Free limited tonemapping | Same | Same (Limited Linux) | High |
| **Plain HDR10/HLG export with static mdcv/clli** | Y Free+Studio | Y Free+Studio (pre-21.0.1 flagged incorrectly → patch; **fixed 21.0.1**) | Y Studio-mediated | High |

*Source:* Blackmagic DaVinci Resolve 19 Supported Codec List (Aug 2024) — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_Supported_Codec_List.pdf ; Studio Features PDF v20 — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_Studio_20_Features.pdf ; Support Family Page (live 2026-08-05) — https://www.blackmagicdesign.com/support/family/davinci-resolve-and-fusion

### Display & viewer

- **Unified pipeline:** 32-bit float; RCM `Input → Timeline → Output`. Recommendation: Timeline = wide gamut Rec.2020 if delivering HDR+SDR.
- **HLG Output choices:** `Rec.709 HLG ARIB STD-B67`, `Rec.2020 HLG`, `Rec.2100 HLG`, `Rec.2100 HLG (Scene)` × separate Color Space/Gamma controls.
- **Viewer HDR (no DeckLink):**
  - macOS 10.14.6+ requires `Use Mac display color profiles for viewers` + `Use 10-bit precision if available` + `Display HDR on viewers if available` + `HDR Video (P3-ST2084)` reference mode. XDR/MacBook HDR works; HLG bug pre-19/20 showed too much contrast vs PQ on XDR.
  - Windows since 19.0: `Support for HDR Displays on Windows` — HDR display + Windows HDR ON + `Use 10-bit precision` + `Use Windows display color management and HDR for viewers`. Single flag for all viewers; mixed SDR+HDR shows wrong on SDR monitors.
  - Linux: not documented for GUI; **DeckLink required**.
- **Professional HDR:** DeckLink 8K Pro G2 / 4K Extreme 12G / UltraStudio 4K Extreme ; ST.2084 signals appear log-like; 19 adds Dolby Vision HDMI tunneling on DeckLink 8K Pro G2.

### QuickTime / metadata specifics for iPhone

- nclc/colr must preserve 9-18-9 (HLG), 9-16-9 (PQ), 2-2-2 (DV P5 fallback); wrong tags → QuickTime/YouTube/Vimeo shift.
- Deliver page 16.2.1+ `Color Space Tag / Gamma Tag` — defaults follow Timeline/Output; override possible. 16.2.2 added `Rec.709-A (1-1-1)` to match QuickTime for SDR web.
- HDR SEI/VUI: HDR10 needs `mdcv+clli` in `hvcC` or container big-endian; HLG needs `preferred_transfer_characteristic=18` ATC SEI in `hvcC`; DV 8.4 needs `dvvC+colr+amve`. Missing SEI → TV not switching to HDR — progressive fix culminating in **21.0.1 + 20.3 Studio**.

### Version history with iPhone-relevant changes

| Version | Date | Change | Confidence |
|---|---|---|---|
| 18.6 | 2023-09-14 | Dolby Vision CM 4.0 L1 analysis ; 3D Dolby Vision ; bypass input CM for RAW in RCM ; Apple Log decode | High — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_18.6_New_Features_Guide.pdf |
| 18.6.4 | 2023-12-05 | Blackmagic RAW 3.6 ; no HDR line | High |
| 18.6.6 | 2024-03-20 | Panasonic AVC big-endian LPCM ; QuickTime alpha | High |
| **19.0** | 2024-08-22 | **HDR Displays on Windows** + **decoding cinematic clips captured by iPhone** + Dolby Vision HDMI tunneling (DeckLink 8K Pro G2) + tone-mapped previews/scopes + up to 4× faster H.264/H.265 decodes (non-Studio Windows) | High — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_New_Features_Guide.pdf |
| **19.1** | 2024-11 | Ability to encode H.265 Main10 on Windows | Med |
| 19.1.1 | 2024-11-09 | H.265 export corruption fixed (Main10 + multi-pass + optimise for speed OFF on Apple Silicon after Sequoia 15.1.1 — M4 Pro/Max) | High (official) + Med (forum t=211412) |
| 19.1.3 | 2025-01-20 | ARRI Alexa 265 ; no HDR | High |
| 20.0 | 2025-04 beta | >100 features ; RCM/CST under-the-hood change retro-noted as BT.2408 | High |
| 20.1 | 2025-mid | H.264/H.265 in MXF Op1A, ACES 2.0 | High |
| 20.1.1 | 2025-09-02 | Dolby Vision metadata formatting improved | High |
| **20.2** | 2025-?? | **RCM and CST now using ITU BT.2408 for HLG and PQ conversion** | Med-High — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.2_New_Features_Guide.pdf |
| **20.3 Studio** | 2025-?? | **improved HDR10 metadata embedding** + stereoscopic 3D monitoring | High — Support page |
| 21.0 | 2026-mid | Fairlight folders, MultiMaster trim, Photo page | High |
| **21.0.1** | 2026-06-24 | **HDR metadata handling for H.265 HDR renders** — *H.265 HDR renders now include improved HDR metadata handling so exported files are more reliably recognized as HDR by compatible TVs/media players* | High — Support Family Page |
| 21.0.2/21.0.3 | 2026-07 | H.265 playback perf on NVIDIA (Studio) | High |

**Regressions & caveats:** Pre-19 Windows no HDR viewer (DeckLink-only → flat/log-like by design). 19.0 Windows HDR rollout had “not available but will be in final” + Fusion preview glitch. HLG on XDR contrast/saturation mismatch `Rec.2100 HLG` vs `PQ1000` (unknown if fully fixed by 20.2 BT.2408). H.265 4:2:2/4:4:4 10/12-bit requires Studio + adequate GPU even on Studio.

### Apple Silicon Media Engines (macOS)

M1/M2/M3/M4 media engine handles H.264 / HEVC Main10 (8/10-bit) / ProRes (all flavors) decode/encode at near-zero CPU (≈0% at 8K ProRes, 170–200 fps ProRes→H.264/5 per bench) via Apple VideoToolbox automatically (no toggle). Impact: iPhone HEVC 4:2:0 decodes real-time at 4K60. Free benefits from OS decoder but HW encode Main10 path remains Studio-gated.

---

## 8. Workflow Integration: Inbound/Outbound Drag & API Fallback Limits

**Verdict:** Inbound Finder→panel drag is **NOT implemented in ClipDock** but is empirically possible under current sandbox; outbound panel→Resolve drag **IS implemented via `webContents.startDrag`**; API-button fallback **IS implemented**. Each seam has distinct documentation grade. All under Resolve Studio only (Free has no Workflow Integrations menu) on Windows/macOS — **Linux not supported for plugins** (README.txt:52-53) , Electron 36.3.2 / Node 22.15.1 per ADR-0003.

| Seam | Question | Status | Grade | Strongest local evidence |
|---|---|---|---|---|
| A1 Inbound drop plumbing | Can renderer receive OS file via HTML5 drag? | Possible but **no handler exists today** | Empirical / Electron-documented | `grep -rn drop` finds zero handlers in `src/` (`src/renderer.ts` only has outbound `dragstart` at 1682) ; selection today only via `dialog.showOpenDialog` (`src/main.ts:290-311`) |
| A2 Path access under isolation | Does renderer learn absolute path? | Yes via `File.path` (Electron extension) but **untrusted** | Documented by Electron, untrusted per ClipDock model | `src/main.ts:624-633` `webPreferences: {contextIsolation:true, sandbox:true, nodeIntegration:false}` ; `src/preload.ts` only whitelists `electron/renderer` + `contextBridge` ; README:19-23 v19.0.2 enforces sandbox+contextIsolation |
| A3 Main validation | Can main safely ingest Finder path? | **Proven** | Documented + tested | `src/path-boundary.ts:8-68` `canonicalRoot/contains/regularFile/isSafeMediaFile` — `lstat`+`realpathSync`+`statSync` + `relative+isAbsolute` ; `src/main-process.ts:33-61` `resolveMainProcessCard` ; `src/main.ts:381-420` `capturedManagedRoot`+`isSafeMediaFile` ; tests `path-boundary.test.mjs`, `main-process.test.mjs:329-428` |
| A4 TrustedRoot | iPhone MOV `/Users/.../DCIM` vs managed root? | External = no containment; managed = `trustedRoot` | Implemented | `src/main.ts:88-110` managed vs external ; `completionDeps.isSafeMediaFile=(fp)=>isSafeMediaFile(fp,managedRoot)` for downloads |
| B Conversion | HDR→SDR ffmpeg in main | Ready, isolate-safe | Implemented | `src/media-prep.ts:101-130` decision/ffmpegArgs (`remux/audio-remux/transcode prores_ks`) ; `discoverFfprobe/discoverFfmpeg` |
| C1 Outbound native drag | `webContents.startDrag` from panel | **Live** | Documented by Electron + proven in ClipDock | `src/main.ts:191-193` `nativeImage.createFromDataURL` 32×32 PNG ; `src/main.ts:288-311` sync `ipcMain.on('clipdock:native-drag-start')→event.sender.startDrag({file/files,icon:DRAG_ICON})` ; `src/main-process.ts:184-200` resolves `cardIds→paths`, dedupes, validates per-card `trustedRoot` ; `src/electron.d.ts:45-46` ; `src/preload.ts:23-28` ; `src/renderer.ts:1682-1701` `startCardDrag` |
| C2 macOS icon | Non-empty NativeImage required | Satisfied | Documented Electron, OS-specific | `src/main.ts:191` comment `macOS startDrag REQUIRES non-empty icon` ; create from base64 PNG — never empty |
| C3 Drag payload | Single vs multi | Both | Implemented | Single `{file,icon}` vs multi `{files,icon}` (`src/main.ts:310-311`) ; queue uses array overload for multi-select |
| C4 Drop targets | Media Pool vs Timeline | **Both empirical — not in SDK docs** | Empirical | `src/main.ts:307` comment `drop onto Media Pool or timeline` ; `src/renderer.ts:1755` aria hints `Drag to Resolve` ; no Blackmagic doc lists targets; scripting docs only cover API import ; Media Pool accepts OS drops in any page when project open ; Timeline only when Edit/Cut page active |
| C5 Renderer isolation for drag | Paths never cross to renderer | Enforced | Implemented | `src/main.ts:82-85` `Map<string,{path,trustedRoot}>` authority ; renderer sees `cardId`+`fileName` only (`src/shared.ts`) |
| D Fallback API | `AddItemListToMediaPool` / `AppendToTimeline` | **Complete** | Official SDK, fully implemented | `src/transfer.ts:59-89` `GetMediaStorage().AddItemListToMediaPool([path])` ; `src/transfer.ts:460-510` `AppendToTimeline` with bin context (`GetRootFolder/GetSubFolderList/AddSubFolder/SetCurrentFolder`), duplicate scan by normalized `File Path`, restore previous bin ; Playhead `OpenPage('edit')`, `GetStartFrame/GetStartTimecode/GetCurrentTimecode/GetSetting('timelineFrameRate')`, `timecodeToFrames` (`src/transfer.ts:95-109`) → `{mediaPoolItem,startFrame,endFrame,recordFrame}` ; sample `Developer/Workflow Integrations/Examples/SamplePlugin/main.js:150-160` confirms `AddItemListToMediaPool` |
| E OS/platform/version | Supported hosts | Constrained | Official | macOS `/Library/.../Workflow Integration Plugins` vs Windows `%PROGRAMDATA%\...` ; LSMinimumSystemVersion 15.0 ; Workspace→Workflow Integrations menu via `manifest.xml` Id `com.clipdock.app` |

**What is documented vs empirically possible:**

- **Documented (primary/official):** Electron sandbox/contextIsolation from 19.0.2 (README NOTE → https://www.electronjs.org/docs/latest/tutorial/sandbox) ; `WebContents.startDrag({file/files,icon})` — https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragoptions (macOS icon non-empty requirement) ; Workflow Integration lifecycle `manifest.xml` + `WorkflowIntegration.node Initialize/GetResolve/CleanUp/RegisterCallback` + `GetMediaStorage/AddItemListToMediaPool`, `Project.GetMediaPool/MediaPool.AppendToTimeline` (Scripting README + `Examples/SamplePlugin/main.js`) ; macOS/Linux plugin support boundary.
- **Empirically possible (not in Blackmagic docs):** HTML5 `drop→File.path` in sandboxed renderer (Electron adds `path` property) ; Resolve Media Pool/timeline as OS file drop targets from `startDrag`.
- **Inferred/unproven until live:** Finder HDR drag preserving spaces/unicode through `file.path` + IPC + `realpathSync` ; >4 GB HDR not blocked (file-drag is by-path, not bytes) ; timeline drop position maps to Resolve-internal playhead/X, not controllable via `startDrag` (API `recordFrame` is the only precise placement).

**Renderer isolation & security note:** Preserve `sandbox:true, contextIsolation:true, nodeIntegration:false` (`src/main.ts:629-633`). Inbound HDR drop must not `require('fs')` in renderer nor expose raw path. Pattern: renderer `dragover→preventDefault`, `drop→event.dataTransfer.files[0]?.path` (Electron only), immediately `ipcRenderer.invoke('clipdock:ingest-drop', path)` — main does `isSafeMediaFile`+`regularFile`+`contains` and replies `cardId|null`.

**Smallest live experiments to close gaps (reversible, <2 min each on macOS 15 × Resolve 21.0.3 Studio first, then Windows 11 × Resolve 21):** E1 inbound drop probe `console.log([...e.dataTransfer.files].map(f=>({name:f.name,path:f.path})))` (pass = absolute path + main `isSafeMediaFile` true for regular file, symlink rejected) ; E2 outbound to Media Pool ; E3 to Timeline (Edit page) ; E4 macOS icon regression (empty icon fails on macOS) ; E5 Free vs Studio + Linux menu missing ; E6 API fallback parity (button `imported/already-imported/timeline-appended/inserted` vs drag visual confirm) ; E7 multi-file drag ; E8 space/unicode path (`My HDR (é) 01.MOV`). If `file.path === undefined`, fallback is `dialog.showOpenDialog` inbound; do not relax sandbox.

*No visual/live Resolve success is claimed — all C4 timeline/media-pool acceptance is empirical pending live re-tests.*


---

## 9. GitHub Tools & Existing Products — Ranked with Licensing Caveats

### 9.1 Ranked GitHub evidence table (trust = code + tests + spec vs anecdote)

| Rank | Repo / Issue | URL (accessed 2026-08-25) | Stars / Activity | License / Maintenance | Proven capability (code read) | Gap / risk |
|---|---|---|---|---|---|---|
| **A1** | **quietvoid/dovi_tool** CLI + `dolby_vision` crate / libdovi | https://github.com/quietvoid/dovi_tool — Release **2.3.3** 2026-07-12 | 1005★ updated 2026-08-24 | **MIT**, Rust 1.88+, active 2026-08-22 | Strongest RPU: `info`/`extract-rpu`/`inject-rpu`/`convert`/`demux`/`mux`/`generate`/`editor`/`export`/`plot` ; modes 0 rewrite, 1 MEL, 2→p8.1, 3 p5→8.1, 4→8.4, 5 preserve mapping. C API via `dolby_vision/README.md` | Works on **HEVC elementary stream** (`.hevc`), not MOV directly — requires `ffmpeg -bsf:v hevc_mp4toannexb` pipe ; no NCLC/colr rewrite ; issue #378 DV→non-DV not natively supported ; #381 empty RPU after editing open ; no tonemap |
| **A2** | **FFmpeg/FFmpeg** | https://github.com/FFmpeg/FFmpeg | 63617★ updated 2026-08-25 | **LGPL 2.1+ / GPL 2+** | Diagnosis `ffprobe -show_streams -show_frames` `color_primaries/trc/space/codec_tag/side_data` ; 4 pipelines: (a) metadata rewrite `-color_primaries ... -bsf:v hevc_metadata`, (b) bitstream filter, (c) tonemap `zscale+tonemap` (hable/mobius) or `libplacebo` (mobius/perceptual), (d) `tonemap_opencl` ; `doc/filters.texi` tonemap/zscale/libplacebo | No native RPU editing ; `libplacebo` requires Gyan build (fallback `zscale` lower quality) ; no Resolve automation ; tag-fix vs tonemap conflated in community |
| **A3** | **MediaArea/MediaInfo** + **MediaInfoLib** | https://github.com/MediaArea/MediaInfo ; https://github.com/MediaArea/MediaInfoLib | 1999★ + 787★ | **BSD-2-Clause**, very active | Diagnosis gold standard: `Format profile`, `HDR format`, `Codec ID dvhe.08.06`, `Color primaries/transfer/matrix`, `Mastering display`, `MaxCLL/FALL` ; backs `pymediainfo`, `mediainfo.js` | Read-only ; no RPU decode ; MOV `colr/nclc` vs MXF divergence → verify with MediaInfo not Finder ⌘I |
| **A4** | **axiomatic-systems/Bento4** + **gpac/gpac (MP4Box)** | Bento4 https://github.com/axiomatic-systems/Bento4 ; GPAC https://github.com/gpac/gpac | Bento4 2493★ 2026-08-24 ; GPAC 3296★ LGPL-2.1 2026-08-25 | Bento4 BSD-like (check `LICENSE`), GPAC LGPL-2.1 | MP4 atom diagnosis & muxing: Bento4 `mp4info` `colr/nclx`, `mp4tag`, `mp4mux` ; GPAC `MP4Box -add -rbds :fmt hevc:dv hev1` ; **metadata rewrite without transcode** (`colr` patch) | Neither parses RPU levels ; Bento4 no releases (`latestRelease: null`) ; GPAC can mis-handle `dvh1` vs `hvc1` |
| **A5** | **bbimer/iphone-hdr-to-sdr-ffmpeg** | https://github.com/bbimer/iphone-hdr-to-sdr-ffmpeg | 0★ updated 2026-08-03 | MIT, single author | Direct iPhone 15/16 Pro Max 4K60 DV 8.4/HLG→Rec.709 ProRes422LT via `libplacebo tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709` + fallback `zscale t=linear:npl=220 tonemap mobius param 0.4 desat 0.5` | Anecdotal/low-trust 0★ no tests ; Windows `.bat` only ; always transcodes ; `npl=220` heuristic undocumented |
| **A6** | **blurridge/ffmpeg-iphone-hdr-sdr-converter** | https://github.com/blurridge/ffmpeg-iphone-hdr-sdr-converter | 1★ 2025-10-17 | none declared | Minimal trustworthy tonemap: `main.py:6-20` `zscale transfer=linear tonemap hable peak 8 zscale transfer=bt709 format yuv420p colorspace bt709` → `libx264 fast crf22` | `peak=8` undocumented, strips audio `-an`, vertical `720x1280` |
| **A7** | **foldvarid93/HDR_to_SDR_VideoConverter** | https://github.com/foldvarid93/HDR_to_SDR_VideoConverter | 0★ 2025-11-23 | none | Hybrid GUI `VideoConverter.py` + `HandBrakeScript.py` `--use-ffmpeg-tonemap --encoder x264/x265 --prefer-gpu` | Thin wrapper, no profile-specific logic |
| **A8** | **pedrolabonia/pydavinci** | https://github.com/pedrolabonia/pydavinci — tag **v0.2.3** 2022-05-15 | 181★ MIT 2026-04 Needs maintainers #42 | MIT Python 3.6+ | Highest-fidelity Resolve wrapper: typed stubs `_resolve_stubs.pyi` expose `MediaPoolItem.GetClipProperty/SetClipProperty`, `GetMetadata/SetMetadata`, `Project.GetSetting/SetSetting`, `TimelineItem.GetClipColor` | No explicit `InputColorSpace` property name documented — BMD string-key API version-fragile ; no HDR example |
| **A9** | **diop/davinci-resolve-api** + **nobphotographr/davinci-resolve-automation** + **MingoBoon/resolve-color-management-toolkit** | diop https://github.com/diop/davinci-resolve-api ; nobphotographr https://github.com/nobphotographr/davinci-resolve-automation ; MingoBoon https://github.com/MingoBoon/resolve-color-management-toolkit | diop 98★ no license 2018 ; nobphotographr 5★ MIT 35 scripts ; MingoBoon 0★ 2026-07-25 | Mixed | Color management patterns: diop `SetClipProperty/SetMetadata/GetSetting/SetSetting` ; nobphotographr `iphone_bmc_interactive.py` end-to-end `CreateProject→SetSetting color science→AddItemsToMediaPool→SetClipProperty→CDL→timeline` ; MingoBoon two-CST chain | diop **2018 stale** ; nobphotographr Blackmagic Camera Log focus ; MingoBoon static site not library |

**Trust rule:** Treat A1–A4 + `pydavinci` stubs as primary implementation evidence; treat A5–A7 screenshot claims as secondary until backed by `ffprobe`/`MediaInfo` dumps.

**Tool capability matrix — separate rewrite vs transcode vs tone-map vs automation:**

| Operation | When | Tool | Minimal example |
|---|---|---|---|
| Diagnose tags | First step every clip | `ffprobe` / `MediaInfo` / `Bento4 mp4info` | `ffprobe -select_streams v:0 -show_entries stream=color_primaries,color_trc,colorspace,codec_tag,side_data -of json file.MOV` ; `MediaInfo --Output=JSON file.MOV` |
| Metadata rewrite (no re-encode) | Tag wrong but base is correct HLG | `ffmpeg -c copy` + `Bento4`/`GPAC` | `ffmpeg -i in.MOV -c copy -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9 out.MOV` ; `MP4Box -add in.hvc:fmt=hevc -rbds` |
| DV RPU extract / inject / convert | Profile shift or remove DV | `dovi_tool` | `ffmpeg -i in.MOV -c:v copy -bsf:v hevc_mp4toannexb -f hevc - \| dovi_tool extract-rpu -o RPU.bin --summary` ; `dovi_tool inject-rpu -i BL.hevc --rpu-in RPU.bin -o out.hevc` (mode 4 is correct for P8.4) |
| Tone-map to SDR (re-encode) | SDR deliverable or tag unrecoverable | `ffmpeg` | `ffmpeg -i in.MOV -vf "libplacebo=tonemapping=mobius:gamut_mode=perceptual:colorspace=bt709" -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:v prores_ks -profile:v 1 out.mov` (bbimer) ; fallback `zscale=transfer=linear,tonemap=hable:peak=8` (blurridge) |
| Resolve automation | Batch 100s of clips | `pydavinci` / `diop` API | `clip.SetClipProperty("Input Color Space","Rec.2020 HLG")` guarded by `GetClipProperty()` dump gate |

*No single repo ties diagnose→rewrite→RPU→tonemap→Resolve batch — the plugin must orchestrate.*

### 9.2 Existing products / workflows (non-GitHub, read-only survey)

| Product | Category | Inspect / rewrite | HLG/PQ/DV RPU | Tone-map | ProRes | Batch/watch | Resolve | Pricing / platform | Limitation |
|---|---|---|---|---|---|---|---|---|---|
| Color Finale Transcoder 2 | macOS standalone + FCP extension | Choose output CS ; no RPU | RAW→PQ/HLG | FCP HDR Tools / LUTs | Proxy→4444 XQ GPU | Queue batch, no watch | **FCP only** | $179 standalone ; Ultimate $350.99 ; 2 Macs ; 7-day watermark trial ; macOS 13–15 | macOS-only, no iPhone HEVC focus |
| EditReady (Hedge) | Mezzanine transcoder | View/edit metadata, ALE, LUT preview | Rec.709↔PQ↔HLG auto 22.2 ; no RPU | Color Awareness + LUTs | ProRes/DNxHR/H264/H265 | Batch parallel ; API/URL scheme Pro-only | None native | $99/$149/$999 tiers Standard vs Pro ; macOS only | Pro for RAW+scripting |
| Shutter Encoder | GPL-3.0 GUI over FFmpeg | FFmpeg flags ; Issue #250 regression | HLG/PQ checkbox ; DV copy-only | LUT + filters | ProRes/DNxHR/CineForm | Queue batch ; no watch (fork adds) | None | Free donationware Win/Mac/Linux 2.6k★ | Single maintainer |
| hdrprobe | Inspector | **Inspection only** unified JSON | Reports profile/CM/L5/trims | No | No | Single/bulk NDJSON | Preflight | Free native binary | Read-only |
| Dolby Professional Tools + `dlb_mp4base` | Dolby licensed | Metafier + `CM_Analyze` generate DV from PQ | DV gen from PQ (HLG→PQ first) ; `mp4muxer` `dvcC/dvvC` | CM Offline | No MXF | CLI batch | Resolve/Flame plugins | Tools free ; **trim $1k/facility perpetual** ; `dlb_mp4base` BSD-3 | PQ prereq |
| ios-media-toolkit | Python CLI + Docker DV preservation | exiftool verify `hvc1/dvcC` | Preserves DV8.4 via `dovi_tool`+`mp4muxer` | No (preserves HDR) | No (HEVC) | Album SHA256 Docker batch | Correct tags | Free | RPU invalid if frames changed |
| bbimer iphone-hdr-to-sdr | Windows batch | Tag `hvc1` | HLG/DV8.4 in → Rec709 out | `libplacebo mobius perceptual` → ProRes LT / HEVC hvc1 | ProRes LT + HEVC | Drag-drop `.bat` | SDR timelines | Free Windows Gyan FFmpeg | Windows only |

**Direct competitor finding:** No turnkey commercial product markets itself as iPhone HDR fixer for Resolve. Closest are **open-source compositions**: `ios-media-toolkit`, `bbimer`, `hdrprobe` + Rodrigo Polo LUT.

### 9.3 Licensing risk register (not legal advice — citations only, re-verify before shipping)

| Area | Cited terms (accessed 2026-08-25) | Risk if shipping binaries |
|---|---|---|
| **Dolby Vision** | Prof Tools free ; trim $1k facility — https://professional.dolby.com ; `dovi_tool` MIT not authorized ; `dlb_mp4base` BSD-3 no patent grant — https://github.com/DolbyLaboratories/dlb_mp4base | Creating RPU or claiming certified may need license |
| **HEVC** | Via LA, Access Advance 27k patents, 25% increase Jan 2026 | Distributing encoder/decoder enforces pools ; SaaS avoids distributor |
| **x264/x265** | GPL-2, `--enable-gpl` makes FFmpeg GPL requires source | Shipping `libx264/x265` triggers GPL disclosure |
| **FFmpeg** | LGPL-2.1 default — https://www.ffmpeg.org/legal.html | Stay `LGPL --disable-nonfree --enable-shared` ; brew/apt binaries often GPL — don’t redistribute |
| **ProRes** | Apple proprietary authorized-only list — https://support.apple.com/118584 ; FFmpeg `prores_ks` unauthorized — https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf | `prores_ks` risks trademark ; use DNxHR |

*Sources for §9:* Dolby Professional Support + Apple Incorporating HDR PDF + FFmpeg legal + `quietvoid/dovi_tool` — https://github.com/quietvoid/dovi_tool (2.3.3) + `DolbyLaboratories/dlb_mp4base` + Color Finale — https://colorfinale.com/transcoder ; Hedge — https://hedge.co/products/editready ; Shutter Encoder — https://www.shutterencoder.com + Apple ProRes white paper + FFmpeg `dovi_rpu.c` + Hedge blog 22.2 + Shutter issue #250.


---

## 10. Lawful Reproducible Corpus & Objective Measurements

**Policy:** No private user media. Commit only generators, `ffprobe`/`dovi_tool` wrappers, hash manifest (`corpus_manifest.json` with URL+date+sha256+expected metadata), and ≤30 s self-captured SDR/HDR clips (<200 MB, git-lfs if needed, with consent). Dolby/EBU/Apple samples are **on-demand, cached locally, git-ignored**.

### Tier 1 — Authoritative, must-include (on-demand)

| # | Sample | Provenance / Format | Expected ffprobe/MediaInfo (key fields) | License / Commit? | Size | Deterministic measurement |
|---|---|---|---|---|---|---|
| 1 | **Dolby Vision profile 8.4 — Glass Blowing etc.** `developer.dolby.com/tools-media/sample-media/video-streams/dolby-vision-streams` + mirror `DolbyLaboratories/dolby-vision-contents` `BL_RPU_dvhe-08-84_1920x1080@24fps` | HEVC Main10 `hvc1`/`dvh1` + `dvcC`/`dvvC` | `color_primaries=bt2020` `color_trc=arib-std-b67` `color_space=bt2020nc` `codec_tag dvhe/dvh1` + `HDR format Dolby Vision dvhe.08.06 BL+RPU HLG compatible` ; `dovi_tool info profile 8.4 BL+RPU` | Dolby account ToS personal/evaluation **not redistributable** ; GitHub mirror no `LICENSE` file (2022-09-21) → **reference only, on-demand cache** | 10–60 MB/clip | Metadata: `ffprobe`, `mediainfo`, `dovi_tool info --summary` ; Pixel: `signalstats` + `histogram` + `psnr/ssim` |
| 2 | **EBU HLG Tech 3373 Colour Bars QT v210 v2.0 2020-07-03** `tech.ebu.ch/publications/tech3373-v210` + TIFF `tech3373-tiff` | QT `v210` 10-bit YCbCr 4:2:2 narrow 64-940/960 carrying BT.2100 HLG | `color_primaries bt2020` `color_trc arib-std-b67` `color_space bt2020nc` `pix_fmt yuv422p10le` ; includes -7% superblack / 109% superwhite | EBU open download free-for-testing; PDF generally freely distributable; no OSS grant → **do NOT commit binary; on-demand `curl -L`** | 23.2 MB zip QT + 2 MB TIFF | Pixel: per-patch 10-bit YCbCr vs Table 3 `tech3373.pdf` ; `signalstats` `BRNG` fraction |
| 3 | **Apple HLS Example Streams** `developer.apple.com/streaming/examples/` | HLS multivariant AVC/HEVC **DolbyVision5 / HDR10** | Playlist `CODECS="hvc1..."` + `VIDEO-RANGE=SDR/HLG/PQ` + `SUPPLEMENTAL-CODECS="dvh1.08.09"` | Apple Sample Code License (2020 PDF) as-is with notice retention ; media **on-demand** | playlist + few MB segments | `ffprobe` on segments `color_trc` vs `VIDEO-RANGE` ; `mediastreamvalidator` |

### Tier 2 — High-value, small/on-demand (self-captured preferred)

| # | Sample | Provenance / format | Expected metadata | License | Size |
|---|---|---|---|---|---|
| 4 | **Apple Log (ProRes Log) on-device** 1–2 s 15 Pro+ via Camera or Blackmagic Camera `ProRes 422 HQ` Log 3840×2160 10-bit | MOV `prores yuv422p10le` + `com.apple.quicktime.color-parms` | `color_primaries` unspecified/bt709 (scene-referred Log via `kCVImageBufferLogTransferFunctionKey`) ; **no** `dvcC`/RPU | **Self-captured = fully ownable, commit-allowed** (≤5 s <200 MB) | 150–400 MB/5 s |
| 5 | **SDR control Rec.709 8-bit** — same device HDR OFF or synthetic `lavfi testsrc2` | `yuv420p 8-bit` `bt709` | `color_primaries bt709` 8-bit no HDR | Synthetic MIT-able, **commit-allowed** | <20 MB |
| 6 | **DV Profile 5 & 8.1 variants** same Dolby source | P5 IPT-PQ-c2 no HDR10 fallback ; P8.1 HDR10 base+RPU | P5 `dvhe.05.09 BL+RPU` ; P8.1 `dvhe.08.06 BL+RPU HDR10 compatible` | Same as #1 login/mirror | 10–60 MB |

### Tier 3 — Metadata edge-cases (synthesized, fully reproducible, zero-privacy)

| Edge | How to synthesize (ffmpeg/dovi_tool) | Expected signal | Measurement distinguishing it |
|---|---|---|---|
| **A Stripped RPU** | `dovi_tool extract-rpu in.mov -o RPU.bin` ; `dovi_tool convert --discard in.hevc -o stripped.hevc` | Still HEVC 10-bit HLG base, **no `dvcC/dvvC` / RPU SEI** ; pixels unchanged | **Metadata fails, pixels pass:** `dovi_tool info 0 RPUs` ; `framemd5` / `ssim All:1.000000` |
| **B Corrected-tag mismatch** | `ffmpeg -i src.mov -c copy -bsf:v h265_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coeffs=1 fixed_tags.mov` | `color_primaries bt709 trc bt709` while RPU declares BT.2020/HLG → washed import | `mediainfo --Inform` ≠ RPU gamut ; pixel hash matches source |
| **C Resolution/level** | `libx265 -x265-params level-idc` 5.1 vs 5.2 | level signaling | `ffprobe level` ; Resolve may reject non-standard level |
| **D CM v2.9 vs v4.0 RPU** | `dovi_tool generate --xml cmv29.xml` vs `--json cmv40.json` | L1/L2/L5/L6 vs +L3/L8/L9/L10/L11 | `dovi_tool info --summary` + `export --levels` JSON diff |
| **E HLG vs PQ HLS signaling** | Playlist `SUPPLEMENTAL-CODECS="dvh1.08.09"` `VIDEO-RANGE HLG` vs `PQ` | `VIDEO-RANGE` must match `color_trc` | `mp4box -info` + `dovi_tool` |

**Expected ffprobe examples:**

```
ffprobe: hevc Main 10 yuv420p10le bt2020nc/bt2020/arib-std-b67 + DOVI dvhe.08.06
mediainfo: Dolby Vision dvhe.08.06 BL+RPU HLG compatible / BT.2020 / HLG / BT.2020 non-constant / 10 / hvc1
```

**Deterministic checks (no display required):** `framemd5` identity vs stripped (SSIM 1.0) proves metadata-only ; `signalstats YMIN/YMAX/BRNG` narrow 10-bit legal `[64,940]` ; `histogram` overlay exact vs tone-map compressed >75% HLG ; `bits_per_raw_sample` / `pix_fmt` / `chroma_location` ; Resolve round-trip import `RCM BT.2100 HLG vs Rec.709` ; vectorscope hue drift >5 ΔE.

**What to fetch first (minimal viable corpus ~100 MB):** 1. EBU v210 zip (23.2 MB) + TIFF (2 MB) 2. Dolby 8.4 FHD (~15 MB) 3. Apple HLS DV manifest (playlist-only) 4. Self-capture 2 s ProRes Log + SDR (~300 MB before trim) 5. Synthesize stripped/metadata-mismatch locally. **Committed:** <5 MB manifest+scripts ; **CI-downloaded:** 40–80 MB.

*Evidence:* `07-test-corpus-and-measurement.md` Tiers 1–3 + `05` + `03` + Apple Incorporating HDR PDF + Dolby + EBU tech.ebu.ch + ITU.

---

## 11. What the Documented Resolve API Can / Cannot Automate

**Authority:** Local `Developer/Scripting/README.txt` 21.0.3 (15 Jul 2026, 1145 lines) + `Developer/Scripting/CHANGELOG.txt` (5 May 2026) + `Developer/Workflow Integrations/README.txt` (3 Oct 2024) + Sample code. Access date 2026-08-25.

### Documented Workflow Integration bridge

| Call | Signature (README:89-113) | Notes |
|---|---|---|
| `WorkflowIntegration.Initialize(pluginId):Bool` / `InitializePromise` | Must pass plugin Id from `manifest.xml` | Loads bridge node |
| `GetResolve():Resolve` / `GetResolvePromise` | Returns scripting `Resolve` object | Single access point |
| `RegisterCallback(name,func):Bool` / `DeregisterCallback` | Names limited (below) |  |
| `SetAPITimeout(secs):Bool`, `GetInfo():{version}`, `CleanUp():Bool` | Housekeeping |  |

**Callbacks supported — ONLY** `RenderStart`, `RenderStop`, `ResolveQuit` (README:115-121). **No** `MediaPoolItemAdded`, `ClipImported`, `TimelineChanged`. Implication: **no automatic trigger on iPhone import**; polling is the only (undocumented) option.

**Electron model:** Studio 19.0.2+ enforces `sandbox:true, contextIsolation:true` ; `WorkflowIntegration.node` is copied from `Help → Documentation → Developer → Workflow Integrations/Examples/SamplePlugin/` (`README:10-16`). **Plugins: Windows, Mac OS X (not Linux).**

### Documented Scripting surface

| Area | API (README line refs) | What is enumerated vs what must be discovered via snapshot |
|---|---|---|
| **Project / Timeline settings** | `Project.GetSetting(name):string / SetSetting(name,value):Bool` (195-196) ; `Timeline.GetSetting/SetSetting` (432-433) | **Only** `superScale`, `timelineFrameRate`, `timelineSampleRate` explicitly enumerated (695-709). **No** `colorScienceMode`, `isColorManaged`, `timelineColorSpace` enumerated locally. Must snapshot `GetSetting()` diff. Caveat: *“custom colorspaces in an ACES workflow … may be read only / disabled”* (683-684). |
| **Media Pool clip properties** | `MediaPoolItem.GetClipProperty(name?) / SetClipProperty(name,value):Bool` (331,333) ; `GetMetadata/type` (305-308) ; `MediaPool.ImportMedia` / `MediaStorage.AddItemListToMediaPool` | Clip Properties section **only** enumerates `Super Scale` and `Cloud Sync` (711-732). `Input Color Space`, `Gamma`, `Color Space Tag` **NOT enumerated** locally. |
| **Timeline insertion** | `MediaPool.AppendToTimeline` / `CreateTimelineFromClips` (236-241) | No `InsertVideoAtPlayhead` for video ; requires `recordFrame` trick (`transfer.ts:456-468`). |
| **Color correction levers** | `Graph.SetLUT(nodeIndex,lutPath):Bool / GetLUT / RefreshLUTList()` (584-587) ; `SetCDL` (~612+) ; `ApplyGradeFromDRX` (589-595) ; `GetNodeGraph` (541-603) | LUT requires path already discovered ; CST with params **not script-exposed** (`grep` hits only render settings). `SetClipProperty("Input Color Space",...)` **undocumented**. |
| **Render / transcode** | `Project.SetRenderSettings({ColorSpaceTag,GammaTag,...})` (850-851) | Export-time tags only. |

**What *is* controllable:** Enumerate clips/folders `GetClipList`, `GetSubFolderList` ; read/write generically `Get/SetMetadata`, `Get/SetClipProperty` (with snapshotting), `Get/SetSetting` ; apply LUT per node `GetNodeGraph → SetLUT (+RefreshLUTList)` ; manage timeline `AppendToTimeline` with `recordFrame`, `CreateTimelineFromClips` ; Deliver `SetRenderSettings` with `ColorSpaceTag/GammaTag`.

**Hard gaps — no documented API:**

1. No iPhone detection flag — HDR subtype not enumerated.
2. No Input Color Space write API documented — undocumented key, may be disabled in ACES/auto-managed (683-684).
3. No auto Color Management switch guarantee.
4. No import-hook / metadata-trigger.
5. No timeline CST injection with parameter control.
6. No Dolby Vision analysis for import correction — `Timeline.AnalyzeDolbyVision` (line 451) analyzes timeline clips post-placement (Studio), not an import fixer.

*Cross-check:* Public Resolve 20.1/19.1 scripting PDFs identical — no new HDR scripting API through 21.0 Beta (changelogs note only GenerateSpeech/audio). Absence evidence is consistent upstream.

---

## 12. Fact / Inference / Community Report — Separation & Contradictions

### How this report separates

- **Fact:** Citable primary spec (ITU, ISO/Apple QTFF, Dolby v1.3.2, Apple TN3145/Support docs), Blackmagic official PDF/Support Page/Codec List/Studio Features, or locally inspected SDK text.
- **Inference:** Interpretation that logically follows facts but requires a live test to confirm.
- **Community report:** Forum threads, blog posts, 0–1★ GitHub repos, screenshot before/after without `ffprobe` dumps. Labeled low-trust until backed by dump.

### Deduplicated contradictions (do not silently choose — state conflict + test)

| # | Contradiction | Evidence on each side | How to resolve (live test) |
|---|---|---|---|
| **C1** | **ProRes HDR/SDR/Log picker per model** — 13/14 Pro lists all three vs 16/17 Pro spec says HDR or Log only | Support 109041 vs 16/17 Pro spec page | Need live 16 Pro/17 Pro picker screenshot + `ffprobe` of ProRes HDR vs Log clips |
| **C2** | **colr fallback 9/1/9 + ATC SEI 147=18 vs always 9/18/9 for DV 8.4** | TN3145 normative 9/18/9 + `amve` vs 2019 HDR Metadata PDF v0.9 9/1/9 + ATC | Capture sweep iOS 14.1–26, dump `colr` + `hvcC` SEI via `mp4dump` + `ffprobe` |
| **C3** | **Resolve Input Color Space string** — `Rec.2020 HLG` vs `Rec.2100 HLG Scene` vs `Rec.2020 (Scene)` vs `Rec.2100 HLG Display` | Manual auto `Rec.2100 HLG` vs forum t=193594 + t=182854 vs Polo range claim | Media Pool `Input Color Space` sweep, measure waveform diffuse white ≈75% |
| **C4** | **HLG Scene (OETF) vs Display (EOTF after OOTF)** | BT.2100-2 defines both; community splits | Same sweep + exposure pull -2 stops |
| **C5** | **`amve` mandatory vs early iOS14 may lack** | TN3145 (2023) normative shall vs Dolby community note pre-amve iOS14.0 | Dump `amve` on iPhone 12 iOS14.0 captures |
| **C6** | **Apple Silicon Media Engine vs BMD doc HW accel matrix** — Free 10-bit 4:2:0 sometimes plays on Windows via Microsoft HEVC Extension | Doc “8-bit OS-supported only” vs forum 19–30% GPU reports | Windows Free vs Studio same file, measure offline vs decode, GPU load |
| **C7** | **`203 nits reference` checkbox scope** — “only for SDR→HDR” vs forum t=215516 | Manual cascade vs forum | Toggle `RCM Custom` with `DaVinci DRT` while timeline has HLG vs RAW |
| **C8** | **NCLC tagging vs actual transform** — `1-1-1` vs `1-2-1` | MingoBoon `fixes.html` vs `04` §5a | Deliver `1-1-1` vs `1-2-1`, open in QuickTime vs VLC/Firefox vs YouTube |
| **C9** | **ProRes Log exact transfer signal / colr code** | `11` gaps: `kCVImageBufferLogTransferFunctionKey appleLog` vs `colr` value | `ffprobe` + `qtffcolr` on 15 Pro vs 17 Pro Log/Log2 captures |
| **C10** | **Dolby spec availability** — archived v1.3.2 PDF vs current Dolby site 404 | `05` reports 404 on Jina 2026-08-25 | Re-fetch authenticated Dolby session or rely on archived PDF Wayback date |
| **C11** | **QTFF `colr` doc URL no longer renders** | `05` Jina 410/429 | Confirm via FFmpeg `mov.c` + CoreMedia enumerations |
| **C12** | **ffmpeg tone-map heuristics** — `npl=220` vs `peak=8` vs `libplacebo bt.2390` | bbimer vs blurridge vs libplacebo docs | Run same EBU + iPhone clip through all three, measure ΔE + `signalstats` |
| **C13** | **Shared Albums cap** — 720p ≤15 min vs iOS 27 beta full-res opt-in | Apple 108916 (2025-02-27) vs MacRumors iOS 27 beta | Re-probe Shared Albums after iOS 27 ships |
| **C14** | **VFR vs CFR** — iPhone default small VFR variations | Apple primary names Auto FPS toggle only ; Dolby community documents VFR | Record low light Auto FPS ON/OFF ; `ffprobe -show_frames | grep pkt_duration_time` |
| **C15** | **ProRes Log exposure clip point moving with ISO** | `11` §5 per Leeming/GammaTo vs Apple white paper fixed curve | Shoot Log chart at ISO 55/125/400/800/2000, measure code value |

---

## 13. Pre-Architecture Evidence Checklist (Exact Local Samples & Settings Needed Next)

This is **context collection only** — no architecture/code. The following must be captured locally **before** any implementation decision, with hashes + settings snapshots.

### A. Local environment snapshot

- [ ] `defaults read /Applications/DaVinci\ Resolve/DaVinci\ Resolve.app/Contents/Info.plist CFBundleShortVersionString` (expect `21.0.3`) + `CFBundleVersion` `21.0.30007` — run `md5 .../Info.plist` + `stat -f %m` 
- [ ] `Developer/Scripting/README.txt` first line + `wc -l` (expect `Last Updated: 15 Jul 2026`, 1145 lines) + `Workflow Integrations/README.txt` (`Updated: 3 Oct 2024`, 352 lines)
- [ ] `resolve --version` or About dialog screenshot (edition **Studio vs Free**) + `GetInfo():{version}` Bridge `21.0.3.7` (`WorkflowIntegration.node` 1,730,064 bytes)
- [ ] OS: `sw_vers` + `system_profiler SPDisplaysDataType` (macOS 15.x or Windows 11 build), GPU: Apple Silicon M1–M4 + media engine, or Nvidia model + Studio driver
- [ ] `ffmpeg -version` (≥6.0, note `libplacebo` presence), `ffprobe -version`, `mediainfo --Version`, `dovi_tool --version` (≥2.3.1), `mp4box -version`, `exiftool -ver`

### B. iPhone source clips to capture (self-captured, own copyright, ≤5 s each, SHA256, provenance log: device / iOS / Settings / transfer path)

| File | Capture settings | Expected ffprobe + box fingerprint | Resolves |
|---|---|---|---|
| `iphone12-14_084_HDR_4K60.mov` | iPhone 12/14 native Camera Video **HDR ON**, Efficient, 4K60 | `hvc1` HEVC Main10 10b 4:2:0 `9/18/9` `dvvC` profile 8 `rpu:1 el:0 compat4` `amve` | C2/C5/C14 |
| `iphone15pro_Log_4K30_prores.mov` | 15 Pro/Max ProRes Log + Blackmagic HEVC Max Log same scene | `prores apch` 10b 4:2:2 vs `hvc1` 10b 4:2:0 ; `appleLog` ext + Rec.2020 | C9 |
| `iphone17pro_Log2_4K30_prores.mov` | 17 Pro Log2 ProRes or RAW→Log2 preview | `appleLog2` + AWG | C1/C9 |
| `iphone_proResHDR_4K30.mov` | 13 Pro+ ProRes HDR 4K30 + Blackmagic `HLG10` | `prores 9/18/9` **no `dvvC`** ; `mdcv/clli`? + `amve`? | C1 |
| `iphone_cinematic_HDR_4K30.mov` | Cinematic 4K HDR 30 fps ON (14+), plus SDR OFF control | `dvvC 8.4` + depth matte | C2 |
| `iphone_SDR_1080p_H264.mov` | HDR OFF, Most Compatible H.264 8-bit | `avc1` 8b `1/1/1` no HDR | Ground truth |

For **each clip** record:
```
ffprobe -v error -select_streams v:0 -show_streams -of json clip.mov
mediainfo --Output=JSON clip.mov
mp4box -diso clip.mov 2>&1 | grep -A6 "colr|mdcv|clli|dvcC|dvvC|amve|hvcC"
exiftool -n -s -G1 -ColorSpace* -Transfer* -MasteringDisplay* clip.mov
dovi_tool info --summary -i <(ffmpeg -i clip.mov -c:v copy -bsf:v hevc_mp4toannexb -f hevc -)
```

### C. Transfer provenance pairs

- [ ] **Keep Originals pair:** Image Capture USB Keep Originals vs Automatic — `md5` + `ffprobe` + resolution
- [ ] **AirDrop pair:** modern Mac (capable) vs Windows (transcoded)
- [ ] **Photos Export pair:** Unmodified Original vs default Export
- [ ] **iCloud pair:** Unmodified Original ZIP vs Most Compatible + Shared Albums 720p
- [ ] **Document path:** WhatsApp Document vs Gallery, Telegram File vs Video

### D. Resolve local settings snapshot

- [ ] Project Settings → Color Management: `Color Science` (YRGB vs YRGB Color Managed), `Color Processing Mode` (SDR vs HDR), `Timeline Color Space`, `Output Color Space`, `Use 203 nits reference for Rec.2100 HDR`
- [ ] Scripting key discovery: `project.GetSetting()` / `clip.GetClipProperty()` with no arg before/after toggling `Input Color Space` — diff keys, record exact strings and `false` vs string
- [ ] Clip Attributes → Data Levels: `Video vs Full` + waveform black point
- [ ] Viewer/Display: `Use 10-bit precision` + `Use Mac/Windows display color management` + OS HDR flag + physical chain (XDR vs Studio Display vs DeckLink)
- [ ] Deliver page: Codec `H.264/H.265` + `Profile Main vs Main10` + `Color Space Tag / Gamma Tag` (`1-1-1` vs `1-2-1`) + `HDR10+ / Dolby Vision` + `mdcv/clli` present?

### E. Objective measurements without Resolve

- [ ] **Metadata-only vs pixel:** generate `stripped.mov` (remove RPU via `dovi_tool convert --discard`) and `retag-mismatch.mov` — verify `framemd5` / `ssim All:1.000000` vs `HDR_Format` absent
- [ ] **EBU bars ingest:** `EBU_Tech3373_HLG_Colour_Bars_as_v210_QT_v20200703.zip` (23.2 MB) + TIFF (2 MB) via `scripts/fetch-corpus.sh` ; keep `sha256` in manifest; run `signalstats YMIN/YMAX/BRNG`, `histogram`, per-patch ±2 code-value check vs Table 3 of `tech3373.pdf`
- [ ] **Tone-map KPI:** same EBU + iPhone 8.4 through `zscale npl 100/220` vs `hable peak 8` vs `libplacebo bt.2390` — record histogram + ΔE

### F. Product-flow smoke checks (reversible, do not claim success)

- [ ] **E1 inbound drop probe** `drop→File.path` + `isSafeMediaFile`
- [ ] **E2 outbound to Media Pool ; E3 to Timeline (Edit page) ; E4 macOS icon regression ; E7 multi-file ; E8 unicode path ; E6 API fallback ; E5 Free vs Studio menu**

**Deliverable of this checklist (before architecture):** One `corpus_manifest.json` (URLs/dates/sha256/expected metadata for Dolby/EBU/HLS on-demand + local clip hashes), one `resolve_settings_snapshot.md` (the §D bullets for 21.0.3 + OS/display/GPU), and a `diagnosis_run.md` showing the four-column report `nclx | VUI | dvvC/amve | RPU bl_range` for each captured clip with conflict verdicts. No conversion recipe is emitted.

*Evidence:* `06` Unknowns §11 + `07` §1–6 + `09` E1–E8 + `10` §4 probe commands + `05` §7 field checklist.


---

## 14. Source Index — Mapping of All 11 Source Reports

All 11 reports were read fully 2026-08-25. No claim of visual/live Resolve success is made.

| Source report | Filename | Primary scope | Where cited in canonical | Coverage |
|---|---|---|---|---|
| **01** | `01-resolve-sdk-capability.md` | Local 21.0.3 SDK authority | §1, §5, §8, §11, §13 | SDK paths + API names quoted verbatim |
| **02** | `02-apple-iphone-hdr-formats.md` | Apple primary capture fundamentals | §2, §3, §5 | TN3145 + HDR PDF + formats |
| **03** | `03-github-tools-and-evidence.md` | GitHub evidence map A1–A9 | §9.1 + §10 + §11 | Ranked table with URLs/licenses |
| **04** | `04-failure-taxonomy.md` | 8-failure taxonomy + CST sub-taxonomy | §2, §6 | All 8 failures mapped |
| **05** | `05-hdr-standards-and-metadata.md` | Four-layer standards model | §5 | Spec→box→RPU layers |
| **06** | `06-resolve-version-platform-matrix.md` | 18.6→21.0.4 version history + OS×capability matrix | §7 | All rows |
| **07** | `07-test-corpus-and-measurement.md` | Lawful corpus Tiers 1–3 + measurements | §10 | Dolby/EBU/HLS + synthetic |
| **08** | `08-product-landscape-and-licensing.md` | Product deep dives + licensing risk register | §9.2–9.3 | Direct competitor finding |
| **09** | `09-workflow-integration-drag-drop.md` | Bidirectional drag audit on 21.0.3 | §1, §8 | Seams + file:line evidence |
| **10** | `10-transfer-and-export-paths.md` | 24-path provenance matrix | §4 | All categories + iOS 27 caveat |
| **11** | `11-iphone-capture-mode-matrix.md` | 8-pipeline capture-mode matrix | §3 | All modes + discriminators |

**Coverage verification (read-only scan, no architecture claim):**

- `grep -r "01-resolve-sdk-capability\|02-apple-iphone" docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` → must hit 11 entries in §14.
- `grep -c "http" docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` → expect ≥30 primary URLs.
- `grep -c "dvvC\|colr\|VUI\|RPU\|amve\|mdcv\|clli" docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` → must be >20.
- `grep -i "CST\|Input Color Space\|Rec.2100\|Rec.2020"` count tracks §2/§6.
- Forbidden claim check: `grep -i "tested in Resol"+"ve|verified in Resol"+"ve|looks corr"+"ect|visually conf"+"irmed|live gra"+"de"  # broken to avoid self-match; intent: search for accidental success claims` should return 0.

*No claim of visual/live Resolve verification is present in this report.*

---

## 15. References (Primary Sources with Access Dates)

> Primary/official sources first; secondary/high-signal community labeled. Inline citations above map to these URLs. All accessed **2026-08-25** unless dated inline.

1. **Apple — TN3145 “HDR Video Metadata”** (2023-03-07, rev 2023-12-12) — https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata
2. **Apple — “Incorporating HDR Video with Dolby Vision into your apps”** PDF — https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf
3. **Apple — “High Dynamic Range Metadata for Apple Devices”** PDF v0.9 (2019-05-31) — https://developer.apple.com/av-foundation/High-Dynamic-Range-Metadata-for-Apple-Devices.pdf
4. **Apple — WWDC20 10010/10009** — https://developer.apple.com/videos/play/wwdc2020/10010/ + /10009/
5. **Apple — `AVCaptureColorSpace` / `appleLog`** — https://developer.apple.com/documentation/avfoundation/avcapturecolorspace
6. **Apple — Support 109041 “About Apple ProRes on iPhone”** — https://support.apple.com/en-us/109041
7. **Apple — Support 116944 “Using HEIF/HEVC media”** (2025-12-05) — https://support.apple.com/en-us/116944
8. **Apple — Support 111762 (2026-04-10) / 108782 (2025-12-12) / 108916 (2025-02-27) / HT201302 (2026-05-19) / 121029** — transfer paths + limits
9. **Apple — `CVImageLogTransferFunction`** — https://developer.apple.com/documentation/corevideo/cvimagelogtransferfunction
10. **Dolby — “Using an Apple iPhone 12 captured Dolby Vision content as a source”** — https://dolby.my.site.com/professionalsupport/s/article/Using-an-Apple-iPhone-12-captured-Dolby-Vision-content-as-a-source-in-a-Dolby-Vision-production
11. **Dolby — “Best Practices Create Dolby Vision Profile 8.4 using DaVinci Resolve”** (2026-01-08)
12. **Dolby — Vision Profiles & Levels v1.3.2 (2019-09-16) PDF** — https://professional.dolby.com/siteassets/content-creation/dolby-vision-for-content-creators/dolbyvisionprofileslevels_v1_3_2_2019_09_16.pdf (archived via Wayback; Dolby site 404 on 2026-08-25)
13. **FFmpeg — `libavutil/pixfmt.h:642-706`, `cbs_h265`, `mov.c:2202,6928,7009,9075`, `dovi_meta.h:30-60`** — https://github.com/FFmpeg/FFmpeg
14. **ExifTool — `QuickTime.pm:503,2993,7653`** — https://github.com/exiftool/exiftool
15. **Blackmagic — Resolve 18.6 New Features Guide** — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_18.6_New_Features_Guide.pdf
16. **Blackmagic — Resolve 19 New Features Guide** — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_New_Features_Guide.pdf
17. **Blackmagic — Resolve 19 Supported Codec List (Aug 2024)** — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_Supported_Codec_List.pdf
18. **Blackmagic — Studio Features PDF v20 (2025-01-27)** — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_Studio_20_Features.pdf
19. **Blackmagic — Support Family Page (live 2026-08-05)** — https://www.blackmagicdesign.com/support/family/davinci-resolve-and-fusion
20. **Blackmagic — Resolve 20.2 New Features Guide** — https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.2_New_Features_Guide.pdf
21. **Blackmagic — Local SDK `Developer/Scripting/README.txt` (15 Jul 2026) + `CHANGELOG.txt` (5 May 2026) + `Developer/Workflow Integrations/README.txt` (3 Oct 2024)** — `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/` (inspected 2026-08-25)
22. **ITU — BT.2100-2 (2018-07) + BT.2020-2 / BT.709-6** — https://www.itu.int/rec/R-REC-BT.2100/en
23. **GitHub — `quietvoid/dovi_tool` (2.3.3, 2026-07-12, 1005★)** — https://github.com/quietvoid/dovi_tool
24. **GitHub — `FFmpeg/FFmpeg` (63617★), `MediaArea/MediaInfo` (1999★), `Bento4` (2493★), `gpac/gpac` (3296★)** — see §9 URLs
25. **EBU — Tech 3373 + `tech3373-v210` QT v210 (2020-07-03) + `tech3373.pdf`** — https://tech.ebu.ch/publications/tech3373
26. **Dolby — Developer `developer.dolby.com/tools-media/sample-media/video-streams/dolby-vision-streams` + `dlb_mp4base` (BSD-3)** — https://github.com/DolbyLaboratories/dlb_mp4base

**Secondary/high-signal community (explicitly labeled, not authoritative):**

- Blackmagic Forum t=182854, t=215217, t=186893, t=173188, t=193594 — https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=182854 etc.
- PostProcess “Color Shift Fixes” (2020-03-16) & “Consistent Color” (2020-07-17) — https://www.thepostprocess.com
- Rodrigo Polo “iPhone HDR video in Resolve the right way!” (2025-11-20) — https://rodrigopolo.com/2025/11/20/iphone-hdr-video-in-resolve-the-right-way/
- MingoBoon `fixes.html` — https://github.com/MingoBoon/resolve-color-management-toolkit
- Gamut “Apple Log vs Apple Log 2” — https://gamut.io/apple-log-vs-apple-log-2-whats-actually-different/ + OCIO #163 — https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/issues/163

---

**End of canonical report.** *No architecture, codec recipe, LUT path, pricing, or live Resolve success is asserted. All claims are evidence-cited and bounded by the contradictions in §12 that require the live captures in §13 before any implementation.*
