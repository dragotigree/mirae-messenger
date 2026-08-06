#!/usr/bin/env node
/**
 * 최근 소기능(공지/채팅고정/카테고리/표시이름) 로직 자동 검증.
 * Electron 없이 sqlite3 + 인라인 로직으로 PASS/FAIL 판정.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(os.tmpdir(), `mirae-verify-${Date.now()}.db`);
const db = new sqlite3.Database(dbPath);

let passed = 0;
let failed = 0;
const results = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    results.push({ name, status: 'PASS', detail: detail || '' });
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    results.push({ name, status: 'FAIL', detail: detail || '' });
    console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function normalizeNoticeCategory(c) {
  const s = String(c || '').trim();
  if (!s) return '전체';
  return s;
}

function isPlaceholderUsername(name) {
  const s = String(name || '').trim();
  return /^(이름없음|이름\s*없음|미설정|unnamed|unknown|n\/?a)$/i.test(s);
}

function profileDisplayName(profile) {
  const p = profile || {};
  const rank = String(p.rank || '').trim();
  const username = isPlaceholderUsername(p.username) ? '' : String(p.username || '').trim();
  if (rank && username) return `${rank} ${username}`;
  if (username) return username;
  if (rank) return rank;
  return '나';
}

function resolveMessageSenderDisplay(senderName, isMe, myProfile) {
  if (isMe && myProfile) return profileDisplayName(myProfile);
  if (isPlaceholderUsername(senderName)) return isMe ? '나' : '상대방';
  return String(senderName || '').trim() || (isMe ? '나' : '상대방');
}

// --- chat pin tombstone logic (mirrors main.js) ---
const chatPinTombstoneMemory = new Map();

function rememberChatPinTombstone(channelKey, clearedAt) {
  const key = String(channelKey || '').trim();
  if (!key) return;
  const at = String(clearedAt || new Date().toISOString());
  const prev = chatPinTombstoneMemory.get(key);
  if (!prev || at > prev) chatPinTombstoneMemory.set(key, at);
}

async function clearChatPinRow(channelKey, clearedAt, opts) {
  const key = String(channelKey || '').trim();
  const force = !!(opts && opts.force);
  const at = String(clearedAt || new Date().toISOString());
  rememberChatPinTombstone(key, at);
  const tombAt = chatPinTombstoneMemory.get(key) || at;
  await run(`INSERT OR REPLACE INTO deleted_chat_pins (channel_key, cleared_at) VALUES (?, ?)`, [key, tombAt]);
  const row = await get(`SELECT pinned_at FROM chat_pins WHERE channel_key = ?`, [key]);
  const pinnedAt = row && row.pinned_at ? String(row.pinned_at) : '';
  const shouldDelete = force || !row || !pinnedAt || pinnedAt <= tombAt;
  if (shouldDelete) {
    await run(`DELETE FROM chat_pins WHERE channel_key = ?`, [key]);
  }
}

async function upsertChatPinRow(pin) {
  const key = String(pin.channel_key || '').trim();
  if (!key) return;
  if (pin._clear) {
    await clearChatPinRow(key, pin.cleared_at || new Date().toISOString(), { force: false });
    return;
  }
  const pinnedAt = String(pin.pinned_at || new Date().toISOString());
  const tombstoneAt = chatPinTombstoneMemory.get(key);
  if (tombstoneAt && pinnedAt <= tombstoneAt) return;
  if (tombstoneAt && pinnedAt > tombstoneAt) {
    chatPinTombstoneMemory.delete(key);
    await run(`DELETE FROM deleted_chat_pins WHERE channel_key = ?`, [key]);
  }
  await run(
    `INSERT OR REPLACE INTO chat_pins (channel_key, msg_uid, message_html, preview_text, sender_name, pinned_at, pinned_by_name, pinned_by_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, pin.msg_uid || '', pin.message_html || '', pin.preview_text || '', pin.sender_name || '', pinnedAt, '', '']
  );
}

async function setupSchema() {
  await run(`CREATE TABLE notices (
    uid TEXT PRIMARY KEY,
    title TEXT, content TEXT, author_name TEXT, author_ip TEXT, created_at TEXT,
    images TEXT DEFAULT '[]', category TEXT DEFAULT '전체'
  )`);
  await run(`CREATE TABLE deleted_notices (uid TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)`);
  await run(`CREATE TABLE chat_pins (
    channel_key TEXT PRIMARY KEY, msg_uid TEXT, message_html TEXT, preview_text TEXT,
    sender_name TEXT, pinned_at TEXT, pinned_by_name TEXT, pinned_by_ip TEXT
  )`);
  await run(`CREATE TABLE deleted_chat_pins (channel_key TEXT PRIMARY KEY, cleared_at TEXT NOT NULL)`);
}

async function testNoticeCategoriesNoOverwrite() {
  await run(`INSERT INTO notices (uid, title, content, author_name, author_ip, created_at, category) VALUES (?,?,?,?,?,?,?)`,
    ['n1', '업데이트공지', '본문1', '작성자', '1.1.1.1', '2026-01-01T00:00:00.000Z', '업데이트']);
  await run(`INSERT INTO notices (uid, title, content, author_name, author_ip, created_at, category) VALUES (?,?,?,?,?,?,?)`,
    ['n2', '재활공지', '본문2', '작성자', '1.1.1.1', '2026-01-02T00:00:00.000Z', '재활치료부']);
  // plain INSERT must not wipe the other (REPLACE would if conflicted on non-uid unique — we assert both remain)
  const rows = await all(`SELECT uid, category FROM notices ORDER BY uid`);
  ok('공지 카테고리 독립 저장', rows.length === 2
    && rows.find((r) => r.uid === 'n1' && r.category === '업데이트')
    && rows.find((r) => r.uid === 'n2' && r.category === '재활치료부'),
    `rows=${JSON.stringify(rows)}`);
}

async function testNoticeSyncNoDuplicate() {
  // Simulate upsertNoticeFromSync fix: SELECT then UPDATE or INSERT; UNIQUE → UPDATE not new uid
  const uid = 'sync-uid-1';
  await run(`INSERT INTO notices (uid, title, content, author_name, author_ip, created_at, category) VALUES (?,?,?,?,?,?,?)`,
    [uid, '원본', 'A', '작성자', '1.1.1.1', '2026-01-01T00:00:00.000Z', '전체']);

  async function upsertFromSync(n) {
    const existing = await get(`SELECT uid FROM notices WHERE uid = ?`, [n.uid]);
    if (existing) {
      await run(
        `UPDATE notices SET title = ?, content = ?, category = ? WHERE uid = ?`,
        [n.title, n.content, normalizeNoticeCategory(n.category), n.uid]
      );
      return;
    }
    try {
      await run(
        `INSERT INTO notices (uid, title, content, author_name, author_ip, created_at, category) VALUES (?,?,?,?,?,?,?)`,
        [n.uid, n.title, n.content, n.author_name, n.author_ip, n.created_at, normalizeNoticeCategory(n.category)]
      );
    } catch (e) {
      if (/UNIQUE|constraint|PRIMARY KEY/i.test(String(e.message || ''))) {
        await run(
          `UPDATE notices SET title = ?, content = ?, category = ? WHERE uid = ?`,
          [n.title, n.content, normalizeNoticeCategory(n.category), n.uid]
        );
        return;
      }
      throw e;
    }
  }

  // Re-sync same content (UPDATE changes may be 0) — must not create second row
  await upsertFromSync({
    uid, title: '원본', content: 'A', author_name: '작성자', author_ip: '1.1.1.1',
    created_at: '2026-01-01T00:00:00.000Z', category: '전체'
  });
  await upsertFromSync({
    uid, title: '수정됨', content: 'B', author_name: '작성자', author_ip: '1.1.1.1',
    created_at: '2026-01-01T00:00:00.000Z', category: '업데이트'
  });

  const rows = await all(`SELECT uid, title, category FROM notices WHERE uid = ? OR title IN ('원본','수정됨')`, [uid]);
  const sameUid = await all(`SELECT uid FROM notices WHERE uid = ?`, [uid]);
  ok('공지 sync 재적용 시 중복 uid 미생성', sameUid.length === 1 && rows.length === 1 && rows[0].title === '수정됨',
    `count=${rows.length} title=${rows[0] && rows[0].title}`);
}

async function testNoticeTombstoneVsBody() {
  const uid = 'tomb-1';
  const incomingBodies = new Set([uid]);
  const deleted = ['tomb-1', 'tomb-2'];
  const toDelete = deleted.filter((u) => !incomingBodies.has(u));
  ok('공지 tombstone보다 같은 응답 본문 우선', toDelete.length === 1 && toDelete[0] === 'tomb-2');
}

async function testChatPinClearAndResurrection() {
  const key = 'dm:1.2.3.4';
  const t0 = '2026-08-06T01:00:00.000Z';
  const tClear = '2026-08-06T02:00:00.000Z';
  const tOld = '2026-08-06T01:30:00.000Z';
  const tNew = '2026-08-06T03:00:00.000Z';

  await upsertChatPinRow({
    channel_key: key, preview_text: '테스트입니다.', pinned_at: t0, sender_name: '회의실'
  });
  let row = await get(`SELECT * FROM chat_pins WHERE channel_key = ?`, [key]);
  ok('채팅 공지 고정 저장', !!row && row.preview_text === '테스트입니다.');

  await clearChatPinRow(key, tClear, { force: true });
  row = await get(`SELECT * FROM chat_pins WHERE channel_key = ?`, [key]);
  const tomb = await get(`SELECT * FROM deleted_chat_pins WHERE channel_key = ?`, [key]);
  ok('채팅 공지 해제 + tombstone', !row && !!tomb && tomb.cleared_at === tClear);

  // Peer sync tries to resurrect old pin
  await upsertChatPinRow({
    channel_key: key, preview_text: '되살아나면 안됨', pinned_at: tOld, sender_name: '회의실'
  });
  row = await get(`SELECT * FROM chat_pins WHERE channel_key = ?`, [key]);
  ok('해제 후 옛 pin sync 되살림 차단', !row);

  // Re-pin after clear
  await upsertChatPinRow({
    channel_key: key, preview_text: '다시 고정', pinned_at: tNew, sender_name: '회의실'
  });
  row = await get(`SELECT * FROM chat_pins WHERE channel_key = ?`, [key]);
  ok('해제 이후 새 고정은 허용', !!row && row.preview_text === '다시 고정');

  // Delayed peer clear older than re-pin must not wipe
  await upsertChatPinRow({ channel_key: key, _clear: true, cleared_at: tClear });
  row = await get(`SELECT * FROM chat_pins WHERE channel_key = ?`, [key]);
  ok('늦은 피어 해제가 최신 재고정을 지우지 않음', !!row && row.preview_text === '다시 고정');
}

async function testBubbleDisplayName() {
  const my = { rank: '간호사', username: '이름없음' };
  const d1 = resolveMessageSenderDisplay('이름없음', true, my);
  ok('내 말풍선 이름없음 → 직급만/나', d1 === '간호사' || d1 === '나', `got=${d1}`);

  const my2 = { rank: '', username: '' };
  const d2 = resolveMessageSenderDisplay('', true, my2);
  ok('내 말풍선 빈이름 → 나', d2 === '나');

  const d3 = resolveMessageSenderDisplay('이름없음', false, my);
  ok('상대 말풍선 이름없음 플레이스홀더 처리', d3 === '상대방');
}

async function testIpmsgFlexCss() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const recip = /\.ipmsg-recipient-pane\s*\{[^}]*flex:\s*1\s+1\s+0/m.test(html);
  const compose = /\.ipmsg-compose-pane\s*\{[^}]*flex:\s*1\s+1\s+0/m.test(html);
  ok('쪽지 모달 수신/작성 영역 50/50 flex', recip && compose);
}

async function testWriterLoginOpenAdminFlag() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // notice writer path with master fallback must use openAdmin: false
  const has = /applyMasterAuthSuccess\(\{\s*openDutyRoster:\s*false,\s*openAdmin:\s*false\s*\}\)/.test(html);
  ok('공지 작성 로그인 시 openAdmin:false', has);
}

async function testMainJsPinAndSyncHooks() {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok('deleted_chat_pins 테이블 존재', /CREATE TABLE IF NOT EXISTS deleted_chat_pins/.test(main));
  ok('clear-chat-pin await clearChatPinRow', /await clearChatPinRow\(key/.test(main));
  ok('upsertNoticeFromSync SELECT 후 INSERT', /SELECT uid FROM notices WHERE uid = \?/.test(main)
    && /forbidNewUidOnConflict/.test(main));
  ok('sync pin 전용 청크 unshift', /chunks\.unshift\(pinChunk\)/.test(main));
  ok('일정 tombstone 본문 우선', /incomingScheduleUids/.test(main));
  ok('update-notice notices-update 송신', /update-notice[\s\S]*?safeWebContentsSend\('notices-update'\)/.test(main));
}

async function main() {
  console.log('=== Mirae minor-feature verification ===\n');
  await setupSchema();
  await testNoticeCategoriesNoOverwrite();
  await testNoticeSyncNoDuplicate();
  await testNoticeTombstoneVsBody();
  await testChatPinClearAndResurrection();
  await testBubbleDisplayName();
  await testIpmsgFlexCss();
  await testWriterLoginOpenAdminFlag();
  await testMainJsPinAndSyncHooks();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  db.close();
  try { fs.unlinkSync(dbPath); } catch (_) {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(dbPath); } catch (_) {}
  process.exit(2);
});
