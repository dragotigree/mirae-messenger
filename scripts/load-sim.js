#!/usr/bin/env node
/**
 * Mirae Messenger — 부하 모의 도구
 *
 * 200명이 한꺼번에 접속하는 상황 등을 로컬/네트워크에서 재현합니다.
 *
 * ┌─ 모드 ──────────────────────────────────────────────────────────────┐
 * │ presence  가상 직원 N명을 이 PC 메신저 목록에 온라인으로 주입       │
 * │           (실제 UI·DB·프레즌스 부하 — 추천)                          │
 * │ udp       대상 PC로 UDP PING 폭주 (수신 rate-limit / 스톰 보호 시험) │
 * │ tcp-chat  대상 PC로 TCP 채팅 다발 전송 (연결·파싱 부하)              │
 * │ db        SQLite persist 단독 스트레스 (기존 stress-presence-persist)│
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 사용 예:
 *   node scripts/load-sim.js presence --users=200
 *   node scripts/load-sim.js presence --users=200 --mode=sustain --seconds=90
 *   node scripts/load-sim.js presence --mode=clear
 *   node scripts/load-sim.js udp --target=192.168.0.10 --count=400 --rate=80
 *   node scripts/load-sim.js tcp-chat --target=192.168.0.10 --messages=100
 *   node scripts/load-sim.js db --users=200 --seconds=12
 *
 * presence 모드는 이 PC에서 메신저가 실행 중이어야 하며,
 * TCP 41235(로컬)로 LOADTEST 명령을 보냅니다. (127.0.0.1만 허용)
 */
'use strict';

const dgram = require('dgram');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const UDP_PORT = 41234;
const TCP_PORT = 41235;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`) || process.argv.includes(`-${name}`);
}

function printHelp() {
  console.log(`Mirae Messenger load-sim

Usage:
  node scripts/load-sim.js <command> [options]

Commands:
  presence   Inject N fake online users into local messenger (recommended)
  udp        Flood UDP PING packets at a target IP
  tcp-chat   Send many TCP CHAT lines to a target IP
  db         Run SQLite presence-persist microbench
  help       Show this help

presence options:
  --users=200          Number of fake peers (1..500, default 200)
  --mode=burst         burst (default) | sustain | clear
  --seconds=60         sustain duration
  --interval=10000     sustain heartbeat interval ms
  --persist=1          1=DB write (default), 0=memory only
  --target=127.0.0.1   messenger host (default localhost)

udp options:
  --target=<ip>        required
  --count=300          total packets
  --rate=50            packets per second
  --name=부하테스터     username field in PING

tcp-chat options:
  --target=<ip>        required
  --messages=50        messages to send
  --concurrency=4      parallel sockets (messenger caps ~8)

db options: forwarded to scripts/stress-presence-persist.js
`);
}

function loadTestIpForIndex(i) {
  const nets = ['192.0.2', '198.51.100', '203.0.113'];
  const idx = Math.max(0, i - 1);
  const netPart = nets[Math.floor(idx / 254) % nets.length];
  const host = (idx % 254) + 1;
  return `${netPart}.${host}`;
}

function buildFakeUsers(n) {
  const users = [];
  for (let i = 1; i <= n; i++) {
    users.push({
      ip: loadTestIpForIndex(i),
      username: `모의직원${String(i).padStart(3, '0')}`,
      rank: i % 7 === 0 ? '실장' : (i % 5 === 0 ? '팀장' : ''),
      dept: `부서${(i % 12) + 1}`,
      floor: `${(i % 8) + 1}층`,
      extNo: String(2000 + i),
      phone: '',
      statusState: 'ONLINE',
      appVersion: 'load-sim'
    });
  }
  return users;
}

function sendTcpJsonLine(host, port, obj, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      const line = JSON.stringify(obj) + '\n';
      socket.write(line, 'utf8', () => {
        // briefly wait for optional ack line
        let buf = '';
        const done = (err, data) => {
          try { socket.destroy(); } catch (_) {}
          if (err) reject(err);
          else resolve(data);
        };
        const timer = setTimeout(() => done(null, buf), 400);
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('\n')) {
            clearTimeout(timer);
            let parsed = null;
            try { parsed = JSON.parse(buf.split('\n')[0]); } catch (_) {}
            done(null, parsed || buf);
          }
        });
        socket.on('error', (e) => {
          clearTimeout(timer);
          done(e);
        });
      });
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TCP timeout ${host}:${port}`));
    });
    socket.on('error', reject);
  });
}

async function cmdPresence(opts) {
  const host = opts.target || '127.0.0.1';
  const mode = opts.mode || 'burst';
  const users = Math.max(1, Math.min(500, parseInt(opts.users || '200', 10) || 200));
  const persist = String(opts.persist || '1') !== '0';

  if (mode === 'clear') {
    console.log(`[presence] clear load-test peers on ${host}…`);
    const res = await sendTcpJsonLine(host, TCP_PORT, {
      type: 'LOADTEST_CMD',
      action: 'clear'
    });
    console.log('[presence] result:', res);
    return;
  }

  if (mode === 'burst') {
    console.log(`[presence] burst inject ${users} peers → ${host} (persist=${persist})`);
    const res = await sendTcpJsonLine(host, TCP_PORT, {
      type: 'LOADTEST_CMD',
      action: 'inject',
      users: buildFakeUsers(users),
      persist,
      staggerMs: 0
    });
    console.log('[presence] result:', res);
    console.log('→ 메신저 직원 목록에 「모의직원001…」이 온라인으로 보여야 합니다.');
    console.log('→ 지울 때: node scripts/load-sim.js presence --mode=clear');
    return;
  }

  if (mode === 'sustain') {
    const seconds = Math.max(5, parseInt(opts.seconds || '60', 10) || 60);
    const interval = Math.max(2000, parseInt(opts.interval || '10000', 10) || 10000);
    console.log(`[presence] sustain ${users} peers for ${seconds}s (heartbeat every ${interval}ms)`);
    const fake = buildFakeUsers(users);
    let res = await sendTcpJsonLine(host, TCP_PORT, {
      type: 'LOADTEST_CMD',
      action: 'inject',
      users: fake,
      persist,
      staggerMs: 2
    });
    console.log('[presence] initial inject:', res);

    const started = Date.now();
    while (Date.now() - started < seconds * 1000) {
      await new Promise((r) => setTimeout(r, interval));
      res = await sendTcpJsonLine(host, TCP_PORT, {
        type: 'LOADTEST_CMD',
        action: 'touch',
        ips: fake.map((u) => u.ip)
      });
      const left = Math.max(0, seconds - Math.round((Date.now() - started) / 1000));
      console.log(`[presence] heartbeat ok · ${left}s left`, res && res.touched != null ? `(touched ${res.touched})` : '');
    }
    console.log('[presence] sustain done. clear with --mode=clear when finished.');
    return;
  }

  throw new Error(`unknown presence mode: ${mode}`);
}

async function cmdUdp(opts) {
  const target = opts.target;
  if (!target) throw new Error('--target=<ip> required');
  const count = Math.max(1, parseInt(opts.count || '300', 10) || 300);
  const rate = Math.max(1, parseInt(opts.rate || '50', 10) || 50);
  const name = opts.name || '부하테스터';
  const socket = dgram.createSocket('udp4');
  const packet = Buffer.from(JSON.stringify({
    type: 'PING',
    username: name,
    rank: '',
    dept: '부하테스트',
    floor: '',
    extNo: '',
    phone: '',
    statusState: 'ONLINE',
    appVersion: 'load-sim-udp'
  }));

  console.log(`[udp] sending ${count} PINGs → ${target}:${UDP_PORT} @ ${rate}/s`);
  console.log('  ※ 소스 IP가 이 PC 하나라서 목록에는 1명만 보입니다. rate-limit/스톰 시험용입니다.');
  console.log('  ※ 200명 목록 부하는 presence 모드를 쓰세요.');

  let sent = 0;
  let dropped = 0;
  const gap = 1000 / rate;
  const t0 = Date.now();

  await new Promise((resolve) => {
    const tick = () => {
      if (sent >= count) {
        resolve();
        return;
      }
      try {
        socket.send(packet, 0, packet.length, UDP_PORT, target, (err) => {
          if (err) dropped += 1;
        });
      } catch (_) {
        dropped += 1;
      }
      sent += 1;
      if (sent % Math.max(1, Math.floor(rate)) === 0) {
        process.stdout.write(`\r  sent ${sent}/${count}`);
      }
      setTimeout(tick, gap);
    };
    tick();
  });

  await new Promise((r) => setTimeout(r, 200));
  try { socket.close(); } catch (_) {}
  console.log(`\n[udp] done in ${Date.now() - t0}ms · sent=${sent} errors=${dropped}`);
}

async function cmdTcpChat(opts) {
  const target = opts.target;
  if (!target) throw new Error('--target=<ip> required');
  const messages = Math.max(1, parseInt(opts.messages || '50', 10) || 50);
  const concurrency = Math.max(1, Math.min(8, parseInt(opts.concurrency || '4', 10) || 4));
  console.log(`[tcp-chat] ${messages} msgs → ${target}:${TCP_PORT} concurrency=${concurrency}`);
  console.log('  ※ 메신저 TCP 동시 연결 상한(~8) 때문에 concurrency를 낮게 유지합니다.');

  let next = 0;
  let ok = 0;
  let fail = 0;
  const t0 = Date.now();

  async function worker() {
    while (next < messages) {
      const i = next;
      next += 1;
      try {
        await sendTcpJsonLine(target, TCP_PORT, {
          type: 'CHAT',
          message: `[load-sim] 부하 테스트 메시지 #${i + 1}`,
          senderName: '부하테스터',
          createdAt: new Date().toISOString(),
          urgent: false,
          uid: `loadsim-${Date.now()}-${i}`
        }, 5000);
        ok += 1;
      } catch (e) {
        fail += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[tcp-chat] done in ${Date.now() - t0}ms · ok=${ok} fail=${fail}`);
}

function cmdDb(extraArgv) {
  const script = path.join(__dirname, 'stress-presence-persist.js');
  const child = spawn(process.execPath, [script, ...extraArgv], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
}

async function main() {
  const cmd = (process.argv[2] || 'help').toLowerCase();
  if (cmd === 'help' || cmd === '-h' || cmd === '--help' || hasFlag('help')) {
    printHelp();
    return;
  }

  const opts = {
    users: arg('users', '200'),
    mode: arg('mode', 'burst'),
    seconds: arg('seconds', '60'),
    interval: arg('interval', '10000'),
    persist: arg('persist', '1'),
    target: arg('target', ''),
    count: arg('count', '300'),
    rate: arg('rate', '50'),
    name: arg('name', '부하테스터'),
    messages: arg('messages', '50'),
    concurrency: arg('concurrency', '4')
  };

  if (cmd === 'presence') {
    if (!opts.target) opts.target = '127.0.0.1';
    await cmdPresence(opts);
    return;
  }
  if (cmd === 'udp') {
    await cmdUdp(opts);
    return;
  }
  if (cmd === 'tcp-chat' || cmd === 'tcp') {
    await cmdTcpChat(opts);
    return;
  }
  if (cmd === 'db') {
    cmdDb(process.argv.slice(3));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error('[load-sim] failed:', err && err.message ? err.message : err);
  if (String(err && err.message || '').includes('ECONNREFUSED')) {
    console.error('  → 메신저가 이 PC에서 실행 중인지, TCP 41235가 열려 있는지 확인하세요.');
  }
  process.exit(1);
});
