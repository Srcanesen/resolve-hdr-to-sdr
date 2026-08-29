# iPhone Capture-Mode Matrix — HDR Color Behavior in DaVinci Resolve

**Date:** 2026-08-25  
**Scope:** Apple Camera (native), Cinematic, ProRes HDR, ProRes Log / Apple Log / Apple Log 2, SDR, front vs rear, Blackmagic Camera, Final Cut Camera  
**Sources:** Primary Apple / Blackmagic / Dolby documentation, triangulated with Resolve guidance. See Sources.

---

## 1. Capture-Mode Matrix (summary)

| # | Mode (distinct pipeline) | Device / OS floor | Codec / container | Bit depth / chroma | Transfer / Primaries / Matrix (signaled) | Dolby Vision / HLG signaling | Sidecar / dynamic metadata |
|---|---|---|---|---|---|---|---|
| 1 | **Native Apple Camera HDR Video (Dolby Vision)** — Video, QuickTake | iPhone 12 generation and later; **iOS 14.1+**; iPad Pro 12.9" 5th gen+ | **HEVC Main10** `.mov` (QTFF); not ProRes | **10-bit 4:2:0 (x420)** | `colr` nclc **9 / 18 / 9** = BT.2020 / **BT.2100 HLG** / BT.2020. Compat fallback `9 / 1 / 9` + ATC SEI 147=18 in `hvcC`. | **Dolby Vision Profile 8.4** (CRID 4 = HLG). Single-layer backward-compat: legacy decodes HLG, DV decodes + RPU. Box `dvvC` + `hvcC`. Ambient `amve`. | Per-frame **RPU dynamic HDR** via `kVTCompressionPropertyKey_HDRMetadataInsertionMode=Auto`; recompute on edit via `PreserveDynamicHDRMetadata=false`. `AVMediaCharacteristicContainsHDRVideo`. |
| 2 | **Cinematic Mode** | iPhone 13: 1080p DV HDR ≤30fps; iPhone 14/15/16/17(+Pro): **up to 4K DV HDR ≤30fps**; iOS 15+. No ProRes. | **HEVC Main10** `.mov` | **10-bit 4:2:0** | Same as (1): **9/18/9 HLG / BT.2020** when HDR ON; SDR 1/1/1 when OFF. | Same Profile 8.4 / HLG as (1) when HDR ON. | Same `dvvC`+`hvcC`+`amve`+RPU plus **depth/disparity matte** for refocus. Editing invalidates RPU. |
| 3 | **ProRes HDR** via Camera.app Video | iPhone **13 Pro (+Max) iOS 15.1+**, 14 Pro, 15 Pro, 16 Pro, 17 Pro; storage-gated; all cameras inc. front; not in Cinematic/Slo-mo/Timelapse. | **ProRes 422 HQ/422/LT/Proxy** `.mov` (ProRes RAW only via Final Cut/3rd-party) | **10-bit 4:2:2** (422 family; 4444 unreachable - no x444 capture per TN3104) | **HDR (HLG)** `colr` **9/18/9**; SDR variant `1/1/1` on 13/14/15 Pro; **16 Pro/17 Pro: SDR removed - only HDR or Log** (Apple Support 109041 Mar 2026). | **HLG only, no DV**: `apcn/apch` etc.; no `dvvC`/RPU. HLG via `colr` + optional `mdcv`/`clli`; `amve` possible. | Static `mdcv`/`clli`; no per-frame RPU. External SSD req for high rates. |
| 4 | **Apple Log (orig)** flat scene-referred | **iPhone 15 Pro/Max+**, iOS 17+; Camera.app only with ProRes ON (ProRes Log). HEVC Max via Final Cut/Blackmagic. | ProRes 422 variants (Camera) or **HEVC Main10** (Final Cut/Blackmagic) `.mov` | **10-bit** | **Proprietary log curve** (see §5 constants) + **Rec.2020 primaries** D65, matrix BT.2020. Not PQ/HLG. Via `CVImageLogTransferFunction.appleLog`. | **None** - Log is scene-referred; graded to Rec.709/HLG/PQ in post. UI ProRes Log vs HDR mutually exclusive. | Official LUT `AppleLogToRec709-v1.0.cube` at developer.apple.com/downloads filter "Apple Log Profile". Resolve 18.6+ Input Gamma Apple Log + Input CS Rec.2020. Monitoring LUT display-only (Record LUT off). |
| 5 | **Apple Log 2** | **iPhone 17 Pro/Max** family; iOS 26 / SDK `appleLog2`. | Same as Log: ProRes 422 or HEVC Main10; RAW maps via Log2 preview. | **10-bit** | **Same gamma as Log**, new **Apple Wide Gamut (AWG)** wider than Rec.2020 (blues/magentas). Bradford CAT per OCIO #163 matrix. | **None** (same as Log). Final Cut preview LUT Log2->SDR or Log2->HLG only. | Needs **Log2-specific LUT/CST**; Rec.2020 LUTs mis-map. Resolve: Input CS **Apple Wide Gamut**, Input Gamma **Apple Log 2** -> DaVinci WG/Intermediate sandwich -> Rec.709/HLG. |
| 6 | **SDR** (HDR toggle OFF) | All 12+ when Settings->Camera->Record Video->HDR OFF. | **HEVC 8/10-bit** (Efficient) or **H.264 8-bit** (Compatible) `.mov`/`.mp4` | 8-bit 4:2:0 (or 10) | `colr` **1/1/1** BT.709 | **None** - no `dvvC`/`mdcv`/`clli`. | No HDR metadata. ISP tone-mapped/sharpened (Log disables sharpening). |
| 7 | **ProRes RAW / RAW HQ** sensor RAW | **iPhone 17 Pro/Max only** + Final Cut/3rd-party; external SSD >=220 MB/s (4K60) / >=440 MB/s (4K120) exFAT; iOS 18+ | **ProRes RAW/HQ** `.mov`, Open Gate 4224x3024 (<=60fps) or 17:9 4224x2240 (<=120fps) | **12-bit Bayer linear** | **No fixed space/gamma** - preview forced Apple Log 2 -> HLG. | **None** at capture. | `proRAW` atoms; Windows needs Apple decoder. |
| 8 | **Third-party HDR** Blackmagic Camera / Final Cut Camera | Blackmagic iOS 17+ free; Final Cut Camera iOS 17.4+. Same hardware floors. | Blackmagic: **HEVC Max 10-bit, H.264, ProRes HQ/422/LT/Proxy, RAW** + 1080p proxy. Final Cut: **HEVC/ProRes/RAW**. | 10-bit 4:2:0/4:2:2 | Override: **Rec.709 / Rec.2020 / P3-D65 / BT2020 HLG10 / HDR10 / Apple Log/2 / ACES** independent of system toggle. | HLG10 = pure **HLG 9/18/9**, HDR10 = **PQ 9/16/9+mdcv/clli** - **no dvvC**. Distinct from DV 8.4 HLG though both decode HLG. | Blackmagic: 17/33-pt `.cube` either **Display-only (default)** vs **Burn-to-clip**; Color Space Tag must match LUT intent. Final Cut Preview-with-LUT toggle similar. |

---

## 2. Native Apple Camera HDR Video (Dolby Vision 8.4 -> HLG)

**Device/OS:** iPhone 12 generation introduced; supported on 12/13/14/15/16/17 + iPad Pro 5th gen+. Requires **iOS 14.1 / macOS 11**. Toggle Settings -> Camera -> Record Video -> HDR Video ON (default ON). OFF forces SDR HEVC/H.264 globally.

**Codec:** Always **HEVC Main10 `hvc1`** in QTFF `.mov`. Variable bitrate; profile level Auto. **Dolby Vision Profile 8.4** cross-compat ID 4 = HLG. Single-layer: non-DV decodes clean HLG; DV decodes + **RPU** enhancement. Not Profile 5 (`dvh1` 2/2/2) — that is delivery-master only. Recorded as `dvvC` (not `dvcC`) for 8.4.

**Signaling (TN3145 + Incorporating HDR PDF):**
```
codec 'hvc1', HEVC Main10
hvcC + dvvC + colr nclc 9/18/9 + amve
colr: primaries 9=BT.2020, transfer 18=HLG (BT.2100), matrix 9=BT.2020 NCL
Compat: colr 9/1/9 + ATC SEI message 147 preferred_transfer=18 in hvcC
```
`amve` (`kCMFormatDescriptionExtension_AmbientViewingEnvironment`, ISO 23008-2 D.2.39) carries ~314 lux living-room env from iPhone 12+. AVFoundation preserves via `kCMFormatDescriptionExtension_AmbientViewingEnvironment` on CMSampleBuffer; stripping yields "extra bright" on Apple displays — must propagate to new pixel buffers. VTDecompression `kVTDecompressionPropertyKey_PropagatePerFrameHDRDisplayMetadata` defaults true; `AVPlayer.appliesPerFrameHDRDisplayMetadata` defaults YES.

**HDR10/HLG pure variants** (non-DV, not default Camera capture): HDR10 = `colr 9/16/9` + `mdcv`+`clli` (required for ProRes, SEI 137/138 fallback in hvcC for HEVC); HLG = `colr 9/18/9` + ATC SEI 147.

**Resolve ingest:** Auto Input Color Space **Rec.2100 HLG / Rec.2020**; RPU not decoded as DV - grade as HLG. Community washed-out issues trace to **full-range 0-255 (.mov) vs Resolve default video/legal 16-235** - fix Data Levels = Full.

## 3. Cinematic Mode

**Floor:** 13 family 1080p HDR 30fps; 14/15/16/17 families 4K HDR 30fps; front+rear. Apple specs: "Cinematic mode up to 4K HDR at 30fps" (15+), "up to 4K Dolby Vision at 30fps" (16/17). Cap is 30fps.

**HDR:** Inherits HDR Video toggle - when ON, HEVC Main10 DV 8.4 9/18/9 + dvvC/amve/RPU identical to §2; when OFF, SDR 1/1/1.

**Exclusions:** **ProRes unavailable** in Cinematic (+ Time-lapse/Slo-mo/Spatial) per Apple Support 109041 and iPhone user guide. Action Mode capped 2.8K 60fps, also HDR-capable.

**Extra matte:** Depth/disparity auxiliary track enables post refocus (Photos/iMovie/FCP/Resolve). Edits that change frames require DV metadata recompute (`PreserveDynamicHDRMetadata=false`).

## 4. ProRes HDR vs ProRes SDR

**Floor:** iOS 15.1+, 13 Pro/Max and later Pro/Max. 128GB internal capped 1080p30; 256GB+: 4K30 internal, 4K60 with USB-C SSD (15 Pro+), 4K120 with >=440 MB/s SSD on 16 Pro/17 Pro (Apple table). External SSD: USB-C 3.2 >=10Gb/s, exFAT, >=220 MB/s (440 for 120); reformat between 120 sessions.

**UI:** Settings -> Camera -> Formats -> Apple ProRes ON -> Video mode picker -> **ProRes HDR / ProRes SDR (13/14/15 Pro only) / ProRes Log**. **16 Pro/17 Pro: SDR choice removed** - only HDR or Log.

**Technical:** Codecs `apcn` (422), `apch` (HQ), `apcs` (LT), `apco` (Proxy), 10-bit 422. HDR signaled **HLG 9/18/9** (+ optional `mdcv`/`clli`) - **no dvvC**. Do not treat as DV. SDR = `colr 1/1/1`. Front camera supports ProRes HDR (user guide: "ProRes is available on all cameras, including the front camera").

## 5. Apple Log / Apple Log 2

**History:** Log = iPhone 15 Pro (A17 Pro) iOS 17; Log2 = iPhone 17 Pro (A19 Pro) + ACES/Genlock; 15/16 Pro picker stays Log, 17 Pro offers Log2. In Camera.app Log only with ProRes; in Final Cut/Blackmagic also with HEVC Max (docs: "you can turn on log recording for HEVC and ProRes. Log requires 15 Pro or later").

**Curve (Apple Log Profile White Paper Rev 1.0, download.developer.apple.com/Developer_Tools/Apple_Log_profile/Apple_Log_Profile_White_Paper.pdf):** Same for Log and Log2.
```
V = 0                         if L < R0
V = c*(L-R0)^2                if R0 <= L < Rt
V = gamma*log2(L+beta)+delta  if L >= Rt
Inverse: L = R0               if V < 0
         L = sqrt(V/c)+R0     if 0 <= V < Pt
         L = 2^((V-delta)/gamma)-beta  if V >= Pt
R0=-0.05641088, Rt=0.01, c=47.28711236, beta=0.00964052, gamma=0.08550479, delta=0.69336945, Pt=c*(Rt-R0)^2
L is scene-referred linear, 1=diffuse white. IRE table: on-camera HDMI 0-1023 full-range differs from post floating 0-1 -> verify scaling for ACES IDT.
```

**Primaries/matrix:**
- Log: **Rec.2020** R(0.708,0.292) G(0.170,0.797) B(0.131,0.046) D65.
- Log2: **Apple Wide Gamut (AWG)** wider, especially saturated blues/magentas. Bradford CAT; OCIO PR #163 matrix: [0.69496 0.24140 0.06363; 0.04736 1.00429 -0.05165; -0.02198 -0.02898 1.05097].

**Codec binding & signaling:** CoreVideo extension `kCVImageBufferLogTransferFunctionKey` = `appleLog`/`appleLog2` + primaries ITU_R_2020 vs AWG; not PQ/HLG nclc. MOV colr may be present but transfer is custom Log code.

**LUT/CST guidance:**
- Official: Downloads filter "Apple Log Profile" -> `AppleLogToRec709-v1.0.cube` (+ ACES LUTs) + 4pp white paper. Final Cut preview presets: Apple Log(LOG2) -> SDR Rec.709 or -> HDR HLG.
- Resolve 18.6+: CST preferred. Log: Input CS Rec.2020 / Input Gamma Apple Log. Log2: Input CS **Apple Wide Gamut**, Input Gamma **Apple Log 2** (or Log name depending on Resolve version) -> intermediate **DaVinci Wide Gamut / Intermediate** (sandwich) -> Rec.709 2.4 or HLG; enable Tone Mapping (DaVinci) + Saturation Compression. Direct Log2->Rec.709 single CST causes fringing/blue clipping.
- Exposure quirk per Leeming/GammaTo tests: clip point moves with ISO - tag 80% zebras at base ISO 55/125; >125 climbs non-linearly to 99% at ISO 2000+. Prefer base ISO for predictable LUT.

**ACES:** No shipped IDT in standard OCIO; bridge via CST or Prolost AppleLog->ACEScc/cct LUTs.

## 6. SDR Baseline

HDR OFF -> all modes emit SDR. HEVC Efficient 8 or 10-bit 4:2:0 or H.264 Most Compatible 8-bit 4:2:0. `colr 1/1/1` BT.709. No dvvC/mdcv/clli/amve. Display-referred, ISP tone-mapped/sharpened (Log disables sharpening/noise reduction). Front/rear identical signaling.

## 7. Front vs Rear

- ProRes (inc. HDR): on **all cameras inc. front** 13 Pro+ (Apple guide verbatim). Front ProRes RAW max 60fps; rear RAW to 120fps (17:9) per Final Cut docs.
- Cinematic/Action/HDR toggle: global to both lenses; no lens-specific transfer/primaries documented; sensor ISPs color-matched.
- Center Stage 18MP (17 Pro front): digital stabilization crop, not color pipeline change.

## 8. Third-Party Apps

### Blackmagic Camera (Blackmagic Design, free, iOS 17+)
Overrides system toggle - explicit Color Space: Rec.709, Rec.2020, P3-D65, BT2020 HLG10, BT2020 HDR10, Apple Log, ACES, Apple Log2/Samsung Log. Codec: HEVC Max 10-bit, H.264, ProRes HQ/422/LT/Proxy, RAW (17 Pro) + optional 1080p HEVC proxy. HLG10/HDR10 are pure HLG 9/18/9 or PQ 9/16/9+mdcv/clli **without dvvC** - mixing with native DV 8.4 HLG are distinct pipelines though both decode as HLG. Log selectable with **HEVC Max** for smaller files (~ProRes quality except extreme keying). LUT: 17/33-pt .cube, modes **Display-only (recommended)** vs **Record LUT to Clip (burn)**; Tag must match LUT intent; zebras 80% Log / 95% Rec.709 per community base ISO 125.

### Final Cut Camera (Apple, iOS 17.4+ companion)
Codec HEVC/ProRes/ProRes RAW (HQ); res 720p/1080p/4K + 4.2K Open Gate 4224x3024 (<=60) / 4224x2240 (<=120) + 240 slo-mo; color SDR Rec.709 / HDR HLG / Apple Log/2; fps 24/25/30/60 (100/120 RAW 17:9). Flags per tech specs: ProRes RAW5, ACES, Log2, Genlock (17 Pro). Guide: standard HDR = HLG 9/18/9; Log flat requires grading; RAW sensor-linear, preview forced Apple Log2->HLG. Headers: HLG `hvcC+colr+amve`, Log as Log extension, RAW `proRAW` atoms; **does not author DV 8.4 RPU** - HDR is native HLG.

## 9. Metadata Discriminators for Ingestion

| Mode | Atoms / extensions | AVFoundation / ffprobe probe |
|---|---|---|
| **DV 8.4 (native HDR Video / HDR Cinematic)** | `hvc1` + `hvcC` + **`dvvC`** + `colr` **9/18/9** + **`amve`**; HEVC RPU SEI | `AVMediaCharacteristicContainsHDRVideo` true; `CMFormatDescription` DolbyVisionConfiguration + AmbientViewingEnvironment; pix fmt x420; ffprobe `color_transfer=arib-std-b67` + tag `dvvC` + `ambient-viewing-environment` |
| **HLG (ProRes HDR or Blackmagic/FinalCut HLG10)** | `apcn/apch/apcs` or `hvc1` + `colr` **9/18/9** + optional `mdcv`/`clli`+`amve`; **no dvvC**; optional ATC SEI 147 compat `9/1/9` | HDR true, transfer ITU_R_2100_HLG, no Dolby config |
| **HDR10 PQ** via Blackmagic | `hvc1`/`apcn` + `colr` **9/16/9** + **`mdcv`+`clli`** (SEI 137/138 fallback in hvcC) | transfer SMPTE_ST_2084 |
| **Apple Log / Log2** | `apcn/apch` or `hvc1` + **`kCVImageBufferLogTransferFunctionKey` appleLog/appleLog2** + primaries Rec.2020 vs AWG; custom Log tag | `CVImageLogTransferFunction`; Resolve Input Gamma Apple Log(/Log2), Input CS Rec.2020 / AWG; external `.cube` sidecar not embedded |
| **SDR** | `hvc1`/`avc1` + `colr` **1/1/1**; no dvvC/mdcv/amve | HDR false |
| **Cinematic depth** | Same as DV 8.4 row + depth `dpth` / `kCMFormatDescriptionExtension_DisparityModel` | `AVDepthData`/`AVCameraCalibrationData` |

ffprobe snippet: `color_primaries=bt2020 + color_transfer=arib-std-b67 + dvvC -> DV 8.4; prores + b67 no dvvC -> ProRes HDR; log transfer -> Log family; smpte2084+mdcv -> PQ`.

## 10. Device / Version Constraints

- DV HEVC: iPhone 12+ only. Cinematic 1080p->4K cap 13->14 gen; 30fps ceiling. 
- ProRes: 13 Pro+ iOS 15.1+; 128GB 1080p30 cap; 256GB+ 4K30 internal; external SSD 4K60 (15 Pro+ 220MB/s) / 4K120 16/17 Pro 440MB/s + exFAT. **16/17 Pro picker: HDR or Log only (no SDR)**.
- Log: 15 Pro+ floor; Log2/AWG 17 Pro floor; HEVC Log only via Final Cut/Blackmagic.
- DV Profile 5 `dvh1` 2/2/2 is delivery-master only, not camera-emitted.

## 11. Resolve Implications

Keep five ingestion branches: (A) DV 8.4 HEVC HLG+dvvC+amve+RPU, (B) pure HLG (ProRes HDR or app HLG10), (C) PQ HDR10, (D) Apple Log Rec.2020, (E) Apple Log2 AWG + SDR. Resolve RCM maps DV 8.4 -> Rec.2100 HLG/Rec.2020; do not check Dolby Vision timeline box for Apple HLG workflow (DV trim is post per Dolby). Log vs Log2 requires matching Input CS or fringing/saturation errors; HLG and SDR sources need **Data Levels Full** override (iPhone .mov full-range 0-255 vs Resolve legal default) or Video Monitor LUT HLG->Gamma2.4.

## 12. Confidence / Gaps

**High (Apple primary triangulated):** DV 8.4 9/18/9 + dvvC + amve + 10-bit x420 + .mov; nclc constants per TN3145/HDR PDF; ProRes exclusions/storage gates/UI picker verbatim via Support 109041; Log curve constants + Rec.2020 verbatim white paper; Final Cut codec/color/RAW Open Gate/60-vs-120 caps; Blackmagic space/LUT semantics verbatim tech specs.

**Medium/derived:** AWG chromaticities from Gamut/OCIO PR #163 Bradford matrix (Apple enum page confirms appleLog2 name but not xy); RPU recompute on Cinematic depth edits inferred from PreserveDynamicHDRMetadata docs; full-vs-video range mismatch from QTFF spec + community waveform tests.

**Gaps needing live file capture:** Exact `colr` transfer code written for Log/Log2 MOVs (whether 2/unspecified or Log private) - needs `ffprobe -show_streams` + `qtffcolr` on 15 Pro vs 17 Pro clips; `amve` presence on ProRes HDR clips (norm says shall for HEVC dvvC, may for ProRes); front-vs-rear RAW/60fps enforcement on 128GB SKUs.

---

## Sources

Access 2026-08-25 unless noted.

1. Apple - About Apple ProRes on iPhone https://support.apple.com/en-us/109041 - ProRes HDR/SDR/Log picker, floors, storage/fps gates, external SSD, 16/17 Pro SDR removal. Primary.
2. Apple iPhone guide - Record ProRes video https://support.apple.com/guide/iphone/record-prores-video-iphde02c478d/ios - ProRes on all cameras inc. front, exclusions Cinematic/Slo-mo/Timelapse, external.
3. Apple - Incorporating HDR with Dolby Vision PDF https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf - DV Profile 8.4 CRID4 HLG, HEVC Main10 x420, dvvC, HDRMetadataInsertionMode, RPU propagation.
4. Apple TN3145 https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata - normative DV 8.4 hvc1+dvvC+colr9/18/9+amve, HDR10 9/16/9+mdcv/clli, HLG 9/18/9+ATC147, amve 314 lux.
5. Apple HDR Metadata PDF 2019 https://developer.apple.com/av-foundation/High-Dynamic-Range-Metadata-for-Apple-Devices.pdf - mdcv/clli/colr nclc legacy Profile 5 2/2/2.
6. Apple TN3104 https://developer.apple.com/documentation/technotes/tn3104-recording-video-in-apple-prores - x422 10-bit cap, no x444.
7. Apple CVImageLogTransferFunction https://developer.apple.com/documentation/corevideo/cvimagelogtransferfunction - appleLog/appleLog2 enum, scene-referred primaries/matrix/Y'CbCr.
8. Apple Final Cut Camera - At a glance / Record video / Set format / About log/RAW / Front camera https://support.apple.com/guide/final-cut-camera/... - HEVC/ProRes/RAW, SDR HLG Log/2, preview LUT intents, Open Gate 4224x3024, front 60fps, ACES/Genlock.
9. Apple Log White Paper https://download.developer.apple.com/Developer_Tools/Apple_Log_profile/Apple_Log_Profile_White_Paper.pdf (via discussions 255143087) - curve constants, Rec.2020 pairing, 0-1023 vs 0-1 scaling.
10. Apple Adjust HDR settings / Edit HDR video https://support.apple.com/guide/iphone/iph2cafe2ebc/ios & https://support.apple.com/en-us/102241 - HDR toggle default ON.
11. Dolby Prof Support - Capturing DV with iPhone & Using iPhone 12 DV https://professionalsupport.dolby.com/s/article/Capturing-Dolby-Vision-with-an-Apple-iPhone - Profile 8.4 production.
12. Blackmagic Camera Tech Specs https://www.blackmagicdesign.com/products/blackmagiccamera/techspecs - codecs, spaces Rec.709/2020/P3/HLG10/HDR10/Apple Log/ACES, proxy, 17/33-pt LUT, built-in Log->709.
13. Gamut/Antler/Prolost Log vs Log2 https://gamut.io/apple-log-vs-apple-log-2-whats-actually-different/ https://antlerpost.com/colour-spaces/AppleLog.html https://prolost.com/blog/applelog - AWG vs Rec.2020, sandwich CST, ACES bridge.
14. OCIO-Config-ACES #163 https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/issues/163 - Log2 / Linear AWG Bradford matrix values.
15. iPhone 16/17/17 Pro Specs https://support.apple.com/en-us/121029 https://support.apple.com/en-us/121031 https://www.apple.com/iphone-17/specs/ https://www.apple.com/iphone-17-pro/specs/ https://support.apple.com/en-gb/125090 - 4K DV caps, Cinematic 4K30, 4K120 Slo-mo, formats HEVC/H264/ProRes/RAW, Log/ACES/Genlock flags.

---

## Implication for ClipDock / DaVinci Pipeline

Do not normalize iPhone sources to one HDR input. Branch five: (A) DV 8.4 HLG+dvvC+amve+RPU, (B) pure HLG, (C) PQ, (D) Log Rec.2020, (E) Log2 AWG + SDR. Gate CST/RCM/mdcv/amve tone-map on dvvC/Log-extension/mdcv discriminators; check Log transfer extension and AWG before assigning Resolve Input CS.

## Risks / Unknowns

- AWG xy undocumented on apple.com beyond enum - rely on OCIO Bradford matrix until white-paper Rev2.
- amve on ProRes headers may/should but not required - dropping during transcode over-brightens.
- Full-vs-video range tagging varies by mode - needs clip-level Data Levels override even after colr pipeline.

