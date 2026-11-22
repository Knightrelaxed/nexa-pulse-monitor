import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CH_CONTROL,
  CH_LOGS,
  OP_OPEN,
  OP_CREDIT,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
  encodeLogOpenFrame,
  encodeCreditFrame,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  decodeLogRecordsPayload,
  LogsStreamClient
} from './js/logs_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Verify binary OPEN frame matches Go proto.EncodeFrame(ChLogs, OpOpen, EncodeLogOpen(...))
{
  const buf = encodeLogOpenFrame({ unitMask: 0x05, minPrio: 4, catMask: 0x02, tailLines: 250 });
  const bytes = new Uint8Array(buf);
  assert.equal(bytes.length, 7);
  assert.deepEqual(Array.from(bytes), [CH_LOGS, OP_OPEN, 0x05, 0x04, 0x02, 0x00, 0xfa]);
}

// 2. Verify binary CREDIT frame matches Go proto.EncodeCredit
{
  const buf = encodeCreditFrame(16384);
  const bytes = new Uint8Array(buf);
  assert.equal(bytes.length, 6);
  assert.deepEqual(Array.from(bytes), [CH_LOGS, OP_CREDIT, 0x00, 0x00, 0x40, 0x00]);
}

// 3. Verify CLOSE, PING (20s keepalive), and PONG frames
{
  assert.deepEqual(Array.from(new Uint8Array(encodeCloseFrame(1))), [CH_LOGS, OP_CLOSE, 1]);
  assert.deepEqual(Array.from(new Uint8Array(encodePingFrame())), [CH_CONTROL, OP_PING]);
  assert.deepEqual(Array.from(new Uint8Array(encodePongFrame(CH_CONTROL))), [CH_CONTROL, OP_PONG]);
}

// 4. Verify 13-byte packed LogRecord decoding (matches Go proto.EncodeLogRecord byte-for-byte)
{
  const ts1 = 1763780000123;
  const msg1 = Buffer.from('[CORE] Ready on :3000 — N.E.X.A', 'utf8');
  const rec1 = Buffer.alloc(13 + msg1.length);
  rec1.writeUInt8(6, 0);        // PrioInfo
  rec1.writeUInt8(0, 1);        // UnitNexaServer
  rec1.writeUInt8(0x08, 2);     // CatCore
  rec1.writeBigUInt64BE(BigInt(ts1), 3);
  rec1.writeUInt16BE(msg1.length, 11);
  msg1.copy(rec1, 13);

  const ts2 = 1763780000456;
  const msg2 = Buffer.from('    at Server.listen (src/app.js:42:10)', 'utf8');
  const rec2 = Buffer.alloc(13 + msg2.length);
  rec2.writeUInt8(3, 0);        // PrioError
  rec2.writeUInt8(0, 1);        // UnitNexaServer
  rec2.writeUInt8(0x00, 2);
  rec2.writeBigUInt64BE(BigInt(ts2), 3);
  rec2.writeUInt16BE(msg2.length, 11);
  msg2.copy(rec2, 13);

  const packed = Buffer.concat([rec1, rec2]);
  const decoded = decodeLogRecordsPayload(new Uint8Array(packed));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].prio, 6);
  assert.equal(decoded[0].unit, 'nexa-server');
  assert.equal(decoded[0].catFlags, 0x08);
  assert.equal(decoded[0].tsMs, ts1);
  assert.equal(decoded[0].message, '[CORE] Ready on :3000 — N.E.X.A');

  // Verify collapsible stack frame grouping in LogsStreamClient
  let latestEntries = [];
  const client = new LogsStreamClient({ onEntries: (list) => { latestEntries = list; } });
  client._appendRecords(decoded);
  assert.equal(latestEntries.length, 1, 'Stack frame line should attach to preceding entry');
  assert.equal(latestEntries[0].stackFrames.length, 1);
  assert.match(latestEntries[0].stackFrames[0], /Server\.listen/);
}

// 5. Verify strict CSP: zero inline style= or .style. across all frontend HTML & JS
{
  const scanFiles = [
    path.join(__dirname, 'index.html'),
    ...fs.readdirSync(path.join(__dirname, 'js'))
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(__dirname, 'js', f)),
    ...fs.readdirSync(path.join(__dirname, 'js', 'views'))
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(__dirname, 'js', 'views', f))
  ];
  for (const file of scanFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(/style=|\.style\./.test(content), false, `Inline style found in ${file}`);
  }
}

console.log('ALL_FRONTEND_PROTOCOL_AND_CSP_CHECKS_PASSED');
