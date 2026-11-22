'use strict';
/**
 * ============================================================
 * N.E.X.A Pulse Monitor — nexa-io Binary Log Stream Client
 *
 * Implements exact PRD §10.1 & §10.3 binary protocol over /io/logs:
 * - Auth: Browser Sec-WebSocket-Protocol ["nexa-io-v1", "nexa-ticket.<ed25519>"]
 * - Frame: [ch: u8][op: u8][payload: N bytes]
 * - OPEN (0x01): [unit_mask: u8][min_prio: u8][cat_mask: u8][tail_lines: u16 BE]
 * - CREDIT (0x03): [bytes: u32 BE] (held while paused for true backpressure)
 * - DATA (0x02): packed LogRecords:
 *   [prio: u8][unit_id: u8][cat_flags: u8][timestamp_ms: u64 BE][msg_len: u16 BE][utf8]
 * - Keeps bounded 2,000-entry ring buffer and groups consecutive stack frames.
 * ============================================================
 */

import { api, wsBaseUrl } from './api.js';

export const CH_CONTROL = 0x00;
export const CH_LOGS = 0x03;
export const OP_OPEN = 0x01;
export const OP_DATA = 0x02;
export const OP_CREDIT = 0x03;
export const OP_CLOSE = 0x04;
export const OP_ERR = 0x06;
export const OP_PING = 0x07;
export const OP_PONG = 0x08;

export const UNIT_NAMES = Object.freeze({
  0: 'nexa-server',
  1: 'caddy',
  2: 'systemd',
  3: 'nexa-io'
});

export const UNIT_MASKS = Object.freeze({
  all: 0x0f,
  'nexa-server': 0x01,
  caddy: 0x02,
  systemd: 0x04,
  'nexa-io': 0x08
});

export const CATEGORY_PRESETS = Object.freeze({
  all: { minPrio: 7, catMask: 0x00 },
  errors: { minPrio: 4, catMask: 0x00 },
  core: { minPrio: 7, catMask: 0x08 },
  bridge: { minPrio: 7, catMask: 0x02 },
  finance: { minPrio: 7, catMask: 0x01 },
  auth: { minPrio: 7, catMask: 0x04 }
});

const MAX_BUFFER_ENTRIES = 2000;
const CREDIT_REPLENISH_THRESHOLD = 8192;
const textDecoder = new TextDecoder('utf-8');

export function encodeLogOpenFrame({ unitMask = 0x0f, minPrio = 7, catMask = 0x00, tailLines = 200 } = {}) {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint8(0, CH_LOGS);
  view.setUint8(1, OP_OPEN);
  view.setUint8(2, unitMask & 0x0f);
  view.setUint8(3, minPrio & 0xff);
  view.setUint8(4, catMask & 0xff);
  view.setUint16(5, Math.min(500, Math.max(10, tailLines)), false);
  return buf;
}

export function encodeCreditFrame(bytes) {
  const buf = new ArrayBuffer(6);
  const view = new DataView(buf);
  view.setUint8(0, CH_LOGS);
  view.setUint8(1, OP_CREDIT);
  view.setUint32(2, bytes >>> 0, false);
  return buf;
}

export function encodeCloseFrame(reason = 1) {
  return new Uint8Array([CH_LOGS, OP_CLOSE, reason & 0xff]).buffer;
}

export function encodePingFrame() {
  return new Uint8Array([CH_CONTROL, OP_PING]).buffer;
}

export function encodePongFrame(ch = CH_CONTROL) {
  return new Uint8Array([ch & 0xff, OP_PONG]).buffer;
}

export function decodeLogRecordsPayload(bytes) {
  const records = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 13 <= bytes.byteLength) {
    const prio = view.getUint8(offset);
    const unitId = view.getUint8(offset + 1);
    const catFlags = view.getUint8(offset + 2);
    const hi = view.getUint32(offset + 3, false);
    const lo = view.getUint32(offset + 7, false);
    const tsMs = hi * 4294967296 + lo;
    const msgLen = view.getUint16(offset + 11, false);
    offset += 13;

    if (offset + msgLen > bytes.byteLength) break;
    const msgSlice = bytes.subarray(offset, offset + msgLen);
    offset += msgLen;

    records.push({
      prio,
      unitId,
      unit: UNIT_NAMES[unitId] || `unit-${unitId}`,
      catFlags,
      tsMs: tsMs > 0 ? tsMs : Date.now(),
      message: textDecoder.decode(msgSlice)
    });
  }
  return records;
}

function isStackFrameLine(msg) {
  return /^\s+at\s+/.test(msg) || /^at\s+[A-Za-z0-9_$.<>]+\s+\(/.test(msg.trim());
}

export class LogsStreamClient {
  constructor({ onEntries, onStateChange, onError }) {
    this.onEntries = onEntries;
    this.onStateChange = onStateChange;
    this.onError = onError;

    this.ws = null;
    this.entries = [];
    this.nextId = 1;
    this.paused = false;
    this.heldCreditBytes = 0;
    this.consumedSinceCredit = 0;
    this.activeFilter = { category: 'all', unit: 'all', tailLines: 200 };
    this.state = 'disconnected'; // disconnected | connecting | live | paused | error
    this.intentionalClose = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.connectSeq = 0;
    this.reconnectAttempt = 0;
    this.openedAt = 0;
  }

  _setState(nextState, detail = '') {
    this.state = nextState;
    if (this.onStateChange) this.onStateChange(nextState, detail);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _startPing(ws) {
    this._stopPing();
    // nexa-io enforces a 45s ReadDeadline; send a 2-byte binary Control PING every 20s
    this.pingTimer = setInterval(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(encodePingFrame()); } catch (_) {}
      }
    }, 20000);
  }

  _sendOpenFrame(ws) {
    const catPreset = CATEGORY_PRESETS[this.activeFilter.category] || CATEGORY_PRESETS.all;
    const unitMask = UNIT_MASKS[this.activeFilter.unit] || UNIT_MASKS.all;
    ws.send(encodeLogOpenFrame({
      unitMask,
      minPrio: catPreset.minPrio,
      catMask: catPreset.catMask,
      tailLines: this.activeFilter.tailLines || 200
    }));
  }

  /**
   * Re-apply unit/category filters in-place over the existing open /io/logs socket
   * (zero extra ticket requests, zero disconnect/reconnect churn).
   */
  applyFilter(filter = {}) {
    this.activeFilter = { ...this.activeFilter, ...filter };
    this.heldCreditBytes = 0;
    this.consumedSinceCredit = 0;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendOpenFrame(this.ws);
      this._setState(this.paused ? 'paused' : 'live', '/io/logs');
      return;
    }
    this.connect(this.activeFilter);
  }

  async connect(filter = this.activeFilter) {
    this.activeFilter = { ...this.activeFilter, ...filter };
    const seq = ++this.connectSeq;
    this.disconnect(false);
    this.intentionalClose = false;
    this.heldCreditBytes = 0;
    this.consumedSinceCredit = 0;
    this._setState('connecting', 'Minting Ed25519 ticket...');

    let minted;
    try {
      minted = await api.mintLogsTicket();
    } catch (err) {
      if (seq !== this.connectSeq || this.intentionalClose) return;
      this._setState('error', err.message || 'Unable to mint logs ticket');
      if (this.onError) this.onError(err.message);
      return;
    }

    if (seq !== this.connectSeq || this.intentionalClose) return;

    const baseProto = minted.protocol || 'nexa-io-v1';
    const subprotocols = [baseProto, `nexa-ticket.${minted.ticket}`];

    let ws;
    try {
      ws = new WebSocket(wsBaseUrl('/io/logs'), subprotocols);
      ws.binaryType = 'arraybuffer';
    } catch (err) {
      this._setState('error', 'WebSocket creation failed');
      return;
    }

    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws || seq !== this.connectSeq) {
        try { ws.close(1000, 'Superseded'); } catch (_) {}
        return;
      }
      this.openedAt = Date.now();
      this._sendOpenFrame(ws);
      this._startPing(ws);
      this._setState(this.paused ? 'paused' : 'live', '/io/logs');
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) return;
      const raw = new Uint8Array(ev.data);
      if (raw.length < 2) return;
      const ch = raw[0];
      const op = raw[1];
      const payload = raw.subarray(2);

      if (op === OP_PONG) {
        if (Date.now() - this.openedAt > 5000) this.reconnectAttempt = 0;
        return;
      }

      if (op === OP_PING) {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodePongFrame(ch));
        return;
      }

      if (op === OP_ERR) {
        const errMsg = payload.length > 1 ? textDecoder.decode(payload.subarray(1)) : 'Stream error';
        this._setState('error', errMsg);
        if (this.onError) this.onError(errMsg);
        return;
      }

      if (op === OP_CLOSE) {
        this._setState('disconnected', 'Stream closed by server');
        return;
      }

      if (op === OP_DATA && ch === CH_LOGS) {
        if (Date.now() - this.openedAt > 5000) this.reconnectAttempt = 0;
        const byteCount = payload.byteLength;
        const recs = decodeLogRecordsPayload(payload);
        if (recs.length > 0) {
          this._appendRecords(recs);
        }

        if (this.paused) {
          this.heldCreditBytes += byteCount;
        } else {
          this.consumedSinceCredit += byteCount;
          if (this.consumedSinceCredit >= CREDIT_REPLENISH_THRESHOLD) {
            const grant = this.consumedSinceCredit;
            this.consumedSinceCredit = 0;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(encodeCreditFrame(grant));
            }
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      // Strictly ignore close events from superseded/previous sockets!
      if (this.ws !== ws) return;
      this.ws = null;
      this._stopPing();
      if (this.intentionalClose || this.state === 'error' || seq !== this.connectSeq) return;

      if (this.openedAt > 0 && Date.now() - this.openedAt > 10000) {
        this.reconnectAttempt = 0;
      }
      this.reconnectAttempt += 1;
      if (this.reconnectAttempt > 5) {
        this._setState('error', 'Stream disconnected — reload or click Clear to retry');
        return;
      }
      const delayMs = Math.min(30000, 2500 * Math.pow(2, this.reconnectAttempt - 1));
      this._setState('disconnected', `Reconnecting in ${Math.round(delayMs / 1000)}s...`);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.intentionalClose && seq === this.connectSeq) {
          this.connect(this.activeFilter);
        }
      }, delayMs);
    });
  }

  _appendRecords(recs) {
    let addedCount = 0;
    for (const r of recs) {
      const last = this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
      // Group consecutive stack frames cleanly under the preceding log entry
      const refTs = last ? (last.lastStackTs || last.tsMs) : 0;
      if (last && last.unitId === r.unitId && isStackFrameLine(r.message) && Math.abs(r.tsMs - refTs) <= 2000) {
        last.stackFrames.push(r.message);
        last.lastStackTs = r.tsMs;
        continue;
      }
      this.entries.push({
        id: this.nextId++,
        prio: r.prio,
        unitId: r.unitId,
        unit: r.unit,
        catFlags: r.catFlags,
        tsMs: r.tsMs,
        message: r.message,
        stackFrames: [],
        expanded: false
      });
      addedCount += 1;
    }

    if (this.entries.length > MAX_BUFFER_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_BUFFER_ENTRIES);
    }

    if (this.onEntries) this.onEntries(this.entries, addedCount);
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const totalToGrant = this.heldCreditBytes + this.consumedSinceCredit;
      this.heldCreditBytes = 0;
      this.consumedSinceCredit = 0;
      if (totalToGrant > 0) {
        this.ws.send(encodeCreditFrame(totalToGrant));
      }
      this._setState('live', '/io/logs');
    } else if (this.paused) {
      this._setState('paused', 'Backpressure held');
    }
  }

  clearBuffer() {
    this.entries = [];
    if (this.onEntries) this.onEntries(this.entries, 0);
  }

  disconnect(markIntentional = true) {
    if (markIntentional) {
      this.intentionalClose = true;
      this.connectSeq += 1;
    }
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const prevWs = this.ws;
    this.ws = null;
    if (prevWs) {
      try {
        if (prevWs.readyState === WebSocket.OPEN) {
          prevWs.send(encodeCloseFrame(1));
        }
        prevWs.close(1000, 'Client closed');
      } catch (_) {}
    }
    if (markIntentional) {
      this._setState('disconnected', '');
    }
  }
}
