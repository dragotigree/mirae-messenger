#!/usr/bin/env node
/**
 * Mirae Messenger — 전체 소기능·보안 게이트 자동 검증
 * Electron 없이 main.js / index.html / preload.js 정적 검사 + sqlite 로직 시뮬레이션
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function has(src, re) {
  return re.test(src);
}

// ---------- static checks ----------
function testVersions() {
  ok('package.json === version.json', pkg.version === ver.version, `${pkg.version} / ${ver.version}`);
}

function testPreloadIpcParity() {
  const invokes = [...preloadSrc.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  const unique = [...new Set(invokes)];
  const missing = unique.filter((ch) => {
    const re = new RegExp(`ipcMain\\.handle\\('${ch.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}'`);
    return !re.test(mainSrc);
  });
  ok('preload invoke ↔ ipcMain.handle 대응', missing.length === 0, missing.length ? missing.join(',') : `${unique.length} channels`);
}

function testNoticeAuthGates() {
  ok('add-notice 세션 게이트', /ipcMain\.handle\('add-notice'[\s\S]{0,200}?masterSessionActive[\s\S]{0,80}?noticeOperatorSessionActive/.test(mainSrc));
  ok('add-notice-operator 마스터 게이트', /ipcMain\.handle\('add-notice-operator'[\s\S]{0,120}?masterSessionActive/.test(mainSrc));
  ok('delete-notice-operator 마스터 게이트', /ipcMain\.handle\('delete-notice-operator'[\s\S]{0,120}?masterSessionActive/.test(mainSrc));
  ok('get-notice-operators 마스터 게이트', /ipcMain\.handle\('get-notice-operators'[\s\S]{0,80}?masterSessionActive/.test(mainSrc));
  ok('작성 로그인 openAdmin:false', /applyMasterAuthSuccess\(\{\s*openDutyRoster:\s*false,\s*openAdmin:\s*false\s*\}\)/.test(htmlSrc));
}

function testMessageEditAuth() {
  ok('MESSAGE_EDIT senderIP 전달', /handleIncomingMessageEdit\(payload,\s*senderIP\)/.test(mainSrc));
  ok('MESSAGE_EDIT sender_ip 조건 UPDATE', /UPDATE messages SET message = \? WHERE msg_uid = \? AND sender_ip = \?/.test(mainSrc));
}

/**
 * 채팅 고정(chat_pins) 기능은 1.0.566에서 완전히 제거됐다. 예전에는 여기서 그 기능이
 * 살아있는지 검사했는데, 기능이 사라진 뒤로도 검사가 남아 매번 4건씩 FAIL을 냈다.
 * 실패가 상시화되면 진짜 회귀가 그 사이에 묻히므로, 검사 방향을 뒤집어
 * "확실히 제거됐고 다시 살아나지 않았는지"를 확인한다.
 */
function testChatPinsRemoved() {
  ok('chat_pins 테이블 재생성 안 함', !/CREATE TABLE IF NOT EXISTS deleted_chat_pins/.test(mainSrc));
  ok('부팅 시 잔존 테이블 정리', /DROP TABLE IF EXISTS deleted_chat_pins/.test(mainSrc));
  ok('스키마 손상 시 비치명 처리', /NON_FATAL_SCHEMA_TABLES/.test(mainSrc));
}

function testDbCorruptRecovery() {
  ok('corrupt 감지 헬퍼', /function isSqliteCorruptError/.test(mainSrc));
  ok('복구 스케줄러', /function scheduleDbCorruptRecovery/.test(mainSrc));
  ok('한국어 corrupt 안내', /로컬 데이터베이스가 손상되었습니다/.test(mainSrc));
  ok('preload onDbCorruptRecovery', /onDbCorruptRecovery/.test(preloadSrc));
  // quick_check는 chat_pins류 스키마 카탈로그 손상을 못 잡아 이미 깨진 DB를 정상으로
  // 백업한 실사고가 있었다. 부팅 검사와 동일한 integrity_check로 교체됨.
  ok('백업 전 integrity_check', /skip auto backup — current DB failed integrity_check/.test(mainSrc));
}

function testNoticeSync() {
  ok('upsertNoticeFromSync SELECT 후 처리', /forbidNewUidOnConflict/.test(mainSrc));
  ok('공지 tombstone 본문 우선', /incomingNoticeUids/.test(mainSrc));
  ok('일정 tombstone 본문 우선', /incomingScheduleUids/.test(mainSrc));
  ok('quiet 후 NOTICE_SYNC 재요청', /TCP listening after quiet period[\s\S]{0,300}?requestNoticeSyncFromOnlinePeers/.test(mainSrc));
  ok('update-notice notices-update', /update-notice[\s\S]*?notifyNoticesChanged\(\)/.test(mainSrc));
  ok('NOTICE_SYNC 이미지 예산', /NOTICE_SYNC_IMAGES_BUDGET_BYTES/.test(mainSrc) && /slimNoticesForBulkSync/.test(mainSrc));
  ok('NOTICE_SYNC 요청 쿨다운', /NOTICE_SYNC_REQUEST_COOLDOWN_MS/.test(mainSrc));
}

function testDutyFlag() {
  ok('부팅 시 can_manage_duty 강제 UPDATE 제거', !/UPDATE notice_operators SET can_manage_duty = 1 WHERE COALESCE\(can_manage_duty, 0\) = 0/.test(mainSrc));
  ok('로그인 시 DB duty 플래그 사용', /noticeOperatorCanManageDutySession = !!\(row\.can_manage_duty\)/.test(mainSrc));
  ok('세션 복원 시 계정 DB 확인', /set-notice-operator-session[\s\S]{0,1200}?FROM notice_operators WHERE username/.test(mainSrc));
  ok('UI canManageDutyRoster가 duty 플래그 확인', /isNoticeOperatorAuthenticated && noticeOperatorCanManageDuty/.test(htmlSrc));
}

function testSidebarFonts() {
  ok('sidebar-item-font-size 변수', /--sidebar-item-font-size:\s*12\.5px/.test(htmlSrc));
  ok('user-name / channel 동일 변수', /#sidebar-left \.user-name-text \{[\s\S]*?font-size:\s*var\(--sidebar-item-font-size\)/.test(htmlSrc)
    && /#sidebar-left \.channel-item \.channel-label \{[\s\S]*?font-size:\s*var\(--sidebar-item-font-size\)/.test(htmlSrc));
}

function testIpmsgLayout() {
  ok('쪽지 수신/작성 flex 50/50', /\.ipmsg-recipient-pane\s*\{[^}]*flex:\s*1\s+1\s+0/.test(htmlSrc)
    && /\.ipmsg-compose-pane\s*\{[^}]*flex:\s*1\s+1\s+0/.test(htmlSrc));
}

function testBubbleName() {
  ok('이름없음 플레이스홀더  scrub', /function isPlaceholderUsername/.test(htmlSrc));
  ok('내 말풍선 profileDisplayName', /function resolveMessageSenderDisplay[\s\S]{0,200}?profileDisplayName\(myProfile\)/.test(htmlSrc));
}

function testCategoryCreate() {
  ok('작성/수정 모드 분리', /boardWriteMode === 'edit'/.test(htmlSrc) && /api\.addNotice/.test(htmlSrc));
  ok('INSERT allowReplace false 기본', /allowReplace:\s*false/.test(mainSrc) || /const allowReplace = !!o\.allowReplace/.test(mainSrc));
}

// ---------- sqlite logic ----------
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function testSqliteLogic() {
  const dbPath = path.join(os.tmpdir(), `mirae-audit-${Date.now()}.db`);
  const db = new sqlite3.Database(dbPath);
  await run(db, `CREATE TABLE notices (
    uid TEXT PRIMARY KEY, title TEXT, content TEXT, author_name TEXT, author_ip TEXT,
    created_at TEXT, images TEXT DEFAULT '[]', category TEXT DEFAULT '전체'
  )`);
  await run(db, `CREATE TABLE chat_pins (
    channel_key TEXT PRIMARY KEY, msg_uid TEXT, message_html TEXT, preview_text TEXT,
    sender_name TEXT, pinned_at TEXT, pinned_by_name TEXT, pinned_by_ip TEXT
  )`);
  await run(db, `CREATE TABLE deleted_chat_pins (channel_key TEXT PRIMARY KEY, cleared_at TEXT NOT NULL)`);
  await run(db, `CREATE TABLE messages (
    id INTEGER PRIMARY KEY, msg_uid TEXT, sender_ip TEXT, message TEXT
  )`);

  // categories independent
  await run(db, `INSERT INTO notices (uid,title,content,author_name,author_ip,created_at,category) VALUES (?,?,?,?,?,?,?)`,
    ['a', 't1', 'c1', 'w', '1.1.1.1', '2026-01-01T00:00:00.000Z', '업데이트']);
  await run(db, `INSERT INTO notices (uid,title,content,author_name,author_ip,created_at,category) VALUES (?,?,?,?,?,?,?)`,
    ['b', 't2', 'c2', 'w', '1.1.1.1', '2026-01-02T00:00:00.000Z', '재활치료부']);
  const cats = await all(db, `SELECT category FROM notices ORDER BY uid`);
  ok('카테고리 독립 저장', cats.length === 2 && cats[0].category === '업데이트' && cats[1].category === '재활치료부');

  // sync upsert no new uid
  async function upsertSync(n) {
    const existing = await get(db, `SELECT uid FROM notices WHERE uid = ?`, [n.uid]);
    if (existing) {
      await run(db, `UPDATE notices SET title=?, content=?, category=? WHERE uid=?`, [n.title, n.content, n.category, n.uid]);
      return;
    }
    try {
      await run(db, `INSERT INTO notices (uid,title,content,author_name,author_ip,created_at,category) VALUES (?,?,?,?,?,?,?)`,
        [n.uid, n.title, n.content, n.author_name, n.author_ip, n.created_at, n.category]);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        await run(db, `UPDATE notices SET title=?, content=?, category=? WHERE uid=?`, [n.title, n.content, n.category, n.uid]);
      } else throw e;
    }
  }
  await upsertSync({ uid: 'a', title: 't1', content: 'c1', author_name: 'w', author_ip: '1.1.1.1', created_at: '2026-01-01T00:00:00.000Z', category: '업데이트' });
  await upsertSync({ uid: 'a', title: 't1-new', content: 'c1', author_name: 'w', author_ip: '1.1.1.1', created_at: '2026-01-01T00:00:00.000Z', category: '업데이트' });
  const aRows = await all(db, `SELECT uid, title FROM notices WHERE uid='a'`);
  ok('sync 재적용 중복 없음', aRows.length === 1 && aRows[0].title === 't1-new');

  // chat pin tombstone
  const tomb = new Map();
  async function clearPin(key, at, force) {
    const prev = tomb.get(key);
    if (!prev || at > prev) tomb.set(key, at);
    await run(db, `INSERT OR REPLACE INTO deleted_chat_pins (channel_key, cleared_at) VALUES (?,?)`, [key, tomb.get(key)]);
    const row = await get(db, `SELECT pinned_at FROM chat_pins WHERE channel_key=?`, [key]);
    if (force || !row || !row.pinned_at || row.pinned_at <= tomb.get(key)) {
      await run(db, `DELETE FROM chat_pins WHERE channel_key=?`, [key]);
    }
  }
  async function upsertPin(pin) {
    const key = pin.channel_key;
    if (pin._clear) {
      await clearPin(key, pin.cleared_at, false);
      return;
    }
    const t = tomb.get(key);
    if (t && pin.pinned_at <= t) return;
    if (t && pin.pinned_at > t) {
      tomb.delete(key);
      await run(db, `DELETE FROM deleted_chat_pins WHERE channel_key=?`, [key]);
    }
    await run(db, `INSERT OR REPLACE INTO chat_pins (channel_key, preview_text, pinned_at) VALUES (?,?,?)`,
      [key, pin.preview_text, pin.pinned_at]);
  }
  await upsertPin({ channel_key: 'dm:1', preview_text: 'hello', pinned_at: '2026-08-06T01:00:00.000Z' });
  await clearPin('dm:1', '2026-08-06T02:00:00.000Z', true);
  await upsertPin({ channel_key: 'dm:1', preview_text: 'old', pinned_at: '2026-08-06T01:30:00.000Z' });
  ok('핀 해제 후 옛 sync 차단', !(await get(db, `SELECT 1 AS x FROM chat_pins WHERE channel_key='dm:1'`)));
  await upsertPin({ channel_key: 'dm:1', preview_text: 'new', pinned_at: '2026-08-06T03:00:00.000Z' });
  ok('핀 재고정 허용', !!(await get(db, `SELECT 1 AS x FROM chat_pins WHERE channel_key='dm:1'`)));
  await upsertPin({ channel_key: 'dm:1', _clear: true, cleared_at: '2026-08-06T02:00:00.000Z' });
  ok('늦은 피어 해제가 재고정 유지', !!(await get(db, `SELECT 1 AS x FROM chat_pins WHERE channel_key='dm:1'`)));

  // message edit auth simulation
  await run(db, `INSERT INTO messages (msg_uid, sender_ip, message) VALUES (?,?,?)`, ['m1', '10.0.0.1', 'hi']);
  await run(db, `UPDATE messages SET message=? WHERE msg_uid=? AND sender_ip=?`, ['edited', 'm1', '10.0.0.1']);
  const okEdit = await get(db, `SELECT message FROM messages WHERE msg_uid='m1'`);
  ok('본인 IP 메시지 수정', okEdit.message === 'edited');
  await run(db, `UPDATE messages SET message=? WHERE msg_uid=? AND sender_ip=?`, ['spoof', 'm1', '10.0.0.2']);
  const afterSpoof = await get(db, `SELECT message FROM messages WHERE msg_uid='m1'`);
  ok('타 IP 메시지 수정 차단', afterSpoof.message === 'edited');

  // corrupt regex
  function isCorrupt(err) {
    return /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|disk image is malformed|file is not a database|database disk image/i.test(String(err && err.message || err || ''));
  }
  ok('corrupt 문자열 인식', isCorrupt(new Error('SQLITE_CORRUPT: database disk image is malformed')));
  ok('일반 오류는 corrupt 아님', !isCorrupt(new Error('UNIQUE constraint failed')));

  await new Promise((r) => db.close(r));
  try { fs.unlinkSync(dbPath); } catch (_) {}
}

async function main() {
  console.log('=== Mirae full-feature audit ===\n');
  testVersions();
  testPreloadIpcParity();
  testNoticeAuthGates();
  testMessageEditAuth();
  testChatPinsRemoved();
  testDbCorruptRecovery();
  testNoticeSync();
  testDutyFlag();
  testSidebarFonts();
  testIpmsgLayout();
  testBubbleName();
  testCategoryCreate();
  await testSqliteLogic();
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
