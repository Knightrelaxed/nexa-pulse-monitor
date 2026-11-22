#!/usr/bin/env node
'use strict';
/**
 * ============================================================
 * N.E.X.A Pulse Monitor — Zero-Dependency Local Dev Preview Server
 *
 * Usage:
 *   node dev-preview.js                 # Demo mode on http://127.0.0.1:4173/monitor/
 *                                       # Demo login: admin / nexa-demo
 *   PORT=4174 node dev-preview.js       # Custom port
 *
 * Features:
 * - Enforces exact production strict CSP (default-src 'self', zero unsafe-inline)
 * - Full mock /monitor/api/* endpoints with real cookie + CSRF X-Nexa-Monitor check
 * - Built-in RFC 6455 WebSocket server (zero npm deps):
 *   - /monitor/ws/metrics (2s live ticks + PAUSE/RESUME)
 *   - /io/logs (validates Sec-WebSocket-Protocol nexa-io-v1 + nexa-ticket.*,
 *     decodes binary OPEN frame, streams real 13-byte binary LogRecord DATA frames)
 * ============================================================
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = __dirname;
const DEMO_USER = process.env.DEMO_USER || 'admin';
const DEMO_PASS = process.env.DEMO_PASS || 'nexa-demo';

const STRICT_CSP = "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ============================================================
// IN-MEMORY DEMO STATE
// ============================================================
const sessions = new Map();
const issuedTickets = new Set();
const startTs = Date.now() - (14 * 86400 + 6 * 3600 + 22 * 60) * 1000;

const alertRules = [
  { id: 'server_down', label: 'nexa-server Crash / Restart', priority: 'P0', description: 'Notify immediately when systemd restarts nexa-server or exits abnormally.', enabled: true },
  { id: 'ram_high', label: 'Node RSS > 300 MiB (3m sustained)', priority: 'P1', description: 'Alert before systemd MemoryHigh (320 MiB) throttling kicks in.', enabled: true },
  { id: 'vps_avail_low', label: 'VPS Available RAM < 120 MiB', priority: 'P1', description: 'Prevent OOM pressure on the 892 MiB Azure B1s instance.', enabled: true },
  { id: 'event_loop_lag', label: 'Event Loop P95 > 120 ms', priority: 'P1', description: 'Detect synchronous blocking on the single-threaded Node.js event loop.', enabled: true },
  { id: 'issue_spike', label: 'Issue Rate > 5 errors / 5 min', priority: 'P2', description: 'Alert on burst exceptions or HTTP 5xx spikes.', enabled: true }
];

const auditLog = [
  { ts: Date.now() - 1800 * 1000, event: 'AUTH_LOGIN_SUCCESS', severity: 'info', detail: `Operator "${DEMO_USER}" authenticated`, ip: '127.0.0.1' },
  { ts: Date.now() - 7200 * 1000, event: 'METRICS_RESET', severity: 'info', detail: 'In-memory HTTP & Event Loop histograms reset', ip: '127.0.0.1' }
];

const issues = [
  {
    fingerprint: 'ERR-4a8c19f2',
    subsystem: 'BRIDGE',
    severity: 'error',
    status: 'unresolved',
    title: 'WebSocket heartbeat timeout on windows-bridge (ThinkPad)',
    culprit: 'src/interfaces/bridge/gateway.js:184',
    route: 'WSS /ws',
    commit: '1647a8e',
    count: 4,
    firstSeenAt: Date.now() - 19 * 3600 * 1000,
    lastSeenAt: Date.now() - 14 * 60 * 1000,
    spark24h: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
    stack: `Error: Bridge heartbeat timeout after 45000ms\n    at Timeout._onTimeout (src/interfaces/bridge/gateway.js:184:19)\n    at listOnTimeout (node:internal/timers:581:17)\n    at process.processTimers (node:internal/timers:519:7)`,
    recentOccurrences: [
      { ts: Date.now() - 14 * 60 * 1000, route: 'WSS /ws', source: 'bridge' },
      { ts: Date.now() - 7 * 3600 * 1000, route: 'WSS /ws', source: 'bridge' }
    ]
  },
  {
    fingerprint: 'ERR-91d0e4b1',
    subsystem: 'AI-ROUTER',
    severity: 'warn',
    status: 'unresolved',
    title: 'Primary Gemini stream 429 rate-limit — fell back to secondary model',
    culprit: 'src/core/Fallback_Engine.js:241',
    route: 'POST /api/chat',
    commit: '1647a8e',
    count: 2,
    firstSeenAt: Date.now() - 31 * 3600 * 1000,
    lastSeenAt: Date.now() - 3 * 3600 * 1000,
    spark24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    stack: `ApiError: 429 RESOURCE_EXHAUSTED (token=[REDACTED-TOKEN])\n    at FallbackEngine.callPrimary (src/core/Fallback_Engine.js:241:15)\n    at FallbackEngine.execute (src/core/Fallback_Engine.js:118:22)`,
    recentOccurrences: [
      { ts: Date.now() - 3 * 3600 * 1000, route: 'POST /api/chat', statusCode: 429 }
    ]
  },
  {
    fingerprint: 'ERR-c3f02a77',
    subsystem: 'HTTP-5XX',
    severity: 'error',
    status: 'resolved',
    title: 'SQLite SQLITE_BUSY transient lock during nightly backup',
    culprit: 'src/database/sqlite.js:92',
    route: 'POST /api/finance/record',
    commit: 'a09d2c1',
    count: 1,
    firstSeenAt: Date.now() - 4 * 86400 * 1000,
    lastSeenAt: Date.now() - 4 * 86400 * 1000,
    spark24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    stack: `SqliteError: database is locked\n    at Database.prepare (src/database/sqlite.js:92:11)`,
    recentOccurrences: [
      { ts: Date.now() - 4 * 86400 * 1000, route: 'POST /api/finance/record', statusCode: 500 }
    ]
  }
];

function jitter(base, spread) {
  return Math.round((base + (Math.random() - 0.5) * spread) * 100) / 100;
}

function buildSnapshot() {
  const uptimeSec = Math.floor((Date.now() - startTs) / 1000);
  const rssMb = Math.round(jitter(164, 14));
  const heapUsedMb = Math.round(jitter(82, 8));
  const heapTotalMb = 112;
  const vpsAvailMb = Math.round(jitter(354, 18));
  return {
    tsSec: Math.floor(Date.now() / 1000),
    cpu: {
      processPct: Math.max(0.2, jitter(2.8, 2.4)),
      vpsPct: Math.max(1.0, jitter(6.4, 4.0)),
      cores: 1,
      loadAvg: [jitter(0.18, 0.08), jitter(0.21, 0.05), 0.19]
    },
    memory: {
      rssMb,
      heapUsedMb,
      heapTotalMb,
      heapPct: Math.round((heapUsedMb / heapTotalMb) * 100),
      externalMb: 12,
      vpsTotalMb: 892,
      vpsAvailMb,
      swapTotalMb: 2047,
      swapUsedMb: 98
    },
    disk: { totalGb: 28.9, usedGb: 8.4, availGb: 19.3, usedPct: 29.1 },
    eventLoop: {
      meanMs: Math.max(0.1, jitter(1.1, 0.6)),
      p95Ms: Math.max(0.5, jitter(3.4, 1.8)),
      maxMs: Math.max(2.0, jitter(11.2, 4.5))
    },
    http: {
      reqPerMin: Math.max(1, Math.round(jitter(24, 12))),
      meanMs: Math.max(2, Math.round(jitter(16, 8))),
      p95Ms: Math.max(8, Math.round(jitter(42, 16)))
    },
    ai: {
      reqPerMin: Math.max(0, Math.round(jitter(3, 3))),
      meanMs: Math.max(120, Math.round(jitter(480, 140)))
    },
    runtime: {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      pid: process.pid,
      hostname: 'nexa-server',
      privateIp: '172.16.0.4',
      nodeEnv: 'production',
      uptimeSec,
      activeHandles: Math.round(jitter(19, 3)),
      activeRequests: Math.max(0, Math.round(jitter(2, 2)))
    },
    git: {
      repository: 'nexa-server',
      appVersion: '2.4.0',
      branch: 'main',
      commitShort: '1647a8e',
      commitMessage: 'feat(monitor): add scrypt auth, metrics ws, and nexa-io subprotocol',
      dirty: false
    },
    domain: {
      activeLiveCalls: 0,
      enrolledDevices: 2,
      aiHealth: {
        groups: [{ name: 'gemma-4-26b', state: 'CLOSED', fails: 0, reopenInSec: 0 }],
        keysCoolingDown: [],
        openCount: 0,
        halfOpenCount: 0,
        coolingKeysCount: 0
      },
      mobile: {
        connected: true,
        rttMs: Math.round(jitter(38, 12)),
        uptimeSec: 184200,
        pendingProactive: 0
      },
      windows: {
        connected: true,
        rttMs: Math.round(jitter(44, 14)),
        uptimeSec: 61400
      }
    }
  };
}

function buildHistoryPoints(count, stepSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const pts = [];
  for (let i = count - 1; i >= 0; i--) {
    const wave = Math.sin(i / 6);
    const rssMb = Math.round(160 + wave * 12 + (Math.random() - 0.5) * 4);
    pts.push({
      tsSec: nowSec - i * stepSec,
      cpuPct: Math.max(0.4, Math.round((2.6 + Math.abs(wave) * 3.1 + Math.random()) * 10) / 10),
      vpsCpuPct: Math.max(1.2, Math.round((6.0 + Math.abs(wave) * 5.2 + Math.random() * 2) * 10) / 10),
      vpsAvailMb: Math.round(360 - wave * 14),
      rssMb,
      heapUsedMb: Math.round(78 + wave * 8),
      heapTotalMb: 112,
      heapPct: Math.round(((78 + wave * 8) / 112) * 100),
      elMeanMs: Math.round((1.0 + Math.abs(wave) * 0.7) * 100) / 100,
      elP95Ms: Math.round((3.1 + Math.abs(wave) * 2.2) * 100) / 100,
      httpReqMin: Math.max(4, Math.round(22 + wave * 10 + Math.random() * 6)),
      httpMeanMs: Math.round(15 + Math.abs(wave) * 8),
      httpP95Ms: Math.round(38 + Math.abs(wave) * 18),
      activeHandles: Math.round(18 + Math.abs(wave) * 3),
      activeReqs: Math.max(0, Math.round(1 + Math.abs(wave) * 2)),
      issuesDelta: 0,
      aiReqMin: Math.max(0, Math.round(2 + Math.abs(wave) * 3)),
      aiMeanMs: Math.round(440 + Math.abs(wave) * 120)
    });
  }
  return pts;
}

function buildHeatmap() {
  const nowHour = Math.floor(Date.now() / 3600000) * 3600;
  const cells = [];
  let healthyCount = 0;
  for (let i = 167; i >= 0; i--) {
    const hourStartSec = nowHour - i * 3600;
    let status = 'healthy';
    let issuesCnt = 0;
    if (i === 19 || i === 82) { status = 'degraded'; issuesCnt = 1; }
    else if (i === 140) { status = 'incident'; issuesCnt = 3; }
    else { healthyCount += 1; }
    cells.push({
      hourStartSec,
      status,
      avgRssMb: 158 + (i % 14),
      maxCpuPct: status === 'incident' ? 68 : (status === 'degraded' ? 28 : 9),
      maxElP95Ms: status === 'degraded' ? 94 : 6,
      issues: issuesCnt
    });
  }
  return {
    healthyPct: Math.round((healthyCount / 168) * 1000) / 10,
    cells
  };
}

function issueSummary() {
  const unresolved = issues.filter(i => i.status === 'unresolved').length;
  const resolved = issues.filter(i => i.status === 'resolved').length;
  return { last1h: 1, last24h: 3, last7d: 7, unresolved, resolved };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.nexa_mon_sid;
  if (!sid) return null;
  const sess = sessions.get(sid);
  if (!sess || sess.expiresAt < Date.now()) {
    if (sid) sessions.delete(sid);
    return null;
  }
  return sess;
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 65536) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
    });
  });
}

// ============================================================
// MINIMAL RFC 6455 WEBSOCKET HELPERS (ZERO DEPENDENCIES)
// ============================================================
function encodeWsFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function createWsDecoder(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let payloadLen = buf[1] & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
      buf = buf.subarray(offset + payloadLen);

      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }

      if (opcode === 0x08) {
        try { socket.end(encodeWsFrame(0x08, Buffer.alloc(0))); } catch (_) {}
        if (onClose) onClose();
        return;
      }
      if (opcode === 0x09) {
        try { socket.write(encodeWsFrame(0x0a, payload)); } catch (_) {}
        continue;
      }
      if (opcode === 0x01 || opcode === 0x02) {
        onMessage(opcode, payload);
      }
    }
  });
  socket.on('close', () => { if (onClose) onClose(); });
  socket.on('error', () => { if (onClose) onClose(); });
}

function encodeBinaryLogRecord({ prio, unitId, catFlags, tsMs, message }) {
  const msgBuf = Buffer.from(message, 'utf8');
  const out = Buffer.alloc(13 + msgBuf.length);
  out.writeUInt8(prio, 0);
  out.writeUInt8(unitId, 1);
  out.writeUInt8(catFlags, 2);
  out.writeBigUInt64BE(BigInt(tsMs), 3);
  out.writeUInt16BE(msgBuf.length, 11);
  msgBuf.copy(out, 13);
  return out;
}

const DEMO_LOG_LINES = [
  { prio: 6, unitId: 0, catFlags: 0x08, message: '[INFO] HTTP server listening on 127.0.0.1:3000 (systemd ready)' },
  { prio: 6, unitId: 0, catFlags: 0x02, message: '[BRIDGE] Mobile Bridge (Galaxy A33) heartbeat OK (rtt=36ms)' },
  { prio: 6, unitId: 0, catFlags: 0x01, message: '[FINANCE] Synced daily expense digest: 4 transactions reconciled' },
  { prio: 6, unitId: 1, catFlags: 0x00, message: 'HTTP/2 GET /monitor/api/overview 200 4.2ms' },
  { prio: 4, unitId: 0, catFlags: 0x08, message: '[WARN] Primary Gemini stream 429 rate-limit — routing to fallback provider' },
  { prio: 3, unitId: 0, catFlags: 0x02, message: '[ERROR] WebSocket heartbeat timeout on windows-bridge (ThinkPad)' },
  { prio: 3, unitId: 0, catFlags: 0x02, message: '    at Timeout._onTimeout (src/interfaces/bridge/gateway.js:184:19)' },
  { prio: 3, unitId: 0, catFlags: 0x02, message: '    at listOnTimeout (node:internal/timers:581:17)' },
  { prio: 6, unitId: 3, catFlags: 0x04, message: '[AUTH] Issued single-use Ed25519 logs ticket (subprotocol nexa-io-v1)' },
  { prio: 6, unitId: 2, catFlags: 0x00, message: 'Started nexa-server.service — N.E.X.A Core Server.' }
];

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = urlObj.pathname;

  if (pathname === '/' || pathname === '/monitor') {
    res.writeHead(302, { Location: '/monitor/' });
    res.end();
    return;
  }

  // API ROUTES
  if (pathname.startsWith('/monitor/api/')) {
    const apiPath = pathname.slice('/monitor/api'.length);
    const sess = getSession(req);

    if (req.method === 'POST' && req.headers['x-nexa-monitor'] !== '1') {
      return sendJson(res, 403, { error: 'Missing X-Nexa-Monitor CSRF header' });
    }

    if (req.method === 'GET' && apiPath === '/auth/status') {
      if (!sess) return sendJson(res, 200, { authenticated: false, configured: true });
      return sendJson(res, 200, {
        authenticated: true,
        configured: true,
        username: sess.username,
        session: {
          username: sess.username,
          expiresAt: sess.expiresAt,
          ttlSec: Math.max(0, Math.floor((sess.expiresAt - Date.now()) / 1000))
        }
      });
    }

    if (req.method === 'POST' && apiPath === '/auth/login') {
      const body = await readJsonBody(req);
      if (body.username !== DEMO_USER || body.password !== DEMO_PASS) {
        auditLog.unshift({ ts: Date.now(), event: 'AUTH_LOGIN_FAILED', severity: 'warn', detail: `Invalid login for "${body.username || ''}"`, ip: '127.0.0.1' });
        return sendJson(res, 401, { error: `Invalid credentials (demo: ${DEMO_USER} / ${DEMO_PASS})` });
      }
      const sid = crypto.randomBytes(24).toString('hex');
      const ttlSec = 24 * 3600;
      const expiresAt = Date.now() + ttlSec * 1000;
      sessions.set(sid, {
        sid,
        username: DEMO_USER,
        userAgent: (req.headers['user-agent'] || 'Desktop Browser').slice(0, 64),
        ip: '127.0.0.1',
        expiresAt
      });
      auditLog.unshift({ ts: Date.now(), event: 'AUTH_LOGIN_SUCCESS', severity: 'info', detail: `Operator "${DEMO_USER}" signed in`, ip: '127.0.0.1' });
      return sendJson(
        res,
        200,
        { authenticated: true, username: DEMO_USER, session: { username: DEMO_USER, expiresAt, ttlSec } },
        { 'Set-Cookie': `nexa_mon_sid=${sid}; Path=/monitor; HttpOnly; SameSite=Strict; Max-Age=${ttlSec}` }
      );
    }

    if (!sess) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'POST' && apiPath === '/auth/logout') {
      sessions.delete(sess.sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'nexa_mon_sid=; Path=/monitor; HttpOnly; SameSite=Strict; Max-Age=0' });
    }

    if (req.method === 'POST' && apiPath === '/auth/sessions/revoke-all') {
      sessions.clear();
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'nexa_mon_sid=; Path=/monitor; HttpOnly; SameSite=Strict; Max-Age=0' });
    }

    if (req.method === 'GET' && apiPath === '/overview') {
      const snap = buildSnapshot();
      return sendJson(res, 200, {
        snapshot: snap,
        services: {
          manager: 'systemd',
          systemdVersion: 'systemd 255',
          canPolkitRestart: true,
          terminalKillSwitchEnabled: false,
          units: [
            { name: 'nexa-server.service', status: 'active', mode: 'always-on', memoryMb: snap.memory.rssMb, cpuPct: snap.cpu.processPct, uptimeSec: snap.runtime.uptimeSec, restarts: 0 },
            { name: 'nexa-log.service', status: 'active', mode: 'socket-activated', memoryMb: 9, cpuPct: 0.1, uptimeSec: 86400, restarts: 0 },
            { name: 'nexa-term.service', status: 'idle', mode: 'socket-activated', memoryMb: 0, cpuPct: 0, uptimeSec: 0, restarts: 0 },
            { name: 'caddy.service', status: 'active', mode: 'reverse-proxy', memoryMb: 28, cpuPct: 0.2, uptimeSec: 1296000, restarts: 0 }
          ]
        },
        issues: issueSummary(),
        cronJobs: [
          { name: 'finance_auto_sync', schedule: '*/3 * * * * (3m)', lastRunAt: Date.now() - 45000, lastStatus: 'ok', lastDurationMs: 312, runCount: 14, failCount: 0, lastError: '' },
          { name: 'morning_briefing', schedule: '05:30 WIB daily', lastRunAt: null, lastStatus: 'scheduled', lastDurationMs: 0, runCount: 0, failCount: 0, lastError: '' }
        ],
        spark1h: buildHistoryPoints(30, 120),
        heatmap: buildHeatmap()
      });
    }

    if (req.method === 'GET' && apiPath === '/metrics/history') {
      const range = urlObj.searchParams.get('range') || '1h';
      const stepMap = { '1h': 60, '6h': 180, '24h': 600, '7d': 3600 };
      const countMap = { '1h': 60, '6h': 120, '24h': 144, '7d': 168 };
      return sendJson(res, 200, {
        range,
        current: buildSnapshot(),
        points: buildHistoryPoints(countMap[range] || 60, stepMap[range] || 60)
      });
    }

    if (req.method === 'GET' && apiPath === '/issues') {
      const status = urlObj.searchParams.get('status') || 'all';
      const search = (urlObj.searchParams.get('search') || '').toLowerCase();
      const filtered = issues.filter(i => {
        if (status !== 'all' && i.status !== status) return false;
        if (search && !`${i.title} ${i.subsystem} ${i.culprit} ${i.fingerprint}`.toLowerCase().includes(search)) return false;
        return true;
      });
      return sendJson(res, 200, { summary: issueSummary(), issues: filtered });
    }

    if (req.method === 'POST' && apiPath === '/issues/clear-resolved') {
      let removed = 0;
      for (let i = issues.length - 1; i >= 0; i--) {
        if (issues[i].status === 'resolved') { issues.splice(i, 1); removed++; }
      }
      return sendJson(res, 200, { removed });
    }

    const issueDetailMatch = apiPath.match(/^\/issues\/([^/]+)$/);
    if (req.method === 'GET' && issueDetailMatch) {
      const found = issues.find(i => i.fingerprint === decodeURIComponent(issueDetailMatch[1]));
      if (!found) return sendJson(res, 404, { error: 'Issue not found' });
      return sendJson(res, 200, found);
    }

    const issueActMatch = apiPath.match(/^\/issues\/([^/]+)\/(resolve|reopen)$/);
    if (req.method === 'POST' && issueActMatch) {
      const found = issues.find(i => i.fingerprint === decodeURIComponent(issueActMatch[1]));
      if (!found) return sendJson(res, 404, { error: 'Issue not found' });
      found.status = issueActMatch[2] === 'resolve' ? 'resolved' : 'unresolved';
      return sendJson(res, 200, found);
    }

    if (req.method === 'POST' && apiPath === '/logs/ticket') {
      const ticket = 'demo.' + crypto.randomBytes(16).toString('hex');
      issuedTickets.add(ticket);
      return sendJson(res, 200, { ticket, protocol: 'nexa-io-v1', expiresInSec: 30 });
    }

    if (req.method === 'GET' && apiPath === '/controls') {
      return sendJson(res, 200, {
        services: { manager: 'systemd', systemdVersion: 'systemd 255', canPolkitRestart: true, terminalKillSwitchEnabled: false },
        activeLiveCalls: 0,
        aiHealth: { groups: [], keysCoolingDown: [], openCount: 0, halfOpenCount: 0, coolingKeysCount: 0 },
        alerts: alertRules,
        alertCooldownMinutes: 15,
        alertChannel: { mobileConnected: true, telegramConfigured: true, activeRoute: 'Mobile Bridge' },
        auth: {
          username: sess.username,
          sessions: Array.from(sessions.values()).map(s => ({
            userAgent: s.userAgent,
            ip: s.ip,
            ttlSec: Math.max(0, Math.floor((s.expiresAt - Date.now()) / 1000)),
            current: s.sid === sess.sid
          }))
        },
        auditLog
      });
    }

    if (req.method === 'POST' && apiPath === '/controls/alerts-settings') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, cooldownMinutes: Number(body.cooldownMinutes) || 15 });
    }

    if (req.method === 'POST' && apiPath === '/controls/alerts/test') {
      auditLog.unshift({ ts: Date.now(), event: 'ALERT_TEST_SENT', severity: 'info', detail: 'channel=mobile_bridge ok=true', ip: '127.0.0.1' });
      return sendJson(res, 200, { ok: true, channel: 'mobile_bridge', sentAt: Date.now() });
    }

    if (req.method === 'POST' && apiPath === '/actions/reset-breakers') {
      auditLog.unshift({ ts: Date.now(), event: 'BREAKERS_RESET', severity: 'warn', detail: 'Cleared 0 group(s) & 0 key cooldown(s)', ip: '127.0.0.1' });
      return sendJson(res, 200, { ok: true, clearedGroups: 0, clearedKeys: 0 });
    }

    const alertMatch = apiPath.match(/^\/controls\/alerts\/([^/]+)$/);
    if (req.method === 'POST' && alertMatch) {
      const body = await readJsonBody(req);
      const rule = alertRules.find(r => r.id === decodeURIComponent(alertMatch[1]));
      if (!rule) return sendJson(res, 404, { error: 'Alert rule not found' });
      rule.enabled = Boolean(body.enabled);
      auditLog.unshift({ ts: Date.now(), event: 'ALERT_RULE_UPDATED', severity: 'info', detail: `${rule.id} -> ${rule.enabled ? 'ON' : 'OFF'}`, ip: '127.0.0.1' });
      return sendJson(res, 200, rule);
    }

    if (req.method === 'POST' && apiPath === '/actions/reset-metrics') {
      auditLog.unshift({ ts: Date.now(), event: 'METRICS_RESET', severity: 'info', detail: 'Operator triggered RESET MONIT', ip: '127.0.0.1' });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && apiPath === '/actions/restart') {
      auditLog.unshift({ ts: Date.now(), event: 'SERVICE_RESTART', severity: 'warn', detail: 'Simulated graceful SIGTERM restart (demo mode)', ip: '127.0.0.1' });
      return sendJson(res, 200, { ok: true, mode: 'demo-simulated' });
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  // STATIC FILES UNDER /monitor/
  if (pathname.startsWith('/monitor/')) {
    let relPath = pathname.slice('/monitor/'.length);
    if (!relPath || relPath.endsWith('/')) relPath = 'index.html';
    const fullPath = path.resolve(ROOT_DIR, relPath);
    if (!fullPath.startsWith(ROOT_DIR) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': STRICT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ============================================================
// WEBSOCKET UPGRADES (/monitor/ws/metrics & /io/logs)
// ============================================================
server.on('upgrade', (req, socket) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

  if (urlObj.pathname === '/monitor/ws/metrics') {
    if (!getSession(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let paused = false;
    const sendTick = () => {
      if (paused || socket.destroyed) return;
      const msg = JSON.stringify({ type: 'METRICS_TICK', snapshot: buildSnapshot(), issues: issueSummary() });
      socket.write(encodeWsFrame(0x01, Buffer.from(msg, 'utf8')));
    };
    sendTick();
    const timer = setInterval(sendTick, 2000);

    createWsDecoder(
      socket,
      (_op, payload) => {
        try {
          const parsed = JSON.parse(payload.toString('utf8'));
          if (parsed.type === 'PAUSE') paused = true;
          if (parsed.type === 'RESUME') { paused = false; sendTick(); }
        } catch (_) {}
      },
      () => clearInterval(timer)
    );
    return;
  }

  if (urlObj.pathname === '/io/logs') {
    const rawProtos = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const ticketProto = rawProtos.find(p => p.startsWith('nexa-ticket.'));
    const ticket = ticketProto ? ticketProto.slice('nexa-ticket.'.length) : '';
    if (!ticket || !issuedTickets.has(ticket)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    issuedTickets.delete(ticket); // single-use

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      'Sec-WebSocket-Protocol: nexa-io-v1\r\n\r\n'
    );

    let timer = null;
    let idx = 0;
    let filter = { unitMask: 0x0f, minPrio: 7, catMask: 0x00 };

    const passes = (rec) => {
      if ((filter.unitMask & (1 << rec.unitId)) === 0) return false;
      if (filter.minPrio > 0 && rec.prio > filter.minPrio) return false;
      if (filter.catMask !== 0 && (rec.catFlags & filter.catMask) === 0) return false;
      return true;
    };

    const sendBatch = (recs) => {
      if (socket.destroyed || recs.length === 0) return;
      const chunks = [Buffer.from([0x03, 0x02])]; // ChLogs, OpData
      for (const r of recs) chunks.push(encodeBinaryLogRecord(r));
      socket.write(encodeWsFrame(0x02, Buffer.concat(chunks)));
    };

    createWsDecoder(
      socket,
      (_op, payload) => {
        if (payload.length < 2) return;
        const ch = payload[0];
        const op = payload[1];
        if (ch === 0x03 && op === 0x01 && payload.length === 7) {
          filter = { unitMask: payload[2], minPrio: payload[3], catMask: payload[4] };
          const now = Date.now();
          let curTs = now - DEMO_LOG_LINES.length * 1600;
          const initial = DEMO_LOG_LINES
            .map((line) => {
              curTs += line.message.startsWith('    at ') ? 15 : 1600;
              return { ...line, tsMs: curTs };
            })
            .filter(passes);
          sendBatch(initial);
          if (!timer) {
            timer = setInterval(() => {
              const sample = DEMO_LOG_LINES[idx % DEMO_LOG_LINES.length];
              idx += 1;
              if (sample.message.startsWith('    at ')) return;
              const entry = { ...sample, tsMs: Date.now() };
              if (passes(entry)) sendBatch([entry]);
            }, 2600);
          }
        }
      },
      () => { if (timer) clearInterval(timer); }
    );
    return;
  }

  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`N.E.X.A Pulse Monitor (Demo Preview) running at http://${HOST}:${PORT}/monitor/`);
  console.log(`Demo credentials: username="${DEMO_USER}"  password="${DEMO_PASS}"`);
  console.log(`Strict CSP enforced: ${STRICT_CSP}`);
});
