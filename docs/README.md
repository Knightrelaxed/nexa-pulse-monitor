# Dokumentasi N.E.X.A Pulse Monitor

Selamat datang di direktori dokumentasi resmi **N.E.X.A Pulse Monitor** — konsol observabilitas web self-hosted yang minimalis, zero-dependency, dan ringan (`~155 KiB` aset statis, `0 MiB` idle sidecar overhead) untuk memantau ekosistem **N.E.X.A Server** pada VPS produksi (`892 MiB` RAM Azure B1s).

Proyek ini menggantikan ketergantungan eksternal **PM2 / PM2+ (`app.pm2.io`)** dan bekerja berdampingan dengan backend Node.js (`nexa-server`) serta sidecar Go (`nexa-io`).

---

## Indeks Dokumentasi

| Dokumen | Fokus Pembahasan |
| :--- | :--- |
| [01-SYSTEM-ARCHITECTURE.md](./01-SYSTEM-ARCHITECTURE.md) | Topologi sistem end-to-end, pemisahan repositori frontend vs backend, orkestrasi `systemd` & Caddy, socket-activation `nexa-io`, persistensi binary ring 7 hari, serta anggaran RAM VPS (`892 MiB`). |
| [02-CONNECTION-AND-PROTOCOLS.md](./02-CONNECTION-AND-PROTOCOLS.md) | Spesifikasi lengkap REST API (`/monitor/api/*`), WebSocket JSON live metrics (`/monitor/ws/metrics`), serta protokol biner WebSocket (`/io/logs`) lengkap dengan skema frame big-endian, flow-control `CREDIT`, dan `PING` keepalive. |
| [03-UI-UX-DESIGN-SYSTEM.md](./03-UI-UX-DESIGN-SYSTEM.md) | Prinsip desain antarmuka, identitas brand (`❯N`), token CSS Dark/Light theme, tata letak shell, Command Palette (`Ctrl+K`), engine grafik Canvas 2D HiDPI, standar log Pure Monochrome White, dan breakdown seluruh 6 layar UI. |
| [04-SECURITY-HARDENING.md](./04-SECURITY-HARDENING.md) | Threat model dan lapisan pertahanan: strict CSP (`default-src 'self'`), autentikasi `scrypt`, sesi cookie `HttpOnly; SameSite=Strict`, proteksi CSRF, tiket Ed25519 single-use, Polkit least-privilege, sandbox systemd, dan redaksi rahasia `FR-SEC-04`. |
| [05-OPERATIONS-AND-DEPLOYMENT.md](./05-OPERATIONS-AND-DEPLOYMENT.md) | Panduan preview lokal (`dev-preview.js`), verifikasi otomatis (`verify_protocol.mjs`), prosedur deployment VPS (Frontend + Backend), manajemen password CLI, dan runbook troubleshooting insiden produksi. |

---

## Ringkasan Peta Endpoint Produksi

- **URL Konsol Web:** `https://nexa-server.indonesiacentral.cloudapp.azure.com/monitor/`
- **Static Assets (Caddy):** `/opt/nexa/nexa-pulse-monitor` → `https://.../monitor/*`
- **Backend API & Metrics WS (`nexa-server.service` port `3000`):**
  - REST API: `/monitor/api/*`
  - Live Telemetry WebSocket: `wss://.../monitor/ws/metrics`
- **Go Sidecar Log Streamer (`nexa-log.socket` → `nexa-log.service`):**
  - Binary Log WebSocket: `wss://.../io/logs` (Unix socket `/run/nexa-log.sock`)
- **Repositori Terkait:**
  - Frontend Konsol Web: [`Knightrelaxed/nexa-pulse-monitor`](https://github.com/Knightrelaxed/nexa-pulse-monitor)
  - Backend Telemetri & Sidecar Go: [`Knightrelaxed/nexa-server`](https://github.com/Knightrelaxed/nexa-server) (`src/monitor/` dan `nexa-io/`)
