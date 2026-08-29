# Failure Taxonomy: iPhone HDR Looks Wrong on DaVinci Resolve Timeline — CST Does Not Recover

**Date:** 2026-08-25 (research) | **Resolve versions cited:** 18.6, 19.x, 19.1 | **iPhone HDR = Dolby Vision Profile 8.4 (HLG Rec.2020 10-bit HEVC) except ProRes Log mode**

## Source Ground Truth (separates source vs processing vs display)

**Fact — iPhone capture:** Since iPhone 12, HDR video = HEVC Main10 .mov, Dolby Vision Profile 8.4: HLG (BT.2100) transfer, BT.2020 primaries, 10-bit 4:2:0, with dynamic Dolby Vision metadata layered on an HLG-compatible base. (Dolby Prof. Support: "Using an Apple iPhone 12 captured Dolby Vision content as a source" — accessed 2025-08-25 via Jina mirror 2026-08-25; Apple Support 102241 confirms "Wide Gamut HDR - Rec.2020 HLG" workflow for iPhone HDR in FCP.)
**Fact — Dolby recommendation:** Import the HLG base layer only; phone-generated DV metadata is *not* reused in a multi-cam grade — re-analyze/generate metadata after grading. Dolby explicitly: HLG sources must be converted to PQ before DV analysis. (Same Dolby article).
**Fact — Apple apps vs Resolve:** Final Cut/QuickTime/Photos interpret profile 8.4 via ColorSync + DV metadata/tone-map adaptively and show "correct" EDR on XDR. Resolve imports HEVC HLG but *ignores DV dynamic metadata* by design (treats as HLG) unless you enable Dolby Vision pipeline at export. (Dolby "Best Practices Create Dolby Vision Profile 8.4 using DaVinci Resolve" 2026-01-08; Blackmagic forum t=182854, t=183981 confirm workflow difference.)
**Inference — Therefore washed-out ≠ only symptom:** Overexposed/high exposure, desaturated/washed, oversaturated/clipped, gamma-shift between viewer vs export, and HDR-on-SDR clipping are distinct failure modes sharing the same HLG source.

---

## Taxonomy — 8 Failures, Symptoms, Smallest Discriminating Test

### 1. Incorrect Project/Timeline/Output Color Management (RCM vs YRGB, SDR vs HDR processing mode)

**Official behavior:** Resolve has two color sciences: `DaVinci YRGB` (manual/CST) vs `DaVinci YRGB Color Managed (RCM)`. In RCM Automatic, Color Processing Mode = SDR or HDR (SDR→HDR, HDR DAWG Intermediate) chooses timeline working space and DRT tone-mapping. Timeline color space = working/intermediate; Output color space = delivery transform. Manual CST workflow requires explicit Input→DWG/I → Output. (Blackmagic DaVinci Resolve 19 Beginners Guide p.222; Resolve 18 Reference Ch.6 "Data Levels, Color Management, ACES, HDR"; Resolve Immersive Workflow Guide p.27-28: DWG/Intermediate + P3-D65 ST2084 1000-nit example).
**Symptoms:** Entire timeline uniformly washed (SDR output from HDR timeline with no tonemap) OR uniformly too punchy/dark (HDR timeline viewed on SDR display without HLG→SDR LUT). Scope: waveform lifted to ~70-100% flat, no clipping flag. CST on node appears to "do nothing" because RCM already transformed clip before CST (order-of-operations double-maps via green "2" in manual p.3127).
**Smallest test:** Toggle `Project Settings > Color Management > Color Science` to `DaVinci YRGB` (bypass RCM) with `Timeline = Rec.709 Gamma 2.4` and disable node CST → re-add single CST: `Input Rec.2020 / Input Gamma Rec.2100 HLG Scene → Output Rec.709 Gamma 2.4`. If image snaps to plausible, root cause was RCM preset overriding CST. Also test: `Automatic Color Management ON → Color Processing Mode = SDR, Output = Rec.709 Gamma 2.4` vs `HDR` - watch whether Media Pool Input Color Space column flips from Rec.2100 HLG to bypass. Confidence: **High** — triangulated manual + forum t=193594 (RCM vs CST order).

### 2. Wrong Input Assignment (Rec.2020 vs Rec.2100 HLG Scene vs ST2084, Scene vs Display)

**Official behavior:** Resolve auto-tags HEVC HLG via NCLC/mxf metadata cascade: raw→embedded NCLC→default Input Color Space→manual override (SteakUnderwater VFXPedia Mirror of Resolve 18.6 Manual Part 287). For iPhone, auto = `Rec.2100 HLG`. Forum reports auto still requires manual fix: `Rec.2100 HLG Scene` vs `Rec.2100 HLG Display`, `Rec.2100 HLG` vs `Rec.2020 (Scene)` expose differences; DJI/iPhone both reported `Rec.2100 HLG Scene` = blown-out, switching to `Rec.2020` fixed (forum t=193594 p=7-8).
**Symptoms:** Highlights blown/overexposed by 1–2 stops *only on HDR clips*, SDR clips normal. HLG Scene error = ~ +1.67 stops over (BT.2408 note). ST2084 (PQ) mistaken for HLG = severe over-bright + hue shift. Scopes show legal-range clamp at 100% but data >100% clipped regardless of exposure slider.
**Smallest test:** Media Pool → List View → enable `Input Color Space` column. Right-click clip → `Input Color Space >` cycle: `Rec.2100 HLG Scene` → `Rec.2020` → `Rec.2100 ST2084` → `Bypass`. No other changes. Observe waveform peak shift. Correct setting is where diffuse white lands ~75% (HLG 75% = 203 nits per ITU, or ~1.0 with 203-nits checkbox). Also verify with `Clip Attributes > Color Space`. Confidence: **High** — most-reported cause (forum t=182854 "always too bright, requires curve adjustment", t=173188, t=177727).

### 3. Dolby Vision Metadata Ignored or Transformed (Profile 8.4 metadata stripped)

**Official behavior:** Profile 8.4 = HLG base + DV RPU metadata. Dolby: editing apps should ingest *base* HLG only; Resolve (and FCP in HDR mode) can import HEVC correctly but Premiere historically could not without transcode. DV metadata is *not* applied as a transform in Resolve's Color page unless you enable `Dolby Vision` palette and export Profile 8.4 (Dolby Best Practices 2026-01-08). Resolve's Decode treats file as HLG; QuickTime/FCP applies DV dynamic tone-map.
**Symptoms:** Clip looks slightly flat vs iPhone Photos/QuickTime EDR (DV metadata gave per-shot trim), especially midtone contrast and highlight roll-off. No amount of static CST/LUT matches QuickTime frame-for-frame; difference varies shot-to-shot. Metadata inspector shows no DV tab in Resolve but shows DV in MediaInfo/Findr Get Info.
**Smallest test:** Play same .mov in QuickTime (Window > Show Movie Inspector) vs Resolve viewer with `Use Mac display color profiles` OFF and CST disabled. Screenshot both. If QuickTime shows punchier adaptive tone-map that changes per scene cut and Resolve is static, metadata is being ignored. Confirm via `mediainfo --Inform="Video;%HDR_Format%"` → `Dolby Vision, Version 1.0, dvhe.08.06, BL+RPU, HLG compatible`. Export test: Deliver > Advanced > `Dolby Vision Profile 8.4` enabled vs disabled — does Resolve generate RPU on export (file size/meta diff)? Confidence: **Medium-High** — Dolby doc + forum t=186893 "funky hybrid Dolby Vision inside an HLG encoded file, just converting HLG to SDR won't look correct."

### 4. Display / Viewer Mismatch (HDR timeline on SDR monitor without tone-map/LUT)

**Official behavior:** Resolve viewer needs `Output Color Space` + display capability match. For HDR grading, manual: `Timeline DWG/Intermediate → Output P3-D65 ST2084 1000-nit` + external HDR I/O (DeckLink/UltraStudio) + `Enable metadata over HDMI` (Dolby+Immersive guide). For SDR monitoring on HDR source, need tone-map or `Video Monitor Lookup Table: HLG → Gamma 2.4` or 203-nits reference checkbox.
**Symptoms:** Viewer looks washed/low-contrast on SDR Mac Studio Display but *correct* on MacBook Pro XDR built-in (forum t=215217 Jan 21 2025). Scopes look correct while viewer doesn't. Toggling `Display HDR in views if available` changes nothing on non-HDR display. Users report "overexposed on Studio Display, correct on M3 MBP XDR".
**Smallest test:** Project Settings → check `Use 203 nits reference for Rec.2100 HDR` (RCM Custom) or apply Viewer LUT `HLG to Rec.709 2.4` → does viewer now match scopes? Cross-check: open same graded frame on two displays (XDR vs Studio Display) or mirror to QuickTime — if QuickTime EDR shows HDR pop but Resolve Studio Display doesn't, it's monitoring, not grade. Confidence: **High** — documented in Beginners Guide HDR mastering + forum t=215217 + t=186893 "You need an HDR screen in HDR mode... on Windows you need Decklink."

### 5. macOS ColorSync / Video Levels / Gamma (Full vs Video/Data levels + 1-1-1 vs 1-2-1 vs Rec.709-A + 709 Scene 1.96 vs 2.4)

**Official behavior:** This is *two* entangled failures: (a) ColorSync: macOS Display P3 ICC + NCLC tags (primaries-transfer-matrix e.g., 1-1-1 = Rec.709/Rec.709/BT.709). Resolve `Timeline Color Space` sets NCLC tags on render; `Use Mac display color profiles for viewers` toggles ColorSync in viewer (PostProcess 2020-03-16, 2020-07-17). `Rec.709-A` (Apple) = 1-1-1 tag with 1.96 gamma tweak to match QuickTime; `Rec.709 Gamma 2.4` = 1-2-1/1-4-1 and appears darker in QuickTime. (b) Data levels: Resolve Deliver > Advanced `Data Levels: Video / Full / Auto`. iPhone records full-range 0-255 but Resolve defaults clip data levels = Video (16-235) (Rodrigo Polo 2025-11-20 "IT'S APPLE HDR" full-range vs legal-range). Levels mismatch lifts blacks and dulls contrast.
**Symptoms (ColorSync):** Timeline and QuickTime export mismatch: Resolve viewer (with Mac profiles ON, Rec.709-A) looks matched, but `Rec.709 Gamma 2.4` export looks darker/washed in QuickTime/Safari and after YouTube recompress. Or opposite: Resolve viewer OFF, export 1-1-1 looks washed in Resolve but correct in QuickTime.
**Symptoms (Levels):** Washed blacks (pedestal ~ 64/1023), not overexposed whites; waveform shows blacks clamped at ~4% not 0%, whites at ~96% not 100%. Applying contrast doesn't restore black point. Polo LUT specifically targets full→video remap.
**Smallest test (ColorSync):** Deliver same 10s ProRes 422 with tags `Rec.709 Gamma 2.4 (1-2-1)` vs `Rec.709-A / Rec.709 (Scene) (1-1-1)`, `Data Levels = Auto`. Get Info in Finder → Color Profile, MediaInfo `colour_primaries / transfer_characteristics / matrix_coefficients`. Open both in QuickTime vs Resolve viewer with `Use Mac display color profiles` ON/OFF. If they swap which matches, it's NCLC. Test also Firefox (non-ColorSync) vs Safari/Chrome (ColorSync) — Firefox matches Resolve viewer OFF.
**Smallest test (Levels):** Clip Attributes → `Data Levels: Video vs Full`. Toggle and watch waveform black point. And Deliver → `Data Levels: Video vs Full (vs Auto)`. Preferred: iPhone source → set clip Data Levels = Full (per Polo), Deliver = Video for broadcast OR Full only for controlled QuickTime matching (forum t=85510 warns Full via ProRes has no flag for other apps). Confidence: **High** for both — PostProcess tests + Polo + Blackmagic forum t=85510.

### 6. Photos-Export / AirDrop / "Most Compatible" Altered Metadata (HEVC 10-bit HDR → H.264 SDR transcode)

**Official behavior:** iPhone Settings > Camera > Formats: `High Efficiency (HEVC)` preserves HDR; `Most Compatible` forces H.264 SDR transcode (Apple Support, Macworld 2021-12-28, dev.to 2026-06-03). Photos app Share vs Save to Files vs AirDrop to non-ProRes target may trigger Apple tone-map to SDR and strip DV/HLG tags, changing codec tag from `hvc1/dvh1` 10-bit to `avc1` 8-bit. Finder Encode Selected Video Files does separate high-quality transcode (Blackcap Blog).
**Symptoms:** Two copies of "same" clip behave differently: AirDropped via Photos Shared album = 8-bit H.264 Rec.709, imports cleanly (no wash), but original .mov via Image Capture / Files = 10-bit HEVC Rec.2020 HLG, imports washed. MediaInfo shows bit depth 10→8, color 9-18-9 → 1-1-1, HDR_Format absent. CST now *degrades* the already-SDR copy.
**Smallest test:** Compare `mdls -name kMDItemCodecs` / MediaInfo / QuickTime Inspector for source vs exported file. Check `Finder Get Info > Color Profile: BT.2020 HLG (9-18-9)` vs `HD (1-1-1)`. If Photos-exported version is already 1-1-1/SDR, treat as SDR (Bypass, no CST) and only apply HDR pipeline to original HEVC. Confidence: **High** — Apple Support + multiple forum reports (t=186893: "Most Compatible is how Apple tone maps it... lower resolution version from iPhoto: .MPG H.264").

### 7. Duplicate Transforms (RCM Auto + manual CST + Timeline LUT + Output LUT)

**Official behavior:** Order-of-operations: Source → Input Color Space (RCM) → Timeline Working → Node CSTs → Timeline Output → Display LUT (Manual p.3127 diagram green "2"). If RCM Auto is ON (input Rec.2100 HLG → DWG) and user also adds node CST `Rec.2100 HLG → Rec.709` plus Timeline Output `Rec.709`, signal is double-mapped: HLG→709 twice = oversaturated/dark crushed or washed depending on order. Similarly, having both `Video Monitor Lookup Table: HLG→Gamma 2.4` *and* output CST to 709 duplicates.
**Symptoms:** Image either extremely contrasty/crunchy with clipped chroma (double compression) OR unexpectedly unchanged when tweaking one CST (other transform compensates). Bypassing nodes (Shift+D) reveals image still transformed. Scopes show non-linear knee with hue shift not matching single DRT.
**Smallest test:** Disable all: Project Settings → set `Color Science = DaVinci YRGB` (not Color Managed), remove `Video Monitor LUT`, delete/disable all CST nodes → image should look flat/washed (raw HLG). Re-enable one transform at a time. Also toggle `Project Settings > Color Management > Bypass` per-clip vs timeline. If disabling RCM alone fixes, duplicate confirmed. Best practice validated by forum t=193594: "Instead of Raw → 709 → DWI → 709, do Raw → DWI → 709." Confidence: **Medium-High** — manual order + Beginners Guide "If certain clips come from different sources, reassign input color spaces... Bypass".

### 8. Genuinely Clipped / Transcoded Source (exposure, 4:2:0 HEVC, platform recompress)

**Official behavior:** iPhone HLG auto-exposure tends to overexpose (forum t=173188 "iPhones have a horrible tendency to over-expose HLG. LTM/GTM preprocessing"). HEVC 4:2:0 55 Mb/s at 4K60 has limited latitude vs Log/Raw 4:2:2/4:4:4. Once highlights > 1000 nits are clipped or chroma subsampled, no CST/DRT can recover.
**Symptoms:** Zebras >100% with no detail return on exposure -1 to -2 stops via HDR wheels; waveform ceiling flat at 1023; vector scope desaturated in highlights (chroma clip). Same symptom after Photos/Finder recompress to H.264 8-bit. Difference from case 2: adjusting Input Gamma from Scene→Display does *not* recover headroom; highlight detail stays missing.
**Smallest test:** In Color page, add gain -2 stops (or HDR wheels → Highlight -50) before CST. If detail returns, was transform error (cases 1-2). If stays clipped, source is clipped. Confirm via original .mov MediaInfo bit depth + histogram in DaVinci Scopes → highlight clipping indicator. Also test ProRes Log alternative on same scene (iPhone 15 Pro+): `Apple Log` Input Color Space correctly holds highlights where HEVC HLG doesn't (forum t=182854 workaround). Confidence: **Medium** — requires shot-level check, but iPhone overexposure is widely reported.

---

## CST Failure Sub-Taxonomy (why "a CST does not recover")

- CST input columns are `Color Space` (gamut primaries) + `Gamma` (OETF/EOTF) — choosing `Rec.2020` (gamut only) vs `Rec.2100 HLG` (gamut+HLG) vs `Rec.2100 ST2084` (PQ) are not interchangeable. iPhone = `Rec.2020 / Rec.2100 HLG (Scene)` per CreativeVideoTips 2023 and forum consensus.
- `HLG Scene` vs `HLG Display`: Scene = camera OETF, Display = EOTF after OOTF. Using Display when Scene needed = ~1.3-1.7 stops error (overexposed). No single correct — varies by whether iPhone applied OOTF.
- Tone-mapping method matters: `DaVinci` vs `Saturation Compression` vs `None` — `None` shows hard clip at 100 nits (reveals DRT dependency), `DaVinci` is subjective fixed math per timeline (forum t=183981), Dolby Vision analysis is per-shot. Expect CST-only to need manual exposure -3 to -4 EV (forum t=173188) before it looks right.
- Levels (full vs video) is orthogonal to CST gamut/gamma — CST assuming video range on full-range source explains Polo's "all YouTube tutorials wrong" claim.

## Recommended Diagnostic Flow (smallest tests in order)

1. Inspect source before Resolve: MediaInfo/QuickTime Get Info → 9-18-9? dvhe.08.06? 10-bit? (rules out case 6 & 8).
2. Resolve Media Pool → Input Color Space column + Clip Attributes Data Levels (cases 2 & 5b).
3. Toggle RCM Auto vs YRGB + single CST (cases 1 & 7).
4. Viewer vs external: 203-nits checkbox / Monitor LUT and XDR vs Studio Display check (case 4).
5. Render two tag variants (1-1-1 vs 1-2-1) and compare in QuickTime/Safari/Firefox (case 5a).
6. DV metadata check via MediaInfo HDR_Format + per-shot variability (case 3).
7. Exposure pull -2 stops to test clipping (case 8).

## Sources — Primary (Official) First

1. Dolby — "Using an Apple iPhone 12 captured Dolby Vision content..." — dolby.my.site.com/professionalsupport — accessed 2025-08-25/2026-08-25 — trusted: defines Profile 8.4 HLG base + metadata reuse rule.
2. Dolby — "Best Practices Create Dolby Vision Profile 8.4 using DaVinci Resolve with an external HDR display" — 2026-01-08 — trusted: Resolve 18+ HDR HLG output + DV 8.4 export steps.
3. Blackmagic — "Using DaVinci Resolve Color Management" (Beginners Guide 19 p.222) + DaVinci Resolve 19 New Features Guide + 15 Color Correction training — documents.blackmagicdesign.com — trusted: RCM vs YRGB, Input/Timeline/Output.
4. Blackmagic — DaVinci Resolve 18 Reference Manual Part 287/298/299 via VFXPedia mirror (SteakUnderwater) — trusted secondary mirror of official manual: auto Input Color Space cascade, Input DRT, 203-nits checkbox, order-of-ops p.3127.
5. Blackmagic — DaVinci Resolve Immersive Workflow Guide — documents.blackmagicdesign.com — trusted: DWG/Intermediate → P3-D65 ST2084 monitoring pipeline, metadata over HDMI.
6. Apple Support 102241 "Edit HDR video recorded on an iPhone or iPad" + 109041 "About Apple ProRes on iPhone" — support.apple.com — trusted: Wide Gamut HDR Rec.2020 HLG library/project settings in FCP, ProRes Log option.
7. Blackmagic Forum — t=182854 (iPhone HDR Dolby Vision - Better Input Color Space) 2023-06-10; t=215217 (Correctly show iPhone HDR on Studio Display) 2025-01-21; t=186893 (iPhone HDR Washed Out/High Exposure) 2023-08-20; t=173188 (iPhone H265 HDR/HLG cannot import without tweaking) 2022-12-25; t=193594 (CST for DJI HLG) — forum.blackmagicdesign.com — official forum: observable overexposure, XDR vs Studio Display, correct settings debate. **Note:** 403 on direct Jina fetch for some threads; excerpts via Exa search highlights used.

## Sources — Secondary (High-Signal Community)

8. Rodrigo Polo — "iPhone HDR video in Resolve the right way!" — 2025-11-20 — Jina verified — full-range (0-255) vs video-range claim + LUT fix.
9. The Post Process — Dan Swierenga — "Color Shift Fixes..." 2020-03-16 & "Consistent Color..." 2020-07-17 — thepostprocess.com — deep NCLC 1-1-1 vs 1-2-1, Rec.709-A, Use Mac Display Color Profiles tests.
10. CodeWithSusan — "DaVinci Resolve - Fix washed out exports (iPhone footage on Mac)" — 2024-06-17 — Jina verified — timeline vs export tag split (Rec.2020 Scene vs Rec.2020 HLG).
11. CreativeVideoTips — "HDR iPhone Video in DaVinci Resolve" — 2023-09-18 — settings Rec.2020 + Rec.2100 HLG Scene + 203 nits.
12. DigitalProduction (Uli Plank) — "LUTs, Tags, or ICC..." — 2026-04-08 — recaps Rec.709-A crutch and 709 Scene 1-1-1 recommendation.

Access dates in Exa highlights stamped 2023-2026; Jina fetches done 2026-08-25.

## Conflicts / Uncertainty

- **HLG Scene vs Display vs Rec.2020:** Official manual doesn't prescribe iPhone-specific Input; forum splits between Rec.2100 HLG Scene (BMD auto), Rec.2020 Scene, and HLG Display. Polo claims range, not gamma, is root. No single universal setting — exposure variability (LTM/GTM) means any fixed Input needs per-clip trim. Mark inference.
- **203-nits checkbox:** Manual says "only for SDR→HDR scaling" but forum t=215516 reports it affects RAW/HDR too when Input/Output DRT = DaVinci. Behavior may be version-dependent (18.6 vs 19).
- **NCLC tagging vs actual transform:** Resolve 16.2+ advanced tags decouple tags from transform; but many players/browsers ignore tags (DigitalProduction 2026). Tests in PostProcess were on High Sierra 10.13 / Resolve 16.2 — macOS ColorSync behavior inverted after 10.14.6 (PostProcess update). Current macOS 14+ may differ.
- **Dolby RPU handling in Resolve free vs Studio:** Studio required for Dolby Vision palette/profile; free version behavior may differ — not always stated in threads.

## Implication for Task (no prescription beyond taxonomy)

Main agent should NOT emit "one universal CST." Instead build symptom picker → test runner mapping each of 8 causes to one-click diagnostic (mediainfo, input override, levels toggle, RCM toggle, viewer LUT, render tag A/B). Triangulate any secondary LUT claim against official RCM/CST order; require per-clip verification.

## Risks / Unknowns

- MediaInfo `transfer_characteristics` vs Resolve `Input Gamma` label mismatch (ARIB STD-B67 vs Rec.2100 HLG Scene) — map table needed.
- Photos/AirDrop pipeline silently transcodes; app ingesting exported MOV cannot know if source was already SDR without provenance flag.
- Genuinely clipped source cannot be distinguished from wrong Scene/Display without exposure pull test.

