#!/usr/bin/env node
/**
 * 시나리오 5 — 장시간 실행·메모리 누수 시뮬
 *
 *  Electron을 며칠 켜둘 수는 없으므로, 동일 패턴을 압축 재현:
 *  A) 장기 idle: presence Map / 메시지 히스토리 / 타이머 콜백 누적 후 GC 전후 heap
 *  B) 미니(compact) ↔ 일반 모드 전환: 큰 UI 상태 객체 create/destroy 반복
 *  C) 채팅 로그 append + trim 누락 시 누수 vs trim 유지
 *
 *   node scripts/stress-memory-churn.js
 *   node scripts/stress-memory-churn.js --quick
 */
'use strict';

const v8 = require('v8');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const QUICK = hasFlag('quick');
const IDLE_TICKS = Math.max(100, parseInt(arg('idle-ticks', QUICK ? '800' : '4000'), 10) || 4000);
const MODE_SWITCHES = Math.max(50, parseInt(arg('mode-switches', QUICK ? '200' : '1000'), 10) || 1000);
const USERS = Math.max(50, parseInt(arg('users', '200'), 10) || 200);
const errorLog = [];

function heapMb() {
  const m = process.memoryUsage();
  return {
    rss: +(m.rss / 1024 / 1024).toFixed(1),
    heapUsed: +(m.heapUsed / 1024 / 1024).toFixed(1),
    heapTotal: +(m.heapTotal / 1024 / 1024).toFixed(1),
    external: +(m.external / 1024 / 1024).toFixed(1)
  };
}

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
    return true;
  }
  // gc 없으면 약한 유도
  const junk = [];
  for (let i = 0; i < 20; i++) junk.push(Buffer.alloc(1024 * 1024));
  junk.length = 0;
  return false;
}

function makeUser(i) {
  return {
    ip: `192.168.${122 + (i % 2)}.${(i % 250) + 1}`,
    username: `직원${i}`,
    rank: i % 5 === 0 ? '수간호사' : '',
    dept: i % 2 === 0 ? '재활' : '내과',
    floor: `${(i % 6) + 1}층`,
    statusState: 'ONLINE',
    photo: i % 7 === 0 ? Buffer.alloc(40 * 1024, i % 200).toString('base64') : '',
    lastPingAt: Date.now(),
    online: true
  };
}

/** 렌더러 유사: allUsers + chatHistories + presence maps */
function createAppState(userCount) {
  const allUsers = new Map();
  const onlineUsers = new Map();
  const peerLastPingAt = new Map();
  const chatHistories = new Map(); // channel → messages[]
  const timers = [];
  for (let i = 0; i < userCount; i++) {
    const u = makeUser(i);
    allUsers.set(u.ip, u);
    onlineUsers.set(u.ip, u);
    peerLastPingAt.set(u.ip, Date.now());
    chatHistories.set(u.ip, []);
  }
  return { allUsers, onlineUsers, peerLastPingAt, chatHistories, timers, viewMode: 'normal', compactList: null, normalLayout: null };
}

function tickIdle(state, tick) {
  // presence PING 갱신 (변경 없으면 객체 교체만)
  state.onlineUsers.forEach((u, ip) => {
    state.peerLastPingAt.set(ip, Date.now());
    if (tick % 40 === 0) {
      // 가끔 프로필 변경 → Map 엔트리 교체
      state.allUsers.set(ip, { ...u, lastPingAt: Date.now(), statusState: tick % 80 === 0 ? 'TREATMENT' : 'ONLINE' });
    }
  });
  // 메시지 유입 (일부 채널)
  if (tick % 3 === 0) {
    const ips = [...state.chatHistories.keys()];
    const ip = ips[tick % ips.length];
    const hist = state.chatHistories.get(ip);
    hist.push({
      id: tick,
      text: `인수인계 #${tick} — ${'가'.repeat(40)}`,
      at: Date.now(),
      html: `<div class="msg">${'나'.repeat(20)}</div>`
    });
    // 정상 앱: 최근 N건만 유지
    const CAP = 500;
    if (hist.length > CAP) hist.splice(0, hist.length - CAP);
  }
}

/** 누수 버전: trim 없이 무한 append */
function tickIdleLeaky(state, tick) {
  const ips = [...state.chatHistories.keys()];
  const ip = ips[tick % ips.length];
  state.chatHistories.get(ip).push({
    id: tick,
    text: `leak ${tick}`,
    blob: Buffer.alloc(2048, tick % 255)
  });
  // 타이머 핸들 누적 (미정리)
  state.timers.push(setTimeout(() => {}, 60000));
}

function buildNormalLayout(state) {
  return {
    mode: 'normal',
    sidebar: [...state.allUsers.values()].map((u) => ({
      ip: u.ip,
      name: u.username,
      dept: u.dept,
      photo: u.photo
    })),
    chatPane: {
      messages: Array.from({ length: 80 }, (_, i) => ({
        i,
        html: `<div>${'메시지'.repeat(10)}</div>`
      })),
      detail: { calendar: Array.from({ length: 30 }, (_, d) => ({ d, events: 2 })) }
    }
  };
}

function buildCompactLayout(state) {
  return {
    mode: 'compact',
    list: [...state.onlineUsers.values()].slice(0, 40).map((u) => ({
      ip: u.ip,
      name: u.username,
      online: u.online
    })),
    miniChat: { preview: '미리보기', unread: 3 }
  };
}

function switchMode(state, toCompact) {
  // 이전 레이아웃 해제
  state.normalLayout = null;
  state.compactList = null;
  if (toCompact) {
    state.viewMode = 'compact';
    state.compactList = buildCompactLayout(state);
  } else {
    state.viewMode = 'normal';
    state.normalLayout = buildNormalLayout(state);
  }
}

async function scenarioLongIdle() {
  const t0 = Date.now();
  forceGc();
  const before = heapMb();
  const state = createAppState(USERS);

  for (let tick = 0; tick < IDLE_TICKS; tick++) {
    tickIdle(state, tick);
  }

  // 타이머만 정리
  state.timers.forEach((t) => clearTimeout(t));
  state.timers.length = 0;

  forceGc();
  const after = heapMb();
  const deltaHeap = +(after.heapUsed - before.heapUsed).toFixed(1);
  const msgCount = [...state.chatHistories.values()].reduce((a, h) => a + h.length, 0);

  // 기준: trim 있으면 사용자당 500 이하, heap 증가 합리적
  const risks = [];
  const maxPer = Math.max(...[...state.chatHistories.values()].map((h) => h.length), 0);
  if (maxPer > 500) risks.push('history-unbounded');
  if (deltaHeap > (QUICK ? 120 : 250)) risks.push('idle-heap-growth');

  // 참조 유지 방지
  state.allUsers.clear();
  state.onlineUsers.clear();
  state.chatHistories.clear();

  return {
    kind: 'long-idle-compressed',
    users: USERS,
    ticks: IDLE_TICKS,
    equivalentNote: `ticks=${IDLE_TICKS} ≈ presence 수초 주기 × 압축. 실제 수일 방치는 Electron에서 별도 관찰.`,
    messageRowsHeld: msgCount,
    maxHistoryPerPeer: maxPer,
    heapBeforeMb: before,
    heapAfterMb: after,
    deltaHeapMb: deltaHeap,
    gcAvailable: typeof global.gc === 'function',
    risks,
    wallMs: Date.now() - t0
  };
}

async function scenarioModeSwitch() {
  const t0 = Date.now();
  forceGc();
  const before = heapMb();
  const state = createAppState(Math.min(USERS, 120));
  // 시드 히스토리
  state.chatHistories.forEach((h) => {
    for (let i = 0; i < 100; i++) h.push({ id: i, text: `seed ${i}`, html: '<div>x</div>' });
  });

  for (let i = 0; i < MODE_SWITCHES; i++) {
    switchMode(state, i % 2 === 0);
  }

  // 마지막 레이아웃 해제
  state.normalLayout = null;
  state.compactList = null;
  forceGc();
  const mid = heapMb();

  // 누수 대조: 레이아웃을 배열에 쌓음
  const leakBag = [];
  for (let i = 0; i < Math.min(MODE_SWITCHES, QUICK ? 80 : 200); i++) {
    leakBag.push(i % 2 === 0 ? buildCompactLayout(state) : buildNormalLayout(state));
  }
  forceGc();
  const withLeak = heapMb();
  leakBag.length = 0;
  forceGc();
  const afterClear = heapMb();

  const deltaClean = +(mid.heapUsed - before.heapUsed).toFixed(1);
  const deltaLeaky = +(withLeak.heapUsed - mid.heapUsed).toFixed(1);
  const recovered = +(withLeak.heapUsed - afterClear.heapUsed).toFixed(1);

  const risks = [];
  if (deltaClean > (QUICK ? 80 : 150)) risks.push('mode-switch-retained');
  // leaky path should show growth — if not, measurement noise
  if (deltaLeaky < 5 && MODE_SWITCHES > 100) {
    errorLog.push({ scenario: 'mode-switch', note: 'leaky bag grew less than expected (ok if GC aggressive)' });
  }

  state.allUsers.clear();
  state.chatHistories.clear();

  return {
    kind: 'mini-normal-mode-churn',
    switches: MODE_SWITCHES,
    heapBeforeMb: before,
    heapAfterCleanSwitchesMb: mid,
    heapWithRetainedLayoutsMb: withLeak,
    heapAfterReleaseMb: afterClear,
    deltaCleanMb: deltaClean,
    deltaLeakyBagMb: deltaLeaky,
    recoveredAfterReleaseMb: recovered,
    risks,
    wallMs: Date.now() - t0,
    note: 'clean 전환은 이전 레이아웃 null. retained 배열은 누수 패턴 대조군.'
  };
}

async function scenarioLeakContrast() {
  const t0 = Date.now();
  forceGc();
  const before = heapMb();
  const state = createAppState(40);
  const ticks = QUICK ? 400 : 1500;
  for (let i = 0; i < ticks; i++) tickIdleLeaky(state, i);
  const timers = state.timers.length;
  const rows = [...state.chatHistories.values()].reduce((a, h) => a + h.length, 0);
  forceGc();
  const after = heapMb();
  state.timers.forEach((t) => clearTimeout(t));
  state.timers.length = 0;
  state.chatHistories.clear();
  forceGc();
  const cleaned = heapMb();

  return {
    kind: 'leak-contrast-no-trim',
    ticks,
    unclearedTimers: timers,
    messageRows: rows,
    heapBeforeMb: before,
    heapAfterLeakyMb: after,
    heapAfterCleanupMb: cleaned,
    deltaLeakyMb: +(after.heapUsed - before.heapUsed).toFixed(1),
    wallMs: Date.now() - t0,
    note: 'trim/타이머 정리 없으면 heap·핸들 증가 — 앱 쪽 CAP·clearTimeout 필요성 입증'
  };
}

function verdict(results) {
  const risks = [
    ...(results.idle.risks || []),
    ...(results.mode.risks || [])
  ];
  let level = 'LOW';
  if (risks.includes('history-unbounded') || risks.includes('mode-switch-retained')) level = 'HIGH';
  else if (risks.length) level = 'MEDIUM';
  // leak contrast is expected to grow — not a fail
  return { level, risks };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 시나리오 5: 장시간·미니모드 메모리 시뮬');
  console.log(` idleTicks=${IDLE_TICKS} modeSwitches=${MODE_SWITCHES} users=${USERS} quick=${QUICK}`);
  console.log(` gc=${typeof global.gc === 'function'} heapLimitMb=${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)}`);
  console.log('══════════════════════════════════════════════');
  if (typeof global.gc !== 'function') {
    console.log(' 힌트: node --expose-gc scripts/stress-memory-churn.js 권장');
  }

  const results = {};
  console.log('\n▶ A) 장기 idle 압축');
  results.idle = await scenarioLongIdle();
  console.log(JSON.stringify(results.idle, null, 2));

  console.log('\n▶ B) 미니↔일반 전환');
  results.mode = await scenarioModeSwitch();
  console.log(JSON.stringify(results.mode, null, 2));

  console.log('\n▶ C) 누수 대조(trim 없음)');
  results.leakContrast = await scenarioLeakContrast();
  console.log(JSON.stringify(results.leakContrast, null, 2));

  const v = verdict(results);
  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    idleDeltaMb: results.idle.deltaHeapMb,
    modeDeltaMb: results.mode.deltaCleanMb,
    leakDeltaMb: results.leakContrast.deltaLeakyMb
  })}`);

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
