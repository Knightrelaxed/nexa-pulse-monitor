# 04 — Arsitektur Keamanan & Threat Model

N.E.X.A Pulse Monitor mengelola data kesehatan infrastruktur produksi serta kemampuan restart server jarak jauh. Oleh karena itu, keamanan dibangun dengan pendekatan **defense-in-depth** dari lapisan edge proxy hingga kernel Linux.

---

## 1. Perimeter Edge & Content Security Policy (Caddy)

Pada `/etc/caddy/Caddyfile`, seluruh respons `/monitor/*` membawa header keamanan ketat:

| Header | Nilai | Perlindungan |
| :--- | :--- | :--- |
| `Content-Security-Policy` | `default-src 'self'; connect-src 'self' wss://nexa-server.indonesiacentral.cloudapp.azure.com; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'` | Menutup celah eksekusi skrip pihak ketiga, inline `<script>`, inline `style=`, serta memblokir clickjacking iframe. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Memaksa TLS 1.3 di seluruh komunikasi browser. |
| `X-Content-Type-Options` | `nosniff` | Mencegah MIME-type sniffing. |
| `X-Frame-Options` | `DENY` | Perlindungan legacy anti-clickjacking. |
| `X-Robots-Tag` | `noindex, nofollow` | Mencegah mesin pencari mengindeks panel operator. |
| `Referrer-Policy` | `no-referrer` | Tidak pernah membocorkan URL konsol ke pihak ketiga. |
| `Cache-Control` | `no-store` (API), `no-cache` (static) | Memastikan data telemetri sensitif & sesi tidak di-cache oleh proxy perantara. |

Di sisi UI JavaScript, seluruh string dinamis dari log, commit git, nama cron, user-agent, dan stack trace melewati fungsi `escapeHtml()` sebelum dirender ke DOM.

---

## 2. Autentikasi Single-User & Proteksi Sesi (`auth_service.js`)

- **Zero External Auth Dependencies:** 100% dibangun menggunakan modul bawaan `node:crypto`.
- **Password Hashing `scrypt`:**
  - Parameter: `N = 16384`, `r = 8`, `p = 1`, panjang kunci `32 byte` dengan salt acak `16 byte` per hash (`scrypt$16384$8$1$<saltHex>$<keyHex>`).
  - Pembandingan username dan password menggunakan `crypto.timingSafeEqual`. Jika username salah, server tetap mengeksekusi verifikasi terhadap `DUMMY_SCRYPT_HASH` untuk mencegah timing side-channel enumeration.
- **Session Cookie Hardening:**
  - Cookie `nexa_mon_sid` dibuat dengan flag **`HttpOnly; SameSite=Strict; Path=/monitor`** (+ **`Secure`** di belakang HTTPS Caddy). Token tidak pernah dapat dibaca oleh `document.cookie` / JavaScript.
  - Masa berlaku default **`12 jam`** (`DEFAULT_SESSION_TTL_MS`), batas keras absolut **`24 jam`** (`MAX_SESSION_LIFETIME_MS`).
  - Batas sesi aktif bersamaan: **`MAX_ACTIVE_SESSIONS = 4`** untuk mencegah penyalahgunaan sesi paralel berlebih.
- **Proteksi Brute-Force:**
  - Maksimal **`5` percobaan gagal per IP** dalam jendela **`15 menit`**.
  - Pelanggaran memicu lockout **`15 menit`** (`HTTP 429` + header `Retry-After`), tercatat di Security Audit Log (`AUTH_LOCKOUT`), serta mengirim **alert proaktif ke Mobile Bridge / Telegram**.
- **Anti-CSRF (Dual Layer):**
  1. Validasi `Origin` / `Referer` terhadap allowlist domain tepercaya (`buildAllowedOrigins`).
  2. Wajib menyertakan custom header **`X-Nexa-Monitor: 1`** pada seluruh request mutasi (`POST`), sehingga `<form>` lintas situs tidak pernah bisa memalsukan permintaan.

---

## 3. Autentikasi WebSocket & Tiket Single-Use Ed25519

1. **`/monitor/ws/metrics`:**
   - Memverifikasi `Origin` (`403` jika di luar allowlist) dan cookie `nexa_mon_sid` (`401` jika tidak ada/expired) tepat saat fase HTTP Upgrade sebelum handshake WebSocket disetujui.
   - Jika operator mengklik **Sign Out All** (`POST /monitor/api/auth/sessions/revoke-all`), seluruh socket metrik yang masih terbuka langsung diputus dengan kode `4001`.
2. **`/io/logs` (`nexa-io`):**
   - Browser tidak pernah mengirim tiket lewat query string URL (yang berisiko tercatat di access log). Browser mengirimkannya lewat **`Sec-WebSocket-Protocol: nexa-io-v1, nexa-ticket.<ticket>`**.
   - Tiket ditandatangani secara kriptografis menggunakan **Ed25519** oleh `ticket_service.js` (`nexa-server`), berumur pendek **`45 detik`**, memiliki **JTI single-use** (anti-replay), dan diikat ke IP/perangkat (`web-monitor-<sessionPrefix>`).
   - `nexa-io` memverifikasi signature menggunakan public key read-only `/etc/nexa/ticket-pub.pem` yang disuntikkan via systemd `LoadCredential`, serta menerapkan **IP rate limiter token-bucket** (`IPRateLimiter`: 30/menit, burst 15).

---

## 4. Isolasi OS, Polkit & Proteksi Data Sensitif

### A. Least-Privilege Restart via Polkit
User `nexa` yang menjalankan Node.js tidak memiliki akses `sudo` maupun hak mengubah sistem. Satu-satunya aksi istimewa yang diizinkan adalah rule Polkit `/etc/polkit-1/rules.d/51-nexa-monitor.rules`:
- **Hanya** berlaku untuk `subject.user === "nexa"`.
- **Hanya** mengizinkan aksi `org.freedesktop.systemd1.manage-units` dengan `unit === "nexa-server.service"` dan `verb === "restart"`.
- Di sisi Node.js (`SystemdInspector`), perintah dipanggil via `execFile('systemctl', ['--no-block', 'restart', 'nexa-server.service'])` — tanpa shell (`sh -c`), sehingga tidak ada celah command injection.

### B. Hardening Unit `systemd`
- **`nexa-server.service`:** `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=full`, `ReadWritePaths=/home/nexa/nexa-server /var/lib/nexa /etc/nexa -/var/log/nexa`.
- **`nexa-log.service`:** Berjalan dengan user non-root `nexa-log`, `SupplementaryGroups=systemd-journal`, `NoNewPrivileges=yes`, `PrivateDevices=yes`, `PrivateNetwork=yes`, `ProtectHome=yes`, `ProtectSystem=strict`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`, `ProtectControlGroups=yes`, `ProtectProc=invisible`, `ProcSubset=all` (minimal agar `journalctl -f` dapat membaca `boot_id`), `RestrictAddressFamilies=AF_UNIX`, `MemoryDenyWriteExecute=yes`, `CapabilityBoundingSet=`, serta memblokir akses ke folder source & `/etc/nexa` (`InaccessiblePaths=-/opt/nexa/server /etc/nexa -/home/nexa/nexa-server`).

### C. Hardware Kill Switch & Redaksi Rahasia (`FR-SEC-04`)
- **Terminal Kill Switch Read-Only:** Web Monitor tidak menyediakan tombol maupun API untuk menyalakan terminal jarak jauh; file `/opt/nexa/etc/terminal.enabled` hanya bisa diubah lewat sesi SSH langsung.
- **Redaksi Rahasia Otomatis:**
  - Di `IssueTracker` (`src/monitor/issue_tracker.js`): seluruh pesan error, route, dan stack trace dibersihkan oleh `redactSecrets()` sebelum disimpan ke RAM/disk. Query string URL dihilangkan pada fingerprint/sanitasi route.
  - Di `nexa-io` (`internal/proto/frame.go`): regex `tokenSafetyRegex` mendeteksi dan menyensor pola `Bearer ...`, kunci Google (`AIza...`), Groq (`gsk_...`), OpenAI/Anthropic (`sk-...`), token JWT (`eyJ...`), serta parameter URL `?ticket=` / `?token=` sebelum log dikirim ke browser. Selain itu, tag `[cat=SYNTHETIC]` dilindungi agar tidak dapat dipalsukan dari teks log aplikasi.
