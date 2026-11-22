# 03 — Desain UI/UX & Design System

N.E.X.A Pulse Monitor dirancang mengikuti filosofi **Minimalist Developer Console** (terinspirasi **Linear**, **Vercel**, dan **Tailscale**): permukaan datar bergaris tipis (*hairline borders*), kepadatan data tinggi yang rapi (*tabular numerals*), kontras tajam, tanpa efek neon berlebih, tanpa library eksternal, dan sepenuhnya kompatibel dengan Content Security Policy ketat (`style-src 'self'`).

---

## 1. Prinsip Desain & Kepatuhan CSP

1. **Zero Runtime Styling Violations:** Seluruh layout, spacing, progress bar (`<progress>`), tinggi sparkbar log, maupun mode responsif dikendalikan 100% melalui class di [styles.css](../styles.css). **Dilarang keras** menggunakan atribut `style="..."` atau mutasi `.style.*` di JavaScript agar CSP `style-src 'self'` selalu lolos tanpa pelanggaran.
2. **Dark-First Dual Theme:** Default menggunakan Dark theme berbasis slate obsidian (`#090b10`), didukung Light theme kontras tinggi (`#f8fafc`), serta mode `System` yang mengikuti `prefers-color-scheme`. Preferensi disimpan lokal di `localStorage` (`nexa_pulse_prefs`) tanpa memakai RAM server.
3. **Resilience During Server Restart:** Banner status offline dan koneksi log `/io/logs` berdiri independen dari koneksi REST/WS Node.js. Ketika operator menekan **Restart Server**, log startup `systemd` dan `nexa-server` tetap tampil live saat Node.js mati sesaat dan menyala kembali.

---

## 2. Identitas Visual & Design Tokens

### Brand Mark (`❯N`)
Logo resmi N.E.X.A Pulse Monitor ([favicon.svg](../favicon.svg) & `index.html`) adalah monogram geometris **`❯N`** — terdiri dari chevron miring rata (*tall flat-cut chevron*) di kiri dan huruf **`N`** proporsi seragam di kanan, dikemas di dalam wadah rounded square `.visor-mark` (`26×26px` di topbar, `44×44px` di layar Sign-In).

### Palet Warna Utama

| Token CSS | Dark Theme (Default) | Light Theme | Fungsi |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#090b10` | `#f8fafc` | Latar belakang utama halaman |
| `--bg-surface` | `#10131a` | `#ffffff` | Latar card, topbar, sidebar, login card |
| `--bg-elevated` | `#161b24` | `#f1f5f9` | Hover state & elemen aktif |
| `--bg-console` | `#0b0e14` | `#ffffff` | Viewport konsol log |
| `--border-hairline` | `rgba(255,255,255,0.07)` | `rgba(15,23,42,0.08)` | Garis pemisah tipis antarkomponen |
| `--text-primary` | `#f3f4f6` | `#0f172a` | Teks judul & nilai KPI utama |
| `--text-secondary` | `#9ca3af` | `#475569` | Teks deskripsi & metadata tabel |
| `--text-muted` | `#6b7280` | `#64748b` | Timestamp log, placeholder, label sekunder |
| `--accent` | `#22d3ee` | `#0891b2` | Aksen primer Cyan (sparkline, tombol aktif, focus ring) |
| `--emerald` | `#10b981` | `#059669` | Status sehat (`Healthy`, `Online`, `Active`) |
| `--amber` | `#f59e0b` | `#d97706` | Peringatan (`Degraded`, `Paused`, `Restart`) |
| `--rose` | `#f43f5e` | `#e11d48` | Insiden / fatal (`Incident`, `Errors`, `OPEN breaker`) |
| `--log-text` | `#e5e7eb` | `#111827` | **Teks seragam seluruh isi log** (monochrome) |

### Tipografi
- **UI Sans:** `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` (ukuran dasar `13.5px`, line-height `1.5`).
- **Telemetry & Log Monospace (`.mono`):** `"JetBrains Mono", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` dengan `font-variant-numeric: tabular-nums` agar angka CPU/RAM/timestamp tidak bergeser ke kiri-kanan setiap tick 2 detik.

---

## 3. Arsitektur Shell & Navigasi Global

Setelah login, operator masuk ke shell persisten (`index.html`):

```text
+-----------------------------------------------------------------------+
| [❯N] N.E.X.A Pulse Monitor  [● Online · 2h · main@224dea1]            |
|                                  [Search Ctrl K] [☾] [user · 11h] Off |
+----------------+------------------------------------------------------+
| ⊞ Overview     |                                                      |
| ∿ Metrics      |  [!] Offline Banner (jika koneksi /api terputus)     |
| ≡ Logs         |                                                      |
| △ Issues   [0] |                                                      |
| ⚙ Controls     |               ACTIVE VIEW WORKSPACE                  |
|                |                   (#view-root)                       |
| -------------- |                                                      |
| VPS MEMORY 58% |                                                      |
| [========----] |                                                      |
| 893M  374Mfree |                                                      |
| Swap 70M Dsk24%|                                                      |
+----------------+------------------------------------------------------+
```

- **Topbar (`48px`):** Menampilkan brand mark `❯N`, status live server + uptime + Git branch/commit, tombol pencarian cepat (`Ctrl K` / `Cmd K`), pengalih tema Dark/Light, sisa masa berlaku sesi (`username · TTL`), dan tombol `Sign out`.
- **Slim Navigation Rail (Sidebar):** Berisi 5 rute utama (`#overview`, `#metrics`, `#logs`, `#issues` lengkap dengan badge live jumlah issue unresolved, `controls`) plus widget permanen **VPS MEMORY / Swap / Disk** di kaki sidebar yang selalu terlihat dari halaman mana pun.
- **Command Palette (`Ctrl+K` / `Cmd+K`):** Modal navigasi cepat untuk melompat ke halaman manapun, membuka `Logs (Errors Only)`, menjalankan `Restart nexa-server`, `Reset Runtime Metrics`, `Reset AI Circuit Breakers`, atau mengganti tema tanpa menyentuh mouse.
- **Restart Confirmation & Live Stepper Modal:** Saat `Restart Server` diklik, dialog memberi peringatan khusus jika ada **Live Voice Call** yang aktif, lalu menampilkan progres 3 langkah secara live (`1. Polkit SIGTERM → 2. Draining & Respawn → 3. Polling PID baru`).

---

## 4. Rincian 6 Layar Utama

### 1. Sign-In Gate
- Kartu tunggal bersih di tengah layar (`max-width: 400px`) dengan brand mark `❯N`, hostname aktif, input Username & Password dengan tombol **Show / Hide**, serta footer indikator keamanan.
- Sebelum login, endpoint status sama sekali tidak membocorkan informasi versi OS, RAM, maupun struktur server.

### 2. Overview (`#overview`)
1. **Top Action Header:** Indikator waktu update relatif (`Live · updated just now`), tombol cepat `Open Logs`, `Reset Monit`, dan `Restart Server`.
2. **4 KPI Cards dengan Live Sparkline:**
   - **CPU Usage:** % proses Node.js, vCPU count, load average, total CPU host, dan sparkline Canvas 2D yang ikut bergerak di setiap tick `2 detik`.
   - **Memory:** Node RSS MiB, detail V8 Heap (`Used / Total MiB` & `%`), `MemAvailable` VPS, dan progress meter yang menandai batas **`320M High`** vs **`420M Max`**.
   - **Event Loop Delay:** Mean ms, P95 ms, Max ms (`perf_hooks`), dan sparkline Emerald.
   - **HTTP & Issues:** Throughput `req/m`, Mean ms, P95 ms, ringkasan jumlah issue `1h / 24h / 7d`, dan sparkline.
3. **Application Health Heatmap (Last 7 Days):** Grid **`7 × 24 = 168 sel`** (per jam dalam zona waktu **WIB**), persentase jam sehat, serta tooltip detail setiap jam (`Avg RSS`, `Max CPU`, `P95 EL`, `Issues`).
4. **Services & Bridges Matrix:** Tabel status langsung untuk 4 unit VPS (`nexa-server.service`, `nexa-log.service`, `nexa-term.service`, `caddy.service`) serta status koneksi real-time **Mobile Bridge (Galaxy A33)** dan **Windows Bridge (ThinkPad)** beserta RTT ms dan pintasan langsung ke **Logs**.
5. **Runtime & Git Versioning + N.E.X.A Telemetry Snapshot:** Repository, Git commit & status working tree (`Clean`/`Unstaged`), Node/V8 version, PID, restarts, Host/Private IP, Disk `/`, Swap, plus 6 metrik domain (Active Handles, In-Flight Requests, Live Voice Calls, AI Req/min, Offline Notif Queue, Enrolled Devices).
6. **AI Providers & Circuit Breakers:** Menampilkan state setiap grup provider AI (`CLOSED`/`HALF_OPEN`/`OPEN`), API keys dalam masa `COOLDOWN` beserta sisa detiknya, dan tombol `Reset Breakers`.
7. **Scheduled Background Jobs (Cron):** Tabel seluruh cron job terjadwal (jadwal WIB, status `OK`/`Failed`/`Scheduled`, kapan terakhir berjalan, durasi ms, serta rasio `Runs / Fails`).

### 3. Metrics (`#metrics`)
Menyediakan eksplorasi grafik Canvas 2D HiDPI (`charts.js` — class `SyncedChartGroup`):
- **Time Range:** `Live (2s)` (menyimpan hingga 180 titik live, diawali seed 60 sampel 1 jam terakhir agar langsung terisi saat dibuka), `1h`, `6h`, `24h`, dan `7d` (diambil dari `monitor_metrics_7d.bin`).
- **Group Filter:** `All`, `System & V8`, `HTTP & Runtime`, `N.E.X.A Domain`.
- **Synchronized Crosshair & Threshold Line:** Menggerakkan kursor di satu grafik akan menyinkronkan garis vertikal crosshair + nilai tooltip pada seluruh grafik lain di layar secara bersamaan. Grafik Memory menampilkan garis putus-putus ambang **`320 MiB High`**.

### 4. Logs (`#logs` — Full-Bleed Pure Monochrome White)
Halaman ini mengambil area penuh (*full-bleed*) untuk pengalaman membaca log setara terminal developer:
- **Prinsip Pure Monochrome White (`styles.css` & `logs.js`):** Seluruh teks pesan log (baik `INFO`, `WARN`, `ERROR`, maupun stack trace) ditampilkan dengan warna teks bersih seragam (`--log-text`), sedangkan timestamp format ringkas (`22 Nov 13:08:02.124`) dan nama unit memakai abu-abu netral (`--log-meta`) tanpa kotak/badge warna-warni agar mata tidak cepat lelah saat memindai ribuan baris.
- **Kontrol Toolbar:**
  - Status live socket (`/io/logs`)
  - Preset kategori (`All`, `Errors`, `Core`, `Bridge`, `Finance`, `Auth`) — dikirim langsung ke `nexa-io` via frame `OPEN` in-place
  - Filter Unit (`All Units`, `nexa-server`, `caddy`, `nexa-io`, `systemd`)
  - Pencarian real-time lokal (pintasan keyboard `/`)
  - `Tail 100 / 200 / 500` (disinkronkan dengan Console Preferences)
  - `Pause / Resume` (mengaktifkan backpressure `CREDIT` sesungguhnya)
  - `Wrap` (aktif secara default agar baris panjang tidak memunculkan scrollbar horizontal di setiap baris)
  - `Export` (mengunduh log yang sedang tampil menjadi file `.log` lokal di browser)
  - `Clear` dan penghitung kapasitas ring buffer (`N / 2,000`)
- **Fitur Interaktif Tambahan:**
  - Baris stack trace (`at ...`) otomatis dikelompokkan di bawah baris error induk dalam toggle **`▸ N frames`** yang bisa dibuka-tutup.
  - Tombol **`Copy`** muncul saat baris di-hover untuk menyalin 1 entri beserta stack trace-nya ke clipboard.
  - **Minimap Canvas** di sisi kanan menampilkan kepadatan log dan dapat diklik untuk melompat cepat.
  - Pil mengambang **`Latest ↓ · +N new`** muncul otomatis jika operator menggulir ke atas untuk membaca log lama.

### 5. Issues (`#issues`)
- Ringkasan KPI error (`Last 1 Hour`, `Last 24 Hours`, `Last 7 Days`, `Unresolved`), tab status (`Unresolved`, `Resolved`, `All`), live search, dan `Clear Resolved`.
- Setiap baris menampilkan severity dot, label `[SUBSYSTEM]` (mis. `[HTTP-5XX]`, `[CORE]`, `[FALLBACK]`, `[CRON]`, `[BRIDGE]`), culprit/route, commit hash, jumlah kemunculan (`Nx`), **mini sparkbar 24 jam**, serta waktu terakhir terlihat.
- Mengklik baris membuka **Slide-Over Detail Inspector** berisi metadata lengkap, **Normalized Stack Trace (`FR-SEC-04 redacted`)**, riwayat 6 kejadian terakhir, serta tombol `Mark Resolved`, `Reopen`, dan `Jump to Logs`.

### 6. Controls & Security (`#controls`)
1. **Service Operations:** `Restart Server` (Polkit SIGTERM), `Reset AI Circuit Breakers`, `Reset Runtime Metrics (RESET MONIT)`, dan status read-only **Remote Terminal Kill Switch** (`/opt/nexa/etc/terminal.enabled`).
2. **Proactive Alerts (Editable):**
   - Indikator route aktif (`Mobile Bridge` vs `Telegram Fallback`).
   - Input `Cooldown` global (`1..120 min`) dan tombol **`Send Test Alert`**.
   - Pengaturan per rule (`High Node RSS Memory`, `Low VPS Available RAM`, `Event Loop Stall`, `HTTP 5xx Spike`, `Fatal Exception`): toggle On/Off, nilai threshold numerik, dan durasi sustained dalam menit.
3. **Console Preferences (Local Browser — 0 Server RAM):**
   - `Theme Mode`: `Dark` / `Light` / `System`
   - `Logs Console Font Size`: `Compact` / `Default` / `Comfort`
   - `Default Log Tail Lines`: `100` / `200` / `500`
   - `Live Metrics Refresh Cadence`: `Live (2s)` / `Eco (5s)`
4. **Account & Active Sessions + Security Audit Log:** Daftar sesi yang sedang login beserta browser/OS, IP, sisa TTL, tombol `Sign Out All`, panduan CLI rotasi password, serta daftar 12 peristiwa keamanan terbaru (login ok/fail, ticket minted, restart, perubahan alert/breaker).

---

## 5. Responsive Breakpoints

- **Desktop (`> 1120px`):** Sidebar selalu terlihat di kiri; KPI 4 kolom; chart & detail 2 kolom; Issues + Detail Drawer berdampingan.
- **Tablet (`<= 1120px`):** KPI turun menjadi 2 kolom; grid chart, panel split-2, dan drawer Issues berubah ke 1 kolom bertumpuk.
- **Compact / Mobile Viewport (`<= 820px`):** Tombol menu burger muncul di topbar; sidebar menjadi slide-over drawer (`z-index: 60`); status pill dan session pill disembunyikan agar header tidak penuh sesak; kolom unit pada Logs disembunyikan demi keterbacaan pesan.
