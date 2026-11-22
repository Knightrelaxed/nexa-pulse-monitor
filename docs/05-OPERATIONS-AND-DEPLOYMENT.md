# 05 — Panduan Deployment, Operasi & Troubleshooting

Dokumen ini berisi panduan praktis untuk menjalankan preview lokal, memverifikasi protokol, men-deploy pembaruan frontend dan backend ke VPS, mengganti kredensial operator, serta menangani kasus operasional yang umum ditemui.

---

## 1. Struktur Proyek & Peta File

### A. Frontend (`nexa-pulse-monitor`)
```text
nexa-pulse-monitor/
├── docs/                                # Dokumentasi proyek (dokumen ini)
├── js/
│   ├── api.js                           # Fetch wrapper (CSRF X-Nexa-Monitor), MetricsSocketClient, formatter WIB
│   ├── app.js                           # Router hash, shell status, Ctrl+K palette, Restart modal, localStorage prefs
│   ├── charts.js                        # Engine Canvas 2D HiDPI (drawSparkline + SyncedChartGroup crosshair)
│   ├── logs_client.js                   # Client WebSocket biner /io/logs + flow-control CREDIT + 20s PING keepalive
│   └── views/
│       ├── overview.js                  # Dashboard KPI, Heatmap 168-jam, Services/Bridges, AI Breakers, Cron
│       ├── metrics.js                   # Grafik multi-seri sinkron (Live 2s & 1h/6h/24h/7d)
│       ├── logs.js                      # Konsol log Pure Monochrome White + minimap + export .log
│       ├── issues.js                    # Tabel issue terdeduplikasi + detail drawer
│       └── controls.js                  # Service ops, threshold alert editable, preferences, sessions & audit log
├── dev-preview.js                       # Server preview lokal zero-dependency (mock API + WS + CSP)
├── verify_protocol.mjs                  # Test suite format frame biner Go-JS parity & zero inline CSS
├── favicon.svg                          # Ikon vektor ❯N
├── index.html                           # Single-page shell & modal markup
├── styles.css                           # Design tokens Dark/Light & layout stylesheet (CSP safe)
└── README.md
```

### B. Komponen Terkait di Backend (`nexa-server`) & VPS
- **Backend Node.js (`c:\workspace\nexa-server\src\monitor\`):** `index.js`, `router.js`, `ws_metrics.js`, `auth_service.js`, `metrics_collector.js`, `history_store.js`, `issue_tracker.js`, `alert_engine.js`, `systemd_inspector.js`.
- **CLI Password (`c:\workspace\nexa-server\scripts\`):** `nexa_monitor_set_password.js`.
- **Go Sidecar (`c:\workspace\nexa-server\nexa-io\`):** `cmd/nexa-io/main.go`, `internal/proto/frame.go`, `internal/logstream/streamer.go`, `systemd/nexa-log.service`.
- **Config Infrastruktur (`c:\workspace\nexa-server\deploy\`):** `caddy/Caddyfile.pulse-monitor`, `systemd/nexa-server.service`, `systemd/51-nexa-monitor.rules`.
- **Lokasi Deploy di VPS:**
  - Frontend Statis: `/opt/nexa/nexa-pulse-monitor`
  - Backend Node.js: `/home/nexa/nexa-server` (state persisten di `/var/lib/nexa`)
  - Binary Go Sidecar: `/opt/nexa/bin/nexa-io`

---

## 2. Pengembangan & Verifikasi Lokal

### Menjalankan Local Demo Preview (Zero-Dependency)
Membutuhkan Node.js v18+ tanpa perlu `npm install`:
```bash
node dev-preview.js
```
Buka `http://127.0.0.1:4173/monitor/` dan login dengan kredensial demo bawaan:
- **Username:** `admin`
- **Password:** `nexa-demo`

Server preview mensimulasikan header CSP produksi ketat, seluruh endpoint `/monitor/api/*`, live WebSocket `/monitor/ws/metrics`, serta streaming frame biner `/io/logs` lengkap dengan `Sec-WebSocket-Protocol`.

### Verifikasi Protokol & CSP Frontend
Jalankan setiap kali mengubah `js/logs_client.js`, `index.html`, atau file JS view:
```bash
node verify_protocol.mjs
```
Skrip ini memvalidasi:
1. Kesetaraan byte-per-byte (`OPEN`, `CREDIT`, `CLOSE`, `PING`, `PONG`, dan 13-byte `LogRecord`) antara JavaScript dan spesifikasi `nexa-io/internal/proto/frame.go`.
2. Nol pemakaian `style="..."` atau `.style.*` di seluruh file HTML/JS (kepatuhan ketat `style-src 'self'`).

### Verifikasi Backend & Go Sidecar (di `nexa-server`)
```bash
# Node.js unit & integration tests
npm test

# Go sidecar unit & race tests (Linux/VPS atau mesin dengan Go terpasang)
cd nexa-io && go test -race ./...
```

---

## 3. Deployment ke VPS Produksi

### A. Update Frontend (`nexa-pulse-monitor`)
Setelah perubahan di-commit dan di-push ke branch `main`:
```bash
ssh nexa-server
cd /opt/nexa/nexa-pulse-monitor
git pull --ff-only origin main
```
Caddy menyajikan file statis secara langsung dengan header `Cache-Control: no-cache`, sehingga refresh browser (`Ctrl+F5`) akan langsung memuat versi terbaru tanpa perlu restart layanan apa pun.

### B. Update Backend (`nexa-server` & `nexa-io`)
Gunakan skrip deploy otomatis di `/home/nexa/nexa-server/deploy.sh`:
```bash
ssh nexa-server
cd /home/nexa/nexa-server
bash deploy.sh
```
`deploy.sh` otomatis menjalankan:
1. `git pull --ff-only origin main` + `npm ci --omit=dev` (jika `package-lock.json` berubah).
2. `npm test` (deployment dibatalkan bila ada test gagal).
3. Apabila folder `nexa-io/` ikut berubah dan compiler `go` tersedia, skrip akan menjalankan `go test -race ./...`, mem-build binary statis baru ke `/opt/nexa/bin/nexa-io`, dan me-restart `nexa-log.socket` & `nexa-term.socket`.
4. Merestart `nexa-server.service` secara bersih via `systemctl restart nexa-server.service`.

### C. Update Konfigurasi Caddy atau Unit Systemd (Bila Berubah)
- Untuk perubahan `/etc/caddy/Caddyfile`: validasi dulu dengan `sudo caddy validate --config /etc/caddy/Caddyfile`, lalu jalankan **`sudo systemctl restart caddy`** (bukan `reload`, karena `admin off` dinonaktifkan).
- Untuk perubahan `/etc/systemd/system/*.service`: jalankan `sudo systemctl daemon-reload` diikuti restart service terkait.

---

## 4. Manajemen Kredensial Operator

Untuk membuat atau mengganti password operator **N.E.X.A Pulse Monitor**, jalankan CLI pada backend `nexa-server`:
```bash
cd /home/nexa/nexa-server
node scripts/nexa_monitor_set_password.js --user faqihhidayat
```
Skrip menghasilkan dua baris konfigurasi:
```dotenv
NEXA_MONITOR_USER=faqihhidayat
NEXA_MONITOR_PASS_HASH=scrypt$16384$8$1$<saltHex>$<keyHex>
```
Tempelkan ke `/home/nexa/nexa-server/.env` (pastikan izin file tetap `chmod 0600`), lalu restart `nexa-server.service` dan verifikasi dari log startup atau endpoint `/monitor/api/auth/status`.
> **Catatan Penting:** Jangan pindahkan `NEXA_MONITOR_PASS_HASH` ke direktif systemd `EnvironmentFile=` tanpa meng-escape `$` (`$$`), karena systemd menginterpretasikan `$...` sebagai ekspansi variabel environment. Pengisian di `.env` dibaca aman secara literal oleh `dotenv` Node.js.

---

## 5. Runbook Troubleshooting

| Gejala | Akar Masalah | Langkah Verifikasi & Solusi |
| :--- | :--- | :--- |
| **Tab Logs berstatus `● Live · /io/logs` tetapi tampil `0 / 2,000` baris (Web & Mobile Bridge)** | Setelah migrasi ke systemd (tanpa `/var/log/nexa/out.log`), `journalctl -f` di dalam `nexa-log.service` gagal jika `ProcSubset=pid` aktif (karena `/proc/sys/kernel/random/boot_id` tersembunyi) atau user `nexa-log` tidak tergabung di grup `systemd-journal`. | 1. Pastikan `id nexa-log` mencakup grup `systemd-journal` (`sudo usermod -aG systemd-journal nexa-log`).<br>2. Pastikan `/etc/systemd/system/nexa-log.service` memakai **`ProcSubset=all`** (tetap mempertahankan `ProtectProc=invisible`).<br>3. Jalankan `sudo systemctl daemon-reload && sudo systemctl stop nexa-log.service` (socket akan membangunkannya ulang pada koneksi berikutnya). |
| **Koneksi `/io/logs` putus-nyambung tiap ~45 detik atau muncul `429 Too many log ticket requests`** | `nexa-io` menerapkan `DefaultReadDeadline = 45s`. Jika client tidak mengirim traffic periodik, socket ditutup dan loop reconnect memicu limit minting tiket. | Pastikan `LogsStreamClient` mengirim Control `PING` `[0x00, 0x07]` tiap `20 detik`, menjaga `connectSeq` guard agar socket lama tidak memicu reconnect timer baru, dan filter berubah lewat `OPEN` in-place tanpa membuat socket baru. |
| **Login gagal `HTTP 403 Forbidden: Missing CSRF verification header` / Origin error** | Permintaan `POST` tidak mengirim header `X-Nexa-Monitor: 1` atau domain di `Origin` belum masuk allowlist `cors_config`. | Pastikan reverse proxy tidak menghapus header custom dan URL akses sama persis dengan domain di `/etc/caddy/Caddyfile` (`nexa-server.indonesiacentral.cloudapp.azure.com`). |
| **`systemctl reload caddy` gagal dijalankan** | `/etc/caddy/Caddyfile` mengaktifkan `{ admin off }` untuk keamanan sehingga API admin reload dimatikan. | Gunakan `sudo systemctl restart caddy` setelah memvalidasi konfigurasi dengan `sudo caddy validate --config /etc/caddy/Caddyfile`. |
| **Event Loop Delay selalu terbaca `~20 ms` di masa idle** | `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` di Node.js menyertakan interval resolusi `20 ms` pada metrik `mean`/`percentile` bawaannya. | Sudah ditangani di `src/monitor/metrics_collector.js` dengan mengurangkan `_elResolutionMs` (`20`), sehingga nilai idle normal terbaca `0.1–0.3 ms`. |
| **Hash `scrypt` gagal saat diset lewat skrip shell** | Output banner `dotenv` v17 (`◇ injected env ...`) ikut tertangkap jika output skrip CLI di-capture mentah tanpa filter. | `scripts/nexa_monitor_set_password.js` sudah menyetel `process.env.DOTENV_CONFIG_QUIET = 'true'`. Pastikan nilai `NEXA_MONITOR_PASS_HASH` di `.env` diawali tepat oleh `scrypt$`. |
