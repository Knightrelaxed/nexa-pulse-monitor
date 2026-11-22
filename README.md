# N.E.X.A Pulse Monitor

Minimalist, self-hosted desktop web observability console for **N.E.X.A Server** (`892 MiB` Azure VPS).

Built as a **100% static Vanilla HTML + CSS + ES Modules** frontend served directly by **Caddy** under `/monitor` — **zero bundler, zero npm dependencies, zero external CDN requests, and zero inline scripts/styles** (`Content-Security-Policy: default-src 'self'`).

---

## Architecture & Screens

| Screen | Route | Data Source |
| :--- | :--- | :--- |
| **Sign In** | Gate | `POST /monitor/api/auth/login` (`scrypt` + `HttpOnly; Secure; SameSite=Strict` cookie + `X-Nexa-Monitor: 1`) |
| **Overview** | `#/overview` | `GET /monitor/api/overview` + live `WS /monitor/ws/metrics` (2s) |
| **Metrics** | `#/metrics` | `GET /monitor/api/metrics/history?range=1h\|6h\|24h\|7d` + synced Canvas 2D charts |
| **Logs** | `#/logs` | Direct binary stream `WSS /io/logs` via Go `nexa-io` (`Sec-WebSocket-Protocol: nexa-io-v1, nexa-ticket.<ed25519>`), pure monochrome white console |
| **Issues** | `#/issues` | `GET /monitor/api/issues`, deduplicated fingerprinting & `FR-SEC-04` redacted stack traces |
| **Controls** | `#/controls` | Polkit graceful restart, `RESET MONIT`, proactive Mobile Bridge alerts, active sessions & audit trail |

---

## Local Demo Preview

No `npm install` required. Requires Node.js v18+.

```bash
node dev-preview.js
```

Open `http://127.0.0.1:4173/monitor/` and sign in with demo credentials:
- **Username:** `admin`
- **Password:** `nexa-demo`

---

## Protocol & CSP Verification

```bash
node verify_protocol.mjs
```

Verifies:
1. Zero inline `style="..."` or `.style.*` usage across all HTML/JS files (strict `style-src 'self'` CSP compliance).
2. Byte-for-byte wire-format parity of `js/logs_client.js` with `nexa-io/internal/proto/frame.go` (`ChLogs=0x03`, `OPEN`, `CREDIT`, `CLOSE`, `PONG`, and 13-byte `LogRecord` decoding).

---

## Production Serving (Caddy)

Caddy serves static files from `/opt/nexa/pulse-monitor` at `/monitor/*` with strict CSP, and reverse-proxies `/monitor/api/*` and `/monitor/ws/metrics` to `127.0.0.1:3000` (`nexa-server`), while `/io/logs` routes directly to the `nexa-io` Go sidecar.
