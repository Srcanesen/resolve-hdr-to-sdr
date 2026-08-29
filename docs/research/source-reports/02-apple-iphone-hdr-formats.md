# iPhone HDR Video — Apple Official Technical Documentation Research
**Access Date:** 2026-08-25 | **Context:** DaVinci Resolve ingestion | **Scope:** Primary Apple sources only

## 1. Capture Fundamentals — Official

**Dolby Vision Profile:** iPhone 12+ (iOS 14.1+) captures HDR as **Dolby Vision Profile 8, Cross-compatibility ID 4 (HLG)** — HEVC Main10 10-bit, 4:2:0, QuickTime .mov, backward-compatible HLG base layer. Official in [Incorporating HDR PDF](https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf) and [TN3145](https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata). Dolby Vision 8.4-capable decoders decode DV + per-frame dynamic metadata; legacy HEVC decoders decode HLG.

**Revision note:** 2019 PDF *High Dynamic Range Metadata for Apple Devices* v0.9 claimed “Only Profile 5 supported” (dvh1/dvcC, colr 2/2/2). Superseded by TN3145 (2023-03-07, rev 2023-12-12) normative for **Profile 8.4** (hvc1/dvvC, colr 9/18/9 + amve). Resolve must handle both eras.

**HDR10/HLG alternatives:** AVFoundation also supports HDR10 (PQ) and HLG as mezzanine formats (WWDC20 10010). Camera app default is DV 8.4; HLG/PQ appear via composition or ProRes workflows. H.264 presets **always convert HDR→SDR** by design.

**Container:** QTFF `hvcC` required; DV layer in `dvvC` (TN3145) / `dvcC` (2019). `hvc1` canonical for 8.4; `dvh1` not used for iPhone capture. Track flag: `AVMediaCharacteristicContainsHDRVideo`.

**Color tags (colr nclc, QT indices):**
- DV 8.4: 9 (BT.2020) / 18 (HLG BT.2100) / 9 (BT.2020) + `amve` — TN3145
- HLG: 9/18/9; legacy HEVC fallback 9/1/9 + ATC SEI 147 value 18 in hvcC (any ATC outside hvcC ignored) — 2019 PDF p8
- HDR10: 9/16 (PQ ST2084)/9 + mdcv+clli (required ProRes, recommended HEVC; else SEI) — 2019 PDF p6
- SDR: 1/1/1
- DV Profile 5 legacy: 2/2/2 single-track dvh1 — 2019 PDF p4

**HEVC:** Main10 Profile, 10-bit pixel format `kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange` (x420) cited across PDFs.

**amve (Ambient Viewing Environment):** Box `amve` (`ambient_illuminance` u32 + x/y u16) = ISO/IEC 23008-2 SEI D.2.39. **Mandatory** for DV 8.4 per TN3145; present in iPhone 12+ captures (kCMFormatDescriptionExtension_AmbientViewingEnvironment). Must preserve on transcode — stripping causes extra-bright EDR rendering. AVPlayer auto tone-maps; AVSampleBufferDisplayLayer/VTDecompressionSession callers must propagate.

**Apple Log / Log 2:** BT.2020 primaries + Apple-defined Log curve (not HLG/PQ). `AVCaptureColorSpace.appleLog` / `HLG_BT2020`. Requires **iPhone 15 Pro+**, HEVC or ProRes encoding. Detect via `AVCaptureDevice.Format.supportedColorSpaces` contains `.appleLog` — not model string. [AVCaptureColorSpace](https://developer.apple.com/documentation/avfoundation/avcapturecolorspace) + [appleLog](https://developer.apple.com/documentation/avfoundation/avcapturecolorspace/applelog) + [Final Cut Camera Log](https://support.apple.com/guide/final-cut-camera/about-standard-log-and-raw-video-dev8637f6692/ios)

**ProRes / ProRes RAW:** 13 Pro+ ProRes SDR/HDR/Log (docs conflict: 13/14 Pro list all three, 16/17 Pro spec says HDR or Log). ProRes RAW 17 Pro+ (15 Pro via Final Cut Camera) Open Gate 4224x3024, external SSD required for sustained 4K60/120, Preview LUT Apple Log 2→HLG. [About ProRes](https://support.apple.com/en-us/109041) + [Record ProRes RAW](https://support.apple.com/guide/final-cut-camera/record-video-in-final-cut-camera-dev6b8c9521d/ios)

**Photos/AVFoundation export:** Toggle `Settings>Camera>Record Video>HDR Video`. iCloud Photos preserves original; AirDrop/Messages/Mail auto-transcode to JPEG/H.264 if receiver lacks HEIF/HEVC; USB Import `Automatic` may convert, `Keep Originals` preserves HEVC. [Using HEIF/HEVC](https://support.apple.com/en-us/116944). AVAssetExportSession HEVC presets preserve HDR (match source, HLG>PQ priority); H.264 converts to SDR. AVAssetWriter to preserve DV 8.4 must set `hevc + HEVC_Main10_AutoLevel + ITU_R_2020/HLG/ITU_R_2020 + kVTCompressionPropertyKey_HDRMetadataInsertionMode=Auto + 10-bit`. HDR→SDR requires explicit Bt.709 + 8-bit before/during 10→8 conversion to avoid banding — AVFoundation tone-maps automatically.

**SDR/EDR display:** HLG backward-compatible — SDR decoders clip >100 nits. EDR ranges: HLG 0–12 (ref white 1.0), PQ 0–100 (10000 nits), SDR 0–1. HDR→SDR server-side without AVFoundation risks wrong look.

**VFR note:** iPhone default is VFR (small ongoing variations + Auto FPS toggle drops to 24fps in low light). May break CFR NLEs; documented via Dolby community, not named in Apple primary capture guide — flag as community-corroborated.

## 2. Uncertainties / Variances

| Claim | Certainty | Why |
|-------|-----------|-----|
| Always 8.4 HLG | High default, uncertain for third-party apps bypassing Camera framework | May emit plain HLG/SDR |
| colr always 9/18/9 | High per TN3145; fallback 9/1/9 legacy path unclear which iOS emits | Needs sample sweep iOS14–26 |
| amve always present | Normative per TN3145 but early iOS14.0 may lack | Only codified 2023 |
| ProRes HDR/Log per model | Conflicting Apple pages (109041 vs spec) | Generation matrix ambiguous |
| Photos SDR downconvert algorithm | Official behavior, opaque mapping | No numeric spec |
| VFR default | High confidence, not Apple-primary named | Only Auto FPS toggle exposed |

## 3. Metadata Inspection Checklist

**A. Container/Codec:**
- [ ] .mov QTFF, `codec_tag` hvc1 (8.4) vs dvh1 (Profile 5 legacy) vs hev1
- [ ] HEVC Main10, 10-bit, 4:2:0 (`yuv420p10le` / x420 / p010)
- [ ] `dvvC` (8.4) vs `dvcC` (5) — MediaInfo HDR format / ffprobe side_data DOVI
- [ ] ATC SEI 147=18 only if colr 9/1/9 case
- [ ] `amve` presence (mp4dump / AVFoundation), not visible in ffprobe
- [ ] HDR10 only: mdcv/clli or SEI

**B. Color (colr/VUI):**
- [ ] primaries 9 BT.2020 (2 if Profile 5 legacy)
- [ ] transfer 18 HLG / 16 PQ / 1 BT.709 fallback / 2 Unspecified
- [ ] matrix 9 BT.2020 (1 for SDR)
- [ ] VUI matches colr; mismatch → Resolve mis-tag risk
- [ ] Apple Log: transfer = Apple Log/Log2, primaries 9

**C. One-liners:**
```
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,codec_tag_string,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,color_primaries,color_transfer,color_space -of default=nw=1 file.mov
mediainfo file.mov
mediainfo --Details=1 file.mov | grep -E "colr|nclc|hvcC|dvvC|dvcC|amve|mdcv|clli|Transfer|primaries"
mp4dump file.mov | grep -A2 -E "colr|amve|dvvC|dvcC|hvcC"
```

**D. Resolve triage:** hvc1+9/18/9+dvvC+yuv420p10le → input Rec.2020 HLG / DV 8.4 HLG; 2/2/2+dvh1 → legacy P5; 9/1/9+ATC18 → fallback HLG; 8-bit/1/1/1 H.264 → SDR transcode; Apple Log flat → apply Apple Log→709 or Log→2020 LUT.

## 4. Primary Sources
1. TN3145 — https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata (2023-03-07, rev 2023-12-12)
2. Incorporating HDR PDF — https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf
3. HDR Metadata PDF v0.9 — https://developer.apple.com/av-foundation/High-Dynamic-Range-Metadata-for-Apple-Devices.pdf (2019-05-31)
4. WWDC20 10010/10009 — https://developer.apple.com/videos/play/wwdc2020/10010/ + /10009/
5. AVCaptureColorSpace — https://developer.apple.com/documentation/avfoundation/avcapturecolorspace + appleLog subpage
6. Tagging media color — https://developer.apple.com/documentation/avfoundation/tagging-media-with-video-color-information
7. About ProRes — https://support.apple.com/en-us/109041 + ProRes RAW white paper
8. Using HEIF/HEVC — https://support.apple.com/en-us/116944
9. HLS Spec — https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices + appendixes

## 5. Implication
Anchor ingestion to TN3145 fingerprint (hvc1+dvvC+9/18/9+amve+Main10); treat 9/1/9+ATC18 as alias; gate Apple Log on transfer key not model; preserve amve; treat H.264 as intentional SDR.

## 6. Risks
Pre-amve iOS14 files, Log/ProRes RAW tagging variance, VFR community-only documentation, duplicate SDR transcodes via Photos sharing.
