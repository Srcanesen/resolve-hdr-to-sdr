# Landscape: Fix / Normalize / Transcode / Tag / Monitor iPhone HDR for DaVinci Resolve

**Date:** 2026-08-25 (all URLs accessed 2026-08-25)
**Scope:** Read-only survey of official docs, repos, licenses, high-signal issues. No install, no purchase, no architecture pick.
**iPhone HDR baseline (fact):** iPhone 12+ captures HEVC Main10 .mov, Dolby Vision Profile 8.4 — cross-compatible HLG (BT.2020, 10-bit, 4:2:0) base layer + per-frame RPU dynamic metadata (Dolby and Apple docs). Decode as HLG on non-DV decoders; DV decoders apply RPU. See Dolby "How to Work With Dolby Vision Sources Captured by the Apple iPhone" and Apple PDF.

## 1. Product / Workflow Deep Dives

### 1.1 Color Finale Transcoder 2
- What: Standalone macOS app + FCP extension for camera RAW (CRM, BRAW, N-RAW, ARRI RAW, Canon CRM) — NOT iPhone HDR fixer. "get missing raw formats into FCP".
- Metadata: No DV RPU editor. Color-space choice Rec.709 / Rec.2020 PQ / HLG / Log-C/BMD Film/Custom — user selects.
- HLG/PQ/DV: Supports RAW->PQ/HLG; docs note HDR->SDR requires FCP HDR Tools if timeline Rec.709. No RPU handling.
- Tone mapping: Delegates to FCP HDR Tools / LUTs.
- ProRes: All flavors Proxy->4444 XQ, GPU.
- Batch/watch: Queue panel: right-click -> Queue for Transcoding -> target folder + progress; no watch daemon.
- Resolve: None native. Standalone "any NLE that supports ProRes" — manual import.
- Pricing/platform: $179 standalone; Ultimate Bundle $350.99; upgrade $53.70 (70% off). 2 Macs, 7-day trial watermarked. macOS 13-15, Intel/Apple Silicon, FCP 10.7+/11. Annual support $59 after year 1 (Jan 1 2024).
- Limitations: macOS-only, per-machine online check, no iPhone HEVC focus, no RPU.
- Sources: colorfinale.com/transcoder, docs.colorfinaletranscoder.com, colorfinale.com/store/upgrade/renew

### 1.2 EditReady (Hedge)
- What: General mezzanine transcoder (MOV/MXF/MP4 + Sony/RED/BRAW/ProRes RAW/ARRI/Canon RAW). Uses vendor SDKs.
- Metadata: View/edit metadata, burn-in overlays, ALE export, LUT preview, ScopeBox link. Color Awareness: output Rec.709 SDR vs PQ/HLG HDR or vendor log.
- HLG/PQ/DV: Rec.709/PQ/HLG auto per blog 22.2; no RPU inject.
- Tone mapping: Implicit via color pipeline + LUTs.
- ProRes: ProRes 422/HQ/LT/Proxy/4444, DNxHD/HR, H.264/H.265, passthrough.
- Batch/watch: Queue batch, Recreate Source Folders, parallel. Automation API + scripting Pro-only; URL scheme replaces CLI (Server-only). No watch-folder in Standard.
- Resolve: None native — mezzanine import.
- Pricing/platform: $99/$149/$999 tiers per site; Standard vs Pro: non-RAW both, RAW+automation Pro only. Free Pro upgrade 2022. 1y updates. macOS only. Hedge License Manager shared.
- Limitations: macOS-only; Pro for RAW+scripting; no DV RPU.
- Sources: hedge.co/products/editready, docs.hedge.video/editready, hedge.co/blog/editready22-2

### 1.3 Shutter Encoder (Paul Pacifico)
- What: Free GPL-3.0 GUI over FFmpeg — general transcoder.
- Metadata: Exposes FFmpeg flags; colorspace checkbox sets -color_primaries etc. Issue #250 regression FFmpeg 7.1 vs 7.0.2.
- HLG/PQ/DV: Convert colorspace via ffmpeg filter; HDR->SDR uses LUT per docs. Supports H.265/ProRes/DNxHR/AV1. No RPU extract/inject; DV copy-only (-c:v copy).
- Tone mapping: FFmpeg filters + LUT.
- ProRes: ProRes/DNxHR/CineForm/Animation/uncompressed.
- Batch/watch: Queue batch; vanilla no watch daemon (fork XonistReal adds it).
- Resolve: None native; Avid recommends for MC/Pro Tools ingest.
- Pricing/platform: Free donationware, no Pro tier. GPL-3.0. Win/Mac/Linux, 3.5M+ downloads. 2.6k stars, 226 issues.
- Limitations: Single maintainer; GPL-3 if redistributed; colorspace flag bugs; no RPU.
- Sources: shutterencoder.com, github.com/paulpacifico/shutter-encoder

### 1.4 ffmpeg / libplacebo / zscale stack
- What: Engine underneath Shutter, HandBrake, davinci-kit, Recoder, custom scripts.
- Metadata: ffprobe/mediainfo read color_primaries/transfer/matrix/Mastering/MaxCLL/FALL. Rewrite via -colorspace/bt709 -bsf:v hevc_mp4toannexb.
- HLG/PQ/DV: Decodes HLG/PQ HEVC. DV RPU decode exists libavcodec/dovi_rpu.c LGPL-2.1+ (influenced by dovi_tool, merged Jan 2022). Can copy DV (-c:v copy -strict unofficial -tag:v hvc1) but cannot generate dvcC/dvvC boxes when re-encoding — needs dovi_tool + dlb_mp4base. Phoronix notes incomplete.
- Tone mapping: Built-in tonemap (hable/mobius legacy per libplacebo, reinhard, clip, linear) + zscale linear pipeline; advanced libplacebo bt.2390/bt.2446a/hable + gamut_mode=perceptual (Vulkan, FFmpeg built with libplacebo).
  Example: zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p
  libplacebo: hwupload,libplacebo=tonemapping=bt.2390:colorspace=bt709:format=yuv420p10le,hwdownload
- ProRes: prores_ks/prores_aw (-c:v prores_ks -profile:v lt|hq|4444 -pix_fmt yuv422p10le), DNxHR. Unauthorized per Apple white paper (not on Authorized Products list).
- Batch/watch: DIY shell/parallel/inotifywait. No daemon.
- Resolve: Importable MOV/MP4; range mismatch trap (full vs legal).
- Pricing/platform: Free LGPL-2.1+ default, GPL-2+ if --enable-gpl (libx264/x265). Cross-platform.
- Limitations: Must pick npl/peak; libplacebo not in default builds; full-range iPhone not auto-detected; no DV generation.
- Sources: ffmpeg.org/legal, libplacebo.org/options, mpegflow.com, github.com/bbimer/iphone-hdr-to-sdr-ffmpeg, FFmpeg dovi_rpu.c

### 1.5 dovi_tool + libdovi (quietvoid)
- What: Rust CLI + dolby_vision crate / C libdovi for RPU lifecycle. MIT, 992 stars, 55 releases latest 2.3.1 2025-08-22, Rust 1.88+.
- Metadata: info (summary/per-frame JSON), export, plot, editor, generate from Dolby CMv2.9/CMv4.0 XML, generic JSON, HDR10+ JSON, madVR.
- HLG/PQ/DV: Core DV primitive: extract-rpu, inject-rpu, convert modes 0-5 (MEL, 8.1, 8.4), demux/mux/remove for single/dual-layer HEVC. Profiles 4/5/7/8. iPhone 8.4 preservation: extract-rpu -> re-encode -> inject-rpu -> mp4muxer.
- Sources: github.com/quietvoid/dovi_tool (README, discussions #78 #102)

### 1.6 hdrprobe (matthane)
- What: Single native binary inspector — consolidates mediainfo+ffprobe+dovi_tool+hdr10plus_tool, memory-maps, parallel seek, flat cost, no temp files. In-process RPU via libdovi.
- Metadata: Inspection only — reports HDR format, mastering DCI-P3, MaxCLL/FALL, DV structure/profile (7.6 FEL), CM v4.0, trim targets, L5 offsets/active area. Supports video + sidecars (RPU .bin, CM XML, HDR10+ JSON). JSON/NDJSON. No rewrite.
- Sources: github.com/matthane/hdrprobe

### 1.7 Dolby Professional Tools + dlb_mp4base
- Prof Tools: Free CLI suite (Metafier, CM Offline, Mezzinator, CM_Analyze). CM_Analyze auto-generates DV from PQ/HDR10 (long-play per-frame, shot-based). Requires HLG->PQ first per Dolby. Mac/Win/Linux via Dolby Customer portal.
- Trim license: $1,000 perpetual, per facility (unlocks 21 primary + 6-vector secondary trims in partner grading systems). Without license base DV + auto analysis works.
- dlb_mp4base/mp4muxer: Reference MP4 muxer for dvcC/dvvC, AC-3/E-AC-3/AC-4 + DV. BSD-3-Clause. Needed because FFmpeg cannot generate DV boxes on re-encode. Step 5 in ios-media-toolkit 6-step.
- Compatibility: Blackmagic Resolve, Autodesk Flame, Filmlight etc.
- Sources: professional.dolby.com, dolby.my.site.com, github.com/DolbyLaboratories/dlb_mp4base

### 1.8 iPhone wrappers
- bbimer/iphone-hdr-to-sdr: Windows .bat for iPhone 15/16 Pro Max 4K60 DV8.4/HLG to Rec709 SDR via libplacebo mobius perceptual -> ProRes 422 LT or HEVC 10-bit hvc1. Drag-drop, fallback zscale npl 220, CRF16.
- ios-media-toolkit: Python CLI + Docker DV preservation 6-step: extract HEVC, extract RPU dovi_tool, re-encode x265/NVENC, inject RPU, mux mp4muxer, add audio. Batch album, SHA256 skip, verify hvc1/dvcC.
- Rodrigo Polo LUT 2025-11-20: Full-range 0-255 vs legal 16-235 fix, DaVinci YRGB Rec709-A timeline, LUT per clip.

### 1.9 Resolve native helpers
- Resolve Studio: Auto Rec2100 HLG Input, YRGB Color Managed, Output HDR HLG or Rec709-A. Dolby Vision checkbox off for iPhone per Dolby. Free limits 4K UHD export, no scopes.
- davinci-kit: Linux DNxHR/AV1 transcode, watch-folder inotifywait, ffprobe inspector, GPU NVENC/AMF/QSV.
- batch-codec-converter: Tauri Rust FFmpeg, fixes Media Offline, DNxHR/ProRes, watch folder, LUT bake.
- Recoder: GTK batch transcoder DNxHD for Resolve.
## 2. Comparison Matrix

| Product | Metadata inspect/rewrite | HLG/PQ/DV RPU | Tone mapping | ProRes | Batch/Watch | Resolve | Pricing/Platform | Limitations |
|---|---|---|---|---|---|---|---:|---|
| Color Finale Transcoder 2 | Choose output CS; no RPU | HLG&PQ RAW->HDR, no RPU | FCP HDR Tools | Proxy->4444 XQ GPU | Queue batch, no watch | FCP plugins + standalone | $179 2 Macs, bundle $350.99, trial, macOS | macOS-only, FCP-centric, no iPhone HEVC |
| EditReady Hedge | Edit metadata, burn-in, ALE, LUT | Rec709<>PQ<>HLG auto; no RPU | Color Awareness + LUTs | ProRes/DNxHR/H264/H265 | Batch parallel; API Pro | None native mezzanine | $99/$149/$999 tiers, Standard vs Pro macOS | macOS-only; RAW+script Pro only |
| Shutter Encoder | FFmpeg flags via GUI | HLG/PQ checkbox; DV copy-only | LUT + ffmpeg filters | ProRes/DNxHR/CineForm | Queue batch; no watch | None file import | Free GPL-3 Win/Mac/Linux | Single dev; flag regressions |
| ffmpeg+libplacebo | ffprobe read; ffmpeg write | HLG/PQ decode; DV RPU decode no box gen | tonemap hable/mobius / libplacebo bt2390 | prores_ks unauthorized + DNxHR | Shell/parallel/inotify | File import; range trap | Free LGPL/GPL cross-platform | Needs flags; libplacebo not default |
| dovi_tool libdovi | info/export/plot/editor/generate | Full RPU extract/inject/convert p4/5/7/8 | RPU trim only | No | CLI scriptable | Supplies RPU | MIT free cross-platform | RPU only needs mp4muxer |
| hdrprobe | Inspection only unified JSON | Reports profile/CM/L5/trims | No | No | Single/bulk NDJSON | Preflight | Free native binary | Read-only |
| Dolby Tools dlb_mp4base | Metafier validate, CM_Analyze gen PQ | DV gen from PQ HLG->PQ; mp4muxer dvcC | CM Offline | No MXF | CLI batch | Resolve/Flame plugins | Tools free trim $1k/facility BSD-3 | PQ prereq |
| ios-media-toolkit | exiftool verify hvc1/dvcC | Preserves DV8.4 dovi+mp4muxer | No preserves HDR | No HEVC | Album SHA256 Docker | Correct iPhone tags | Free Python Docker | RPU invalid if scene changes |
| bbimer iphone-hdr-to-sdr | Tag hvc1 | HLG/DV8.4 in Rec709 out | libplacebo mobius perceptual | ProRes LT + HEVC | Drag-drop .bat | AE/Premiere/Resolve SDR | Free Windows Gyan FFmpeg | Windows only |
| Resolve native | Auto Rec2100 HLG | HLG correct DV as HLG base | CST HDR Primary 1000-nit | ProRes decode/encode Studio | Media Pool queue | Native | Studio $295 Free limited | SDR monitor wrong w/o LUT |
| davinci-kit etc | ffprobe inspector | HLG/PQ via transcode no RPU | LUT bake | DNxHR/ProRes/AV1 | Watch inotify/Tauri | Fixes Media Offline | Free OSS GPL/MIT | Linux focus no DV |

## 3. Direct Competitor Finding
No turnkey commercial product markets itself as iPhone HDR fixer for Resolve. All commercial transcoders are general RAW/mezzanine converters.
Closest are open-source compositions:
- ios-media-toolkit — DV preservation + tag + batch + verify. MIT Docker.
- bbimer iphone-hdr-to-sdr — HDR to SDR tonemap to ProRes for SDR timelines Windows.
- hdrprobe — monitor/inspect unified DV report.
Only productized SDR fix without transcode is Rodrigo Polo LUT full-range fix.
## 4. Licensing Risk Register (not legal advice)

| Area | Cited terms | Risk if ship binaries |
|---|---|---|
| Dolby Vision | Prof Tools free; trim $1k facility. dovi_tool MIT not authorized. dlb_mp4base BSD-3 no patent grant. WO2017079132A1. | Creating RPU or claiming certified may need license. |
| HEVC | Via LA, Access Advance 27k patents, 25pct increase Jan 2026, past 2030. | Distributing encoder/decoder in binary enforces pools. SaaS avoids distributor. |
| x264 x265 | GPL-2, --enable-gpl makes FFmpeg GPL requires source. | Shipping libx264/x265 triggers GPL disclosure. Use OpenH264. |
| FFmpeg | LGPL-2.1 default, no gpl/nonfree, dynamic, attribution. | Stay LGPL --disable-nonfree --enable-shared. brew/apt is GPL dont redistribute. |
| ProRes | Apple proprietary authorized only, FFmpeg unauthorized, list support.apple.com/118584. | FFmpeg prores_ks risks trademark. License SDK or use DNxHR. |
| Other | libplacebo permissive, hdrprobe MIT, Shutter GPL-3, Color Finale 2 activations. | GPL-3 copyleft prefer MIT/BSD. |
## 5. User Limitations
- Resolve washed-out BMD 182854: HLG legal vs iPhone full-range needs LUT/CST/SDR monitor XDR.
- Premiere at time no HEVC HLG per Dolby doc.
- Shutter Issue 250 ffmpeg 7.1 broke transfer write.
- DV badge loss vanilla ffmpeg shows HDR not DV needs dvcC + hvc1.
- hvc1 vs hev1 HandBrake 1128 iOS requires hvc1.
- iPhone no ProRes RAW; ProRes Log external USB-C Pro Max only.

## 6. Gaps
- No commercial RPU rewrite 8.4 to PQ; all HLG passthrough.
- EditReady pricing rate-limit confirm at hedge.co.
- Shutter libplacebo varies per OS.
- Dolby trim $1k ISV vs facility confirm customer.dolby.com

## 7. Sources
1 Dolby iPhone DV https://dolby.my.site.com/professionalsupport/s/article/Using-an-Apple-iPhone-12-captured-Dolby-Vision-content-as-a-source-in-a-Dolby-Vision-production
2 Apple DV PDF https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf
3 FFmpeg legal https://www.ffmpeg.org/legal.html
4 dovi_tool https://github.com/quietvoid/dovi_tool
5 dlb_mp4base https://github.com/DolbyLaboratories/dlb_mp4base
6 Color Finale https://colorfinale.com/transcoder
7 Hedge https://hedge.co/products/editready
8 Shutter https://www.shutterencoder.com
9 Apple ProRes https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf
10 Rodrigo Polo https://rodrigopolo.com/2025/11/20/iphone-hdr-video-in-resolve-the-right-way/
11 BMD Forum https://forum.blackmagicdesign.com/viewtopic.php?f=33&t=182854
12 iOS toolkit https://github.com/jgorostegui/ios-media-toolkit

## 8. Implication
Inspect solved hdrprobe+ffprobe, transcode split preserve DV vs normalize SDR, monitor Resolve-native. Shipping binaries must use LGPL/MIT/BSD-3 to avoid GPL and HEVC/ProRes entanglements; DV cert orthogonal.

Report read-only 2026-08-25 re-verify before quoting.
