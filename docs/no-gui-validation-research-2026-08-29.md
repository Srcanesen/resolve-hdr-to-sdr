# No-GUI Doğrulama Araştırması — 2026-08-29 (Düzeltilmiş)

**Kapsam:** Önceki sürümdeki kritik yanlış (headless desteği olmadığı iddiası) ve bayat kanal/inbound-drop detayları temizlendi. Bu sürüm, aşağıdaki gerçek bounded `test:resolve:headless` çalışmasının komut/kapsam/sonucunu, birincil yerel doküman bulgularından ayrı olarak kaydeder.
**Yerel temel:** DaVinci Resolve Studio **21.0.3 (bundle 21.0.30007)** + Workflow Integration bridge **21.0.3.7** — `docs/research/2026-08-25-davinci-iphone-hdr-workflow-integration-research.md` ile doğrulanmıştır.
**Final no-GUI kanıtı:** Parent tarafından doğrudan gözlemlenen üç bounded grup (gerçek HLG pipeline `Sample/1.MOV`, headless `WorkflowIntegration` bridge deneyi, mekanik bundle taşınabilirliği) bu revizyonda ayrı bounded olgu olarak eklenmiştir; komutlar bounded, temp/Resolve kalıntısı `0` olarak doğrulanmıştır.

---

## 1. Düzeltilen Kritik Hata

Önceki rapor headless desteği olmadığını iddia ediyordu — **yanlış**.

Resmi yerel doküman aksini söyler:

> `DaVinci Resolve can be launched in a headless mode without the user interface using the -nogui command line option. When DaVinci Resolve is launched using this option, the user interface is disabled. However, the various scripting APIs will continue to work as expected.`

**Atıf:** `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt:76-79` — başlık `Running DaVinci Resolve in headless mode`.

Sonuç: Scripting API'leri `-nogui` altında çalışmaya devam eder; "GUI olmadan hiçbir Resolve otomasyonu çalışmaz" genellemesi geçersizdir.

---

## 2. Birincil Kanıt — Ne Doğrudan Yazıyor, Ne Yazmıyor

| Kaynak | Satır | Ne söyler |
|---|---|---|
| `Developer/Scripting/README.txt` | 76-79 | `-nogui` resmi destek; UI devre dışı, scripting API'leri çalışır |
| `Developer/Scripting/README.txt` | 225-238 | `MediaStorage.AddItemListToMediaPool` ve `MediaPool.AppendToTimeline` / `CreateTimelineFromClips` varyantları dokümante; harici `Scripting/README.txt:76-79` ile birlikte `-nogui` altında API import/append prensipte test edilebilir |
| `Developer/Workflow Integrations/README.txt` | 61-62 | Resolve başlangıçta `Workflow Integration Plugins` kökünü tarar, her geçerli plugin için `Workspace → Workflow Integrations` altında menü oluşturur, kullanıcı menüye tıklayınca plugin yüklenir ve HTML ayrı pencerede gösterilir — UI kapalıyken bu **menü/panel yükleme yolu** kanıtlanamaz |
| `Developer/Workflow Integrations/README.txt` | 98-129 | `WorkflowIntegration.node` API'leri (`Initialize`, `InitializePromise`, `GetResolve`, `SetAPITimeout`, `RegisterCallback`, `CleanUp` vb.) dokümante; ancak **hiçbir satır `Initialize`'ın `-nogui` altında başarısız olacağını söylemez** |
| `Developer/Workflow Integrations/README.txt` | 136-143 | Workflow Integration **scriptleri** (Python/Lua, UIManager veya PyQt veya `no GUI at all`) Resolve tarafından `Workspace` menüsünden tetiklenebilir; üçüncü taraf UI yöneticisi veya **hiç GUI olmadan** çalışabilir — bu **script** kategorisi, Electron **panel/plugin** kategorisinden ayrıdır |

**Ayrım — zorunlu:** Resolve scripting headless desteği ≠ Workflow Electron panel/native drag kanıtı. Birincisi resmi, ikincisi GUI'ye bağlıdır.

**Sınıflandırma notu:** Electron uygulamasını manuel başlatıp headless Resolve'a `WorkflowIntegration.Initialize` ile bağlama denemesi **UNDOCUMENTED / sınırlı deney gerektirir** — dokümanda yasak da yok, garanti de yok. Önceki raporun "Hayır" hükmü kanıtsızdı.

---

## 3. Ne `-nogui` ile Test Edilebilir, Ne Edilemez

**`-nogui` altında scripting API ile test edilebilir (API import/append, native drag değil):**

- Harici Python/Lua script ile `GetProjectManager().CreateProject` / `GetMediaPool()` / `GetMediaStorage().AddItemListToMediaPool(...)` / `MediaPool.AppendToTimeline(...)` / `GetClipProperty` / `GetMetadata` okuması. Atıf: `Scripting/README.txt:76-79` + `225-238`. Bu, **API düzeyinde Media Pool'a alma ve timeline'a ekleme**yi doğrular; OS seviyesinde sürükle-bırakı doğrulamaz.

**`-nogui` ile kanıtlanamaz (GUI gerektirir):**

- `Workspace → Workflow Integrations` menü enumerasyonu ve Electron panel HTML penceresinin yüklenmesi — `Workflow Integrations/README.txt:61-62` yolu UI kapalıyken izlenemez.
- `WorkflowIntegration.node` host lifecycle'ının panel bağlamında `Initialize → GetResolve` başarısı — menü/panel olmadan resmi kanıt yok; harici Electron'u headless Resolve'a bağlama **UNDOCUMENTED** (98-129 sessiz).
- Native `webContents.startDrag({file, icon})` ile görünür Media Pool/timeline hedefine OS drop — görünür kaynak ve hedef gerektirir; headless'te doğrulanamaz. Unit mock sadece gating/çağrıyı kanıtlar.

**Script vs Panel ayrımı:** `Workflow Integrations/README.txt:136-143`'teki "no GUI at all" ifadesi **scriptleri** kapsar, Electron panelini değil. Script headless çalışabilir; panel için aynı genelleme yapılamaz.

**Native drag:** Resmi Electron API `webContents.startDrag` görünür pencere + non-empty icon + OS drop hedefi gerektirir; headless'te kaynak/hedef görünür değil. Mevcut unit testler sadece doğru outputId/verified gating altında `startDrag`'in çağrıldığını kanıtlar.

---

## 4. Mekanik Bundle Kontrolleri — No-GUI Çalışır

Aşağıdakiler **mevcut macOS'ta GUI olmadan** çalışır, Resolve açık olması gerekmez:

- `file <bundle/binary>` + `lipo -archs <binary>` (Mach-O tipi ve `x86_64` + `arm64` slice matrisi)
- `otool -L <binary>` (dylib/rpath listesi; yalnızca `/usr/lib`, `/System/Library` ve `@rpath`/`@loader_path`/`@executable_path` kabul edilir)
- `codesign --verify --deep --strict <bundle>`
- `shasum -a 256` / hash karşılaştırma (`WorkflowIntegration.node` resmi SDK kopyası)
- rpath sızıntı taraması (`@rpath`, mutlak geliştirici yolu içermeme)
- `find build/... -type l | wc -l` (symlink yok), `ls -l tools/` regular executable kontrolü

Atıf: repo `scripts/bundle-audit.cjs` ve `docs/workflow-integration-dev.md:Build` invariants; bundle audit artık bu Darwin `file`/`lipo`/`otool -L` kontrollerini shell olmadan çalıştırır ve başarısızlıkta build'i fail-closed durdurur. Bu kontroller offline/mekanik kategorisindedir.

**Final mekanik bundle kanıtı (parent doğrudan gözlemi, bounded komutlar):**

- `WorkflowIntegration.node` — `file`: `Mach-O universal binary with 2 architectures` → `lipo -archs`: `x86_64 arm64`; `codesign --verify --deep --strict` **geçer**; imza: `Developer ID Application: Blackmagic Design Inc (9ZGFBWLSYP)`, `CodeDirectory flags=0x20000` (sıkı), `Authority=Developer ID Certification Authority`. Yerel codesign doğrulaması **geçer**, ancak temiz-host taşınabilirliği kanıtı değildir.
- `tools/ffmpeg` ve `tools/ffprobe` — her biri `file`: `Mach-O 64-bit executable arm64` → `lipo -archs`: `arm64`-only; `codesign` çıktısı `flags=0x2(adhoc)` (ad-hoc imzalı, Apple notarization değil); `otool -L` her binary için **83 dylib** bağımlılığı listeler ve bunların arasında mutlak `/opt/homebrew/...` yolları bulunur (örn. `/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1/lib/libavcodec.63.dylib`, `/opt/homebrew/opt/libxcb/lib/libxcb.1.dylib`).
- Sonuç: Yeni audit (`scripts/bundle-audit.cjs`) Darwin gate'i ile **fail-closed** reddeder; mevcut bundle **self-contained değil / Intel-portable değil**. Portable universal (`x86_64+arm64`) ve relocatable (`@rpath`/`@loader_path`/`@executable_path` only) tool provisioning ile temiz-host runtime doğrulaması **blocked/deferred** (BUG-025). Yerel `codesign --verify` geçişi ≠ temiz host garantisi.

**Temiz makine taşınabilirliği** ise ayrıdır: aynı komutlar **temiz bir host'ta** scriptlenebilir, ancak mevcut makinedeki geçiş temiz host garantisi vermez. Gerçek Workflow panel/native drag yine GUI ister.

---

## 5. Ertelenen Üç Gerçek Grup (Audit Kaynağı)

`docs/bug-audit-and-remediation-2026-08-29.md` ve `docs/workflow-integration-dev.md:Manual Host Smoke`'a göre ertelenenler:

1. **Host Initialize/panel/native drag** — `WorkflowIntegration.Initialize` host startup, `Workspace → Workflow Integrations` panel yükleme, `webContents.startDrag` ile Media Pool/timeline drop kabulü. Yalnızca canlı Studio GUI'de. Headless bridge deneyi (bkz. §7.2) bu GUI host kanıtının yerini tutmaz.
2. **Portable tool provisioning ve temiz macOS runtime** — local audit gate artık `file`/`lipo`/`otool -L` ile Intel/Apple Silicon ve relocatable dylib koşullarını uygular; ancak mevcut `tools/ffmpeg`/`ffprobe` arm64-only, ad-hoc ve `/opt/homebrew/...` bağımlılıklı olduğu için build fail-closed olur (her biri 83 dylib, absolute Homebrew path). Universal/relocatable tool provision, codesign/notarization, `WorkflowIntegration.node` Electron uyumu ve MoltenVK/libplacebo runtime doğrulaması hâlâ DEFERRED/clean-host kapsamındadır ve **blocked** olarak sınıflandırılır.
3. **Kalibre Rec.709 görsel A/B** — `hlg-rec709-v1` ve `pq-rec709-v1` (BT.2390/perceptual/peak_detect) çıktısının kalibre Rec.709 ekranda insan gözüyle doğrulanması. Mekanik `verify-spike.sh` + `verify_contract.py` (frame count/duration/tag/privacy) yeterli değil; gerçek HLG pipeline'ın mekanik PASS'ı (bkz. §7.1) görsel kabul kanıtı değildir.

---

## 6. Smoke Matrisi — 11 Madde İçin Kesin Sınıflandırma

Her satır: **offline** (CI/headless), **Resolve `-nogui` scripting** (API import/append), **PARTIAL/NOT SUPPORTED BY CURRENT EVIDENCE** (dokümansız headless bridge deneyinde başarısız), **GUI-only**, **clean-host**, veya **human visual**. Final parent gözlemi sonrası güncellenmiştir; komutlar bounded, temp/Resolve kalıntısı `0`.

| # | Doğrulama maddesi | Sınıf | Gerekçe |
|---|---|---|---|
| **1** | `npm run test:python` — classifier/inspector/verify-contract (saf Python, ffprobe mock) | **offline** | Resolve yok; CI'da headless koşar |
| **2** | `npm run test:electron` — IPC/b-profile/conversion-service mock, fake `WorkflowIntegration.node` | **offline** | Resolve yok; `node --test` headless |
| **3** | `npm run doctor` + `npm run bundle:resolve` allowlist/symlink/hash/deref + Darwin `file`/`lipo`/`otool -L` portability gate + `git diff --check` | **offline — EXPECTED FAIL (mevcut bundle)** | Yerel mekanik; GUI yok. Mevcut arm64/ad-hoc/Homebrew tools nedeniyle bundle komutu beklenen şekilde nonzero döner — fail-closed kanıtı (bkz. §7.3). |
| **4** | `file` / `lipo -archs` / `otool -L` / `codesign --verify --deep --strict` / hash/rpath taraması (bundle üzerinde) | **offline (yerel no-GUI) — MIXED** | `WorkflowIntegration.node` universal `x86_64 arm64`, Developer ID, codesign verify **PASS**; `ffmpeg`/`ffprobe` her biri arm64-only, ad-hoc, 83 absolute `/opt/homebrew` dylib bağımlılığı ile **FAIL** — audit fail-closed, bundle NOT self-contained/Intel-portable |
| **5** | `ffprobe`/`ffmpeg` metadata zinciri — `colr nclx 9/18/9`, VUI, `dvvC`/`mdcv`/`clli` çıkarımı + gerçek HLG pipeline mekanik doğrulaması (`Sample/1.MOV` → `hlg-local-b-v1` → Rec.709, bkz. §7.1) | **offline (mekanik) — PASS mekanik, görsel değil** | Container/stream side-data + gerçek `b-executor` conversion + verifier `exit 0/PASS` (source SHA + Rec.709 tags). Temp çıktı silindi. Kalibre görsel A/B hâlâ human visual. |
| **6** | `MediaStorage.AddItemListToMediaPool` + `MediaPool.AppendToTimeline` + `GetClipProperty`/`GetMetadata` readback — harici Python script ile | **Resolve `-nogui` scripting — PASS (sentetik fixture)** | `Scripting/README.txt:76-79` + `225-238`; `-nogui` altında scripting API çalışır — API import/append'i kanıtlar, native drag'i değil (bkz. §8). |
| **7** | Electron plugin `Workspace → Workflow Integrations` menü enumerasyonu ve panel HTML pencere yükleme | **GUI-only** | `Workflow Integrations/README.txt:61-62` yolu UI kapalıyken kanıtlanamaz |
| **8** | `WorkflowIntegration.node` `Initialize('com.hdrtosdr.app')` → `GetResolve()` host startup (Electron panel bağlamı) — headless Resolve `-nogui` karşısında harici Electron deneyi | **PARTIAL / NOT SUPPORTED BY CURRENT EVIDENCE (headless bridge)** | Repo Electron **41.10.3** ve Resolve-bundled Electron **her ikisi** denendi; kurulu resmi `WorkflowIntegration.node` ile `Initialize('com.hdrtosdr.app')` **true** döndü, ancak `SetAPITimeout`, `GetResolve`, `CleanUp` **başarısız**. Her iki koşum da sahip olunan Resolve çocuğunu temizledi (Residue `0`). Dokümansız sınır; GUI host'ta panel **önceden açılmıştı**, bu yüzden headless bridge başarısızlığı ürün hatası değil. |
| **9** | Native `webContents.startDrag({file, icon})` → Media Pool / Timeline OS drop | **GUI-only** | Görünür kaynak/hedef gerekir; mock sadece gating/çağrıyı kanıtlar — `https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragoptions` |
| **10** | Temiz makine taşınabilirliği — universal arch/relocatable dylib/codesign/MoltenVK/`tools/ffmpeg` runtime (başka host) | **clean-host — BLOCKED/DEFERRED** | Gate mevcut host'ta mekanik olarak çalışır; mevcut tools gate'i geçmez (arm64-only/ad-hoc/83 absolute dep). Universal/relocatable provisioning ve clean-host runtime hâlâ BUG-025 kapsamında blocked/deferred |
| **11** | Kalibre Rec.709 ekranda tone-map görsel A/B (`hlg-rec709-v1` / `pq-rec709-v1`) | **human visual — DEFERRED** | Mekanik tag/frame/duration/privacy doğrulaması ve mekanik HLG pipeline PASS'ı (§7.1) görsel doğruluğu kanıtlamaz |

**Not:** 6 = API düzeyidir (import/append), 9 = OS drag düzeyidir (native). İkisi karıştırılmamalı. 5 ve 6'daki mekanik PASS'lar görsel kabul yerine geçmez; 8'deki headless bridge kısmi başarısızlığı GUI host (panel daha önce açıldı) başarısızlığı değildir.

---

## 7. Final No-GUI Bounded Kanıtı — Üç Grup (Parent Doğrudan Gözlemi, 2026-08-29)

Komutlar bounded, temp dosyalar ve Resolve kalıntısı `0` olarak doğrulanmıştır. Aşağıdaki üç bulgu **overclaim olmadan** kaydedilmiştir.

### 7.1 Gerçek HLG Pipeline no-GUI PASS — `Sample/1.MOV`

**Olgu (bounded, overclaim yok):** Gerçek medya `Sample/1.MOV` üzerinden yerel pipeline GUI olmadan koşturuldu:

- **Inspector** sınıflandırması: `hlgKnownLocal` profil `hlg-local-b-v1` (mekanik).
- **Gerçek `b-executor` conversion** (mock değil) **başarılı** — yerel `ffmpeg` zinciri ile Rec.709 çıktısı üretildi.
- **Verifier** `exit 0` / `PASS`: source SHA eşleşti, çıktı `Rec.709` tag'leri doğrulandı.
- **Temp çıktı** işlem sonrası **silindi** (kalıntı `0`).

**Sınır:** Bu, **mekanik yerel pipeline** kanıtıdır; **görsel kabul** kanıtı değildir. Kalibre Rec.709 ekranda insan gözüyle A/B doğrulaması hâlâ deferred/human visual (madde 11). Source dosya `Sample/1.MOV` hiçbir zaman overwrite edilmedi.

### 7.2 Undocumented WorkflowIntegration Bridge Deneyi — Owned Resolve `-nogui` Karşısında

**Kapsam (bounded):** İki ayrı Electron runtime ile aynı headless Resolve çocuğuna karşı denendi; resmi kurulu `WorkflowIntegration.node` kullanıldı, yalnızca sahip olunan child yönetildi:

- **Deney A:** Repo Electron **41.10.3** + `/Library/Application Support/.../WorkflowIntegration.node` (resmi kurulu kopya).
- **Deney B:** Resolve-bundled Electron (Resolve app içindeki Electron) + aynı resmi node.

Her iki koşumda:

- `Initialize('com.hdrtosdr.app')` → **`true`** döndü.
- `SetAPITimeout` → **başarısız**.
- `GetResolve` → **başarısız**.
- `CleanUp` → **başarısız**.
- **Cleanup:** Her iki koşum da sahip olunan Resolve child'ı `TERM→KILL` ile temizledi; **Resolve residue `0`**, fuscript residue `0`.

**Sınıflandırma:** **PARTIAL / NOT SUPPORTED BY CURRENT EVIDENCE** — dokümansız sınır. Bu, **GUI host'ta ürün hatası değildir**. Gerçek GUI host'ta panel **önceden başarıyla açılmıştı** (`Workspace → Workflow Integrations` menüsü altında HTML yüklendi); headless bridge davranışı ayrı, dokümansız bir sınırdır. Önceki "Hayır" hükmü gibi, bu deney de tek başına genelleme yapılmaksızın bounded olarak kaydedilir.

### 7.3 Mekanik Bundle Kanıtı — Universal vs Ad-hoc / Self-contained Değil

**Olgu (bounded `file`/`lipo`/`otool`/`codesign`):**

- `WorkflowIntegration.node` — `file`: `Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit bundle x86_64] [arm64:Mach-O 64-bit bundle arm64]` → `lipo -archs`: `x86_64 arm64`; `codesign --verify --deep --strict` **PASS**; imza `Authority=Developer ID Application: Blackmagic Design Inc (9ZGFBWLSYP)`, `TeamIdentifier=9ZGFBWLSYP`, `CodeDirectory v=20400 size=... flags=0x20000(runtime)`.
- `tools/ffmpeg` — `file`: `Mach-O 64-bit executable arm64` → `lipo -archs`: `arm64`-only; `codesign -dv`: `CodeDirectory v=20200 size=... flags=0x2(adhoc) Signature=adhoc`; `otool -L`: **83** dylib, aralarında absolute `/opt/homebrew/...` (örn. `/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1/lib/libavcodec.63.dylib`, `/opt/homebrew/opt/libxcb/lib/libxcb.1.dylib`, `/opt/homebrew/opt/mbedtls/lib/libmbedcrypto.16.dylib`).
- `tools/ffprobe` — aynı: `Mach-O 64-bit executable arm64`, `arm64`-only, `flags=0x2(adhoc)`, `otool -L`: **83** dylib, absolute `/opt/homebrew/...` yolları.

**Sonuç:** Yeni audit (`scripts/bundle-audit.cjs`) Darwin gate'i ile **fail-closed** davranır — mevcut `ffmpeg`/`ffprobe` thin/ad-hoc/absolute-dep nedeniyle reddedilir; mevcut bundle **NOT self-contained / NOT Intel-portable** olarak sınıflandırılır. Portable universal/relocatable tool provisioning ve clean-host runtime doğrulaması **blocked/deferred** (BUG-025). Yerel `codesign --verify` geçişi temiz-host garantisi değildir.

---

## 8. Gerçek Bounded `test:resolve:headless` Sonucu (Sentetik Fixture)

**Komut:**

```bash
npm run test:resolve:headless
```

**Kapsam:** Resolve ve `fuscript` önceden çalışıyorsa reddeder; repo-local
`tools/ffmpeg` ile tek karelik geçici medya üretir; tam bundle binary'sini
`/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve -nogui`
olarak doğrudan çalıştırır ve resmi `RESOLVE_SCRIPT_API`, `RESOLVE_SCRIPT_LIB`,
`PYTHONPATH` değişkenlerini ayarlar. Resolve PID sahipliği her mutasyondan ve
`Quit` isteğinden önce doğrulanır. Yalnızca benzersiz scratch proje ve yalnızca
sahip olunan fixture kullanılır: `CreateProject` →
`AddItemListToMediaPool` → `CreateTimelineFromClips`; ardından sınırlı version,
clip/property ve timeline readback yapılır. `finally` içinde scratch proje
kapatılıp silinir; TERM→KILL cleanup, proje/medya silinmesi ve Resolve/fuscript
kalıntısı doğrulanır. Mevcut proje, timeline veya medya kullanılmaz; `open -a`
kullanılmaz.

**Sonuç: PASS.** Resolve `21.0.3.7`; clip count `1`, name
`hdrtosdr_resolve_smoke_fixture.mp4`, duration `00:00:01:00`, resolution `16x16`,
codec `H.264 High L1.0`, fixture path match `true`; timeline count `1`, item count
`1`; scratch proje kapatıldı/silindi, geçici medya silindi, yalnızca sahip olunan
çocuğa Quit istendi, PID kanıtları `true`, Resolve residue `0`, fuscript residue
`0`.

Bu deney madde 6'daki headless scripting API import/append/readback zincirini
kanıtlar; Workflow paneli, `WorkflowIntegration.node` panel host lifecycle'ı,
native drag/drop veya görsel kalite iddiası eklemez. Ayrıca bu sonuç bundle
portability kanıtı değildir: mevcut provisioning ile `npm run bundle:resolve`
Darwin audit gate tarafından beklenen şekilde nonzero ile reddedilir.

---

## 9. Kapsam Dışı Bırakılanlar (Bu Raporda Bilinçli Temizlendi)

- Bayat kanal adları ve inbound drop detayları — bu repoya ait değil, çıkarıldı.
- Yanlış icon/headless nedenselliği gibi kanıtsız genellemeler.
- Gelecek tarihli örnek provenance yorumları ve alakasız SHA tarihçesi.

Bu rapor yalnızca yukarıdaki 11 maddenin sınıflandırmasını ve birincil atıfları verir.

---

## 10. Resmi Kaynaklar

- **Blackmagic yerel (kurulu):**
  - `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt:76-79` — `-nogui` headless
  - `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt:225-238` — `AddItemListToMediaPool` / `AppendToTimeline`
  - `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/README.txt:61-62` — plugin enumerasyon/menü yükleme
  - `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/README.txt:98-129` — `WorkflowIntegration.node` API'leri (Initialize başarısızlığı yazmaz)
  - `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/README.txt:136-143` — scriptler `no GUI at all` ile çalışabilir (Electron panelden ayrı)
- **Electron resmi:**
  - `https://www.electronjs.org/docs/latest/api/web-contents#contentsstartdragoptions` — `webContents.startDrag(options)` (`file`/`files` + `icon: NativeImage`, macOS'ta non-empty icon zorunlu; görünür kaynak/hedef gerekir)

Repo içi tamamlayıcı: `docs/workflow-integration-dev.md:Build` ve `docs/bug-audit-and-remediation-2026-08-29.md` (ertelenen gruplar).

---

## 11. Doğrulama

- `npm run test:resolve:headless` — PASS; yukarıdaki kapsam ve sonuç kanıtı (sentetik fixture, §8).
- Gerçek HLG pipeline no-GUI (`Sample/1.MOV`, `hlg-local-b-v1`, gerçek b-executor, verifier exit 0/PASS, Rec.709 tags, source SHA) — **MECHANICAL PASS**; temp çıktı silindi (kalıntı `0`); görsel kabul değil (bkz. §7.1).
- Headless WorkflowIntegration bridge (repo Electron 41.10.3 + Resolve-bundled Electron, resmi node, `Initialize true` / `SetAPITimeout`+`GetResolve`+`CleanUp` fail) — **PARTIAL / NOT SUPPORTED BY CURRENT EVIDENCE**; her iki koşum Resolve residue `0` ile temizlendi (bkz. §7.2); GUI paneli daha önce açıldı, headless bridge ayrı sınır.
- `npm run bundle:resolve` — EXPECTED FAIL (Darwin gate fail-closed); `WorkflowIntegration.node` universal/Developer ID/codesign PASS, `ffmpeg`/`ffprobe` her biri arm64-only/ad-hoc/83 absolute `/opt/homebrew` dylib bağımlılığı ile reddedilir (bkz. §7.3).
- `git diff --check` — whitespace hatası yok.
- Komutlar bounded, geçici dosyalar ve yalnızca sahip olunan Resolve çocuğu yönetildi; normal `npm run check` offline kalır ve Resolve başlatmaz.

*Not: Bu rapor §5/§6'daki mekanik PASS'ların görsel doğruluk, headless bridge'in ise GUI host panel başarısızlığı olarak genellenemeyeceğini açıkça ayırır.*
