# DaVinci Resolve iPhone HDR Compatibility Matrix — 18.6 to 21.0.4

**Scope:** Decode, color management, Dolby Vision grading, display monitoring boundaries affecting iPhone HDR (HLG / Dolby Vision Profile 8.4). Read-only official docs primary; forum claims labeled separately.

**Date compiled:** 2026-08-25. Current shipping: Resolve 21.0.4 (2026-08-05), Resolve Studio 21.0.4, Resolve 20.3.3/Studio 20.3.3 maintenance branch.

---
## 1. iPhone HDR Format Primer (Primary: Apple)

**iPhone capture since iPhone 12 is HEVC Main10 10-bit 4:2:0 in QuickTime .mov, Dolby Vision Profile 8.4 with HLG-compatible base layer** — Dolby Professional Support article: Codec/Format HEVC Main10 video in Apple Quicktime container (.mov) — HDR format Dolby Vision with HLG base layer (Profile 8.4) — Transfer HLG (BT.2100-1) — Primaries BT.2020 — Chroma 4:2:0 — 10-bit. Apple TN3145 + AvFoundation doc confirm:

> TN3145: "Dolby Vision Profile 8.4 — codec type shall be hvc1 — HEVC shall be encoded at Main10 Profile — Only Single-track files — Dolby Decoder Configuration Record (dvvC) shall be present — colr atom: Primaries 9 (BT.2020), Transfer 18 (BT.2100 HLG), Matrix 9 (BT.2020) — ambient viewing environment atom (amve) shall be present."
> Incorporating HDR PDF: "HDR video recorded with Dolby Vision is in Dolby Vision Profile 8, Cross compatibility ID 4 (HLG) format... designed to be backwards compatible with HLG, as it allows existing HEVC decoders to decode as HLG. The codec type is HEVC (10-bit). Dolby Vision 8.4-capable decoders decode as Dolby Vision and there is additional per-frame metadata."

**HLG vs PQ:** HLG uses nclc 9-18-9 (or legacy 9-1-9 with ATC SEI 18); HDR10 uses 9-16-9; Dolby Vision Profile 5 uses dvh1 + unspecified 2-2-2. Apple notes: kCMFormatDescriptionExtension_AmbientViewingEnvironment must be preserved or video appears "extra bright"; AVPlayer tone-maps automatically, AVSampleBufferDisplayLayer/VTDecompressionSession must propagate ambientViewingEnvironment.

**Confidence:** High — Apple primary docs.

---
## 2. Compatibility Matrix (Condensed)

Legend: Y=Supported/documented, ~=Limited/conditional, X=Not supported, F=Forum-reported. Confidence in parentheses.

| Axis | macOS (Intel / Apple Silicon) | Windows 10/11 | Linux (Rocky 8.6 CUDA) |
|---|---|---|---|
| H.265 10-bit Main10 4:2:0 decode (iPhone .mov) — Free | Y Yes, GPU accelerated (both editions). Codec list: H.265 ... Yes, GPU accelerated for macOS (High) | ~ 8-bit OS-supported profiles. More profiles + GPU in Studio. In practice 10-bit 4:2:0 often decodes via OS (slow/no HW) or shows offline/glitches; 4:2:2 consistently offline in Free (Med-High) | X Studio Only (GPU accelerated on Nvidia). Free = audio only / offline (High) |
| H.265 10-bit decode — Studio | Y Yes GPU accelerated, uses Apple VideoToolbox / Media Engine automatically via OS (High) | Y More profiles + GPU acceleration unlocked. HW decode requires supported Nvidia/Intel GPU (High) | Y Studio Only, Nvidia GPU accelerated (High) |
| H.265 Main10 encode | Y Studio (HW on Intel + Apple Silicon M1+). Free: 8-bit only. 16.2.2+ added HW Main10 on Mac; 17.4.4 added Main10 on Apple Silicon Studio (High) | ~ Studio: Main10 requires adequate Nvidia GPU; Free: Main only (8-bit). 19.1 added Ability to encode H.265 Main10 formats on Windows (Med-High) | Y Studio + Nvidia GPU accelerated (High) |
| HDR grading base (RCM PQ/HLG, HDR palette, DWG Intermediate) | Y Free + Studio (High) | Y Same (High) | Y Same (High) |
| Professional HDR scopes (full ST.2084/HLG nit precision) | Studio only (High — Studio Features PDF: Support for HDR video scopes Studio) | Studio only (High) | Studio only |
| Dolby Vision grading/render (L1 analysis, CMU, trim) | Studio + separate Dolby license for advanced trims. Free = limited tonemapping only (High) | Same | Same (Studio Limited on Linux) |
| HDR10+ dynamic metadata | Studio (High) | Studio | Studio |
| HDR Vivid (China CUVA) | Studio (High) | Studio | Studio |
| Plain HDR10/HLG export with static metadata (mdcv/clli) | Y Free + Studio (High) | Y Free + Studio (but pre-21.0.1 HDR metadata flagged incorrectly — required patching; fixed 21.0.1) | Y Studio-mediated |
| HDR viewer on GUI (no DeckLink) | Y macOS 10.14.6+ with Use Mac display color profiles for viewers + Use 10-bit precision if available + Display HDR on viewers if available + HDR Video (P3-ST2084) profile. Works on XDR/MacBook HDR (High) | Y Since 19.0: Support for HDR Displays on Windows — requires HDR-capable display + Windows HDR ON + Use 10-bit precision in viewers if available + Use Windows display color management and HDR for viewers. Single output to all viewers; SDR monitors look wrong when enabled (Med-High) | X Not documented for GUI; DeckLink required (High) |
| HDR monitoring via DeckLink/UltraStudio | Y Required for professional HDR. Manual: ST.2084 signals appear log-like; display normalizes (High) | Y Same — UltraStudio 4K Extreme / DeckLink 8K/4K 12G cited; Intensity Pro 4K = Rec.601/709 only, no HDR (High) | Y Same |
| iPhone-specific decode (Cinematic mode, Dolby 8.4 dvvC/amve) | Y 19.0 added Support for decoding cinematic clips captured by iPhone (High) — HLG base layer always decodes; Dolby metadata requires Studio CMU | ~ Same decode; no extra iPhone path on Windows except OS HEVC extension hack (Low, forum-only) | ~ Same |

---
## 3. Edition Boundary: Studio vs Free (Official)

**Source:** Blackmagic DaVinci_Resolve_Studio_20_Features.pdf + products/davinciresolve/studio + Codec List Aug 2024.

- Free: "Virtually all 8-bit formats up to UHD 3840x2160 60fps" + core grading, collaboration, HDR grading (RCM PQ/HLG), basic HDR scopes, static HDR10/HLG export. One GPU, no HW H.264/H.265 accel on Windows/Linux in docs.
- Studio adds: Up to 120fps 32K, multiple GPUs, accelerated H.264/H.265 hardware decode/encode (depends on hardware/codec), temporal/spatial NR, Magic Mask, 45 extra FX, professional HDR scopes (nit/cd/m2), Dolby Vision CMU (GPU-accelerated) + HDR10+/Vivid, IMF/JPEG2000 >=4K/Dolby, Kakadu, DCP, encode plugins, HDR metadata over HDMI (Studio only). Quote: "HDR scopes in DaVinci Resolve Studio are capable of measuring and providing detailed information about ST.2084 and HLG images... replace 10-bit scale with nit values" and "Dolby Vision support includes a GPU accelerated version of the Dolby Vision CMU... Access to advanced trim controls requires a separate Dolby license."

**Forum nuance (Low confidence, label only):** Free on Windows doctrinally blocks 10-bit H.265 per doc, but users report 10-bit 4:2:0 sometimes plays (19%-30% GPU) while 4:2:2 or high-bitrate DLog-M shows glitches/offline. Likely due to Microsoft HEVC Extension supplying OS decoder that Free happens to use, not a supported path. No error toast in Free — confusing UX.

---
## 4. OS Boundary

### macOS
- Codec handling: Resolve uses Apple VideoToolbox APIs -> Media Engine automatically ("easy to check: Play 8K ProRes... close to 0 CPU"). M1/M2/M3/M4 media engines handle H.264/H.265/ProRes (including 10-bit up to 4:4:4) encode (H.264/H.265/ProRes only) automatically. No user toggle; supported in both editions historically, but Studio gets full HW path per compatibility site.
- Color management: Must enable Use Mac Display Color Profiles for viewers + Use 10-bit precision in viewers if available (Prefs -> System -> General) + Display HDR on viewers if available (Project Settings -> Color Management). Set macOS to HDR Video (P3-ST2084) reference mode. Resolve sends ColorSync metadata; HLG viewer bug pre-19/20 — HLG showed too much contrast vs PQ on XDR due to wrong ColorSync metadata (forum-confirmed; workaround CST HLG->PQ).
- OS version coupling: Resolve 17.4+ Universal Binary, Metal-only; supports macOS 12+ (Sonoma compat doc). Apple Silicon requires recent macOS for ProRes RAW, Main10 fixes.

### Windows
- Codec handling: "8-bit OS-supported profiles. More profiles and GPU acceleration in Studio" — Free relies on OS H.264/H.265 (potentially CPU). Installing Microsoft HEVC Video Extension sometimes enables 10-bit 4:2:0 in Free (forum-only). Studio unlocks Nvidia/Intel QuickSync HW accel for more profiles including 10-bit 4:2:2 Main10.
- HDR viewer (new in 19.0): Support for HDR Displays on Windows (asterisk: "As of this writing, HDR Displays on Windows was not available but will be included in the final release.") Requires HDR display, Windows HDR ON (System -> Display -> HDR), Use 10-bit precision in viewers if available. 19+ also adds Use Windows display color management and HDR in viewers. Caveats (forum, not official): single SDR/HDR flag for all viewers; mixed SDR+HDR monitor setups show wrong colors on SDR screens; preview may not update in Fusion until page switch; may need NVIDIA neural optimization pref.

### Linux
- Codec: H.264/H.265 Studio Only (GPU accelerated on Nvidia) for both decode/encode. No Free HW accel; ProRes decode requires Studio for some MXF paths. Not relevant for typical iPhone workflow.

---
## 5. GPU / Display / Color Management

- Unified pipeline: Resolve is 32-bit floating point internally; RCM maps Input -> Timeline -> Output color spaces. Recommendation: start Timeline = wide gamut (Rec.2020) if delivering HDR+SDR later.
- Timeline/Output choices for iPhone HLG: Manual lists 4 HLG outputs: Rec.709 HLG ARIB STD-B67, Rec.2020 HLG ARIB STD-B67, Rec.2100 HLG, Rec.2100 HLG (Scene). Separate Color Space/Gamma controls allow Rec.2020 + Rec.2100 HLG. Creative Video Tips (covers 18.6): iPhone HDR correction via CST — Input color space to Rec.2020, Input Gamma to Rec.2100 HLG (Scene), checkbox HDR 203 Nits Diffuse White.
- Bit depth: Scopes show 10-bit scale; Studio HDR scopes add nit scale. Encode requires high-quality 10-bit capable media format. Viewer 10-bit requires Studio on Windows/Linux per Studio Features doc: "10-bit viewers in Windows and Linux Studio —".
- Display requirements (official): For true HDR grading: ST.2084-compatible HDR display (1000-nit or 5000-nit capable) via DeckLink 8K Pro G2 / 4K Extreme 12G / UltraStudio 4K Extreme (19 adds Dolby Vision HDMI tunneling on DeckLink 8K Pro G2, tone-mapped previews). For GUI preview only: HDR-capable laptop/monitor (e.g., Pro Display XDR) can preview via viewer — not for color-critical grading.
- Metadata delivery: For H.265 HDR, Resolve must write VUI + SEI (mdcv/clli for HDR10; dvvC + colr for DV; colr 9-18-9 for HLG) both in container and HEVC bitstream. Historical bug: Resolve wrote container-level only -> TVs did not switch to HDR; required 3rd-party patch (Hybrid/ffmpeg). Fixed progressively; 21.0.1 explicitly: "HDR metadata handling for H.265 HDR renders... Windows and MainConcept H.265 codecs"; 20.3 Studio: "improved HDR10 metadata embedding and better stereoscopic 3D monitoring."

---
## 6. Version History 18.6 -> 21.0.x (Quoted Evidence)

| Version | Date | HDR / iPhone-relevant change (quoted) | Confidence |
|---|---|---|---|
| 18.6 | 2023-09-14 | Dolby Vision CM 4.0 L1 analysis with user-selected filtering support. Stereoscopic 3D support for Dolby Vision workflows. Option to bypass input color management for RAW clips in RCM. Support for Apple Log video formats + decode Sony XAVC H/HS + Accelerated H.265 interlaced encodes on modern Windows Intel systems. | High — New Features Guide |
| 18.6.4 | 2023-12-05 | Support Blackmagic RAW 3.6, transcription bin controls; no HDR-specific line. | High |
| 18.6.6 | 2024-03-20 | Ability to encode Panasonic AVC ... Option to encode big endian LPCM in QuickTime. Addressed default alpha mode interpretation for some QuickTime media. Addressed some Sony XAVC H clips being shown as offline. | High |
| 19.0 | 2024-08-22 final | Support for HDR displays on Windows * (pref + HDR ON) + Support for decoding cinematic clips captured by iPhone + Dolby Vision HDMI tunneling on DeckLink 8K Pro G2. Dolby Vision tone mapped viewer previews and scopes in dual SDI mode. Option to link Dolby Vision target display selection for trims. Improved HDR Vivid support. Up to 4x faster H.264/H.265 decodes on non-Studio in Windows. Up to 2x faster H.264/H.265 native encodes in Windows. | High — New Features Guide |
| 19.1 | 2024-11 | New Encode and Decode Support: Ability to encode H.265 Main10 formats in DaVinci Resolve on Windows. | Med |
| 19.1.1 | 2024-11-09 | H.265 export corruption fixed — improvements to H.265 encoding and H.265 multipass renders. Forum: 19.1 would generate corrupted exports when using H.265 with Main10 + multi-pass + optimise for speed OFF — Apple Silicon after macOS Sequoia 15.1.1 — fixed in 19.1.1 (M4 Pro/Max). | High (official) + Med (forum) |
| 19.1.3 | 2025-01-20 | Cache/Fusion/AAF/audio fixes; Support for ARRI Alexa 265 clips. No HDR line. | High |
| 19.1.4 | 2025-?? | Support for Apple ProRes encoding on Windows and Linux systems, Samsung Log LUTs. No HDR line. | High |
| 20.0 | 2025-04 beta | >100 new features — keyframe/curve editor, AI tools. Under-the-hood RCM and CST now using ITU BT.2408 for HLG and PQ conversion per 20.2 guide retro-note. | High |
| 20.1 | 2025-mid | Adds encode H.264/H.265 in MXF Op1A, Apple Spatial Audio, improved safe area, ACES 2.0. | High |
| 20.1.1 | 2025-09-02 | Faster cloud loads, Dolby Vision metadata formatting improved, Clearer bit rate/quality layout for Windows codecs. | High |
| 20.2 | 2025-?? | RCM and CST now using ITU BT.2408 (HLG/PQ conversion spec change), Apple ProRes RAW play support. | Med-High |
| 20.3 (Studio) | 2025-?? | improved HDR10 metadata embedding and better stereoscopic 3D monitoring (Studio-only line). Addresses Dolby Vision IMF metadata issue (20.3.3 note). | High — Support page |
| 21.0 | 2026-mid | Adds Fairlight folders, MultiMaster trim passes, Photo page, layer node graphs. | High |
| 21.0.1 | 2026-06-24 | improves DNG and Apple ProRAW decoding, Fusion dual screen, HDR metadata handling for H.265 HDR renders ... H.265 HDR renders now include improved HDR metadata handling so exported files are more reliably recognized as HDR by compatible TVs/media players. ... Windows and MainConcept H.265 codecs... | High — direct iPhone HDR fix |
| 21.0.2/21.0.3 | 2026-07 | improved H.265 playback performance on NVIDIA GPUs (Studio). | High |

**Regression notes:**
- Pre-19 Windows: HDR viewer did not exist — only DeckLink path. Expect flat/log-like viewer by design.
- 19.0 Windows HDR: Initial rollout had not available but will be in final + forum reports of preview not updating in Fusion Float16 until page switch.
- HLG on macOS XDR: Persistent contrast/saturation mismatch when Output = Rec.2100 HLG vs PQ1000 — Resolve sent wrong ColorSync metadata vs Final Cut/QuickTime. Workaround CST HLG->PQ. Unknown if fully fixed by BT.2408 in 20.2.
- H.265 4:2:2/4:4:4 10/12-bit: Requires Studio + adequate Nvidia/Intel GPU even on Studio; Free shows offline or software fallback.

---
## 7. Apple Silicon Media Engines

- Hardware: M1/M2/M3/M4 SoC media engine handles decode/encode for H.264, HEVC Main10 (8/10-bit), ProRes (all flavors) at very low CPU (0% CPU at 8K ProRes playback, ~1000 fps ProRes->ProRes, 170-200 fps ProRes->H.264/5 per forum bench). Resolve uses Apple APIs automatically — no toggle. Containers irrelevant; codecs matter.
- Impact on iPhone HDR: iPhone HEVC 10-bit 4:2:0 decodes via media engine -> near-zero CPU, real-time even at 4K60. Encoding to Main10 H.265 also via media engine (Studio path). Free still benefits from OS decoder but without Studio HW encode path, encoding falls back to CPU/Main profile.
- Limitation: Media engine only encodes H.264/H.265/ProRes; other codecs (DNxHR/CineForm) go CPU.

---
## 8. QuickTime / Metadata Specifics for iPhone

- nclc/colr: Must preserve nclc Tags: HLG 9-18-9 (or 9-1-9 fallback), PQ 9-16-9, DV P5 2-2-2. Wrong tags -> QuickTime/YouTube/Vimeo shift.
- Resolve tags UI: 16.2.1+ added Color Space Tag / Gamma Tag on Deliver page (Advanced Video Settings) — by default follows Timeline/Output Color Space; override possible. 16.2.2 added Rec.709-A (1-1-1) to match QuickTime 1-1-1 handling for SDR web deliveries.
- HDR SEI/VUI: For HDR10, need mdcv + clli in hvcC or container big-endian. For HLG, need preferred_transfer_characteristic = 18 ATC SEI in hvcC. For DV 8.4, need dvvC + colr + amve. Missing SEI = TV not switching to HDR even if file plays.

---
## 9. Display & Viewer Requirements Summary

| Need | macOS | Windows |
|---|---|---|
| 10-bit precision | Prefs -> System -> General -> Use 10-bit precision in viewers if available + restart | Same + (since 19) Use Windows display color management and HDR for viewers |
| OS HDR | macOS HDR Video (P3-ST2084) reference mode; disable True Tone/Auto Brightness | Settings -> System -> Display -> HDR ON per HDR display |
| Resolve HDR flag | Project Settings -> Color Management -> Display HDR on viewers if available + Color Processing Mode: HDR, Output Color Space: Rec.2100 HLG / Rec.2020 ST2084 1000 nits / etc. | Same but Windows HDR pref drives viewer pipeline |
| Reference path | DeckLink/UltraStudio -> ST.2084 HDR display for accurate nits (XDR is preview only) | Same — DeckLink required for accurate HDR; Windows HDR viewer is poor mans but usable |
| Scopes | Basic nit waveform free; Studio HDR scopes for per-nit accuracy | Same; Studio HDR scopes |

**Warning:** Enabling Windows HDR pref forces HDR flag for all viewers — SDR viewers on SDR monitors will look wrong until pref disabled. No per-monitor auto-detection in Resolve (forum: Resolve cannot poll EDID/HDR per display; Windows manages).

---
## 10. Confidence Ratings

- High: Apple codec/metadata specs; Blackmagic codec list OS matrix; Studio vs Free Dolby/HDR scope split; 19.0 Windows HDR viewer addition; 21.0.1/20.3 HDR metadata fixes (official support notes).
- Medium-High: Apple Silicon media engine via VideoToolbox; Windows Main10 encode addition in 19.1.
- Medium: 4x faster decode / 2x faster encode numbers (workload-dependent); HLG ColorSync bug still present vs fixed by 20.2 BT.2408 (no explicit fix note).
- Low (forum-only): Microsoft HEVC Extension enabling 10-bit 4:2:0 in Free; exact 4:2:2 HW threshold; flicker/preview update glitches.

---
## 11. Unknowns Requiring Local Capture (Cannot Assume)

1. Exact Resolve build + OS: Does reporter run 18.6.x, 19.1.1 (corruption fix), 20.x BT.2408, or 21.0.1 (HDR metadata fix)? Behavior changes at each.
2. Edition + GPU: Free vs Studio + GPU model/driver (Nvidia Studio driver, Intel QuickSync, Apple Si generation). Determines HW accel and Main10 availability.
3. File probe: ffprobe/MediaInfo for iPhone file — codec tag (hvc1 vs hvcC), colr nclc values, dvvC/amve/mdcv/clli presence, bit depth, chroma (4:2:0 vs 4:2:2), profile/level, data rate.
4. Project settings: Color Management — Color science, Input/Timeline/Output Color Space, Use Separate Color Space and Gamma, Use 203 nits reference for Rec.2100 HDR.
5. Deliver page: Codec H.264/H.265, Profile Main vs Main10, 10-bit checkbox, Color Space Tag / Gamma Tag, HDR10+ / Dolby Vision export toggles, multipass + optimise for speed, data rate, container .mov vs .mp4.
6. Viewer prefs + OS display: Use 10-bit precision, Use [Mac|Windows] display color management and HDR, macOS reference mode or Windows HDR ON per display, ICC profile, DisplayCAL calibration.
7. Monitoring chain: DeckLink/UltraStudio model + firmware + display EDID vs GPU-direct HDMI + OLED HDR (8-bit panel advertising HDR) — determines whether TV switches to HDR.
8. Post-render verification: Playback in QuickTime Player vs VLC vs TV USB — does TV OSD show HDR/HLG/DV? Check output file with ffprobe for VUI/SEI presence at bitstream level (not just container).
9. macOS Sequoia 15.x regression: Corroborate corruption on M4 Pro/Max after Sequoia 15.1.1 if on 19.1.

---
## 12. Sources (Primary -> Forum)

1. Blackmagic — Resolve 18.6 New Features Guide (PDF, 2023-09-14) — Dolby Vision CM 4.0 L1 analysis — High. https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_18.6_New_Features_Guide.pdf
2. Blackmagic — Resolve 19 New Features Guide (PDF) — Support for HDR Displays on Windows, Support for decoding cinematic clips captured by iPhone, Dolby Vision HDMI tunneling, Up to 4x faster H.264/H.265 decodes on non-Studio in Windows — High. https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_New_Features_Guide.pdf
3. Blackmagic — Resolve 19 Supported Codec List (Aug 2024 PDF) — macOS H.265 Yes GPU accelerated vs Windows 8-bit OS-supported profiles vs Linux Studio Only — High. https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_Supported_Codec_List.pdf
4. Blackmagic — Studio Features PDF (v20, 2025-01-27) — Support for Dolby Vision workflows Studio / Limited tonemapping, HDR video scopes Studio, 10-bit viewers in Windows and Linux Studio — High. https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_Studio_20_Features.pdf
5. Blackmagic — Support Family Page (live, 2026-08-05) — 21.0.1 HDR metadata handling for H.265 HDR renders, 20.3 Studio improved HDR10 metadata embedding — High. https://www.blackmagicdesign.com/support/family/davinci-resolve-and-fusion
6. Blackmagic — Resolve Studio Product Page — supports up to 120fps at 32K... accelerated H.264/H.265... Dolby Vision GPU accelerated CMU... HDR scopes nit values — High. https://www.blackmagicdesign.com/products/davinciresolve/studio
7. Blackmagic — Resolve 20.2 New Features Guide (PDF) — RCM and CST now using ITU BT.2408 for HLG and PQ conversion — High. https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.2_New_Features_Guide.pdf
8. Apple — TN3145 HDR Video Metadata — Dolby 8.4 hvc1 Main10 dvvC colr 9-18-9 amve shall be present — High. https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata
9. Apple — Incorporating HDR Video with Dolby Vision into your apps (PDF) — Dolby Vision Profile 8, Cross compatibility ID 4 (HLG) ... backwards compatible with HLG ... HEVC (10-bit) ... per-frame metadata — High.
10. Apple — High Dynamic Range Metadata for Apple Devices (PDF) — colr atom tables for DV P5 dvh1 2-2-2, HDR10 hvc1/ProRes 9-16-9 + mdcv/clli, HLG 9-18-9 — High.
11. Dolby — Using iPhone 12 Dolby Vision as source — HEVC Main10 Apple Quicktime (.mov) Dolby Vision HLG base layer Profile 8.4 — High. https://dolby.my.site.com/professionalsupport/s/article/Using-an-Apple-iPhone-12-captured-Dolby-Vision-content-as-a-source-in-a-Dolby-Vision-production
12. Digital Cinema Society / Newsshooter — Resolve 21.0.1 coverage (2026-06-24/25) — H.265 HDR renders now include improved HDR metadata handling ... Windows and MainConcept — Medium. https://dcsonline.org/news/blackmagic-releases-davinci-resolve-21-0-1-adding-improvements-for-raw-image-workflows-and-hdr-delivery/
13. Forum — H.265 export corruption fixed 19.1.1 (Blackmagic Forum t=211412, 2024-11-09) — Apple Silicon M4 Pro corrupted exports Main10 multipass — Low/Med. https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=211412
14. Forum — Windows HDR viewer thread (t=208880, 2024) — Use Windows display color management and HDR for viewers ... single output — Low. https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=208880
15. Forum — HLG on XDR thread (t=206201) — HLG shows too much contrast/saturation on XDR vs PQ1000/CST workaround — Low. https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=206201

---
## 13. Implication for Task

- Do NOT assume iPhone .mov failure = corrupt file — Profile 8.4 is HEVC Main10 + HLG fallback; Free on Windows/Linux will often show offline or tonemapped SDR without Studio/HW. macOS Free will usually decode HLG layer.
- Do NOT chase Dolby Vision trim without Studio — generate plain HDR10/HLG master in Free; only switch to Studio + Dolby license if deliverable explicitly requires DV metadata.
- Validate at bitstream level after any HDR render — especially pre-21.0.1. A file that plays in QuickTime but not TV HDR mode likely lacks SEI mdcv/clli in HEVC stream (container-only flag).

---
*Report generated read-only from official Blackmagic/Apple/Dolby primary docs; forum claims explicitly labeled. Main agent must verify version/edition/OS locally before concluding.*
