'use strict';

export const API_BASE = '/monitor/api';

let onUnauthorizedCb = null;
let onConnectivityCb = null;

export function setApiHooks({ onUnauthorized, onConnectivity } = {}) {
  if (typeof onUnauthorized === 'function') onUnauthorizedCb = onUnauthorized;
  if (typeof onConnectivity === 'function') onConnectivityCb = onConnectivity;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtUptime(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  if (s === 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtRelative(tsMs) {
  const diffSec = Math.max(0, Math.floor((Date.now() - Number(tsMs || 0)) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtWibTime(tsMs, withMs = false) {
  const d = new Date(Number(tsMs || Date.now()));
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(d);
    if (!withMs) return `${parts} WIB`;
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${parts}.${ms}`;
  } catch (_) {
    return d.toISOString().slice(11, withMs ? 23 : 19);
  }
}

export function fmtWibLogTimestamp(tsMs) {
  const d = new Date(Number(tsMs || Date.now()));
  try {
    const datePart = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short'
    }).format(d);
    const timePart = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(d);
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${datePart} ${timePart}.${ms}`;
  } catch (_) {
    return d.toISOString().slice(5, 23).replace('T', ' ');
  }
}

export function fmtWibDateTime(tsMs) {
  const d = new Date(Number(tsMs || Date.now()));
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(d);
    return `${s} WIB`;
  } catch (_) {
    return d.toISOString();
  }
}

export function fmtTtl(ttlSec) {
  const s = Math.max(0, Math.floor(Number(ttlSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function apiRequest(method, path, body = null, { suppressAuthRedirect = false } = {}) {
  const headers = {
    'X-Nexa-Monitor': '1'
  };
  const init = {
    method,
    credentials: 'same-origin',
    headers
  };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (networkErr) {
    if (onConnectivityCb) onConnectivityCb(false);
    const err = new Error('Network error reaching nexa-server');
    err.isNetwork = true;
    throw err;
  }

  if (onConnectivityCb) onConnectivityCb(true);

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  if (res.status === 401 && !suppressAuthRedirect && onUnauthorizedCb) {
    onUnauthorizedCb();
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.code;
    err.data = data;
    throw err;
  }

  return data;
}

export const api = {
  authStatus: () => apiRequest('GET', '/auth/status', null, { suppressAuthRedirect: true }),
  login: (username, password) => apiRequest('POST', '/auth/login', { username, password }, { suppressAuthRedirect: true }),
  logout: () => apiRequest('POST', '/auth/logout', {}),
  overview: () => apiRequest('GET', '/overview'),
  metricsHistory: (range = '1h', maxPoints = 180) =>
    apiRequest('GET', `/metrics/history?range=${encodeURIComponent(range)}&maxPoints=${encodeURIComponent(maxPoints)}`),
  issues: ({ status = 'all', subsystem = '', search = '' } = {}) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (subsystem) qs.set('subsystem', subsystem);
    if (search) qs.set('search', search);
    return apiRequest('GET', `/issues?${qs.toString()}`);
  },
  issueDetail: (fp) => apiRequest('GET', `/issues/${encodeURIComponent(fp)}`),
  resolveIssue: (fp) => apiRequest('POST', `/issues/${encodeURIComponent(fp)}/resolve`, {}),
  reopenIssue: (fp) => apiRequest('POST', `/issues/${encodeURIComponent(fp)}/reopen`, {}),
  clearResolvedIssues: () => apiRequest('POST', '/issues/clear-resolved', {}),
  mintLogsTicket: () => apiRequest('POST', '/logs/ticket', {}),
  controls: () => apiRequest('GET', '/controls'),
  setAlertRule: (ruleId, enabled) => apiRequest('POST', `/controls/alerts/${encodeURIComponent(ruleId)}`, { enabled }),
  updateAlertRule: (ruleId, patch) => apiRequest('POST', `/controls/alerts/${encodeURIComponent(ruleId)}`, patch),
  setAlertCooldown: (cooldownMinutes) => apiRequest('POST', '/controls/alerts-settings', { cooldownMinutes }),
  sendTestAlert: () => apiRequest('POST', '/controls/alerts/test', {}),
  resetBreakers: () => apiRequest('POST', '/actions/reset-breakers', {}),
  resetMetrics: () => apiRequest('POST', '/actions/reset-metrics', {}),
  restartServer: (force = false) => apiRequest('POST', '/actions/restart', { force }),
  revokeAllSessions: () => apiRequest('POST', '/auth/sessions/revoke-all', {})
};

export function wsBaseUrl(pathname) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${pathname}`;
}

/**
 * Zero-overhead WebSocket client for /monitor/ws/metrics.
 * Auto-reconnects with capped backoff; closes cleanly on logout/unload.
 */
export class MetricsSocketClient {
  constructor({ onTick, onStatus }) {
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.ws = null;
    this.closed = false;
    this.paused = false;
    this.attempt = 0;
    this.reconnectTimer = null;
  }

  connect() {
    this.closed = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      this.ws = new WebSocket(wsBaseUrl('/monitor/ws/metrics'));
    } catch (_) {
      this._scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.attempt = 0;
      if (this.paused) this.sendControl('PAUSE');
      if (this.onStatus) this.onStatus(true);
    });

    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === 'METRICS_TICK' && this.onTick) {
          this.onTick(msg);
        }
      } catch (_) {}
    });

    this.ws.addEventListener('close', (ev) => {
      if (this.onStatus) this.onStatus(false);
      if (ev.code === 4001 && onUnauthorizedCb) {
        this.closed = true;
        onUnauthorizedCb();
        return;
      }
      if (!this.closed) this._scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      // close handler triggers reconnect
    });
  }

  sendControl(type) {
    this.paused = type === 'PAUSE';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type })); } catch (_) {}
    }
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const delayMs = Math.min(10000, 1200 * Math.pow(1.5, Math.min(this.attempt, 6)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, delayMs);
  }

  disconnect() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'Client disconnect'); } catch (_) {}
      this.ws = null;
    }
  }
}
