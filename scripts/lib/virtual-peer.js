#!/usr/bin/env node
/**
 * 가상 피어(TCP/UDP) — Mirae Messenger CHAT / MSG_ACK / FILE_XFER 최소 구현
 * 같은 PC에서 포트 오프셋 + 논리 서브넷 라벨로 다수 기동.
 */
'use strict';

const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('crypto');

const FILE_XFER_CHUNK_RAW_BYTES = 280 * 1024;
const MAX_FILE_XFER_BYTES = 50 * 1024 * 1024;
const MAX_PENDING_FILE_XFERS = 24;
const MAX_PENDING_FILE_XFER_BYTES = 256 * 1024 * 1024;

class VirtualPeer extends EventEmitter {
  /**
   * @param {{ id:string, username?:string, tcpPort:number, udpPort?:number, subnet?:string, host?:string }} opts
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.username = opts.username || opts.id;
    this.tcpPort = opts.tcpPort;
    this.udpPort = opts.udpPort || 0;
    this.subnet = opts.subnet || '122'; // 논리 대역: '122' | '123'
    this.host = opts.host || '127.0.0.1';
    this.logicalIp = opts.logicalIp || `192.168.${this.subnet}.${(opts.octet || 10)}`;
    this.server = null;
    this.udp = null;
    this.online = false;
    this.paused = false;
    this.received = new Map();
    this.acksSent = 0;
    this.chatsReceived = 0;
    this.connectFails = 0;
    this._dropNext = 0;
    this.pendingXfers = new Map();
    this.filesReceived = [];
    this.fileAccepts = 0;
    this.fileAborts = 0;
    this.fileRejectBusy = 0;
    this.maxConcurrentXfers = MAX_PENDING_FILE_XFERS;
    this.maxPendingXferBytes = MAX_PENDING_FILE_XFER_BYTES;
    this.errors = [];
  }

  logError(msg, detail) {
    const entry = { at: new Date().toISOString(), peer: this.id, msg, detail: detail || null };
    this.errors.push(entry);
    this.emit('error-log', entry);
  }

  pendingXferBytes() {
    let n = 0;
    this.pendingXfers.forEach((e) => { n += Number(e.size) || 0; });
    return n;
  }

  canAcceptXfer(size) {
    if (this.pendingXfers.size >= this.maxConcurrentXfers) return false;
    if (this.pendingXferBytes() + size > this.maxPendingXferBytes) return false;
    if (size <= 0 || size > MAX_FILE_XFER_BYTES) return false;
    return true;
  }

  async start() {
    if (this.server) return;
    this.server = net.createServer((socket) => this._onConn(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.tcpPort, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    if (this.udpPort) {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      await new Promise((resolve, reject) => {
        this.udp.once('error', reject);
        this.udp.bind(this.udpPort, this.host, () => {
          this.udp.removeListener('error', reject);
          resolve();
        });
      });
      this.udp.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString('utf8'));
          this.emit('udp', data, rinfo);
        } catch (_) { /* ignore */ }
      });
    }
    this.online = true;
  }

  async stop() {
    this.online = false;
    this.pendingXfers.clear();
    await new Promise((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server = null;
    });
    if (this.udp) {
      try { this.udp.close(); } catch (_) {}
      this.udp = null;
    }
  }

  dropNext(n) {
    this._dropNext = Math.max(0, n | 0);
  }

  pauseAccept() {
    this.paused = true;
  }

  resumeAccept() {
    this.paused = false;
  }

  _onConn(socket) {
    if (this.paused || !this.online) {
      socket.destroy();
      return;
    }
    let buf = '';
    socket.on('data', (chunk) => {
      if (this.paused) return;
      buf += chunk.toString('utf8');
      if (buf.length > 8 * 1024 * 1024) {
        buf = '';
        socket.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        this._handleLine(line, socket);
      }
    });
    socket.on('error', () => {});
  }

  _handleLine(line, socket) {
    if (!line || !line.trim()) return;
    if (this._dropNext > 0) {
      this._dropNext -= 1;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (_) {
      this.logError('json-parse', line.slice(0, 80));
      return;
    }
    const type = payload.type || 'CHAT';
    if (type === 'CHAT') {
      this.chatsReceived += 1;
      const uid = payload.uid || payload.msgUid || '';
      if (uid) this.received.set(String(uid), payload);
      this.emit('chat', payload);
      if (uid) {
        try {
          socket.write(JSON.stringify({ type: 'MSG_ACK', msgUid: uid }) + '\n');
          this.acksSent += 1;
        } catch (_) { /* ignore */ }
      }
    } else if (type === 'MSG_ACK') {
      this.emit('ack', payload);
    } else if (type === 'FILE_XFER_START') {
      this._onFileStart(payload, socket);
    } else if (type === 'FILE_XFER_CHUNK') {
      this._onFileChunk(payload);
    } else if (type === 'FILE_XFER_END') {
      this._onFileEnd(payload);
    } else if (type === 'PING' || type === 'GOODBYE') {
      this.emit('presence', payload);
    } else {
      this.emit('other', payload);
    }
  }

  _onFileStart(payload, socket) {
    const xferUid = payload.xferUid;
    const size = Number(payload.size) || 0;
    const totalChunks = Number(payload.totalChunks) || 0;
    if (!xferUid || size <= 0 || size > MAX_FILE_XFER_BYTES || totalChunks <= 0) {
      try {
        socket.write(JSON.stringify({ type: 'FILE_XFER_ABORT', xferUid, reason: 'size_or_chunks' }) + '\n');
      } catch (_) {}
      this.fileAborts += 1;
      return;
    }
    if (!this.canAcceptXfer(size)) {
      try {
        socket.write(JSON.stringify({ type: 'FILE_XFER_ABORT', xferUid, reason: 'receiver_busy' }) + '\n');
      } catch (_) {}
      this.fileRejectBusy += 1;
      this.fileAborts += 1;
      return;
    }
    this.pendingXfers.set(xferUid, {
      fileName: payload.fileName || 'file',
      mime: payload.mime || 'application/octet-stream',
      size,
      totalChunks,
      chunks: new Map(),
      sender: payload.sender,
      msgUid: payload.msgUid,
      fromSubnet: payload.fromSubnet || null
    });
    try {
      socket.write(JSON.stringify({ type: 'FILE_XFER_ACCEPT', xferUid }) + '\n');
      this.fileAccepts += 1;
    } catch (_) {}
  }

  _onFileChunk(payload) {
    const entry = this.pendingXfers.get(payload.xferUid);
    if (!entry) return;
    const index = Number(payload.index);
    if (!Number.isInteger(index) || index < 0 || index >= entry.totalChunks) return;
    try {
      entry.chunks.set(index, Buffer.from(payload.data || '', 'base64'));
    } catch (e) {
      this.logError('chunk-decode', e.message);
    }
  }

  _onFileEnd(payload) {
    const entry = this.pendingXfers.get(payload.xferUid);
    if (!entry) return;
    this.pendingXfers.delete(payload.xferUid);
    if (entry.chunks.size !== entry.totalChunks) {
      this.logError('chunk-missing', `${entry.chunks.size}/${entry.totalChunks}`);
      this.fileAborts += 1;
      return;
    }
    const parts = [];
    for (let i = 0; i < entry.totalChunks; i++) {
      const c = entry.chunks.get(i);
      if (!c) {
        this.logError('chunk-gap', i);
        this.fileAborts += 1;
        return;
      }
      parts.push(c);
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== entry.size) {
      this.logError('size-mismatch', `${buf.length}!=${entry.size}`);
      this.fileAborts += 1;
      return;
    }
    const rec = {
      xferUid: payload.xferUid,
      fileName: entry.fileName,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      fromSubnet: entry.fromSubnet,
      msgUid: entry.msgUid
    };
    this.filesReceived.push(rec);
    this.emit('file', rec, buf);
  }

  /**
   * @returns {Promise<{ok:boolean, ack?:boolean, reason?:string}>}
   */
  sendChat(host, port, message, uid, opts) {
    const o = opts || {};
    const waitAck = o.waitAck !== false;
    const timeoutMs = o.timeoutMs || 2500;
    return new Promise((resolve) => {
      if (this.paused) {
        this.connectFails += 1;
        resolve({ ok: false, ack: false, reason: 'paused' });
        return;
      }
      const client = new net.Socket();
      let settled = false;
      let gotAck = false;
      const done = (ok, reason) => {
        if (settled) return;
        settled = true;
        try { client.destroy(); } catch (_) {}
        resolve({ ok, ack: gotAck, reason });
      };
      client.setTimeout(timeoutMs);
      client.connect(port, host, () => {
        const line = JSON.stringify({
          type: 'CHAT',
          sender: this.username,
          message,
          uid,
          fromSubnet: this.subnet,
          logicalIp: this.logicalIp
        }) + '\n';
        client.write(line);
        if (!waitAck) {
          client.end();
          done(true);
        }
      });
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'MSG_ACK' && String(msg.msgUid) === String(uid)) {
              gotAck = true;
              this.emit('ack', msg);
              done(true);
              return;
            }
          } catch (_) { /* ignore */ }
        }
      });
      client.on('error', () => {
        this.connectFails += 1;
        done(false, 'error');
      });
      client.on('timeout', () => {
        this.connectFails += 1;
        done(gotAck, 'timeout');
      });
      client.on('close', () => {
        if (waitAck) done(gotAck, gotAck ? undefined : 'close');
      });
    });
  }

  /**
   * FILE_XFER 송신 (ACCEPT 핸드셰이크 + 청크)
   * @returns {Promise<{ok:boolean, reason?:string, aborted?:boolean}>}
   */
  sendFile(host, port, buf, meta, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 120000;
    const xferUid = meta.xferUid || `xf_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const fileName = meta.fileName || 'file.bin';
    const mime = meta.mime || 'application/octet-stream';
    return new Promise((resolve) => {
      if (!buf || !buf.length) {
        resolve({ ok: false, reason: 'empty' });
        return;
      }
      if (buf.length > MAX_FILE_XFER_BYTES) {
        resolve({ ok: false, reason: 'over_max_50mb' });
        return;
      }
      const totalChunks = Math.max(1, Math.ceil(buf.length / FILE_XFER_CHUNK_RAW_BYTES));
      const client = new net.Socket();
      let settled = false;
      let phase = 'wait-accept';
      let recvBuf = '';
      let legacyTimer = null;
      const done = (ok, reason, aborted) => {
        if (settled) return;
        settled = true;
        if (legacyTimer) clearTimeout(legacyTimer);
        try { client.destroy(); } catch (_) {}
        resolve({ ok, reason, aborted: !!aborted });
      };
      const writeRest = () => {
        if (legacyTimer) { clearTimeout(legacyTimer); legacyTimer = null; }
        let i = 0;
        const writeNext = () => {
          if (settled) return;
          if (i >= totalChunks) {
            client.write(JSON.stringify({ type: 'FILE_XFER_END', xferUid }) + '\n');
            phase = 'done';
            client.end();
            return;
          }
          const start = i * FILE_XFER_CHUNK_RAW_BYTES;
          const slice = buf.subarray(start, Math.min(start + FILE_XFER_CHUNK_RAW_BYTES, buf.length));
          const line = JSON.stringify({
            type: 'FILE_XFER_CHUNK',
            xferUid,
            index: i,
            data: slice.toString('base64')
          }) + '\n';
          i += 1;
          const ok = client.write(line);
          if (!ok) client.once('drain', () => setImmediate(writeNext));
          else setImmediate(writeNext);
        };
        writeNext();
      };
      client.setTimeout(timeoutMs);
      client.connect(port, host, () => {
        client.write(JSON.stringify({
          type: 'FILE_XFER_START',
          xferUid,
          fileName,
          mime,
          size: buf.length,
          totalChunks,
          sender: this.username,
          msgUid: meta.msgUid,
          fromSubnet: this.subnet,
          logicalIp: this.logicalIp
        }) + '\n');
        legacyTimer = setTimeout(() => {
          if (settled || phase !== 'wait-accept') return;
          phase = 'sending-legacy';
          writeRest();
        }, 800);
      });
      client.on('data', (chunk) => {
        if (settled || phase !== 'wait-accept') return;
        recvBuf += chunk.toString('utf8');
        let idx;
        while ((idx = recvBuf.indexOf('\n')) !== -1) {
          const line = recvBuf.slice(0, idx);
          recvBuf = recvBuf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.xferUid && msg.xferUid !== xferUid) continue;
            if (msg.type === 'FILE_XFER_ACCEPT') {
              phase = 'sending';
              writeRest();
              return;
            }
            if (msg.type === 'FILE_XFER_ABORT') {
              done(false, msg.reason || 'abort', true);
              return;
            }
          } catch (_) { /* ignore */ }
        }
      });
      client.on('close', () => {
        if (phase === 'done') done(true);
        else if (!settled) done(false, 'closed_early');
      });
      client.on('error', () => done(false, 'error'));
      client.on('timeout', () => done(false, 'timeout'));
    });
  }

  sendUdp(host, port, obj) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const buf = Buffer.from(JSON.stringify(obj));
      sock.send(buf, port, host, (err) => {
        try { sock.close(); } catch (_) {}
        resolve(!err);
      });
    });
  }
}

/**
 * 송신측 재전송용 expand (main.js messageHtmlForWire 와 동일 규칙의
 * mirae-file:// 이 로컬에 없으면 원문 유지 → 수신측에서 열리지 않음(버그 재현).
 */
function expandMiraeFileUrlsToDataUrls(messageHtml, resolveFile) {
  if (typeof messageHtml !== 'string' || messageHtml.indexOf('mirae-file://') === -1) {
    return messageHtml;
  }
  return messageHtml.replace(/((?:src|href)=")mirae-file:\/\/([^"]+)(")/gi, (full, prefix, encName, suffix) => {
    try {
      const name = decodeURIComponent(String(encName).split(/[?#]/)[0]);
      const resolved = typeof resolveFile === 'function' ? resolveFile(name) : null;
      if (!resolved || !resolved.buf) return full;
      const mime = resolved.mime || 'application/octet-stream';
      return `${prefix}data:${mime};base64,${resolved.buf.toString('base64')}${suffix}`;
    } catch (_) {
      return full;
    }
  });
}

function buildFileXferPayloads(buf, meta) {
  const totalChunks = Math.max(1, Math.ceil(buf.length / FILE_XFER_CHUNK_RAW_BYTES));
  const payloads = [];
  payloads.push({
    type: 'FILE_XFER_START',
    xferUid: meta.xferUid,
    fileName: meta.fileName,
    mime: meta.mime || 'application/octet-stream',
    size: buf.length,
    totalChunks
  });
  for (let i = 0; i < totalChunks; i++) {
    const start = i * FILE_XFER_CHUNK_RAW_BYTES;
    const slice = buf.subarray(start, Math.min(start + FILE_XFER_CHUNK_RAW_BYTES, buf.length));
    payloads.push({
      type: 'FILE_XFER_CHUNK',
      xferUid: meta.xferUid,
      index: i,
      data: slice.toString('base64')
    });
  }
  payloads.push({ type: 'FILE_XFER_END', xferUid: meta.xferUid });
  return payloads;
}

module.exports = {
  VirtualPeer,
  expandMiraeFileUrlsToDataUrls,
  buildFileXferPayloads,
  FILE_XFER_CHUNK_RAW_BYTES,
  MAX_FILE_XFER_BYTES,
  MAX_PENDING_FILE_XFERS,
  MAX_PENDING_FILE_XFER_BYTES
};
