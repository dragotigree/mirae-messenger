const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, MenuItem, shell, nativeImage, dialog, screen, globalShortcut, session, desktopCapturer, protocol } = require('electron');
const path = require('path');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const fs = require('fs');
const https = require('https');
const transportHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { startMobileServer } = require('./mobile_server');

function loadScheduleXlsxBuilder() {
  try {
    return require('./lib/minimal-xlsx').buildXlsxBuffer;
  } catch (e) {
    return null;
  }
}

// 🔒 중복 실행 방지: 이 프로그램은 단일 인스턴스 락을 걸지 않고 있어서, 같은 PC에서
// 실수로 두 번 실행되면(트레이에 이미 떠 있는데 아이콘을 다시 더블클릭 하는 경우 등) 서로 다른
// 두 프로세스가 같은 데이터베이스 파일에 동시에 쓰게 된다. 특히 오래된(백그라운드에 남아있던)
// 인스턴스가 자리비움 자동전환 등으로 예전 프로필 정보를 뒤늦게 다시 저장해버리면, 방금 새로
// 저장한 정보가 조용히 예전 값으로 덮어써지는 문제가 생길 수 있다. 이를 막기 위해 두 번째
// 실행은 즉시 종료하고, 이미 떠 있는 창을 앞으로 가져온다.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// mirae-file:// 첨부 미리보기용 — app ready 전에 등록해야 img/src에서 로드됨
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mirae-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        stream: true,
        corsEnabled: true
      }
    }
  ]);
} catch (e) {
  /* ignore */
}
app.on('second-instance', () => {
  showAndFocusWindow();
});

// 🛡 마지막 안전장치: 여기서 잡지 못한 예외/Promise 거부가 있어도 병원 업무 중에
// 프로그램이 통째로 멈추는 일은 없어야 한다. 로그만 남기고 계속 진행한다.
process.on('uncaughtException', (err) => {
  console.error('❌ 처리되지 않은 예외(무시하고 계속 진행):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ 처리되지 않은 Promise 거부(무시하고 계속 진행):', reason);
});

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

let mainWindow;
let scheduleBoardWindow = null;
/** 렌더러 작성자/공지 작성 권한 로그인 — 타인 일정 수정·삭제 허용 */
let noticeOperatorSessionActive = false;
/** 마스터 관리자 UI 로그인 (렌더러 verify-master-auth 성공 시) */
let masterSessionActive = false;
/** ip → { username, rank, dept, floor, extNo, phone } — 마스터가 지정한 표시 정보 */
const profileOverrides = new Map();
let toastWindow = null;
let toastDismissTimer = null;
/** 렌더러: 지금 보고 있는 대화방 + 창 포커스 (같은 방이면 토스트 생략) */
let toastUiState = { focused: false, activeChannelKey: '' };
let tray = null;
let trayLaunchViewMode = 'normal'; // 트레이·단축키로 창을 열 때 사용할 화면 (normal | compact)
let isQuitting = false;
let currentViewMode = 'normal';
let savedNormalWindowBounds = null;

/** OneDrive·공유폴더 EBUSY 회피: preload는 userData 캐시에서 로드 */
let resolvedMainPreloadPath = path.join(__dirname, 'preload.js');
let resolvedToastPreloadPath = path.join(__dirname, 'toast-preload.js');

function preloadCacheDir() {
  return path.join(app.getPath('userData'), 'preload-cache');
}

function pendingUpdateDir() {
  return path.join(app.getPath('userData'), 'pending-update');
}

function pendingRelSafe(relPath) {
  return String(relPath).replace(/\//g, '__');
}

function pendingRelFromSafe(safe) {
  return String(safe).replace(/__/g, '/');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyFileWithRetry(sourcePath, destPath, retries = 10) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
      await fs.promises.copyFile(sourcePath, tmp);
      try {
        await fs.promises.rename(tmp, destPath);
      } catch (renameErr) {
        await fs.promises.unlink(tmp).catch(() => {});
        await fs.promises.copyFile(sourcePath, destPath);
      }
      return;
    } catch (e) {
      lastErr = e;
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) && i < retries - 1) {
        await sleepMs(120 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('copyFileWithRetry failed');
}

async function filesMatchByStat(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) < 2;
  } catch (e) {
    return false;
  }
}

async function stagePendingUpdate(relPath, sourcePath) {
  const safe = pendingRelSafe(relPath);
  const dest = path.join(pendingUpdateDir(), safe);
  await copyFileWithRetry(sourcePath, dest);
}

async function applyPendingUpdatesOnStartup() {
  let names;
  try {
    names = await fs.promises.readdir(pendingUpdateDir());
  } catch (e) {
    return 0;
  }
  let applied = 0;
  for (const safe of names) {
    const from = path.join(pendingUpdateDir(), safe);
    let st;
    try {
      st = await fs.promises.stat(from);
    } catch (e) {
      continue;
    }
    if (!st.isFile()) continue;
    const rel = pendingRelFromSafe(safe);
    const to = path.join(__dirname, rel);
    try {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await copyFileWithRetry(from, to);
      await fs.promises.unlink(from);
      applied++;
      console.log('[업데이트] 재시작 후 보류 파일 적용:', rel);
    } catch (e) {
      console.error('[업데이트] 보류 파일 적용 실패:', rel, e.message);
    }
  }
  return applied;
}

async function cachePreloadScript(basename) {
  const source = path.join(__dirname, basename);
  const cached = path.join(preloadCacheDir(), basename);
  try {
    if (!(await filesMatchByStat(source, cached))) {
      await copyFileWithRetry(source, cached);
    }
    await fs.promises.access(cached, fs.constants.R_OK);
    return cached;
  } catch (e) {
    console.error(`[preload-cache] ${basename} 캐시 실패 — 설치 경로 사용:`, e.message);
    try {
      await fs.promises.access(source, fs.constants.R_OK);
      return source;
    } catch (e2) {
      throw e;
    }
  }
}

async function initPreloadScriptCache() {
  await fs.promises.mkdir(preloadCacheDir(), { recursive: true });
  resolvedMainPreloadPath = await cachePreloadScript('preload.js');
  resolvedToastPreloadPath = await cachePreloadScript('toast-preload.js');
  console.log('[preload-cache] main:', resolvedMainPreloadPath);
}

async function refreshPreloadScriptCacheIfNeeded() {
  try {
    resolvedMainPreloadPath = await cachePreloadScript('preload.js');
    resolvedToastPreloadPath = await cachePreloadScript('toast-preload.js');
  } catch (e) {
    console.error('[preload-cache] 갱신 실패:', e.message);
  }
}

function getMainPreloadPath() {
  return resolvedMainPreloadPath;
}

function getToastPreloadPath() {
  return resolvedToastPreloadPath;
}

// 미니 모드 상단 툴바(공지·관리·파일·기억·기록·새로고침 6개)가 잘리지 않도록 최소 너비 확보
const COMPACT_DEFAULT_WIDTH = 480;
const COMPACT_DEFAULT_HEIGHT = 680;
const COMPACT_MIN_WIDTH = 480;
const COMPACT_MIN_HEIGHT = 520;
const NORMAL_MIN_WIDTH = 1040;
const NORMAL_MIN_HEIGHT = 600;

const UDP_PORT = 41234;
const TCP_PORT = 41235;
const PRESENCE_STALE_MS = 12000;
/** UDP로 한 번이라도 본 동료는 이 기간 동안 목록에 유지 (프로그램 미실행·오프라인 포함) */
const KNOWN_USER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_TCP_LINE_BUFFER = 512 * 1024;
/** NOTICE_SYNC 한 줄이 이 값을 넘지 않도록 청크로 나눔 (구버전도 RESPONSE 병합 가능) */
const NOTICE_SYNC_SAFE_LINE_BYTES = 400 * 1024;
/** CHAT 등 단일 TCP 라인 안전 상한 (수신 버퍼 512KB 미만 여유) */
const MAX_CHAT_WIRE_BYTES = 400 * 1024;
/** 분할 파일 전송 최대 크기 (이보다 크면 공유 폴더 안내) */
const MAX_FILE_XFER_BYTES = 10 * 1024 * 1024;
/** 청크 원본 바이트 — base64(~373KB)+JSON 이 MAX_TCP_LINE_BUFFER(512KB) 아래 */
const FILE_XFER_CHUNK_RAW_BYTES = 280 * 1024;
/** 수신 조립 타임아웃 */
const FILE_XFER_ASSEMBLE_TIMEOUT_MS = 3 * 60 * 1000;
/** 전송 TCP 타임아웃 (피어당) */
const FILE_XFER_SEND_TIMEOUT_MS = 90 * 1000;
/** DM SENT인데 ACK 없으면 이 시간 후 재전송 (수신측 msg_uid 중복 차단) */
const SENT_ACK_RETRY_AFTER_MS = 8000;
const SENT_ACK_MAX_RETRIES = 4;
/** 사용자 목록 IPC 디바운스 */
const USER_LIST_NOTIFY_DEBOUNCE_MS = 350;

// 🏢 병원 내 층(부서)별로 네트워크 대역(서브넷)이 나뉘어 있어 일반 브로드캐스트(255.255.255.255)가
// 다른 대역까지 넘어가지 못하는 문제가 있었다. 다른 대역의 브로드캐스트 주소(예: .255)로 보내는
// 방식은 라우터가 "다이렉트 브로드캐스트 포워딩"을 막아두면 여전히 전달되지 않으므로, 대신 알고
// 있는 대역의 모든 호스트 주소(1~254)에 직접(유니캐스트) 신호를 보낸다. 나중에 층/네트워크 대역이
// 추가되면 이 배열에 대역 앞 3자리(예: '192.168.124')만 한 줄 추가하면 된다.
const KNOWN_SUBNET_PREFIXES = [
  '192.168.122',
  '192.168.123'
];

function buildKnownSubnetHostIps() {
  const ips = [];
  KNOWN_SUBNET_PREFIXES.forEach(prefix => {
    for (let host = 1; host <= 254; host++) {
      ips.push(`${prefix}.${host}`);
    }
  });
  return ips;
}
const KNOWN_SUBNET_HOST_IPS = buildKnownSubnetHostIps();

const allKnownUsers = new Map();
const persistedPhotos = {}; // ip -> photo (재시작 후에도 사진이 바로 보이도록 DB에서 미리 불러옴)
const onlineUsers = new Map();
/** @type {Set<string>} 재전송 중인 PENDING msg_uid(또는 id) — 짧은 간격 중복 TCP 방지 */
const pendingResendInflight = new Set();
/** @type {Map<string, number>} SENT→ACK 재시도 횟수 */
const sentAckRetryCount = new Map();
let notifyUserListTimer = null;
let notifyUserListForce = false;
let miraeFileProtocolRegistered = false;
let willDownloadHandlerBound = false;
let udpBindRetryTimer = null;
let tcpBindRetryTimer = null;
let tcpServerInstance = null;
let presenceFlushTimersStarted = false;

const MY_IP = getMyIP();

let myProfile = {
  username: '홍길동',
  rank: '사원',
  dept: '재활치료부',
  floor: '10층',
  extNo: '1010',
  phone: '010-0000-0000',
  statusState: 'ONLINE',
  photo: ''
};
// DB에서 실제 저장된 프로필(직급 등)을 불러오기 전까지는 위 하드코딩된 기본값이 임시로 들어있는
// 상태다. 이 값이 다른 PC로 전파되면 "실장 정용범"처럼 잘못된 값이 잠깐 보였다가 실제 값(예: 물리
// 치료실장)으로 바뀌는 것처럼 보이므로, 로딩이 끝나기 전에는 내 정보를 내보내지 않는다.
let profileLoaded = false;

let showNotificationPreview = true;
let notifyIncomingMessages = true;
let notifyReadReceipts = true;
/** 새 메시지 알림 방식: toast(기본) | desktop — 둘 중 하나만 표시 */
let incomingNotifyMode = 'toast';
/** 새 메시지 토스트 표시 시간(초). 기본 7초, 긴급은 +2초 */
let toastDurationSeconds = 7;
let pendingToastChannelKey = '';
/** channelKey → 알림 유지 만료시각 — 동일 발신/채널은 알림 1개만 */
const activeIncomingNotifyUntil = new Map();
let spellCheckerEnabled = false;

// 🔄 쉬운 업데이트 기능: package.json의 version 값을 단일 기준으로 사용한다.
// (예전에는 이 줄에 버전을 직접 문자열로 적어야 했는데, package.json 값과 따로 놀면서
//  실제로는 새 버전이 배포됐는데도 이 앱은 구버전이라고 착각하는 문제가 있었다.)
const APP_VERSION = require('./package.json').version;
// 마스터가 지정한 공유 폴더(예: 병원 공유 드라이브) 경로. 여기 최신 파일을 올려두면
// 전 직원 PC가 자동으로 새 버전이 있는지 확인하고, 원할 때 한 번에 업데이트할 수 있다.
let updateSourcePath = '';
// 기본: GitHub. 옛 버전 브리지용으로 Z/공유폴더 경로도 계속 지원한다.
const DEFAULT_UPDATE_SOURCE_PATH = 'https://github.com/dragotigree/mirae-messenger';
const Z_BRIDGE_UPDATE_SOURCE_PATH = 'Z:\\9.재활치료실(PT&OT&언어&임상심리)\\물리치료실\\messenger';
let pendingRestartTimer = null;
let pendingUpdateRemoteVersion = '';
let autoUpdateAlreadyApplied = false;

// 🚑 이동요청시스템(mirae-transport) 연동: 이동기사에게 이동 요청을 전달하는 앱스크립트 웹앱 주소.
let transportWebappUrl = '';
let downloadFolderPath = '';
const DEFAULT_TRANSPORT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyjVOLYk-hxNJ7ShdWOcjOHtY8Smoam16M3r42_LEW4eu_lf-YG3Nt0yeC82NJzmTIp/exec';

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function parseUpdateSource(src) {
  const s = String(src || '').trim();
  if (!s) return { kind: 'none' };
  if (/^github:/i.test(s)) {
    const m = s.match(/^github:([^/#\s]+)\/([^/#\s]+)(?:#([^\s]+))?$/i);
    if (!m) return { kind: 'none' };
    return { kind: 'github', owner: m[1], repo: m[2].replace(/\.git$/i, ''), ref: m[3] || 'main' };
  }
  if (/^https?:\/\/github\.com\//i.test(s)) {
    try {
      const hashRef = s.includes('#') ? s.split('#').pop() : '';
      const u = new URL(s.split('#')[0]);
      const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
      if (parts.length < 2) return { kind: 'none' };
      return { kind: 'github', owner: parts[0], repo: parts[1], ref: hashRef || 'main' };
    } catch (e) {
      return { kind: 'none' };
    }
  }
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(s)) {
    try {
      const u = new URL(s);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 3) return { kind: 'none' };
      return { kind: 'github', owner: parts[0], repo: parts[1], ref: parts[2] || 'main' };
    } catch (e) {
      return { kind: 'none' };
    }
  }
  // Z드라이브·공유폴더 경로 (옛 버전 브리지)
  return { kind: 'folder', dir: s };
}

/** 빈 값·잘못된 값만 기본(GitHub)으로. Z경로는 유지(잘린 경로는 messenger로 보정). */
function normalizeUpdateSourcePath(src) {
  const s = String(src || '').trim();
  if (!s) return DEFAULT_UPDATE_SOURCE_PATH;
  const meta = parseUpdateSource(s);
  if (meta.kind === 'github' && meta.owner && meta.repo) {
    const ref = meta.ref && meta.ref !== 'main' ? `#${meta.ref}` : '';
    return `https://github.com/${meta.owner}/${meta.repo}${ref}`;
  }
  if (meta.kind === 'folder') {
    const cleaned = s.replace(/[\\/]+$/, '');
    if (/물리치료실$/i.test(cleaned) && !/messenger$/i.test(cleaned)) {
      return Z_BRIDGE_UPDATE_SOURCE_PATH;
    }
    return s;
  }
  return DEFAULT_UPDATE_SOURCE_PATH;
}

function persistUpdateSourcePath(nextPath) {
  updateSourcePath = normalizeUpdateSourcePath(nextPath);
  db.run(`UPDATE app_settings SET update_source_path = ? WHERE id = 1`, [updateSourcePath], logDbErr);
}

function githubUpdateTokenPath() {
  return path.join(app.getPath('userData'), 'github-update-token.txt');
}

function loadGithubUpdateToken() {
  try {
    const t = fs.readFileSync(githubUpdateTokenPath(), 'utf8').trim();
    return t || '';
  } catch (e) {
    return '';
  }
}

function httpsGetBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 25000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGetBuffer(res.headers.location, headers).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 180)}`));
          return;
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('업데이트 서버 응답 시간 초과'));
    });
  });
}

async function fetchGithubUpdateFile(meta, relPath) {
  const filePath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const token = loadGithubUpdateToken();
  const apiUrl = `https://api.github.com/repos/${meta.owner}/${meta.repo}/contents/${filePath}?ref=${encodeURIComponent(meta.ref)}`;
  const headers = {
    'User-Agent': 'MiraeMessenger-Updater',
    Accept: 'application/vnd.github.raw+json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await httpsGetBuffer(apiUrl, headers);
  } catch (e) {
    // API 실패 시 raw URL 재시도 (public 또는 token)
    const rawUrl = `https://raw.githubusercontent.com/${meta.owner}/${meta.repo}/${meta.ref}/${filePath}`;
    const rawHeaders = { 'User-Agent': 'MiraeMessenger-Updater' };
    if (token) rawHeaders.Authorization = `Bearer ${token}`;
    return httpsGetBuffer(rawUrl, rawHeaders);
  }
}

async function readUpdateSourceBytes(relPath) {
  const meta = parseUpdateSource(updateSourcePath);
  if (meta.kind === 'github') {
    return fetchGithubUpdateFile(meta, relPath);
  }
  if (meta.kind === 'folder') {
    return fs.promises.readFile(path.join(meta.dir, relPath));
  }
  throw new Error('업데이트 소스가 설정되지 않았습니다.');
}

/** PowerShell Set-Content -Encoding utf8 등이 붙인 UTF-8 BOM 제거 후 JSON 파싱 */
function parseUpdateJsonText(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  return JSON.parse(text);
}

async function writeBufferWithRetry(destPath, buffer, retries = 10) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
      await fs.promises.writeFile(tmp, buffer);
      try {
        await fs.promises.rename(tmp, destPath);
      } catch (renameErr) {
        await fs.promises.unlink(tmp).catch(() => {});
        await fs.promises.writeFile(destPath, buffer);
      }
      return;
    } catch (e) {
      lastErr = e;
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) && i < retries - 1) {
        await sleepMs(120 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('writeBufferWithRetry failed');
}

async function stagePendingUpdateBuffer(relPath, buffer) {
  const safe = pendingRelSafe(relPath);
  const dest = path.join(pendingUpdateDir(), safe);
  await writeBufferWithRetry(dest, buffer);
}

function previewBody(rawMessage) {
  if (showNotificationPreview) {
    return String(rawMessage).replace(/<[^>]*>?/gm, '');
  }
  return '메시지가 도착했습니다. 확인해 주세요.';
}

function shouldSuppressMessageToast(channelKey) {
  const key = String(channelKey || '').trim();
  if (!key || !toastUiState.focused) return false;
  return toastUiState.activeChannelKey === key;
}

function getDisplayForIncomingToast() {
  try {
    const cursor = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(cursor);
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

function closeMessageToast() {
  clearTimeout(toastDismissTimer);
  toastDismissTimer = null;
  const key = pendingToastChannelKey;
  if (key) activeIncomingNotifyUntil.delete(key);
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.close();
  }
  toastWindow = null;
  pendingToastChannelKey = '';
}

function truncateToastText(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(12, Number(maxLen) || 72);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 1)}…`;
}

function showMessageToast({ title, body, urgent, channelKey }) {
  if (!notifyIncomingMessages) return;
  const display = getDisplayForIncomingToast();
  const work = display.workArea || display.bounds;
  const width = 420;
  const height = 168;
  // 화면(작업 영역) 정중앙
  const x = Math.round(work.x + (work.width - width) / 2);
  const y = Math.round(work.y + (work.height - height) / 2);

  clearTimeout(toastDismissTimer);
  toastDismissTimer = null;
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.close();
  }
  toastWindow = null;
  pendingToastChannelKey = String(channelKey || '');

  toastWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    resizable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: getToastPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const q = new URLSearchParams({
    title: truncateToastText(title || '새 메시지', 48),
    body: truncateToastText(body || '', 72),
    urgent: urgent ? '1' : '0'
  });

  toastWindow.loadFile(path.join(__dirname, 'toast.html'), { search: `?${q.toString()}` });
  toastWindow.once('ready-to-show', () => {
    if (toastWindow && !toastWindow.isDestroyed()) toastWindow.showInactive();
  });
  toastWindow.on('closed', () => { toastWindow = null; });

  const secs = Math.max(2, Math.min(60, Number(toastDurationSeconds) || 7));
  const ms = (urgent ? secs + 2 : secs) * 1000;
  toastDismissTimer = setTimeout(() => closeMessageToast(), ms);
}

function showDesktopNotification({ title, body, urgent, channelKey }) {
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({
      title: title || '미래병원 메신저',
      body: body || '',
      icon: getAppNativeIcon(),
      silent: false,
      urgency: urgent ? 'critical' : 'normal'
    });
    const openKey = channelKey != null && channelKey !== '' ? String(channelKey) : '';
    notification.on('click', () => {
      showAndFocusWindow();
      if (openKey && mainWindow) safeWebContentsSend('open-chat-from-toast', { channelKey: openKey });
    });
    notification.show();
  } catch (e) {
    console.error('데스크톱 알림 표시 오류:', e.message);
  }
}

function notifyIncomingMessageNotification(opts) {
  if (!notifyIncomingMessages) return;
  if (shouldSuppressMessageToast(opts && opts.channelKey)) return;
  const o = opts || {};
  const key = String(o.channelKey || '').trim() || '__unknown__';
  const now = Date.now();
  const until = activeIncomingNotifyUntil.get(key) || 0;
  // 동일 발신/채널: 알림 유지 시간 동안은 추가 알림 없음 (토스트·데스크탑 공통)
  if (until > now) return;

  const secs = Math.max(2, Math.min(60, Number(toastDurationSeconds) || 7));
  const ms = ((o.urgent ? secs + 2 : secs) * 1000);
  activeIncomingNotifyUntil.set(key, now + ms);

  const mode = incomingNotifyMode === 'desktop' ? 'desktop' : 'toast';
  if (mode === 'desktop') {
    showDesktopNotification({
      title: o.title || '새 메시지',
      body: o.body || '메시지가 도착했습니다.',
      urgent: !!o.urgent,
      channelKey: o.channelKey
    });
  } else {
    showMessageToast(o);
  }
}

let chatLogDirEnsured = false;
function getChatLogDir() {
  const dir = path.join(app.getPath('userData'), 'chat_logs');
  if (!chatLogDirEnsured) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      chatLogDirEnsured = true;
    } catch (e) {
      console.error('채팅 로그 폴더 생성 오류:', e.message);
    }
  }
  return dir;
}

function sanitizeFileName(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'unknown';
}

function getReceivedFilesDir() {
  const dir = downloadFolderPath || app.getPath('downloads');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('파일 저장 폴더 생성 오류:', e.message);
  }
  return dir;
}

/** xferUid → { meta, chunks: Map<index, Buffer>, timer, senderIP } */
const pendingFileXfers = new Map();

function formatFileSizeLabel(sizeBytes) {
  const n = Number(sizeBytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function buildChatFileBoxHtml(fileName, sizeBytes, storedName) {
  const safeName = String(fileName || 'file').replace(/[<>&"]/g, (ch) => (
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : '&quot;'
  ));
  const href = `mirae-file://${encodeURIComponent(storedName)}`;
  const sizeLabel = formatFileSizeLabel(sizeBytes);
  return `<div class="chat-file-box"><span style="font-size: 24px;">📄</span><div class="chat-file-meta"><div class="chat-file-name">${safeName}</div><div class="chat-file-size">${sizeLabel}</div></div><a class="chat-file-dl" href="${href}" download="${safeName}">받기</a></div>`;
}

function clearPendingFileXfer(xferUid) {
  const entry = pendingFileXfers.get(xferUid);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingFileXfers.delete(xferUid);
}

function makeStoredFileName(fileName, msgUid) {
  const safeName = sanitizeFileName(fileName || 'file');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uidPart = msgUid ? `${sanitizeFileName(String(msgUid).slice(0, 40))}_` : '';
  return `${uidPart}${timestamp}_${safeName}`;
}

async function writeReceivedFileAsync(storedName, buffer) {
  const dir = getReceivedFilesDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, storedName);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

function writeJsonLinesToIp(ip, payloads, timeoutMs) {
  return new Promise((resolve) => {
    if (!ip || ip === MY_IP) {
      resolve(false);
      return;
    }
    const client = new net.Socket();
    let settled = false;
    let success = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch (e) { /* ignore */ }
      resolve(!!ok);
    };
    client.setTimeout(timeoutMs || FILE_XFER_SEND_TIMEOUT_MS);
    client.connect(TCP_PORT, ip, () => {
      let i = 0;
      const writeNext = () => {
        if (settled) return;
        if (i >= payloads.length) {
          success = true;
          client.end();
          return;
        }
        const line = JSON.stringify(payloads[i++]) + '\n';
        if (Buffer.byteLength(line, 'utf8') > MAX_TCP_LINE_BUFFER - 2048) {
          console.error('FILE_XFER 청크가 너무 큼 — 중단');
          done(false);
          return;
        }
        const ok = client.write(line);
        if (!ok) client.once('drain', () => setImmediate(writeNext));
        else setImmediate(writeNext);
      };
      writeNext();
    });
    client.on('close', () => done(success));
    client.on('error', () => done(false));
    client.on('timeout', () => done(false));
  });
}

function resolveFileXferTargets(chatTarget) {
  return new Promise((resolve) => {
    const kind = chatTarget && chatTarget.kind;
    if (kind === 'dm') {
      const peerIp = String((chatTarget && chatTarget.peerIp) || '').trim();
      if (!peerIp) {
        resolve({ error: '대화 상대를 찾을 수 없습니다.' });
        return;
      }
      if (!onlineUsers.has(peerIp)) {
        resolve({ error: '상대가 오프라인이라 큰 파일을 보낼 수 없습니다.' });
        return;
      }
      resolve({
        ips: [peerIp],
        receiverKey: peerIp,
        partnerName: (allKnownUsers.get(peerIp) || {}).username || peerIp
      });
      return;
    }
    if (kind === 'group') {
      const groupUid = chatTarget && chatTarget.groupUid;
      if (!groupUid) {
        resolve({ error: '그룹을 찾을 수 없습니다.' });
        return;
      }
      db.get(`SELECT * FROM group_chats WHERE uid = ?`, [groupUid], (err, row) => {
        if (err || !row) {
          resolve({ error: '그룹을 찾을 수 없습니다.' });
          return;
        }
        let members = [];
        try { members = JSON.parse(row.members); } catch (e) { members = []; }
        const ips = members
          .map((m) => m && m.ip)
          .filter((ip) => ip && ip !== MY_IP && onlineUsers.has(ip));
        if (!ips.length) {
          resolve({ error: '온라인인 그룹 멤버가 없어 파일을 보낼 수 없습니다.' });
          return;
        }
        resolve({
          ips,
          receiverKey: `GROUP:${groupUid}`,
          partnerName: row.name || chatTarget.groupName || '그룹',
          groupName: row.name || chatTarget.groupName || '그룹'
        });
      });
      return;
    }
    resolve({ error: '큰 파일은 1:1 또는 그룹에서 보내 주세요.' });
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
    totalChunks,
    chatTarget: meta.chatTarget,
    sender: meta.sender,
    msgUid: meta.msgUid
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

function handleFileXferStart(payload, senderIP) {
  const xferUid = payload && payload.xferUid;
  if (!xferUid || !senderIP) return;
  const size = Number(payload.size) || 0;
  const totalChunks = Number(payload.totalChunks) || 0;
  if (size <= 0 || size > MAX_FILE_XFER_BYTES || totalChunks <= 0 || totalChunks > 512) {
    sendToIpDirect(senderIP, { type: 'FILE_XFER_ABORT', xferUid, reason: 'size_or_chunks' });
    return;
  }
  clearPendingFileXfer(xferUid);
  const entry = {
    senderIP,
    fileName: String(payload.fileName || 'file'),
    mime: String(payload.mime || 'application/octet-stream'),
    size,
    totalChunks,
    chatTarget: payload.chatTarget || { kind: 'dm' },
    sender: payload.sender || (allKnownUsers.get(senderIP) || {}).username || senderIP,
    msgUid: payload.msgUid || null,
    chunks: new Map(),
    timer: null
  };
  entry.timer = setTimeout(() => {
    console.error('FILE_XFER 조립 타임아웃:', xferUid);
    clearPendingFileXfer(xferUid);
  }, FILE_XFER_ASSEMBLE_TIMEOUT_MS);
  pendingFileXfers.set(xferUid, entry);
}

function handleFileXferChunk(payload, senderIP) {
  const xferUid = payload && payload.xferUid;
  const entry = pendingFileXfers.get(xferUid);
  if (!entry || entry.senderIP !== senderIP) return;
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0 || index >= entry.totalChunks) return;
  if (typeof payload.data !== 'string' || !payload.data) return;
  try {
    const buf = Buffer.from(payload.data, 'base64');
    if (buf.length > FILE_XFER_CHUNK_RAW_BYTES + 4096) return;
    entry.chunks.set(index, buf);
  } catch (e) {
    console.error('FILE_XFER 청크 디코드 오류:', e.message);
  }
}

function handleFileXferAbort(payload) {
  if (payload && payload.xferUid) clearPendingFileXfer(payload.xferUid);
}

async function handleFileXferEnd(payload, senderIP) {
  const xferUid = payload && payload.xferUid;
  const entry = pendingFileXfers.get(xferUid);
  if (!entry || entry.senderIP !== senderIP) return;
  try {
    if (entry.chunks.size !== entry.totalChunks) {
      console.error('FILE_XFER 청크 누락:', entry.chunks.size, '/', entry.totalChunks);
      clearPendingFileXfer(xferUid);
      return;
    }
    const parts = [];
    for (let i = 0; i < entry.totalChunks; i++) {
      const part = entry.chunks.get(i);
      if (!part) {
        clearPendingFileXfer(xferUid);
        return;
      }
      parts.push(part);
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== entry.size || buf.length > MAX_FILE_XFER_BYTES) {
      clearPendingFileXfer(xferUid);
      return;
    }
    clearPendingFileXfer(xferUid);

    const storedName = makeStoredFileName(entry.fileName, entry.msgUid || xferUid);
    await writeReceivedFileAsync(storedName, buf);
    const messageHtml = buildChatFileBoxHtml(entry.fileName, entry.size, storedName);
    const msgUid = entry.msgUid || generateMsgUid();
    const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const senderName = formatSenderDisplay(entry.sender, senderIP);
    const kind = entry.chatTarget && entry.chatTarget.kind;

    if (kind === 'group' && entry.chatTarget.groupUid) {
      const receiverKey = `GROUP:${entry.chatTarget.groupUid}`;
      const groupName = entry.chatTarget.groupName || '그룹';
      shouldSkipDuplicateChannelMessage(msgUid, () => {
        if (mainWindow) {
          safeWebContentsSend('receive-group-message', {
            uid: entry.chatTarget.groupUid,
            senderName,
            senderIP,
            message: messageHtml,
            createdAt: currentTime,
            msgUid,
            messageId: null
          });
          notifyIncomingMessageNotification({
            title: `👥 [${groupName}] ${senderName}님의 파일`,
            body: `📎 ${entry.fileName}`,
            channelKey: receiverKey
          });
        }
        db.run(
          `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
          [senderName, senderIP, receiverKey, messageHtml, msgUid],
          (err) => {
            logDbErr(err);
            if (!err && msgUid) markIncomingChatUid(msgUid);
          }
        );
        appendChatLog(receiverKey, groupName, entry.sender, messageHtml);
      });
      return;
    }

    // DM (기본)
    if (senderIP === MY_IP) return;
    const persistDm = ({ showUi }) => {
      if (showUi && mainWindow) {
        safeWebContentsSend('receive-message', {
          senderName,
          senderIP,
          message: messageHtml,
          urgent: false,
          createdAt: currentTime,
          uid: msgUid
        });
        notifyIncomingMessageNotification({
          title: `💬 ${entry.sender}님의 파일`,
          body: `📎 ${entry.fileName}`,
          channelKey: senderIP
        });
        appendChatLog(`DM_${senderIP}`, entry.sender, entry.sender, messageHtml);
      }
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
        [senderName, senderIP, MY_IP, messageHtml, msgUid],
        (err) => {
          logDbErr(err);
          if (err) return;
          if (msgUid) markIncomingChatUid(msgUid);
          if (msgUid) sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
        }
      );
    };
    if (msgUid && hasRememberedIncomingChatUid(msgUid)) {
      db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [msgUid], (err, row) => {
        if (err) { logDbErr(err); persistDm({ showUi: false }); return; }
        if (row) {
          sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
          return;
        }
        persistDm({ showUi: false });
      });
      return;
    }
    if (msgUid) {
      db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [msgUid], (err, row) => {
        if (err) { logDbErr(err); persistDm({ showUi: true }); return; }
        if (row) {
          markIncomingChatUid(msgUid);
          sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
          return;
        }
        persistDm({ showUi: true });
      });
      return;
    }
    persistDm({ showUi: true });
  } catch (e) {
    console.error('FILE_XFER 완료 처리 오류:', e.message || e);
    clearPendingFileXfer(xferUid);
  }
}

// 💬 채팅 메시지 안에 첨부된 이미지/파일(base64 data URL)을 찾아서 실제 파일로 저장한다.
// compact=true 이면 DB 저장용으로 data URL을 mirae-file:// 로 바꿔 용량을 줄인다.
// 재전송 시에는 expandMiraeFileUrlsToDataUrls()로 파일에서 다시 data URL을 만든다.
function extractAndSaveAttachments(messageHtml, options) {
  const opts = options || {};
  const compact = !!opts.compact;
  if (typeof messageHtml !== 'string' || messageHtml.indexOf('data:') === -1) return messageHtml;
  const dir = getReceivedFilesDir();
  let out = messageHtml;
  const regex = /((?:src|href)=")(data:([^;]+);base64,([^"]+))(")/gi;
  const replacements = [];
  let match;
  let fileIndex = 0;
  while ((match = regex.exec(messageHtml)) !== null) {
    const full = match[0];
    const prefix = match[1];
    const mimeType = match[3];
    const base64Data = match[4];
    const suffix = match[5];
    let fileName = '';
    const around = messageHtml.slice(Math.max(0, match.index - 80), match.index + full.length + 120);
    const altMatch = around.match(/alt="([^"]*)"/i);
    if (altMatch) fileName = altMatch[1];
    if (!fileName) {
      const nameMatch = around.match(/font-size:\s*13px;">([^<]+)<\/div>/i);
      fileName = nameMatch ? nameMatch[1] : `file_${Date.now()}`;
    }
    try {
      const ext = (mimeType.split('/')[1] || 'bin').split(';')[0] || 'bin';
      const safeName = sanitizeFileName(fileName);
      const finalName = safeName.includes('.') ? safeName : `${safeName}.${ext}`;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const uidPart = opts.msgUid ? `${sanitizeFileName(String(opts.msgUid).slice(0, 40))}_` : '';
      const storedName = `${uidPart}${timestamp}_${fileIndex}_${finalName}`;
      fileIndex += 1;
      const filePath = path.join(dir, storedName);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      if (compact) {
        replacements.push({
          from: full,
          to: `${prefix}mirae-file://${encodeURIComponent(storedName)}${suffix}`
        });
      }
    } catch (e) {
      console.error('첨부파일 처리 오류:', e.message);
    }
  }
  if (compact && replacements.length) {
    replacements.forEach((r) => { out = out.split(r.from).join(r.to); });
  }
  return out;
}

function compactStoredMessageHtml(messageHtml, msgUid) {
  return extractAndSaveAttachments(messageHtml, { compact: true, msgUid: msgUid || '' });
}

/** 재전송용: mirae-file:// → data URL (파일이 없으면 원문 유지) */
function expandMiraeFileUrlsToDataUrls(messageHtml) {
  if (typeof messageHtml !== 'string' || messageHtml.indexOf('mirae-file://') === -1) return messageHtml;
  const dir = getReceivedFilesDir();
  return messageHtml.replace(/((?:src|href)=")mirae-file:\/\/([^"]+)(")/gi, (full, prefix, encName, suffix) => {
    try {
      const name = path.basename(decodeURIComponent(encName.split(/[?#]/)[0]));
      const filePath = path.join(dir, name);
      if (!fs.existsSync(filePath)) return full;
      const buf = fs.readFileSync(filePath);
      const ext = (path.extname(name) || '').replace('.', '').toLowerCase() || 'bin';
      const mime =
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'png' ? 'image/png'
            : ext === 'gif' ? 'image/gif'
              : ext === 'webp' ? 'image/webp'
                : ext === 'pdf' ? 'application/pdf'
                  : 'application/octet-stream';
      return `${prefix}data:${mime};base64,${buf.toString('base64')}${suffix}`;
    } catch (e) {
      return full;
    }
  });
}

function messageHtmlForWire(messageHtml) {
  return expandMiraeFileUrlsToDataUrls(messageHtml);
}

function maybeCompactMessageRowByUid(msgUid) {
  const uid = String(msgUid || '').trim();
  if (!uid) return;
  db.get(
    `SELECT id, message, status FROM messages WHERE msg_uid = ? AND sender_ip = ? LIMIT 1`,
    [uid, MY_IP],
    (err, row) => {
      if (err || !row || !row.message) return;
      if (row.status === 'PENDING') return;
      if (typeof row.message !== 'string' || row.message.indexOf('data:') === -1) return;
      const compacted = compactStoredMessageHtml(row.message, uid);
      if (compacted && compacted !== row.message) {
        db.run(`UPDATE messages SET message = ? WHERE id = ?`, [compacted, row.id], logDbErr);
      }
    }
  );
}

function compactMessageRowById(rowId, msgUid, messageHtml) {
  if (!rowId || typeof messageHtml !== 'string' || messageHtml.indexOf('data:') === -1) return;
  try {
    const compacted = compactStoredMessageHtml(messageHtml, msgUid);
    if (compacted && compacted !== messageHtml) {
      db.run(`UPDATE messages SET message = ? WHERE id = ?`, [compacted, rowId], logDbErr);
    }
  } catch (e) {
    console.error('메시지 compact 오류:', e.message);
  }
}

/** 메시지 큐/채널용 가상 receiver 키 — 실제 사용자 IP가 아님 */
function isSyntheticReceiverKey(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;
  if (s === 'BROADCAST') return true;
  return (
    s.startsWith('BCAST:') ||
    s.startsWith('DEPT:') ||
    s.startsWith('FLOOR:') ||
    s.startsWith('GROUP:') ||
    s.startsWith('DEPTPEER:') ||
    s.startsWith('FLOORPEER:')
  );
}

function encodeDeptPeerKey(ip, dept) {
  return `DEPTPEER:${ip}|${String(dept || '')}`;
}
function encodeFloorPeerKey(ip, floor) {
  return `FLOORPEER:${ip}|${String(floor || '')}`;
}
function parseDeptPeerKey(key) {
  const s = String(key || '');
  if (!s.startsWith('DEPTPEER:')) return null;
  const rest = s.slice('DEPTPEER:'.length);
  const idx = rest.indexOf('|');
  if (idx < 0) return { ip: rest, dept: '' };
  return { ip: rest.slice(0, idx), dept: rest.slice(idx + 1) };
}
function parseFloorPeerKey(key) {
  const s = String(key || '');
  if (!s.startsWith('FLOORPEER:')) return null;
  const rest = s.slice('FLOORPEER:'.length);
  const idx = rest.indexOf('|');
  if (idx < 0) return { ip: rest, floor: '' };
  return { ip: rest.slice(0, idx), floor: rest.slice(idx + 1) };
}

function isChatWireTooLarge(payloadObj) {
  try {
    return Buffer.byteLength(JSON.stringify(payloadObj) + '\n', 'utf8') > MAX_CHAT_WIRE_BYTES;
  } catch (e) {
    return true;
  }
}

/** 동일 msg_uid+peer PENDING 중복 없이 큐에 넣음 (온라인 전송 실패·오프라인 공용) */
function enqueuePendingPeerMessage(peerKey, message, msgUid) {
  const key = String(peerKey || '').trim();
  const uid = String(msgUid || '').trim();
  if (!key || !uid) return;
  db.get(
    `SELECT id FROM messages WHERE msg_uid = ? AND receiver_ip = ? AND sender_ip = ? LIMIT 1`,
    [uid, key, MY_IP],
    (err, row) => {
      if (err) {
        logDbErr(err);
        return;
      }
      if (row) return;
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
        [senderLabelForMe(), MY_IP, key, message, uid],
        logDbErr
      );
    }
  );
}

function registerMiraeFileProtocol() {
  if (miraeFileProtocolRegistered) return;
  try {
    protocol.registerFileProtocol('mirae-file', (request, callback) => {
      try {
        const raw = String(request.url || '').replace(/^mirae-file:\/\//i, '').split(/[?#]/)[0];
        const name = path.basename(decodeURIComponent(raw));
        if (!name || name === '.' || name === '..') {
          callback({ error: -2 });
          return;
        }
        callback({ path: path.join(getReceivedFilesDir(), name) });
      } catch (e) {
        callback({ error: -2 });
      }
    });
    miraeFileProtocolRegistered = true;
  } catch (e) {
    console.error('mirae-file 프로토콜 등록 실패:', e.message);
  }
}

function normalizeRankText(rank) {
  const r = String(rank ?? '').trim();
  if (!r || r === '-' || r === '—' || r === '–') return '';
  return r;
}

function displayNameFromParts(rank, username, fallback) {
  const r = normalizeRankText(rank);
  let n = String(username || '').trim();
  if (r && n) {
    while (n === r || n.startsWith(`${r} `)) {
      if (n === r) return r;
      n = n.slice(r.length).trim();
    }
    return `${r} ${n}`;
  }
  if (n) return n;
  if (r) return r;
  return fallback || '';
}

function senderLabelForMe() {
  if (!myProfile) return '나';
  return displayNameFromParts(myProfile.rank, myProfile.username, '나') || '나';
}

function scheduleModificationAudit() {
  return {
    modified_at: new Date().toISOString(),
    modified_by_name: senderLabelForMe(),
    modified_by_ip: MY_IP
  };
}

/** 채팅 말풍선·기록용: 직책 + 이름 (DB에는 username만 있는 예전 메시지도 IP/목록으로 보강) */
function formatSenderDisplay(username, senderIP) {
  if (senderIP === MY_IP) return senderLabelForMe();
  if (senderIP) {
    const byIp = allKnownUsers.get(senderIP);
    if (byIp) {
      return displayNameFromParts(byIp.rank, byIp.username, username || '알 수 없음') || byIp.username || username || '알 수 없음';
    }
  }
  const uname = String(username || '').trim();
  if (uname) {
    for (const u of allKnownUsers.values()) {
      if (u.username === uname) {
        return displayNameFromParts(u.rank, u.username, uname);
      }
      const label = displayNameFromParts(u.rank, u.username, '');
      if (label && label === uname) {
        return displayNameFromParts(u.rank, u.username, uname);
      }
    }
    const parsed = parseSenderNameToProfile(uname);
    if (parsed && parsed.username) {
      for (const u of allKnownUsers.values()) {
        if (u.username === parsed.username) {
          return displayNameFromParts(u.rank, u.username, parsed.username);
        }
      }
    }
    return uname;
  }
  return '알 수 없음';
}

/** 그룹 멤버 JSON에 직책·부서·층 스냅샷 (오프라인·목록 미동기화 시에도 표시용) */
function memberSnapshotFromIp(ip) {
  if (ip === MY_IP) {
    return {
      ip: MY_IP,
      username: myProfile.username || '',
      rank: myProfile.rank || '',
      dept: myProfile.dept || '',
      floor: myProfile.floor || ''
    };
  }
  const u = allKnownUsers.get(ip);
  if (u) {
    return {
      ip,
      username: u.username || ip,
      rank: u.rank || '',
      dept: u.dept || '',
      floor: u.floor || ''
    };
  }
  return { ip, username: ip, rank: '', dept: '', floor: '' };
}

function enrichGroupMemberEntry(m) {
  if (!m || !m.ip) return m;
  const snap = memberSnapshotFromIp(m.ip);
  const username = snap.username && snap.username !== m.ip ? snap.username : (m.username || snap.username || m.ip);
  return {
    ip: m.ip,
    username,
    rank: snap.rank || m.rank || '',
    dept: snap.dept || m.dept || '',
    floor: snap.floor || m.floor || ''
  };
}

function enrichGroupMembersJson(membersJson) {
  let members = [];
  try { members = JSON.parse(membersJson || '[]'); } catch (e) { return membersJson; }
  if (!Array.isArray(members)) return membersJson;
  return JSON.stringify(members.map(enrichGroupMemberEntry));
}

function messageHtmlToPlain(raw) {
  if (raw == null) return '';
  const s = String(raw);
  if (s.includes('deleted-msg-flag')) return '[삭제된 메시지]';
  const plain = s.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
  return plain || '[첨부파일/이미지]';
}

function conversationKeyForMessage(row) {
  const receiver = row.receiver_ip;
  if (
    receiver === 'BROADCAST' ||
    (typeof receiver === 'string' &&
      (receiver.startsWith('DEPT:') || receiver.startsWith('FLOOR:') || receiver.startsWith('GROUP:')))
  ) {
    return receiver;
  }
  if (row.sender_ip === MY_IP) return receiver || 'unknown';
  if (receiver === MY_IP) return row.sender_ip || 'unknown';
  return receiver || row.sender_ip || 'unknown';
}

function channelLabelForKey(key) {
  if (!key) return '알 수 없음';
  if (key === 'BROADCAST') return '전체 공지';
  if (key.startsWith('DEPT:')) return `부서 ${key.slice(5)}`;
  if (key.startsWith('FLOOR:')) return `층 ${key.slice(6)}`;
  if (key.startsWith('GROUP:')) return `그룹 ${key.slice(6)}`;
  const u = allKnownUsers.get(key);
  if (u) return displayNameFromParts(u.rank, u.username, key) || key;
  if (key === MY_IP) return senderLabelForMe();
  return key;
}

function backupFolderTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function queryAllMessagesForExport() {
  return new Promise((resolve) => {
    db.all(
      `SELECT id, sender_name, sender_ip, receiver_ip, message, status, msg_uid,
       strftime('%Y-%m-%d %H:%M:%S', created_at, 'localtime') as created_at
       FROM messages ORDER BY id ASC`,
      [],
      (err, rows) => {
        if (err) {
          logDbErr(err);
          resolve([]);
          return;
        }
        resolve(
          (rows || []).map((r) => {
            const channelKey = conversationKeyForMessage(r);
            return {
              id: r.id,
              created_at: r.created_at,
              channel_key: channelKey,
              channel_label: channelLabelForKey(channelKey),
              sender_name: formatSenderDisplay(r.sender_name, r.sender_ip),
              sender_ip: r.sender_ip,
              receiver_ip: r.receiver_ip,
              message_plain: messageHtmlToPlain(r.message),
              message_html: r.message,
              status: r.status,
              msg_uid: r.msg_uid,
              is_me: r.sender_ip === MY_IP
            };
          })
        );
      }
    );
  });
}

function buildReadableChatExport(messages) {
  const lines = [];
  lines.push('Mirae Messenger 대화 백업');
  lines.push(`내보낸 시각: ${new Date().toLocaleString('ko-KR')}`);
  lines.push(`버전: ${APP_VERSION}`);
  lines.push(`총 ${messages.length}건`);
  lines.push('');
  let lastChannel = null;
  messages.forEach((m) => {
    const ch = m.channel_label || m.channel_key;
    if (ch !== lastChannel) {
      lines.push('');
      lines.push('='.repeat(60));
      lines.push(`[ ${ch} ]`);
      lines.push('='.repeat(60));
      lastChannel = ch;
    }
    lines.push(`[${m.created_at}] ${m.sender_name}: ${m.message_plain}`);
  });
  return lines.join('\n');
}

function csvEscapeField(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsvChatExport(messages) {
  const header = ['id', 'created_at', 'channel', 'sender', 'message', 'status'];
  const rows = messages.map((m) =>
    [m.id, m.created_at, m.channel_label, m.sender_name, m.message_plain, m.status].map(csvEscapeField).join(',')
  );
  return `\uFEFF${header.join(',')}\n${rows.join('\n')}\n`;
}

async function copyChatLogsDirectory(destDir) {
  const src = getChatLogDir();
  let count = 0;
  try {
    await fs.promises.mkdir(destDir, { recursive: true });
    const names = await fs.promises.readdir(src);
    for (const name of names) {
      if (!name.endsWith('.txt')) continue;
      await fs.promises.copyFile(path.join(src, name), path.join(destDir, name));
      count += 1;
    }
  } catch (e) {
    console.error('채팅 로그 복사 오류:', e.message);
  }
  return count;
}

function appendChatLog(logKey, logLabel, senderName, rawMessage) {
  try {
    const dir = getChatLogDir();
    const fileName = `${sanitizeFileName(logLabel)}_${sanitizeFileName(logKey)}.txt`;
    const filePath = path.join(dir, fileName);
    const timestamp = new Date().toLocaleString('ko-KR');
    const plainMessage = String(rawMessage).replace(/<[^>]*>?/gm, '').trim() || '[첨부파일/이미지]';
    const line = `[${timestamp}] ${senderName}: ${plainMessage}\n`;
    fs.appendFile(filePath, line, 'utf8', (err) => {
      if (err) console.error('채팅 로그 저장 오류:', err.message);
    });
  } catch (e) {
    console.error('채팅 로그 저장 오류:', e.message);
  }
}

function getMyIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

let cachedAppIcon = null;
let cachedTrayIcon = null;

const MESSENGER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0EA5E9"/><stop offset="100%" stop-color="#0369A1"/></linearGradient></defs><rect width="256" height="256" rx="55" fill="url(#bg)"/><path d="M75 190 L57.5 200 L75 155 Z" fill="#ffffff"/><rect x="47.5" y="57.5" width="161" height="105" rx="30" fill="#ffffff"/><circle cx="90.5" cy="110" r="9.5" fill="#0369A1"/><circle cx="128" cy="110" r="9.5" fill="#0369A1"/><circle cx="165.5" cy="110" r="9.5" fill="#0369A1"/></svg>`;

function createMessengerIcon(size) {
  const svg = MESSENGER_ICON_SVG.replace('<svg ', `<svg width="${size}" height="${size}" `);
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  if (img.isEmpty()) return nativeImage.createEmpty();
  const { width, height } = img.getSize();
  if (width === size && height === size) return img;
  return img.resize({ width: size, height: size, quality: 'best' });
}

function getAppNativeIcon() {
  if (cachedAppIcon) return cachedAppIcon;
  const pngPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(pngPath)) {
    const img = nativeImage.createFromPath(pngPath);
    if (!img.isEmpty() && img.getSize().width >= 128) {
      cachedAppIcon = img;
      return cachedAppIcon;
    }
  }
  cachedAppIcon = createMessengerIcon(256);
  return cachedAppIcon;
}

/** Windows 트레이: 16px 전용 아이콘 (큰 PNG 축소 시 깨짐 방지) */
function getTrayIcon() {
  if (cachedTrayIcon) return cachedTrayIcon;
  const icoPath = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(icoPath)) {
    const img = nativeImage.createFromPath(icoPath);
    if (!img.isEmpty()) {
      cachedTrayIcon = img.resize({ width: 16, height: 16, quality: 'best' });
      return cachedTrayIcon;
    }
  }
  cachedTrayIcon = createMessengerIcon(16);
  return cachedTrayIcon;
}

const dbPath = path.join(app.getPath('userData'), 'mirae_messenger.db');
const db = new sqlite3.Database(dbPath);

db.on('error', (err) => {
  console.error('❌ 데이터베이스 오류(무시하고 계속 진행):', err.message);
});

// 🛡 SQLite 안정성 강화: PC가 강제 종료(정전, 블루스크린)되어도 DB가 깨지지 않도록.
// (아래 세 문장은 순서가 중요해서 serialize()로 묶는다 — WAL 모드 설정 → 동기화 설정 → 무결성 검사 순.
//  단, serialize()는 SQLite 문장끼리의 순서만 보장할 뿐, 그 안의 콜백에서 하는 파일 복사 같은
//  비-SQLite 비동기 작업까지 기다려주지는 않으므로 복구 로직은 아래에서 별도로 안전하게 처리한다.)
db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA synchronous = NORMAL`);
  db.run(`PRAGMA busy_timeout = 5000`);
  db.get(`PRAGMA integrity_check`, (err, row) => {
    const ok = !err && row && row.integrity_check === 'ok';
    if (ok) return;
    console.error('⚠️ 데이터베이스 손상 감지 — 최근 백업으로 복구를 시도합니다:', err ? err.message : row);
    // ⚠️ 파일이 열려있는 채로는(특히 Windows에서) 백업으로 통째로 덮어쓸 수 없다.
    // 그래서 연결부터 완전히 닫은 뒤 파일을 바꾸고, 재시작을 강제한다.
    db.close(async () => {
      try {
        const dir = path.join(app.getPath('userData'), 'backups');
        const names = (await fs.promises.readdir(dir).catch(() => [])).filter(n => n.startsWith('auto_backup_')).sort().reverse();
        if (names.length === 0) {
          console.error('⚠️ 복구할 백업이 없습니다. 프로그램을 강제 종료합니다 — 관리자에게 문의해 주세요.');
          app.exit(1);
          return;
        }
        const latestBackup = path.join(dir, names[0]);
        const corruptedCopy = dbPath + `.corrupted_${Date.now()}`;
        await fs.promises.copyFile(dbPath, corruptedCopy).catch(() => {});
        await fs.promises.copyFile(latestBackup, dbPath);
        // 손상됐던 세션의 -wal/-shm 보조 파일이 남아있으면 복구한 본 파일과 안 맞을 수 있으니 정리한다.
        await fs.promises.unlink(dbPath + '-wal').catch(() => {});
        await fs.promises.unlink(dbPath + '-shm').catch(() => {});
        console.error(`✅ ${names[0]} 백업으로 복구했습니다. 손상된 원본은 ${path.basename(corruptedCopy)}로 보관됩니다. 자동으로 재시작합니다.`);
        // 복구 직후엔 반드시 새 프로세스로 깨끗하게 다시 열어야 하므로, 안내 없이 바로 재시작한다.
        app.relaunch();
        app.exit(0);
      } catch (e) {
        console.error('❌ 자동 복구 실패:', e.message, '— 관리자에게 문의해 주세요.');
        app.exit(1);
      }
    });
  });
});

// 💾 journal_mode=WAL이면 최근 쓰기 내용이 mirae_messenger.db-wal 파일에 잠깐 남아있을 수 있다.
// 그 상태에서 mirae_messenger.db 파일만 그대로 복사하면 최신 내용이 빠진 백업이 만들어질 수 있으므로,
// 백업 직전에는 항상 이걸 먼저 실행해서 -wal 내용을 본 파일로 합쳐(checkpoint) 넣는다.
function checkpointWal() {
  return new Promise((resolve) => {
    db.run(`PRAGMA wal_checkpoint(TRUNCATE)`, () => resolve());
  });
}

function logDbErr(err) {
  if (!err) return;
  console.error('DB 오류:', err.message);
  // 이 로그는 main 프로세스 쪽이라 npm start로 켰을 때만 터미널에 보인다.
  // 패키징된 프로그램에서도 보이도록 화면(개발자 도구 콘솔)에도 함께 남긴다.
  logToRendererConsole('error', 'DB 오류: ' + err.message);
}

let logsDirEnsured = false;
function getLogsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!logsDirEnsured) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      logsDirEnsured = true;
    } catch (e) { /* 로그 폴더 자체를 못 만들어도 프로그램은 계속 돌아가야 한다 */ }
  }
  return dir;
}

// 📝 문제 발생 시 나중에 원인을 찾을 수 있도록, 주요 이벤트를 하루 단위 파일로 남긴다 (최근 14일 보관).
function writeToLogFile(level, message) {
  try {
    const dir = getLogsDir();
    const todayStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `messenger_${todayStr}.log`);
    const line = `[${new Date().toLocaleString('ko-KR')}] [${level.toUpperCase()}] ${message}\n`;
    fs.appendFile(filePath, line, 'utf8', () => {});
  } catch (e) { /* 로그 저장 실패는 무시 — 로그 때문에 프로그램이 멈추면 안 된다 */ }
}

function cleanupOldLogFiles() {
  const dir = getLogsDir();
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  fs.readdir(dir, (err, names) => {
    if (err || !names) return;
    names.forEach(name => {
      if (!name.startsWith('messenger_')) return;
      const filePath = path.join(dir, name);
      fs.stat(filePath, (err2, stat) => {
        if (!err2 && stat.mtimeMs < cutoff) fs.unlink(filePath, () => {});
      });
    });
  });
}

function logToRendererConsole(level, message) {
  console.log(message);
  writeToLogFile(level, message);
  safeWebContentsSend('main-process-log', { level, message });
}

/** 창이 닫히는 중·파괴된 뒤 IPC send로 프로세스가 죽지 않도록 한다. */
function safeWebContentsSend(channel, ...args) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, ...args);
  } catch (e) {
    console.error('renderer IPC send 실패:', channel, e.message);
  }
}

/** 일정 DB 변경 시 메인·현황판 등 모든 창에 반영 */
function notifySchedulesChanged() {
  try {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return;
      try { wc.send('schedules-update'); } catch (e) { /* ignore */ }
    });
  } catch (e) {
    console.error('schedules-update broadcast 실패:', e.message);
  }
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_name TEXT,
    sender_ip TEXT,
    receiver_ip TEXT,
    message TEXT,
    status TEXT DEFAULT 'SENT',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, logDbErr);
  db.run(`ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'SENT'`, () => {});
  // ✏️ 메시지 수정/삭제 기능을 위해, 보내는 쪽과 받는 쪽이 같은 메시지를 가리킬 수 있는 공용 ID.
  db.run(`ALTER TABLE messages ADD COLUMN msg_uid TEXT`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_key TEXT NOT NULL,
    emoji TEXT NOT NULL,
    reactor_ip TEXT NOT NULL,
    reactor_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(msg_key, reactor_ip)
  )`, logDbErr);

  db.run(`CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT, rank TEXT, dept TEXT, floor TEXT, ext_no TEXT, phone_no TEXT, status_state TEXT
  )`, logDbErr);
  // 예전 버전에서 이미 user_profile 테이블이 만들어져 있던 PC는 위 CREATE TABLE이 그냥 무시되므로,
  // 없을 수 있는 컬럼들을 하나씩 추가해서 최신 구조로 맞춰준다. (이미 있으면 에러가 나지만 무시됨)
  // ※ 바로 이 누락 때문에 phone_no 컬럼이 없는 PC에서 프로필 저장이 매번 조용히 실패하고 있었음.
  ['username TEXT', 'rank TEXT', 'dept TEXT', 'floor TEXT', 'ext_no TEXT', 'phone_no TEXT', 'status_state TEXT', 'photo TEXT'].forEach(colDef => {
    db.run(`ALTER TABLE user_profile ADD COLUMN ${colDef}`, () => {});
  });

  db.run(`CREATE TABLE IF NOT EXISTS master_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    master_id TEXT DEFAULT 'admin',
    master_password TEXT DEFAULT 'admin1234'
  )`, logDbErr);
  db.run(`ALTER TABLE master_config ADD COLUMN master_id TEXT DEFAULT 'admin'`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS known_users (
    ip TEXT PRIMARY KEY, username TEXT, rank TEXT, dept TEXT, floor TEXT, ext_no TEXT, phone_no TEXT, status_state TEXT
  )`, logDbErr);
  db.run(`ALTER TABLE known_users ADD COLUMN photo TEXT`, () => {});
  db.run(`ALTER TABLE known_users ADD COLUMN last_seen_at INTEGER`, () => {});
  // 과거 버그: BCAST:/DEPTPEER: 등 pending receiver 키가 known_users에 들어가 사이드바에 가짜 유저로 표시됨
  db.run(
    `DELETE FROM known_users WHERE ip LIKE 'BCAST:%' OR ip LIKE 'DEPTPEER:%' OR ip LIKE 'FLOORPEER:%'
      OR ip LIKE 'DEPT:%' OR ip LIKE 'FLOOR:%' OR ip LIKE 'GROUP:%' OR ip = 'BROADCAST'`,
    logDbErr
  );
  db.run(`CREATE TABLE IF NOT EXISTS user_profile_overrides (
    ip TEXT PRIMARY KEY,
    username TEXT DEFAULT '',
    rank TEXT DEFAULT '',
    dept TEXT DEFAULT '',
    floor TEXT DEFAULT '',
    ext_no TEXT DEFAULT '',
    phone_no TEXT DEFAULT '',
    updated_at TEXT
  )`, logDbErr);
  db.all(`SELECT ip, photo FROM known_users WHERE photo IS NOT NULL AND photo != ''`, [], (err, rows) => {
    if (!err && rows) rows.forEach(r => {
      if (isSyntheticReceiverKey(r.ip)) return;
      persistedPhotos[r.ip] = r.photo;
    });
  });

  db.run(`CREATE TABLE IF NOT EXISTS notices (
    uid TEXT PRIMARY KEY,
    title TEXT,
    content TEXT,
    author_name TEXT,
    author_ip TEXT,
    created_at TEXT
  )`, logDbErr);
  // 예전 버전에서 이미 notices 테이블이 만들어져 있던 PC는 위 CREATE TABLE이 그냥 무시되므로,
  // 없을 수 있는 컬럼들을 하나씩 추가해서 최신 구조로 맞춰준다. (이미 있으면 에러가 나지만 무시됨)
  ['uid TEXT', 'title TEXT', 'content TEXT', 'author_name TEXT', 'author_ip TEXT', 'created_at TEXT'].forEach(colDef => {
    db.run(`ALTER TABLE notices ADD COLUMN ${colDef}`, () => {});
  });
  setTimeout(() => {
    db.all(`SELECT rowid FROM notices WHERE uid IS NULL OR uid = ''`, [], (err, rows) => {
      if (err || !rows) return;
      rows.forEach(r => {
        const newUid = `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        db.run(`UPDATE notices SET uid = ? WHERE rowid = ?`, [newUid, r.rowid], logDbErr);
      });
    });
  }, 500); // ALTER TABLE 반영 시간을 약간 두고 실행

  db.run(`CREATE TABLE IF NOT EXISTS notice_operators (
    username TEXT PRIMARY KEY, password_hash TEXT, display_name TEXT, added_at TEXT
  )`, logDbErr);
  db.run(`ALTER TABLE notice_operators ADD COLUMN can_manage_duty INTEGER DEFAULT 0`, () => {});

  // 채널·1:1 대화 상단 공지 고정 (채널당 1개)
  db.run(`CREATE TABLE IF NOT EXISTS chat_pins (
    channel_key TEXT PRIMARY KEY,
    msg_uid TEXT,
    message_html TEXT,
    preview_text TEXT,
    sender_name TEXT,
    pinned_at TEXT,
    pinned_by_name TEXT,
    pinned_by_ip TEXT
  )`, logDbErr);

  // 당직의 / 의료진 OFF (날짜별)
  db.run(`CREATE TABLE IF NOT EXISTS duty_roster (
    date_str TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    note TEXT DEFAULT '',
    updated_at TEXT,
    updated_by_name TEXT,
    updated_by_ip TEXT,
    PRIMARY KEY (date_str, kind, name)
  )`, logDbErr);

  // 🚑 이동요청시스템(mirae-transport) 연동: 보낸 이동 요청 기록을 로컬에도 남겨둔다.
  db.run(`CREATE TABLE IF NOT EXISTS transport_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT, from_loc TEXT, to_loc TEXT, request_time TEXT,
    requested_by TEXT, created_at TEXT, status TEXT
  )`, logDbErr);
  ['remote_id TEXT', 'treatment_name TEXT', 'driver_status TEXT', 'processed_by TEXT', 'cancel_reason TEXT'].forEach(colDef => {
    db.run(`ALTER TABLE transport_requests ADD COLUMN ${colDef}`, () => {});
  });

  db.run(`CREATE TABLE IF NOT EXISTS hospital_schedules (
    uid TEXT PRIMARY KEY,
    type TEXT,
    title TEXT,
    time_str TEXT,
    author_name TEXT,
    author_ip TEXT,
    created_at TEXT,
    remind_before INTEGER DEFAULT 0
  )`, logDbErr);
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN remind_before INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN attending_physician TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN time_end_str TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN ward TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN rm_team TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN room_no TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN patient_name TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN modified_at TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN modified_by_name TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN modified_by_ip TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN time_start_undecided INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN time_end_undecided INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN meal_cancel_breakfast INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN meal_cancel_lunch INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN meal_cancel_dinner INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN remark TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE hospital_schedules ADD COLUMN guardian_only INTEGER DEFAULT 0`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_ip TEXT,
    is_broadcast INTEGER DEFAULT 0,
    message TEXT,
    send_at TEXT,
    sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, logDbErr);

  db.run(`CREATE TABLE IF NOT EXISTS group_chats (
    uid TEXT PRIMARY KEY,
    name TEXT,
    members TEXT,
    created_by TEXT,
    created_at TEXT
  )`, logDbErr);

  db.run(`CREATE TABLE IF NOT EXISTS channel_read_cursors (
    channel_key TEXT NOT NULL,
    reader_ip TEXT NOT NULL,
    last_read_msg_uid TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_key, reader_ip)
  )`, logDbErr);
  db.run(`ALTER TABLE channel_read_cursors ADD COLUMN last_read_msg_uid TEXT NOT NULL DEFAULT ''`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS chat_view_clears (
    channel_key TEXT PRIMARY KEY,
    hide_up_to_id INTEGER NOT NULL DEFAULT 0,
    cleared_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, logDbErr);

  db.run(`CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    show_notification_preview INTEGER DEFAULT 1,
    notify_incoming_messages INTEGER DEFAULT 1,
    notify_read_receipts INTEGER DEFAULT 1,
    update_source_path TEXT DEFAULT '',
    transport_webapp_url TEXT DEFAULT '',
    download_folder_path TEXT DEFAULT ''
  )`, logDbErr);
  db.run(`ALTER TABLE app_settings ADD COLUMN update_source_path TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN transport_webapp_url TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN download_folder_path TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN tray_launch_view_mode TEXT DEFAULT 'normal'`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN notify_incoming_messages INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN notify_read_receipts INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN toast_duration_seconds INTEGER DEFAULT 7`, () => {});
  db.run(`ALTER TABLE app_settings ADD COLUMN incoming_notify_mode TEXT DEFAULT 'toast'`, () => {});
  db.get(`SELECT * FROM app_settings WHERE id = 1`, (err, row) => {
    if (!row) {
      updateSourcePath = DEFAULT_UPDATE_SOURCE_PATH;
      transportWebappUrl = DEFAULT_TRANSPORT_WEBAPP_URL;
      downloadFolderPath = app.getPath('downloads');
      db.run(`INSERT INTO app_settings (id, show_notification_preview, update_source_path, transport_webapp_url, download_folder_path) VALUES (1, 1, ?, ?, ?)`, [updateSourcePath, transportWebappUrl, downloadFolderPath], logDbErr);
    } else {
      showNotificationPreview = !!row.show_notification_preview;
      if (row.notify_incoming_messages != null) notifyIncomingMessages = !!row.notify_incoming_messages;
      if (row.notify_read_receipts != null) notifyReadReceipts = !!row.notify_read_receipts;
      if (row.toast_duration_seconds != null) {
        const n = parseInt(row.toast_duration_seconds, 10);
        if (Number.isFinite(n)) toastDurationSeconds = Math.max(2, Math.min(60, n));
      }
      if (row.incoming_notify_mode === 'desktop' || row.incoming_notify_mode === 'toast') {
        incomingNotifyMode = row.incoming_notify_mode;
      } else {
        incomingNotifyMode = 'toast';
      }
      // GitHub 또는 Z/공유폴더. 잘린 Z경로는 messenger 폴더로 보정.
      const rawPath = row.update_source_path || DEFAULT_UPDATE_SOURCE_PATH;
      updateSourcePath = normalizeUpdateSourcePath(rawPath);
      transportWebappUrl = row.transport_webapp_url || DEFAULT_TRANSPORT_WEBAPP_URL;
      downloadFolderPath = row.download_folder_path || app.getPath('downloads');
      trayLaunchViewMode = row.tray_launch_view_mode === 'compact' ? 'compact' : 'normal';
      if (!row.update_source_path || rawPath !== updateSourcePath || !row.transport_webapp_url || !row.download_folder_path) {
        db.run(`UPDATE app_settings SET update_source_path = ?, transport_webapp_url = ?, download_folder_path = ? WHERE id = 1`, [updateSourcePath, transportWebappUrl, downloadFolderPath], logDbErr);
      }
    }
  });

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_ip, receiver_ip)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_ip)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_msg_uid ON messages(msg_uid)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pending_out ON messages(sender_ip, status, receiver_ip)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(sent, send_at)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hospital_schedules_time ON hospital_schedules(time_str)`, logDbErr);

  db.get(`SELECT * FROM master_config WHERE id = 1`, (err, row) => {
    if (!row) db.run(`INSERT INTO master_config (id, master_id, master_password) VALUES (1, 'admin', 'admin1234')`, logDbErr);
  });

  function onProfileLoadedForPresence() {
    if (!onlineUsers.has(MY_IP)) {
      registerSelf();
      if (globalUdpSocket) broadcastPresence(globalUdpSocket);
    }
    loadProfileOverrides(() => {
      loadPersistedKnownUsers(() => {
        profileOverrides.forEach((ov) => refreshUserAfterProfileOverride(ov.ip));
        notifyUserList();
      });
    });
    setTimeout(() => flushAllPendingOutboundMessages(), 1500);
  }

  db.get(`SELECT * FROM user_profile WHERE id = 1`, (err, row) => {
    if (row) {
      myProfile = {
        username: row.username || '홍길동',
        rank: row.rank != null ? String(row.rank) : '',
        dept: row.dept || '재활치료부',
        floor: row.floor || '10층',
        extNo: row.ext_no || '1010',
        phone: row.phone_no || '010-0000-0000',
        statusState: row.status_state || 'ONLINE',
        photo: row.photo || ''
      };
      profileLoaded = true;
      logToRendererConsole('info', `[프로필] DB에서 불러옴: ${myProfile.username} ${myProfile.rank} ${myProfile.dept} ${myProfile.floor} ${myProfile.extNo}`);
    } else {
      logToRendererConsole('info', `[프로필] DB에 저장된 프로필이 없어 기본값으로 새로 만듭니다: ${myProfile.username} ${myProfile.rank}`);
      db.run(`INSERT INTO user_profile (id, username, rank, dept, floor, ext_no, phone_no, status_state, photo) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [myProfile.username, myProfile.rank, myProfile.dept, myProfile.floor, myProfile.extNo, myProfile.phone, myProfile.statusState, myProfile.photo || ''], () => {
          profileLoaded = true;
          onProfileLoadedForPresence();
        });
      return;
    }
    onProfileLoadedForPresence();
  });
});

function setTrayLaunchViewMode(mode, persist) {
  trayLaunchViewMode = mode === 'compact' ? 'compact' : 'normal';
  if (persist !== false) {
    db.run(`UPDATE app_settings SET tray_launch_view_mode = ? WHERE id = 1`, [trayLaunchViewMode], logDbErr);
  }
  if (tray) tray.setContextMenu(buildTrayContextMenu());
  safeWebContentsSend('tray-launch-view-mode-changed', trayLaunchViewMode);
}

function openMainWindowWithViewMode(mode) {
  const resolved = mode === 'compact' ? 'compact' : 'normal';
  showAndFocusWindow();
  safeWebContentsSend('apply-tray-view-mode', resolved);
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: '💬 메시지 보내기 (Ctrl+Alt+S)',
      click: () => openMainWindowWithViewMode(trayLaunchViewMode)
    },
    {
      label: '📜 전체 주고받은 메시지 열기 (Ctrl+Alt+E)',
      click: () => {
        openMainWindowWithViewMode(trayLaunchViewMode);
        safeWebContentsSend('trigger-open-all-logs');
      }
    },
    { type: 'separator' },
    {
      label: '🖥️ 기본 화면으로 열기',
      click: () => openMainWindowWithViewMode('normal')
    },
    {
      label: '📱 미니 화면으로 열기',
      click: () => openMainWindowWithViewMode('compact')
    },
    { type: 'separator' },
    { label: '트레이·단축키로 열 때', enabled: false },
    {
      label: '기본 화면',
      type: 'radio',
      checked: trayLaunchViewMode === 'normal',
      click: () => setTrayLaunchViewMode('normal')
    },
    {
      label: '미니 화면',
      type: 'radio',
      checked: trayLaunchViewMode === 'compact',
      click: () => setTrayLaunchViewMode('compact')
    },
    { type: 'separator' },
    {
      label: '🛠️ 문제 진단 화면 열기',
      click: () => {
        openMainWindowWithViewMode(trayLaunchViewMode);
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.openDevTools({ mode: 'right' });
        }
      }
    },
    { type: 'separator' },
    { label: '종료', click: () => { beginAppQuit(); } }
  ]);
}

function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);

  tray.setToolTip('미래병원 사내 메신저');
  tray.setContextMenu(buildTrayContextMenu());
  tray.on('double-click', () => openMainWindowWithViewMode(trayLaunchViewMode));
}

function showAndFocusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.focus();
  }
}

function initSpellCheckerSession() {
  const ses = session.defaultSession;
  if (!ses) return;
  try {
    ses.setSpellCheckerLanguages(['ko-KR', 'en-US']);
    ses.setSpellCheckerEnabled(spellCheckerEnabled);
  } catch (e) {
    console.error('맞춤법 검사 초기화 오류:', e.message);
  }
}

function attachEditableContextMenu(webContents) {
  webContents.on('context-menu', (event, params) => {
    const menu = new Menu();
    if (spellCheckerEnabled && params.misspelledWord && params.dictionarySuggestions && params.dictionarySuggestions.length) {
      params.dictionarySuggestions.slice(0, 8).forEach((suggestion) => {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion)
        }));
      });
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ role: 'selectAll', enabled: params.editFlags.canSelectAll }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }
    if (menu.items.length === 0) return;
    const win = BrowserWindow.fromWebContents(webContents);
    menu.popup(win ? { window: win } : undefined);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: NORMAL_MIN_WIDTH,
    minHeight: NORMAL_MIN_HEIGHT,
    title: "Mirae Messenger",
    icon: getAppNativeIcon(),
    frame: false,
    webPreferences: {
      preload: getMainPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: spellCheckerEnabled,
      backgroundThrottling: true
    }
  });

  mainWindow.setMenu(null);
  attachEditableContextMenu(mainWindow.webContents);
  mainWindow.loadFile('index.html');

  mainWindow.on('hide', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(true);
    }
  });
  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(true);
    }
  });
  mainWindow.on('focus', () => { toastUiState.focused = true; });
  mainWindow.on('blur', () => { toastUiState.focused = false; });

  // 📁 채팅에서 파일/사진을 "다운로드"하면 브라우저 기본 위치 대신 설정에서 지정한 폴더로 저장한다.
  // session 공유 리스너이므로 창 재생성 시 중복 등록하지 않는다.
  if (!willDownloadHandlerBound) {
    willDownloadHandlerBound = true;
    session.defaultSession.on('will-download', (event, item) => {
      try {
        const targetDir = downloadFolderPath || app.getPath('downloads');
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        item.setSavePath(path.join(targetDir, item.getFilename()));
      } catch (e) {
        console.error('다운로드 경로 설정 오류:', e.message);
      }
    });
  }

  mainWindow.on('maximize', () => {
    if (mainWindow) safeWebContentsSend('window-maximized-state', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow) safeWebContentsSend('window-maximized-state', false);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  // 🛡 화면(렌더러 프로세스)이 죽어도(예: 메모리 부족) 창을 새로 띄워 계속 쓸 수 있게 한다.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('❌ 화면 프로세스가 종료됨(재생성 시도):', details.reason);
    if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
    setTimeout(() => {
      createWindow();
      if (mainWindow) mainWindow.show();
    }, 500);
  });
}

async function openScheduleBoardWindow(payload) {
  const data = typeof payload === 'string' ? { dateStr: payload } : (payload || {});
  const dateStr = data.dateStr || '';
  const sendOpenPayload = (win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('schedule-board-open', {
      dateStr,
      focusQuickAdd: !!data.focusQuickAdd,
      editUid: data.editUid || ''
    });
  };

  if (scheduleBoardWindow && !scheduleBoardWindow.isDestroyed()) {
    try {
      const [cw, ch] = scheduleBoardWindow.getSize();
      if (cw < 1400 || ch < 920) {
        scheduleBoardWindow.setSize(Math.max(cw, 1400), Math.max(ch, 920));
      }
    } catch (e) { /* ignore */ }
    scheduleBoardWindow.show();
    scheduleBoardWindow.focus();
    sendOpenPayload(scheduleBoardWindow);
    return;
  }

  await refreshPreloadScriptCacheIfNeeded();

  scheduleBoardWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: '병동 일정 현황판 — Mirae Messenger',
    icon: getAppNativeIcon(),
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: getMainPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  scheduleBoardWindow.setMenu(null);
  attachEditableContextMenu(scheduleBoardWindow.webContents);
  scheduleBoardWindow.loadFile('index.html', { hash: 'schedule-board' });
  scheduleBoardWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => sendOpenPayload(scheduleBoardWindow), 150);
  });
  scheduleBoardWindow.on('closed', () => {
    scheduleBoardWindow = null;
  });
}

// 🪟 프레임 없는 창(frame:false)이라 -/□/X 버튼을 직접 그려야 하므로, 그 버튼들이 호출하는 IPC.
ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window-maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('focus-main-window', () => { showAndFocusWindow(); });

ipcMain.handle('open-schedule-board-window', async (event, payload = {}) => {
  const data = typeof payload === 'string' ? { dateStr: payload } : payload;
  openScheduleBoardWindow(data);
  return { success: true };
});

ipcMain.handle('close-schedule-board-window', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win !== mainWindow) {
    win.close();
    return { success: true };
  }
  return { success: false };
});

ipcMain.on('message-toast-activate', () => {
  const key = pendingToastChannelKey;
  closeMessageToast();
  showAndFocusWindow();
  if (key && mainWindow) safeWebContentsSend('open-chat-from-toast', { channelKey: key });
});

ipcMain.on('message-toast-open', () => {
  const key = pendingToastChannelKey;
  closeMessageToast();
  showAndFocusWindow();
  if (key && mainWindow) safeWebContentsSend('open-chat-from-toast', { channelKey: key });
});

ipcMain.on('message-toast-close', () => {
  closeMessageToast();
});

ipcMain.on('toast-ui-state', (_, state) => {
  if (state && typeof state.activeChannelKey === 'string') {
    toastUiState.activeChannelKey = state.activeChannelKey;
  } else if (!state || state.activeChannelKey == null) {
    toastUiState.activeChannelKey = '';
  }
});

ipcMain.handle('get-desktop-capture-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null
  }));
});

ipcMain.handle('capture-desktop-source-image', async (event, sourceId) => {
  try {
    const primary = screen.getPrimaryDisplay();
    const thumbW = Math.min(7680, Math.max(640, Math.round(primary.size.width * primary.scaleFactor)));
    const thumbH = Math.min(4320, Math.max(480, Math.round(primary.size.height * primary.scaleFactor)));
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: thumbW, height: thumbH },
      fetchWindowIcons: false
    });
    const source = sources.find((s) => s.id === sourceId) || sources.find((s) => String(s.id).startsWith('screen')) || sources[0];
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      return { success: false, error: 'EMPTY_CAPTURE' };
    }
    const jpeg = source.thumbnail.toJPEG(88);
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('set-main-window-hidden', async (event, hidden) => {
  if (!mainWindow) return { success: false };
  if (hidden) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.showInactive();
  }
  return { success: true };
});

ipcMain.handle('set-tray-launch-view-mode', async (event, mode) => {
  setTrayLaunchViewMode(mode === 'compact' ? 'compact' : 'normal');
  return trayLaunchViewMode;
});

ipcMain.handle('get-tray-launch-view-mode', async () => trayLaunchViewMode);

function registerGlobalShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+S', () => {
    openMainWindowWithViewMode(trayLaunchViewMode);
  });
  // 🛠️ 문제 진단 화면은 Alt 조합 전역 단축키(Ctrl+Alt+D)로 열도록 했었으나,
  // Alt가 들어간 전역 단축키가 한글 IME와 충돌해 가끔 입력이 먹통이 되는 문제를 일으켜 제거함.
  // 트레이 아이콘 우클릭 메뉴의 "🛠️ 문제 진단 화면 열기"로 여전히 열 수 있다.
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('미래병원 메신저');
  }
  const pendingApplied = await applyPendingUpdatesOnStartup();
  if (pendingApplied > 0) {
    console.log(`[업데이트] 보류 파일 ${pendingApplied}개 적용됨`);
  }
  try {
    await initPreloadScriptCache();
  } catch (e) {
    console.error('[preload-cache] 시작 시 캐시 초기화 실패:', e.message);
  }
  initSpellCheckerSession();
  registerMiraeFileProtocol();
  createWindow();
  createTray();
  registerGlobalShortcuts();
  startUdpDiscovery();
  startTcpServer();
  startMobileServer(db, MY_IP);
  startScheduledMessageChecker();
  startPresenceSweeper();
  startAutoBackup();
  startUpdateChecker();
});

app.on('before-quit', () => {
  broadcastGoodbye();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

/** 트레이/강제종료 등 — GOODBYE 전송 후 종료 */
function beginAppQuit() {
  isQuitting = true;
  broadcastGoodbye();
  setTimeout(() => {
    try { app.quit(); } catch (e) { /* ignore */ }
  }, 120);
}

let globalUdpSocket = null;
let udpStatus = 'starting';
let tcpStatus = 'starting';

function notifyNetworkStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeWebContentsSend('network-status-update', {
      myIp: MY_IP, udpStatus, tcpStatus, onlineCount: onlineUsers.size
    });
  }
}

function startUdpDiscovery() {
  if (globalUdpSocket) {
    try { globalUdpSocket.removeAllListeners(); globalUdpSocket.close(); } catch (e) { /* ignore */ }
    globalUdpSocket = null;
  }
  globalUdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  globalUdpSocket.once('listening', () => {
    try { globalUdpSocket.setBroadcast(true); } catch (e) { /* ignore */ }
    udpStatus = 'running';
    notifyNetworkStatus();
    registerSelf();
    broadcastPresence(globalUdpSocket);

    if (!presenceFlushTimersStarted) {
      presenceFlushTimersStarted = true;
      setInterval(() => {
        registerSelf();
        if (globalUdpSocket) broadcastPresence(globalUdpSocket);
      }, 4000);
      setTimeout(() => flushAllPendingOutboundMessages(), 2500);
      setInterval(() => flushAllPendingOutboundMessages(), 15000);
    }
  });

  globalUdpSocket.on('message', (msg, rinfo) => {
    if (rinfo.address === MY_IP) return;

    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'GOODBYE') {
        const leftAt = Number(data.leftAt) || Date.now();
        if (markPeerOffline(rinfo.address, leftAt)) {
          notifyUserList();
          writeToLogFile('info', `[네트워크] ${data.username || rinfo.address}(${rinfo.address}) 종료(GOODBYE) 처리`);
        }
        return;
      }
      if (data.type === 'PING') {
        const previouslyKnown = allKnownUsers.get(rinfo.address);
        const now = Date.now();
        const overlay = {
          ip: rinfo.address,
          username: data.username,
          rank: data.rank || '',
          dept: data.dept || '',
          floor: data.floor || '',
          extNo: data.extNo || '',
          phone: data.phone || '',
          statusState: data.statusState || 'ONLINE',
          appVersion: data.appVersion || (previouslyKnown && previouslyKnown.appVersion) || '',
          photo: (previouslyKnown && previouslyKnown.photo) || persistedPhotos[rinfo.address] || '',
          lastPingAt: now,
          online: true,
          isMe: false
        };
        const userObj = mergeUserProfile(previouslyKnown, overlay, true);
        // lastSeen = 마지막 '종료/오프라인' 시각. 접속 중에는 갱신하지 않는다.
        userObj.lastPingAt = now;
        if (previouslyKnown && Number(previouslyKnown.lastSeen) > 0) {
          userObj.lastSeen = Number(previouslyKnown.lastSeen);
        }

        const wasOffline = !onlineUsers.has(rinfo.address);
        const profileChanged = !previouslyKnown
          || previouslyKnown.username !== userObj.username
          || previouslyKnown.rank !== userObj.rank
          || previouslyKnown.dept !== userObj.dept
          || previouslyKnown.floor !== userObj.floor
          || previouslyKnown.extNo !== userObj.extNo
          || previouslyKnown.phone !== userObj.phone
          || previouslyKnown.statusState !== userObj.statusState
          || previouslyKnown.appVersion !== userObj.appVersion
          || !!previouslyKnown.online !== true;

        onlineUsers.set(rinfo.address, userObj);
        allKnownUsers.set(rinfo.address, userObj);
        persistKnownUserSnapshot(userObj);

        if (wasOffline || profileChanged) notifyUserList();

        if (wasOffline) {
          resendPendingMessages(rinfo.address);
          requestNoticeSync(rinfo.address);
          syncGroupsWithPeer(rinfo.address);
          if (myProfile.photo) {
            sendToIps([rinfo.address], { type: 'PROFILE_PHOTO_SYNC', ip: MY_IP, photo: myProfile.photo });
          } else {
            sendToIps([rinfo.address], { type: 'PROFILE_PHOTO_REQUEST' });
          }
        }
      }
    } catch (e) {}
  });

  globalUdpSocket.on('error', (err) => {
    console.error('UDP 소켓 오류:', err);
    udpStatus = `오류: ${err.code || err.message}`;
    notifyNetworkStatus();
    if (udpBindRetryTimer) return;
    udpBindRetryTimer = setTimeout(() => {
      udpBindRetryTimer = null;
      console.error('UDP 재바인딩 시도…');
      startUdpDiscovery();
    }, 3000);
  });

  try {
    globalUdpSocket.bind(UDP_PORT);
  } catch (e) {
    console.error('UDP bind 예외:', e.message);
    udpStatus = `오류: ${e.message}`;
    notifyNetworkStatus();
  }
}

function registerSelf() {
  // DB에서 실제 프로필을 아직 못 불러왔으면(부팅 직후 짧은 순간) 하드코딩된 기본값을 화면에
  // 등록하지 않는다 — 이걸 빠뜨리면 내 사이드바 카드에 "실장 정용범"이 잠깐 보였다가 몇 초 뒤
  // "물리치료실장 정용범"으로 바뀌는 현상이 생긴다.
  if (!profileLoaded) return;
  const now = Date.now();
  const prev = allKnownUsers.get(MY_IP);
  const me = {
    ip: MY_IP,
    username: myProfile.username,
    rank: myProfile.rank,
    dept: myProfile.dept,
    floor: myProfile.floor,
    extNo: myProfile.extNo,
    phone: myProfile.phone,
    statusState: myProfile.statusState,
    appVersion: APP_VERSION,
    photo: myProfile.photo || '',
    lastPingAt: now,
    // 내 카드는 보통 숨기지만, lastSeen은 이전 종료 시각을 유지
    lastSeen: (prev && Number(prev.lastSeen) > 0) ? Number(prev.lastSeen) : 0,
    online: true,
    isMe: true
  };
  onlineUsers.set(MY_IP, me);
  allKnownUsers.set(MY_IP, me);
  persistKnownUserSnapshot(me);
  notifyUserList();
}

function broadcastPresence(socket) {
  if (!socket) return;
  if (!profileLoaded) return; // 아직 DB에서 실제 프로필을 못 불러왔으면 기본값을 내보내지 않는다.
  const packet = Buffer.from(JSON.stringify({
    type: 'PING',
    username: myProfile.username,
    rank: myProfile.rank,
    dept: myProfile.dept,
    floor: myProfile.floor,
    extNo: myProfile.extNo,
    phone: myProfile.phone,
    statusState: myProfile.statusState,
    appVersion: APP_VERSION
  }));
  // 같은 대역은 기존 방식(브로드캐스트)으로 빠르게 전송
  socket.send(packet, 0, packet.length, UDP_PORT, '255.255.255.255');
  // 다른 층 대역은 라우터의 브로드캐스트 차단 여부와 상관없이 전달되도록 호스트별 유니캐스트로 전송
  KNOWN_SUBNET_HOST_IPS.forEach(ip => {
    try { socket.send(packet, 0, packet.length, UDP_PORT, ip); } catch (e) { /* ignore */ }
  });
}

function broadcastGoodbye() {
  if (!globalUdpSocket) return;
  const packet = Buffer.from(JSON.stringify({
    type: 'GOODBYE',
    username: (myProfile && myProfile.username) || '',
    leftAt: Date.now()
  }));
  try {
    globalUdpSocket.send(packet, 0, packet.length, UDP_PORT, '255.255.255.255');
  } catch (e) { /* ignore */ }
  KNOWN_SUBNET_HOST_IPS.forEach((ip) => {
    try { globalUdpSocket.send(packet, 0, packet.length, UDP_PORT, ip); } catch (e) { /* ignore */ }
  });
}

/**
 * 상대를 오프라인으로 표시하고 lastSeen(=종료/이탈 시각)을 기록한다.
 * @returns {boolean} 상태가 바뀌었으면 true
 */
function markPeerOffline(ip, leftAtHint) {
  if (!ip || ip === MY_IP) return false;
  const wasOnline = onlineUsers.has(ip);
  const live = onlineUsers.get(ip);
  if (wasOnline) onlineUsers.delete(ip);
  const known = allKnownUsers.get(ip) || live;
  if (!known) return false;
  const pingAt = Number((live && live.lastPingAt) || known.lastPingAt || 0);
  const leftAt = Number(leftAtHint) || pingAt || Date.now();
  const prevSeen = Number(known.lastSeen) || 0;
  // 종료 시각이 핵심. 예전에 잘못 저장된(접속 시작 등) 값보다 이번 이탈 시각을 우선한다.
  const lastSeen = leftAtHint ? leftAt : Math.max(prevSeen, leftAt);
  const alreadyOffline = !known.online && !wasOnline && prevSeen === lastSeen;
  if (alreadyOffline) return false;
  const offline = {
    ...known,
    online: false,
    statusState: 'OFFLINE',
    lastSeen,
    lastPingAt: pingAt || leftAt,
    presenceLastSeen: true
  };
  allKnownUsers.set(ip, offline);
  persistKnownUserSnapshot(offline);
  return true;
}

function touchPeerPresence(ip) {
  if (!ip || ip === MY_IP || isSyntheticReceiverKey(ip)) return;
  if (!onlineUsers.has(ip)) return;
  const now = Date.now();
  const u = onlineUsers.get(ip);
  if (!u) return;
  const updated = { ...u, lastPingAt: now, online: true };
  onlineUsers.set(ip, updated);
  const known = allKnownUsers.get(ip);
  if (known) {
    allKnownUsers.set(ip, { ...known, lastPingAt: now, online: true });
  }
}

function looksLikeIpv4(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function isUsableProfilePhotoValue(photo) {
  if (!photo || typeof photo !== 'string') return false;
  const p = photo.trim();
  if (!p || p === 'undefined' || p === 'null') return false;
  if (p.startsWith('data:image/svg')) return false;
  if (p.startsWith('data:image/')) return true;
  return /^https?:\/\//i.test(p);
}

function profileOverrideFromRow(row) {
  if (!row || !row.ip) return null;
  return {
    ip: row.ip,
    username: row.username || '',
    rank: row.rank || '',
    dept: row.dept || '',
    floor: row.floor || '',
    extNo: row.ext_no || '',
    phone: row.phone_no || ''
  };
}

function loadProfileOverrides(callback) {
  db.all(`SELECT * FROM user_profile_overrides`, [], (err, rows) => {
    if (err) logDbErr(err);
    profileOverrides.clear();
    (rows || []).forEach((row) => {
      const ov = profileOverrideFromRow(row);
      if (ov) profileOverrides.set(ov.ip, ov);
    });
    if (callback) callback();
  });
}

function applyStoredProfileOverride(u) {
  if (!u || !u.ip) return u;
  const ov = profileOverrides.get(u.ip);
  if (!ov) return u;
  const out = { ...u };
  ['username', 'rank', 'dept', 'floor', 'extNo', 'phone'].forEach((f) => {
    if (Object.prototype.hasOwnProperty.call(ov, f)) {
      out[f] = String(ov[f] ?? '').trim();
    }
  });
  return out;
}

function persistProfileOverrideToDb(ov) {
  if (!ov || !ov.ip) return;
  const updatedAt = new Date().toISOString();
  db.run(
    `INSERT INTO user_profile_overrides (ip, username, rank, dept, floor, ext_no, phone_no, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       username = excluded.username, rank = excluded.rank, dept = excluded.dept,
       floor = excluded.floor, ext_no = excluded.ext_no, phone_no = excluded.phone_no,
       updated_at = excluded.updated_at`,
    [ov.ip, ov.username || '', ov.rank || '', ov.dept || '', ov.floor || '', ov.extNo || '', ov.phone || '', updatedAt],
    logDbErr
  );
}

function storeProfileOverride(patch) {
  if (!patch || !patch.ip) return;
  const prev = profileOverrides.get(patch.ip) || { ip: patch.ip };
  const merged = {
    ip: patch.ip,
    username: patch.username != null ? String(patch.username).trim() : (prev.username || ''),
    rank: patch.rank != null ? String(patch.rank).trim() : (prev.rank || ''),
    dept: patch.dept != null ? String(patch.dept).trim() : (prev.dept || ''),
    floor: patch.floor != null ? String(patch.floor).trim() : (prev.floor || ''),
    extNo: patch.extNo != null ? String(patch.extNo).trim() : (prev.extNo || ''),
    phone: patch.phone != null ? String(patch.phone).trim() : (prev.phone || '')
  };
  profileOverrides.set(patch.ip, merged);
  persistProfileOverrideToDb(merged);
  db.run(
    `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT status_state FROM known_users WHERE ip = ?), 'OFFLINE'), COALESCE((SELECT photo FROM known_users WHERE ip = ?), ''), COALESCE((SELECT last_seen_at FROM known_users WHERE ip = ?), 0))
     ON CONFLICT(ip) DO UPDATE SET
       username = excluded.username, rank = excluded.rank, dept = excluded.dept,
       floor = excluded.floor, ext_no = excluded.ext_no, phone_no = excluded.phone_no`,
    [merged.ip, merged.username, merged.rank, merged.dept, merged.floor, merged.extNo, merged.phone, merged.ip, merged.ip, merged.ip],
    logDbErr
  );
}

function applyProfileOverrideToSelf(patch) {
  if (!patch || patch.ip !== MY_IP) return;
  myProfile = {
    ...myProfile,
    username: patch.username !== undefined ? patch.username : myProfile.username,
    rank: patch.rank !== undefined ? patch.rank : myProfile.rank,
    dept: patch.dept !== undefined ? patch.dept : myProfile.dept,
    floor: patch.floor !== undefined ? patch.floor : myProfile.floor,
    extNo: patch.extNo !== undefined ? patch.extNo : myProfile.extNo,
    phone: patch.phone !== undefined ? patch.phone : myProfile.phone
  };
  db.run(
    `INSERT OR REPLACE INTO user_profile (id, username, rank, dept, floor, ext_no, phone_no, status_state, photo) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [myProfile.username, myProfile.rank, myProfile.dept, myProfile.floor, myProfile.extNo, myProfile.phone, myProfile.statusState, myProfile.photo || ''],
    logDbErr
  );
}

function refreshUserAfterProfileOverride(ip) {
  if (ip === MY_IP) {
    const ov = profileOverrides.get(ip);
    if (ov) applyProfileOverrideToSelf(ov);
    registerSelf();
    notifyUserList();
    return;
  }
  const live = allKnownUsers.get(ip);
  if (live) {
    const patched = applyStoredProfileOverride({ ...live });
    allKnownUsers.set(ip, patched);
    if (onlineUsers.has(ip)) onlineUsers.set(ip, patched);
  }
  notifyUserList();
}

function handleProfileOverrideSync(payload) {
  const p = payload && payload.profile;
  if (!p || !p.ip) return;
  storeProfileOverride({
    ip: p.ip,
    username: p.username,
    rank: p.rank,
    dept: p.dept,
    floor: p.floor,
    extNo: p.extNo != null ? p.extNo : p.ext_no,
    phone: p.phone != null ? p.phone : p.phone_no
  });
  refreshUserAfterProfileOverride(p.ip);
}

function mergeUserProfile(base, overlay, online) {
  const merged = { ...(base || {}) };
  if (!overlay) {
    merged.online = !!online;
    return merged;
  }
  const fields = ['username', 'rank', 'dept', 'floor', 'extNo', 'phone', 'statusState', 'photo', 'appVersion'];
  // 접속 중(PING)일 때는 빈 직급도 "의도적으로 비움"으로 반영한다.
  // 비우지 않으면 known_users / 스냅샷에 남은 "실장" 등이 영원히 되살아난다.
  const clearableWhenOnline = new Set(['rank', 'dept', 'floor', 'extNo', 'phone']);
  fields.forEach((f) => {
    const o = overlay[f];
    if (o == null) return;
    if (String(o).trim() === '') {
      if (online && clearableWhenOnline.has(f) && Object.prototype.hasOwnProperty.call(overlay, f)) {
        merged[f] = '';
      }
      return;
    }
    const b = merged[f];
    if (f === 'username' && looksLikeIpv4(o) && b && String(b).trim() && !looksLikeIpv4(b)) return;
    if (f === 'photo' && !isUsableProfilePhotoValue(o) && isUsableProfilePhotoValue(b)) return;
    merged[f] = o;
  });
  merged.lastSeen = merged.lastSeen || 0;
  merged.lastPingAt = merged.lastPingAt || 0;
  if (online) {
    // 접속 중에는 lastSeen(종료 시각)을 건드리지 않고 하트비트만 갱신
    const pingAt = Number(overlay.lastPingAt) || Date.now();
    merged.lastPingAt = pingAt;
  } else if (overlay.presenceLastSeen && overlay.lastSeen) {
    merged.lastSeen = Math.max(merged.lastSeen, overlay.lastSeen);
  } else if (overlay.lastSeen && overlay.lastSeen > 0) {
    // 메시지 시각 등으로 lastSeen을 덮어쓰지 않도록, 기존 값이 있으면 유지·최대만
    merged.lastSeen = Math.max(merged.lastSeen, overlay.lastSeen);
  }
  merged.ip = merged.ip || overlay.ip;
  merged.isMe = merged.ip === MY_IP;
  merged.online = !!online;
  if (merged.photo && !isUsableProfilePhotoValue(merged.photo)) merged.photo = '';
  return applyStoredProfileOverride(merged);
}

function userObjFromKnownUsersRow(row) {
  const obj = {
    ip: row.ip,
    username: row.username || '알 수 없음',
    rank: row.rank || '',
    dept: row.dept || '',
    floor: row.floor || '',
    extNo: row.ext_no || '',
    phone: row.phone_no || '',
    statusState: row.status_state || 'OFFLINE',
    photo: row.photo || persistedPhotos[row.ip] || '',
    appVersion: '',
    lastSeen: row.last_seen_at || 0,
    online: false,
    isMe: row.ip === MY_IP
  };
  if (obj.photo && !isUsableProfilePhotoValue(obj.photo)) obj.photo = '';
  return obj;
}

function persistKnownUserSnapshot(u) {
  if (!u || !u.ip) return;
  if (isSyntheticReceiverKey(u.ip)) return;
  db.get(`SELECT * FROM known_users WHERE ip = ?`, [u.ip], (err, row) => {
    if (err) logDbErr(err);
    const existing = row ? userObjFromKnownUsersRow(row) : null;
    const merged = mergeUserProfile(existing, u, !!u.online);
    const mergedForStore = applyStoredProfileOverride(merged);
    let lastSeen = mergedForStore.lastSeen || merged.lastSeen || 0;
    if (u.online) {
      // 접속 중에는 DB의 last_seen_at(마지막 종료 시각)을 유지한다.
      // (예전처럼 Date.now()로 덮으면 '프로그램 시작 시각'처럼 보일 수 있음)
      if (existing && existing.lastSeen) {
        lastSeen = Math.max(lastSeen, existing.lastSeen);
      }
    } else if (!lastSeen && existing && existing.lastSeen) {
      lastSeen = existing.lastSeen;
    } else if (existing && existing.lastSeen) {
      lastSeen = Math.max(lastSeen, existing.lastSeen);
    }
    db.run(
    `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       username = excluded.username,
       rank = excluded.rank,
       dept = CASE WHEN excluded.dept != '' THEN excluded.dept ELSE known_users.dept END,
       floor = CASE WHEN excluded.floor != '' THEN excluded.floor ELSE known_users.floor END,
       ext_no = CASE WHEN excluded.ext_no != '' THEN excluded.ext_no ELSE known_users.ext_no END,
       phone_no = CASE WHEN excluded.phone_no != '' THEN excluded.phone_no ELSE known_users.phone_no END,
       status_state = excluded.status_state,
       photo = CASE WHEN excluded.photo != '' THEN excluded.photo ELSE known_users.photo END,
       last_seen_at = MAX(COALESCE(known_users.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0))`,
    [
      mergedForStore.ip,
      mergedForStore.username || '',
      mergedForStore.rank || '',
      mergedForStore.dept || '',
      mergedForStore.floor || '',
      mergedForStore.extNo || '',
      mergedForStore.phone || '',
      mergedForStore.statusState || 'OFFLINE',
      isUsableProfilePhotoValue(mergedForStore.photo) ? mergedForStore.photo : '',
      lastSeen
    ],
    logDbErr
    );
  });
}

function loadPersistedKnownUsers(callback) {
  db.all(
    `SELECT * FROM known_users WHERE ip != ?`,
    [MY_IP],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        supplementKnownUsersFromMessagePeers(callback);
        return;
      }
      (rows || []).forEach((row) => {
        if (!row || !row.ip || row.ip === MY_IP) return;
        if (isSyntheticReceiverKey(row.ip)) return;
        const fromDb = userObjFromKnownUsersRow(row);
        const live = allKnownUsers.get(row.ip);
        if (live && onlineUsers.has(row.ip)) return;
        if (live) {
          allKnownUsers.set(row.ip, applyStoredProfileOverride(mergeUserProfile(fromDb, live, onlineUsers.has(row.ip))));
        } else {
          allKnownUsers.set(row.ip, applyStoredProfileOverride({ ...fromDb, online: onlineUsers.has(row.ip) }));
        }
      });
      supplementKnownUsersFromMessagePeers(callback);
    }
  );
}

function supplementKnownUsersFromMessagePeers(callback) {
  db.all(
    `SELECT m.ip, m.last_ts, (
       SELECT sender_name FROM messages
       WHERE (sender_ip = m.ip OR receiver_ip = m.ip) AND sender_ip = m.ip
       ORDER BY id DESC LIMIT 1
     ) AS sender_name
     FROM (
       SELECT ip, MAX(last_ts) AS last_ts FROM (
         SELECT sender_ip AS ip, strftime('%s', created_at) AS last_ts FROM messages
         WHERE sender_ip != ? AND sender_ip != 'BROADCAST'
           AND sender_ip NOT LIKE 'DEPT:%' AND sender_ip NOT LIKE 'FLOOR:%' AND sender_ip NOT LIKE 'GROUP:%'
           AND sender_ip NOT LIKE 'BCAST:%' AND sender_ip NOT LIKE 'DEPTPEER:%' AND sender_ip NOT LIKE 'FLOORPEER:%'
           AND datetime(created_at) >= datetime('now', '-180 days')
         UNION ALL
         SELECT receiver_ip AS ip, strftime('%s', created_at) AS last_ts FROM messages
         WHERE receiver_ip != ? AND receiver_ip != 'BROADCAST'
           AND receiver_ip NOT LIKE 'DEPT:%' AND receiver_ip NOT LIKE 'FLOOR:%' AND receiver_ip NOT LIKE 'GROUP:%'
           AND receiver_ip NOT LIKE 'BCAST:%' AND receiver_ip NOT LIKE 'DEPTPEER:%' AND receiver_ip NOT LIKE 'FLOORPEER:%'
           AND datetime(created_at) >= datetime('now', '-180 days')
       ) GROUP BY ip
     ) m`,
    [MY_IP, MY_IP],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        if (callback) callback();
        return;
      }
      (rows || []).forEach((row) => {
        if (!row || !row.ip || row.ip === MY_IP) return;
        if (isSyntheticReceiverKey(row.ip) || !looksLikeIpv4(row.ip)) return;
        const msgLastSeen = row.last_ts ? Math.floor(Number(row.last_ts) * 1000) : 0;
        // 대화 시각은 '마지막 종료'가 아님 — lastSeen이 없을 때만 보조로 씀
        const lastSeenFallback = msgLastSeen > 0 ? msgLastSeen : 0;
        const displayName = String(row.sender_name || '').trim();
        const stub = {
          ip: row.ip,
          username: (displayName && !looksLikeIpv4(displayName)) ? displayName : row.ip,
          rank: '',
          dept: '',
          floor: '',
          extNo: '',
          phone: '',
          statusState: 'OFFLINE',
          photo: persistedPhotos[row.ip] || '',
          appVersion: '',
          lastSeen: 0,
          online: false,
          isMe: false
        };
        if (allKnownUsers.has(row.ip)) {
          const existing = allKnownUsers.get(row.ip);
          const merged = mergeUserProfile(existing, stub, !!onlineUsers.has(row.ip));
          if (!(Number(merged.lastSeen) > 0) && lastSeenFallback > 0) {
            merged.lastSeen = lastSeenFallback;
          }
          if (looksLikeIpv4(merged.username) && displayName && !looksLikeIpv4(displayName)) {
            merged.username = displayName;
          }
          const parsed = parseSenderNameToProfile(displayName);
          // 과거 메시지 sender_name("실장 정용범")에서 직급을 다시 채우지 않는다.
          // 직급은 실시간 PING / 마스터 지정값만 신뢰한다.
          if (parsed && parsed.username && (looksLikeIpv4(merged.username) || !String(merged.username || '').trim())) {
            merged.username = parsed.username;
          }
          allKnownUsers.set(row.ip, applyStoredProfileOverride(merged));
          persistKnownUserSnapshot(merged);
          return;
        }
        if (looksLikeIpv4(stub.username) && !displayName) return;
        const parsedNew = parseSenderNameToProfile(displayName);
        if (parsedNew && parsedNew.username) {
          stub.username = parsedNew.username;
          // 신규 stub도 메시지에서 직급을 추정하지 않음 (빈 직급 유지)
        }
        if (lastSeenFallback > 0) stub.lastSeen = lastSeenFallback;
        allKnownUsers.set(row.ip, applyStoredProfileOverride(stub));
        persistKnownUserSnapshot(stub);
      });
      repairKnownUsersFromMessages(() => repairKnownUsersProfiles(callback));
    }
  );
}

function parseSenderNameToProfile(senderName) {
  const s = String(senderName || '').trim();
  if (!s || looksLikeIpv4(s)) return null;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    return {
      username: tokens[tokens.length - 1],
      rank: tokens.slice(0, -1).join(' ')
    };
  }
  return { username: s, rank: '' };
}

function repairKnownUsersProfiles(callback) {
  db.all(`SELECT members FROM group_chats`, [], (err, groupRows) => {
    if (err) logDbErr(err);
    const fromGroups = new Map();
    (groupRows || []).forEach((row) => {
      let members = [];
      try { members = JSON.parse(row.members || '[]'); } catch (e) {}
      members.forEach((m) => {
        if (!m || !m.ip || m.ip === MY_IP) return;
        if (isSyntheticReceiverKey(m.ip) || !looksLikeIpv4(m.ip)) return;
        const snap = {
          ip: m.ip,
          username: m.username || '',
          // 그룹 멤버 스냅샷의 옛 직급은 복원하지 않음 ("실장" 부활 방지)
          dept: m.dept || '',
          floor: m.floor || '',
          extNo: m.extNo || m.ext_no || '',
          phone: m.phone || m.phone_no || ''
        };
        fromGroups.set(m.ip, mergeUserProfile(fromGroups.get(m.ip), snap, false));
      });
    });

    db.all(`SELECT * FROM known_users WHERE ip != ?`, [MY_IP], (err2, rows) => {
      if (err2) {
        logDbErr(err2);
        if (callback) callback();
        return;
      }
      const list = (rows || []).filter((r) => r && r.ip && !isSyntheticReceiverKey(r.ip));
      if (!list.length) {
        if (callback) callback();
        return;
      }
      let pending = list.length;
      list.forEach((row) => {
        const finishOne = () => {
          pending -= 1;
          if (pending === 0 && callback) callback();
        };
        const base = userObjFromKnownUsersRow(row);
        const needsDetail = !(base.rank && base.dept);
        const groupSnap = fromGroups.get(row.ip);
        let merged = groupSnap ? mergeUserProfile(base, groupSnap, onlineUsers.has(row.ip)) : base;

        if (!needsDetail) {
          allKnownUsers.set(row.ip, { ...merged, online: onlineUsers.has(row.ip) });
          finishOne();
          return;
        }

        db.get(
          `SELECT sender_name FROM messages WHERE sender_ip = ? ORDER BY id DESC LIMIT 1`,
          [row.ip],
          (e, msg) => {
            if (e) logDbErr(e);
            const name = String((msg && msg.sender_name) || '').trim();
            const parsed = parseSenderNameToProfile(name);
            if (parsed && parsed.username) {
              // 과거 말풍선 이름에서 직급을 복원하지 않음 — "실장" 등이 되살아나는 원인
              merged = mergeUserProfile(merged, {
                ip: row.ip,
                username: parsed.username
              }, onlineUsers.has(row.ip));
            }
            const before = JSON.stringify({ rank: base.rank, dept: base.dept, extNo: base.extNo, phone: base.phone });
            const after = JSON.stringify({ rank: merged.rank, dept: merged.dept, extNo: merged.extNo, phone: merged.phone });
            allKnownUsers.set(row.ip, { ...merged, online: onlineUsers.has(row.ip) });
            if (before !== after || !(base.rank && base.dept)) {
              persistKnownUserSnapshot(merged);
            }
            finishOne();
          }
        );
      });
    });
  });
}

function repairKnownUsersFromMessages(callback) {
  db.all(`SELECT * FROM known_users WHERE ip != ?`, [MY_IP], (err, rows) => {
    if (err) {
      logDbErr(err);
      if (callback) callback();
      return;
    }
    const targets = (rows || []).filter((r) => r && r.ip && !isSyntheticReceiverKey(r.ip) && looksLikeIpv4(r.username));
    if (!targets.length) {
      repairKnownUsersProfiles(callback);
      return;
    }
    let pending = targets.length;
    targets.forEach((row) => {
      db.get(
        `SELECT sender_name FROM messages WHERE sender_ip = ? ORDER BY id DESC LIMIT 1`,
        [row.ip],
        (e, msg) => {
          if (e) logDbErr(e);
          const name = String((msg && msg.sender_name) || '').trim();
          if (name && !looksLikeIpv4(name)) {
            const base = userObjFromKnownUsersRow(row);
            const parsed = parseSenderNameToProfile(name);
            const patch = parsed && parsed.username
              ? { username: parsed.username, ip: row.ip, lastSeen: base.lastSeen }
              : { username: name, ip: row.ip, lastSeen: base.lastSeen };
            const patched = mergeUserProfile(base, patch, false);
            allKnownUsers.set(row.ip, { ...patched, online: onlineUsers.has(row.ip) });
            persistKnownUserSnapshot(patched);
          }
          pending -= 1;
          if (pending === 0) repairKnownUsersProfiles(callback);
        }
      );
    });
  });
}

function profilePhotoForIp(ip) {
  const key = String(ip || '').trim();
  if (!key) return '';
  if (key === MY_IP) return isUsableProfilePhotoValue(myProfile.photo) ? myProfile.photo : '';
  const known = allKnownUsers.get(key);
  const photo = (known && known.photo) || persistedPhotos[key] || '';
  return isUsableProfilePhotoValue(photo) ? photo : '';
}

function userListEntryForRenderer(u) {
  const photo = profilePhotoForIp(u.ip);
  const { photo: _omit, ...rest } = u;
  return {
    ...rest,
    online: onlineUsers.has(u.ip),
    hasPhoto: !!photo
  };
}

/** 표시용 이름에서 직급 접두를 제거한 동일인 키 */
function canonicalPersonName(u) {
  if (!u) return '';
  let n = String(u.username || '').trim();
  if (!n || looksLikeIpv4(n)) return '';
  const r = normalizeRankText(u.rank);
  if (r) {
    while (n === r || n.startsWith(`${r} `)) {
      if (n === r) return '';
      n = n.slice(r.length).trim();
    }
  }
  const knownRanks = ['부장', '실장', '팀장', '부팀장', '주임', '과장', '대리', '사원'];
  for (const label of knownRanks) {
    if (n.startsWith(label + ' ')) {
      n = n.slice(label.length).trim();
      break;
    }
  }
  return n;
}

function preferUserListEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  // 대화 상대 카드는 접속 중인 IP를 우선 (여러 PC면 가장 최근 PING)
  if (!!a.online !== !!b.online) return a.online ? a : b;
  // 자기 자신 카드는 목록에서 제외하므로, 합칠 때는 이 PC(isMe)를 대표로 잡아 alias에만 남긴다
  if (!!a.isMe !== !!b.isMe) return a.isMe ? a : b;
  return (Number(a.lastSeen) || 0) >= (Number(b.lastSeen) || 0) ? a : b;
}

/**
 * 같은 사람이 다른 PC(IP)로 잡힌 중복 항목을 사이드바용으로 한 명만 남긴다.
 * - 여러 PC가 동시에 온라인이어도 표시는 1명 (나머지 IP는 aliasIps)
 * - 온라인 + 오프라인 유령(이전 PC) → 온라인만
 * - 모두 오프라인 → 가장 최근 lastSeen
 */
function dedupeUsersByPersonIdentity(list) {
  const byName = new Map();
  const passthrough = [];
  (list || []).forEach((u) => {
    const key = canonicalPersonName(u);
    if (!key) {
      passthrough.push(u);
      return;
    }
    const k = key.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(u);
  });
  const out = [...passthrough];
  byName.forEach((entries) => {
    if (entries.length === 1) {
      out.push(entries[0]);
      return;
    }
    let best = entries[0];
    for (let i = 1; i < entries.length; i++) best = preferUserListEntry(best, entries[i]);
    const aliasIps = entries.map((e) => e.ip).filter((ip) => ip && ip !== best.ip);
    // 대표가 오프라인인데 별칭 중 온라인이 있으면 그쪽으로 승격
    if (!best.online) {
      const onlineAlt = entries.find((e) => e.online && e.ip !== best.ip);
      if (onlineAlt) {
        const rest = entries.map((e) => e.ip).filter((ip) => ip && ip !== onlineAlt.ip);
        out.push(rest.length ? { ...onlineAlt, aliasIps: rest } : onlineAlt);
        return;
      }
    }
    out.push(aliasIps.length ? { ...best, aliasIps } : best);
  });
  return out;
}

function notifyUserList(force) {
  if (force) notifyUserListForce = true;
  if (notifyUserListTimer) return;
  notifyUserListTimer = setTimeout(() => {
    notifyUserListTimer = null;
    const forced = notifyUserListForce;
    notifyUserListForce = false;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const combinedList = dedupeUsersByPersonIdentity(
      Array.from(allKnownUsers.values())
        .filter((u) => u && u.ip && !isSyntheticReceiverKey(u.ip))
        .map(userListEntryForRenderer)
    );
    safeWebContentsSend('user-list-update', combinedList);
    if (forced) { /* keep API compatible */ }
  }, USER_LIST_NOTIFY_DEBOUNCE_MS);
}

function notifyUserListNow() {
  if (notifyUserListTimer) {
    clearTimeout(notifyUserListTimer);
    notifyUserListTimer = null;
  }
  notifyUserListForce = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const combinedList = dedupeUsersByPersonIdentity(
    Array.from(allKnownUsers.values())
      .filter((u) => u && u.ip && !isSyntheticReceiverKey(u.ip))
      .map(userListEntryForRenderer)
  );
  safeWebContentsSend('user-list-update', combinedList);
}

function startPresenceSweeper() {
  let ipChangeNoticeSent = false;
  setInterval(() => {
    // 🌐 DHCP 갱신 등으로 이 PC의 IP가 바뀌면, 살아있는 동안엔 예전 IP로 계속 통신하게 되어
    // 다른 PC들이 나를 못 찾게 된다. IP 자체를 실시간으로 바꿔 쓰는 건 워낙 여러 곳(메시지 기록,
    // 상대방이 알고 있는 내 주소 등)에 영향을 줘서 위험하므로, 감지되면 재시작을 안내한다.
    if (!ipChangeNoticeSent) {
      const currentIp = getMyIP();
      if (currentIp && currentIp !== MY_IP) {
        ipChangeNoticeSent = true;
        console.error(`⚠️ IP 주소가 변경된 것으로 보입니다 (${MY_IP} → ${currentIp}). 재시작을 권장합니다.`);
        if (mainWindow) {
          safeWebContentsSend('main-process-log', {
            level: 'error',
            message: `이 PC의 네트워크 주소가 바뀐 것 같습니다(${MY_IP} → ${currentIp}). 다른 PC와의 연결이 원활하지 않다면 프로그램을 재시작해 주세요.`
          });
        }
      }
    }

    const now = Date.now();
    let changed = false;

    onlineUsers.forEach((u, ip) => {
      if (ip === MY_IP) return;
      const beat = Number(u.lastPingAt || u.lastSeen) || 0;
      if (now - beat > PRESENCE_STALE_MS) {
        if (markPeerOffline(ip, beat || now)) {
          changed = true;
          writeToLogFile('info', `[네트워크] ${u.username || ip}(${ip}) 오프라인 처리됨`);
        }
      }
    });

    if (changed) notifyUserList();
  }, 5000);
}

function startTcpServer() {
  if (tcpServerInstance) {
    try { tcpServerInstance.close(); } catch (e) { /* ignore */ }
    tcpServerInstance = null;
  }
  const server = net.createServer((socket) => {
    let buffer = '';

    const drain = () => {
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        parseAndRoute(line, socket);
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_TCP_LINE_BUFFER) {
        console.error('TCP 수신 버퍼 초과 — 연결을 끊습니다.');
        buffer = '';
        socket.destroy();
        return;
      }
      drain();
    });
    socket.on('end', () => {
      drain();
      if (buffer.trim()) { parseAndRoute(buffer, socket); buffer = ''; }
    });
    socket.on('error', () => {});
  });
  tcpServerInstance = server;
  server.on('error', (err) => {
    console.error('TCP 서버 오류:', err);
    tcpStatus = `오류: ${err.code || err.message}`;
    notifyNetworkStatus();
    if (tcpBindRetryTimer) return;
    tcpBindRetryTimer = setTimeout(() => {
      tcpBindRetryTimer = null;
      console.error('TCP 재바인딩 시도…');
      startTcpServer();
    }, 3000);
  });
  server.on('listening', () => {
    tcpStatus = 'running';
    notifyNetworkStatus();
  });
  server.listen(TCP_PORT);
}

function parseAndRoute(line, socket) {
  if (!line || !line.trim()) return;
  try {
    const payload = JSON.parse(line);
    const senderIP = (socket.remoteAddress || '').replace('::ffff:', '');
    if (!senderIP) return;
    routeIncomingPayload(payload, senderIP);
  } catch (e) {
    console.error('TCP 페이로드 파싱 오류:', e.message);
  }
}

function routeIncomingPayload(payload, senderIP) {
  try {
    touchPeerPresence(senderIP);
    const type = payload.type || 'CHAT';
    switch (type) {
    case 'CHAT': handleIncomingChat(payload, senderIP); break;
    case 'BROADCAST': handleIncomingBroadcast(payload, senderIP); break;
    case 'DEPT_MESSAGE': handleIncomingDeptMessage(payload, senderIP); break;
    case 'FLOOR_MESSAGE': handleIncomingFloorMessage(payload, senderIP); break;
    case 'READ_RECEIPT': handleReadReceipt(payload, senderIP); break;
    case 'CHANNEL_READ':
      handleChannelRead(payload, senderIP).catch((e) => {
        console.error('CHANNEL_READ 처리 오류:', e.message || e);
      });
      break;
    case 'NOTICE_ADD': handleNoticeAdd(payload.notice); break;
    case 'NOTICE_UPDATE': handleNoticeUpdate(payload.notice); break;
    case 'NOTICE_DELETE': handleNoticeDelete(payload.uid); break;
    case 'NOTICE_SYNC_REQUEST': handleNoticeSyncRequest(senderIP); break;
    case 'NOTICE_SYNC_RESPONSE': handleNoticeSyncResponse(payload.notices, payload.operators, payload.schedules, payload.updateSourcePath, payload.profileOverrides, payload.chatPins, payload.dutyRoster); break;
    case 'OPERATOR_ADD': handleOperatorAdd(payload.operator); break;
    case 'OPERATOR_DELETE': handleOperatorDelete(payload.username); break;
    case 'SCHEDULE_ADD': handleScheduleAdd(payload.schedule); break;
    case 'SCHEDULE_DELETE': handleScheduleDelete(payload.uid); break;
    case 'SCHEDULE_EDIT': handleScheduleEdit(payload.schedule); break;
    case 'MESSAGE_EDIT': handleIncomingMessageEdit(payload); break;
    case 'MESSAGE_REACTION': handleIncomingMessageReaction(payload, senderIP); break;
    case 'MSG_ACK': handleMsgAck(payload); break;
    case 'GROUP_SYNC': handleGroupSync(payload.group); break;
    case 'GROUP_MESSAGE': handleIncomingGroupMessage(payload, senderIP); break;
    case 'GROUP_RENAME_NOTICE': handleGroupRenameNotice(payload); break;
    case 'GROUP_JOIN_NOTICE': handleGroupRenameNotice(payload); break;
    case 'CONFIG_SYNC': handleConfigSync(payload); break;
    case 'FORCE_UPDATE':
      handleForceUpdateCommand(payload, senderIP).catch((e) => {
        console.error('FORCE_UPDATE 처리 오류:', e.message || e);
      });
      break;
    case 'FORCE_UPDATE_RESULT':
      safeWebContentsSend('force-update-result', {
        success: !!payload.success,
        msg: payload.msg || '',
        fromIp: payload.fromIp || senderIP,
        version: payload.version || ''
      });
      break;
    case 'CHAT_PIN_SYNC': handleChatPinSync(payload); break;
    case 'DUTY_ROSTER_SYNC': handleDutyRosterSync(payload); break;
    case 'OPERATOR_DUTY_PERM': handleOperatorDutyPerm(payload); break;
    case 'PROFILE_PHOTO_SYNC': handleProfilePhotoSync(payload.ip || senderIP, payload.photo); break;
    case 'PROFILE_PHOTO_REQUEST': handleProfilePhotoRequest(senderIP); break;
    case 'PROFILE_OVERRIDE_SYNC': handleProfileOverrideSync(payload); break;
    case 'FILE_XFER_START': handleFileXferStart(payload, senderIP); break;
    case 'FILE_XFER_CHUNK': handleFileXferChunk(payload, senderIP); break;
    case 'FILE_XFER_END':
      handleFileXferEnd(payload, senderIP).catch((e) => {
        console.error('FILE_XFER_END 처리 오류:', e.message || e);
      });
      break;
    case 'FILE_XFER_ABORT': handleFileXferAbort(payload); break;
    default: break;
    }
  } catch (e) {
    console.error('수신 메시지 처리 오류:', e.message || e);
  }
}

// 👤 프로필 사진 전체 동기화: 상대가 사진을 보내오면 저장하고 화면에 반영
function handleProfilePhotoSync(fromIP, photo) {
  const known = allKnownUsers.get(fromIP);
  if (known) known.photo = photo || '';
  const online = onlineUsers.get(fromIP);
  if (online) online.photo = photo || '';
  persistedPhotos[fromIP] = photo || '';
  db.run(`INSERT INTO known_users (ip, photo) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET photo = excluded.photo`, [fromIP, photo || ''], logDbErr);
  notifyUserList();
  safeWebContentsSend('profile-photo-update', { ip: fromIP, photo: photo || '' });
}

// 누군가 내 프로필 사진을 요청하면 보내준다 (새로 발견된 상대에게 서로 요청)
function handleProfilePhotoRequest(fromIP) {
  if (!myProfile.photo) return;
  const client = new net.Socket();
  client.setTimeout(1200);
  client.connect(TCP_PORT, fromIP, () => {
    client.write(JSON.stringify({ type: 'PROFILE_PHOTO_SYNC', ip: MY_IP, photo: myProfile.photo }) + '\n');
    client.end();
  });
  client.on('error', () => {});
  client.on('timeout', () => client.destroy());
}

function handleIncomingChat(payload, senderIP) {
  if (senderIP === MY_IP) return;

  const uid = payload.uid || null;

  const ackIfUid = () => {
    if (uid) sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid: uid });
  };

  // DB INSERT 성공 후에만 UID 기억 + ACK (조기 remember로 유실되면 재전송도 막힘)
  const persist = ({ showUi }) => {
    if (showUi) {
      const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const uiPayload = {
        senderName: formatSenderDisplay(payload.sender, senderIP),
        senderIP: senderIP,
        message: payload.message,
        urgent: !!payload.urgent,
        createdAt: currentTime,
        uid
      };
      if (mainWindow) {
        safeWebContentsSend('receive-message', uiPayload);
        notifyIncomingMessageNotification({
          title: payload.urgent ? `🚨 [긴급] ${payload.sender}님의 메시지` : `💬 ${payload.sender}님의 메시지`,
          body: previewBody(payload.message),
          urgent: !!payload.urgent,
          channelKey: senderIP
        });
      }
      appendChatLog(`DM_${senderIP}`, payload.sender, payload.sender, payload.message);
    }

    const storedMessage = compactStoredMessageHtml(payload.message);
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [formatSenderDisplay(payload.sender, senderIP), senderIP, MY_IP, storedMessage, uid],
      (err) => {
        logDbErr(err);
        if (err) return;
        if (uid) markIncomingChatUid(uid);
        ackIfUid();
      }
    );
  };

  if (uid && hasRememberedIncomingChatUid(uid)) {
    db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
      if (err) {
        logDbErr(err);
        persist({ showUi: false });
        return;
      }
      if (row) {
        ackIfUid();
        return;
      }
      // 메모리는 있으나 DB 행 없음 → 재저장 후 ACK
      persist({ showUi: false });
    });
    return;
  }

  if (uid) {
    db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
      if (err) {
        logDbErr(err);
        persist({ showUi: true });
        return;
      }
      if (row) {
        markIncomingChatUid(uid);
        ackIfUid();
        return;
      }
      persist({ showUi: true });
    });
    return;
  }

  persist({ showUi: true });
}

function handleIncomingDeptMessage(payload, senderIP) {
  if (payload.dept && myProfile.dept && payload.dept !== myProfile.dept) return;

  const receiverKey = `DEPT:${payload.dept}`;
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const senderName = formatSenderDisplay(payload.sender, senderIP);
  const msgUid = payload.msgUid || null;

  shouldSkipDuplicateChannelMessage(msgUid, () => {
    const storedMessage = compactStoredMessageHtml(payload.message);
    if (mainWindow) {
      safeWebContentsSend('receive-dept-message', {
        dept: payload.dept,
        senderName,
        senderIP: senderIP,
        message: payload.message,
        createdAt: currentTime,
        msgUid,
        messageId: null
      });
    }
    notifyIncomingMessageNotification({
      title: `👥 [${payload.dept}] ${senderName}님의 메시지`,
      body: previewBody(payload.message),
      channelKey: receiverKey
    });

    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [senderName, senderIP, receiverKey, storedMessage, msgUid],
      (err) => {
        logDbErr(err);
        if (!err && msgUid) markIncomingChatUid(msgUid);
      }
    );
    appendChatLog(receiverKey, `부서_${payload.dept}`, payload.sender, payload.message);
  });
}

function handleIncomingFloorMessage(payload, senderIP) {
  if (payload.floor && myProfile.floor && payload.floor !== myProfile.floor) return;

  const receiverKey = `FLOOR:${payload.floor}`;
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const senderName = formatSenderDisplay(payload.sender, senderIP);
  const msgUid = payload.msgUid || null;

  shouldSkipDuplicateChannelMessage(msgUid, () => {
    const storedMessage = compactStoredMessageHtml(payload.message);
    if (mainWindow) {
      safeWebContentsSend('receive-floor-message', {
        floor: payload.floor,
        senderName,
        senderIP: senderIP,
        message: payload.message,
        createdAt: currentTime,
        msgUid,
        messageId: null
      });
    }
    notifyIncomingMessageNotification({
      title: `🏢 [${payload.floor}] ${senderName}님의 메시지`,
      body: previewBody(payload.message),
      channelKey: receiverKey
    });

    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [senderName, senderIP, receiverKey, storedMessage, msgUid],
      (err) => {
        logDbErr(err);
        if (!err && msgUid) markIncomingChatUid(msgUid);
      }
    );
    appendChatLog(receiverKey, `${payload.floor}`, payload.sender, payload.message);
  });
}

/** 1:1 읽음 데스크탑 알림은 상대당 앱 실행 중 딱 1회만 */
const dmAwaitingReadReceiptNotify = new Map();
const dmReadReceiptDesktopShown = new Set();
/** 세션 내 동일 수신 msg_uid — DB INSERT 성공 후에만 기록 */
const recentIncomingChatUids = new Map();
const RECENT_CHAT_UID_TTL_MS = 15 * 60 * 1000;

function pruneRecentIncomingChatUids(now = Date.now()) {
  if (recentIncomingChatUids.size <= 800) return;
  recentIncomingChatUids.forEach((t, k) => {
    if (now - t > RECENT_CHAT_UID_TTL_MS) recentIncomingChatUids.delete(k);
  });
}

function hasRememberedIncomingChatUid(uid) {
  const key = String(uid || '').trim();
  if (!key) return false;
  pruneRecentIncomingChatUids();
  return recentIncomingChatUids.has(key);
}

function markIncomingChatUid(uid) {
  const key = String(uid || '').trim();
  if (!key) return;
  pruneRecentIncomingChatUids();
  recentIncomingChatUids.set(key, Date.now());
}

function shouldSkipDuplicateChannelMessage(msgUid, onUnique) {
  const uid = msgUid ? String(msgUid).trim() : '';
  if (!uid) {
    onUnique();
    return;
  }
  // 메모리 hit이어도 DB에 없으면 재저장 (조기 remember로 유실된 경우 복구)
  db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
    if (err) {
      logDbErr(err);
      onUnique();
      return;
    }
    if (row) {
      markIncomingChatUid(uid);
      return;
    }
    onUnique();
  });
}

function armDmReadReceiptNotify(targetIP) {
  const ip = String(targetIP || '').trim();
  if (!ip) return;
  if (dmReadReceiptDesktopShown.has(ip)) return;
  dmAwaitingReadReceiptNotify.set(ip, true);
}

function handleReadReceipt(payload, senderIP) {
  const readerLabel = formatSenderDisplay(payload.readerName, senderIP);
  const wasAwaiting = dmAwaitingReadReceiptNotify.get(senderIP) === true;
  if (wasAwaiting) dmAwaitingReadReceiptNotify.set(senderIP, false);

  let notifyRead = wasAwaiting && notifyReadReceipts && !dmReadReceiptDesktopShown.has(senderIP);
  if (notifyRead) dmReadReceiptDesktopShown.add(senderIP);

  if (mainWindow) {
    safeWebContentsSend('read-receipt', {
      readerIP: senderIP,
      readerName: readerLabel,
      readAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      showAlert: notifyRead
    });
  }
  if (notifyRead) {
    showDesktopNotification({
      title: '✓ 메시지를 읽었습니다',
      body: `${readerLabel}님이 메시지를 확인했습니다.`,
      silent: false
    });
  }
}

function getAudienceIpsForChannel(channelKey) {
  return new Promise((resolve) => {
    if (!channelKey || typeof channelKey !== 'string') {
      resolve([]);
      return;
    }
    if (channelKey === 'BROADCAST') {
      const ips = [];
      allKnownUsers.forEach((u, ip) => {
        if (ip !== MY_IP && !isSyntheticReceiverKey(ip) && looksLikeIpv4(ip)) ips.push(ip);
      });
      resolve(ips);
      return;
    }
    if (channelKey.startsWith('DEPT:')) {
      const dept = channelKey.slice(5);
      const ips = [];
      allKnownUsers.forEach((u, ip) => {
        if (ip !== MY_IP && !isSyntheticReceiverKey(ip) && looksLikeIpv4(ip) && u.dept === dept) ips.push(ip);
      });
      resolve(ips);
      return;
    }
    if (channelKey.startsWith('FLOOR:')) {
      const floor = channelKey.slice(6);
      const ips = [];
      allKnownUsers.forEach((u, ip) => {
        if (ip !== MY_IP && !isSyntheticReceiverKey(ip) && looksLikeIpv4(ip) && u.floor === floor) ips.push(ip);
      });
      resolve(ips);
      return;
    }
    if (channelKey.startsWith('GROUP:')) {
      const uid = channelKey.slice(6);
      db.get(`SELECT members FROM group_chats WHERE uid = ?`, [uid], (err, row) => {
        if (err || !row) { resolve([]); return; }
        let members = [];
        try { members = JSON.parse(row.members); } catch (e) {}
        resolve(members.map(m => m.ip).filter(ip => ip && ip !== MY_IP));
      });
      return;
    }
    resolve([]);
  });
}

function compareChannelMsgUids(channelKey, uidA, uidB) {
  return new Promise((resolve) => {
    if (!uidA && !uidB) { resolve(0); return; }
    if (!uidA) { resolve(-1); return; }
    if (!uidB) { resolve(1); return; }
    if (uidA === uidB) { resolve(0); return; }
    db.all(
      `SELECT msg_uid, id FROM messages WHERE receiver_ip = ? AND msg_uid IN (?, ?)`,
      [channelKey, uidA, uidB],
      (err, rows) => {
        if (err || !rows || rows.length < 2) {
          resolve(uidA > uidB ? 1 : -1);
          return;
        }
        const idMap = {};
        rows.forEach((r) => { idMap[r.msg_uid] = r.id; });
        const idA = idMap[uidA] || 0;
        const idB = idMap[uidB] || 0;
        resolve(idA === idB ? 0 : (idA > idB ? 1 : -1));
      }
    );
  });
}

function upsertChannelReadCursorMaxUid(channelKey, readerIp, lastReadMsgUid) {
  const uid = String(lastReadMsgUid || '').trim();
  if (!channelKey || !readerIp || !uid) return Promise.resolve(false);
  return new Promise((resolve) => {
    db.get(
      `SELECT last_read_msg_uid FROM channel_read_cursors WHERE channel_key = ? AND reader_ip = ?`,
      [channelKey, readerIp],
      async (err, row) => {
        const prev = row ? (row.last_read_msg_uid || '') : '';
        if (prev === uid) { resolve(true); return; }
        if (prev) {
          const cmp = await compareChannelMsgUids(channelKey, uid, prev);
          if (cmp <= 0) { resolve(true); return; }
        }
        db.run(
          `INSERT OR REPLACE INTO channel_read_cursors (channel_key, reader_ip, last_read_msg_uid, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
          [channelKey, readerIp, uid],
          (err2) => { logDbErr(err2); resolve(!err2); }
        );
      }
    );
  });
}

function relayChannelRead(channelKey, lastReadMsgUid) {
  const payload = {
    type: 'CHANNEL_READ',
    channelKey,
    lastReadMsgUid,
    readerName: myProfile.username
  };
  if (channelKey === 'BROADCAST') {
    broadcastToOnlinePeers(payload);
    return;
  }
  if (typeof channelKey === 'string' && channelKey.startsWith('DEPT:')) {
    const dept = channelKey.slice(5);
    const ips = [];
    onlineUsers.forEach((u, ip) => { if (ip !== MY_IP && u.dept === dept) ips.push(ip); });
    sendToIps(ips, payload);
    return;
  }
  if (typeof channelKey === 'string' && channelKey.startsWith('FLOOR:')) {
    const floor = channelKey.slice(6);
    const ips = [];
    onlineUsers.forEach((u, ip) => { if (ip !== MY_IP && u.floor === floor) ips.push(ip); });
    sendToIps(ips, payload);
    return;
  }
  if (typeof channelKey === 'string' && channelKey.startsWith('GROUP:')) {
    const uid = channelKey.slice(6);
    db.get(`SELECT members FROM group_chats WHERE uid = ?`, [uid], (err, row) => {
      if (err || !row) return;
      let members = [];
      try { members = JSON.parse(row.members); } catch (e) {}
      sendToIps(members.map(m => m.ip).filter(ip => ip && ip !== MY_IP), payload);
    });
  }
}

async function handleChannelRead(payload, senderIP) {
  const channelKey = payload.channelKey;
  const lastReadMsgUid = payload.lastReadMsgUid || payload.lastReadMessageId;
  if (!channelKey || !lastReadMsgUid || !senderIP) return;
  await upsertChannelReadCursorMaxUid(channelKey, senderIP, lastReadMsgUid);
  if (mainWindow) {
    safeWebContentsSend('channel-read-update', {
      channelKey,
      readerIP: senderIP,
      lastReadMsgUid
    });
  }
}

function handleIncomingBroadcast(payload, senderIP) {
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const senderName = formatSenderDisplay(payload.sender, senderIP);
  const msgUid = payload.msgUid || null;

  shouldSkipDuplicateChannelMessage(msgUid, () => {
    const storedMessage = compactStoredMessageHtml(payload.message);
    if (mainWindow) {
      safeWebContentsSend('receive-broadcast', {
        senderName,
        senderIP: senderIP,
        message: payload.message,
        createdAt: currentTime,
        msgUid,
        messageId: null
      });
    }
    notifyIncomingMessageNotification({
      title: `📢 전체공지 - ${senderName}`,
      body: previewBody(payload.message),
      channelKey: 'BROADCAST'
    });

    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, 'BROADCAST', ?, 'SENT', ?)`,
      [senderName, senderIP, storedMessage, msgUid],
      (err) => {
        logDbErr(err);
        if (!err && msgUid) markIncomingChatUid(msgUid);
      }
    );
    appendChatLog('BROADCAST', '전체공지', payload.sender, payload.message);
  });
}

function handleNoticeAdd(n) {
  if (!n || !n.uid) return;
  db.get(`SELECT uid FROM notices WHERE uid = ?`, [n.uid], (err, row) => {
    if (row) return;
    db.run(
      `INSERT OR REPLACE INTO notices (uid, title, content, author_name, author_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [n.uid, n.title, n.content, n.author_name, n.author_ip, n.created_at],
      () => { if (mainWindow) safeWebContentsSend('notices-update'); }
    );
  });
}

function handleNoticeUpdate(n) {
  if (!n || !n.uid) return;
  db.run(`UPDATE notices SET title = ?, content = ? WHERE uid = ?`, [n.title, n.content, n.uid], () => {
    if (mainWindow) safeWebContentsSend('notices-update');
  });
}

function handleNoticeDelete(uid) {
  if (!uid) return;
  db.run(`DELETE FROM notices WHERE uid = ?`, [uid], () => {
    if (mainWindow) safeWebContentsSend('notices-update');
  });
}

function tcpWriteJsonLines(targetIP, payloads) {
  const lines = (payloads || []).map((p) => JSON.stringify(p) + '\n').filter((l) => l.length > 1);
  if (!lines.length || !targetIP) return;
  const client = new net.Socket();
  client.setTimeout(4000);
  client.connect(TCP_PORT, targetIP, () => {
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_TCP_LINE_BUFFER - 2048) {
        console.error('NOTICE_SYNC 청크가 여전히 너무 큼 — 건너뜀');
        continue;
      }
      client.write(line);
    }
    client.end();
  });
  client.on('error', () => {});
  client.on('timeout', () => client.destroy());
}

function buildNoticeSyncPayloadChunks(notices, operators, schedules, profileOverridesRows) {
  const chunks = [];
  const baseMeta = {
    type: 'NOTICE_SYNC_RESPONSE',
    notices: [],
    operators: [],
    schedules: [],
    profileOverrides: [],
    updateSourcePath: updateSourcePath || ''
  };

  const tryPush = (obj) => {
    const size = Buffer.byteLength(JSON.stringify(obj) + '\n', 'utf8');
    if (size <= NOTICE_SYNC_SAFE_LINE_BYTES) {
      chunks.push(obj);
      return true;
    }
    return false;
  };

  // 1) 공지+작성자+overrides (보통 작음)
  const head = {
    ...baseMeta,
    notices: notices || [],
    operators: operators || [],
    profileOverrides: profileOverridesRows || []
  };
  if (!tryPush(head)) {
    // 극단적으로 크면 필드별로
    if ((notices || []).length) tryPush({ ...baseMeta, notices });
    if ((operators || []).length) tryPush({ ...baseMeta, operators });
    if ((profileOverridesRows || []).length) tryPush({ ...baseMeta, profileOverrides: profileOverridesRows });
  }

  // 2) 일정은 청크로
  const list = schedules || [];
  if (!list.length) return chunks.length ? chunks : [{ ...baseMeta }];

  let batch = [];
  const flushBatch = () => {
    if (!batch.length) return;
    const obj = { ...baseMeta, schedules: batch };
    if (tryPush(obj)) {
      batch = [];
      return;
    }
    // 단건도 크면 스킵(손상된 거대 행 방지)
    if (batch.length === 1) {
      console.error('일정 단건이 TCP 한도를 초과해 동기화에서 제외:', batch[0] && batch[0].uid);
      batch = [];
      return;
    }
    const half = batch.slice(0, Math.ceil(batch.length / 2));
    const rest = batch.slice(Math.ceil(batch.length / 2));
    batch = half;
    flushBatch();
    batch = rest;
    flushBatch();
  };

  list.forEach((s) => {
    batch.push(s);
    const probe = { ...baseMeta, schedules: batch };
    if (Buffer.byteLength(JSON.stringify(probe) + '\n', 'utf8') > NOTICE_SYNC_SAFE_LINE_BYTES) {
      batch.pop();
      flushBatch();
      batch.push(s);
    }
  });
  flushBatch();
  return chunks.length ? chunks : [{ ...baseMeta, schedules: list.slice(0, 1) }];
}

function handleNoticeSyncRequest(senderIP) {
  db.all(`SELECT * FROM notices`, [], (err, notices) => {
    if (err) return;
    db.all(`SELECT * FROM notice_operators`, [], (err2, operators) => {
      db.all(`SELECT * FROM hospital_schedules`, [], (err3, schedules) => {
        db.all(`SELECT * FROM user_profile_overrides`, [], (err4, profileOverridesRows) => {
          db.all(`SELECT * FROM chat_pins`, [], (err5, chatPins) => {
            db.all(`SELECT * FROM duty_roster`, [], (err6, dutyRoster) => {
              const chunks = buildNoticeSyncPayloadChunks(
                notices || [],
                operators || [],
                schedules || [],
                profileOverridesRows || []
              );
              if (chunks.length) {
                chunks[0].chatPins = chatPins || [];
                chunks[0].dutyRoster = dutyRoster || [];
              }
              tcpWriteJsonLines(senderIP, chunks);
            });
          });
        });
      });
    });
  });
}

function handleNoticeSyncResponse(notices, operators, schedules, remoteUpdateSourcePath, remoteProfileOverrides, chatPins, dutyRoster) {
  if (Array.isArray(notices)) {
    notices.forEach(n => {
      if (!n || !n.uid) return;
      db.run(
        `INSERT OR REPLACE INTO notices (uid, title, content, author_name, author_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [n.uid, n.title, n.content, n.author_name, n.author_ip, n.created_at],
        logDbErr
      );
    });
    if (mainWindow) safeWebContentsSend('notices-update');
  }
  if (Array.isArray(operators)) {
    operators.forEach(o => {
      db.run(`INSERT OR REPLACE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty) VALUES (?, ?, ?, ?, ?)`,
        [o.username, o.password_hash, o.display_name, o.added_at, o.can_manage_duty ? 1 : 0], logDbErr);
    });
    if (mainWindow) safeWebContentsSend('notice-operators-update');
  }
  if (Array.isArray(schedules)) {
    schedules.forEach(s => {
      const meta = schedulePatientMetaFromPayload(s);
      const und = scheduleTimeUndecidedFromPayload(s);
      const meal = scheduleMealCancelFromPayload(s);
      const remark = scheduleRemarkFromPayload(s);
      const guardianOnly = scheduleGuardianOnlyFromPayload(s);
      db.run(
        `INSERT OR IGNORE INTO hospital_schedules (uid, type, title, time_str, author_name, author_ip, created_at, remind_before, attending_physician, time_end_str, ward, rm_team, room_no, patient_name, time_start_undecided, time_end_undecided, meal_cancel_breakfast, meal_cancel_lunch, meal_cancel_dinner, remark, guardian_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.uid, s.type, s.title, s.time_str, s.author_name, s.author_ip, s.created_at, s.remind_before || 0, s.attending_physician || '', s.time_end_str || '', meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly],
        logDbErr
      );
    });
    if (mainWindow) notifySchedulesChanged();
  }
  if (Array.isArray(remoteProfileOverrides)) {
    remoteProfileOverrides.forEach((row) => {
      const ov = profileOverrideFromRow(row);
      if (!ov) return;
      storeProfileOverride(ov);
      refreshUserAfterProfileOverride(ov.ip);
    });
  }
  if (Array.isArray(chatPins)) {
    chatPins.forEach((p) => upsertChatPinRow(p, false));
    if (mainWindow) safeWebContentsSend('chat-pins-update');
  }
  if (Array.isArray(dutyRoster)) {
    dutyRoster.forEach((row) => upsertDutyRosterRow(row, false));
    if (mainWindow) safeWebContentsSend('duty-roster-update');
  }
  if (remoteUpdateSourcePath && !updateSourcePath) {
    persistUpdateSourcePath(remoteUpdateSourcePath);
  }
}

function handleConfigSync(payload) {
  if (payload && typeof payload.updateSourcePath === 'string') {
    persistUpdateSourcePath(payload.updateSourcePath);
  }
}

function handleOperatorAdd(o) {
  if (!o || !o.username) return;
  db.run(`INSERT OR REPLACE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty) VALUES (?, ?, ?, ?, ?)`,
    [o.username, o.password_hash, o.display_name, o.added_at, o.can_manage_duty ? 1 : 0], () => {
      if (mainWindow) safeWebContentsSend('notice-operators-update');
    });
}

function handleOperatorDutyPerm(payload) {
  if (!payload || !payload.username) return;
  const flag = payload.canManageDuty ? 1 : 0;
  db.run(`UPDATE notice_operators SET can_manage_duty = ? WHERE username = ?`, [flag, payload.username], () => {
    if (mainWindow) safeWebContentsSend('notice-operators-update');
  });
}

function upsertChatPinRow(pin, broadcast) {
  if (!pin || !pin.channel_key) return;
  if (pin._clear) {
    db.run(`DELETE FROM chat_pins WHERE channel_key = ?`, [pin.channel_key], () => {
      if (mainWindow) safeWebContentsSend('chat-pins-update');
    });
    if (broadcast) broadcastToOnlinePeers({ type: 'CHAT_PIN_SYNC', pin: { channel_key: pin.channel_key, _clear: true } });
    return;
  }
  db.run(
    `INSERT OR REPLACE INTO chat_pins (channel_key, msg_uid, message_html, preview_text, sender_name, pinned_at, pinned_by_name, pinned_by_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pin.channel_key,
      pin.msg_uid || '',
      pin.message_html || '',
      pin.preview_text || '',
      pin.sender_name || '',
      pin.pinned_at || new Date().toISOString(),
      pin.pinned_by_name || '',
      pin.pinned_by_ip || ''
    ],
    () => {
      if (mainWindow) safeWebContentsSend('chat-pins-update');
    }
  );
  if (broadcast) broadcastToOnlinePeers({ type: 'CHAT_PIN_SYNC', pin });
}

function handleChatPinSync(payload) {
  if (!payload || !payload.pin) return;
  upsertChatPinRow(payload.pin, false);
}

function upsertDutyRosterRow(row, broadcast) {
  if (!row || !row.date_str || !row.kind || !row.name) return;
  if (row._clear) {
    db.run(`DELETE FROM duty_roster WHERE date_str = ? AND kind = ? AND name = ?`, [row.date_str, row.kind, row.name], () => {
      if (mainWindow) safeWebContentsSend('duty-roster-update');
    });
    if (broadcast) broadcastToOnlinePeers({ type: 'DUTY_ROSTER_SYNC', row: { ...row, _clear: true } });
    return;
  }
  db.run(
    `INSERT OR REPLACE INTO duty_roster (date_str, kind, name, note, updated_at, updated_by_name, updated_by_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.date_str,
      row.kind,
      row.name,
      row.note || '',
      row.updated_at || new Date().toISOString(),
      row.updated_by_name || '',
      row.updated_by_ip || ''
    ],
    () => {
      if (mainWindow) safeWebContentsSend('duty-roster-update');
    }
  );
  if (broadcast) broadcastToOnlinePeers({ type: 'DUTY_ROSTER_SYNC', row });
}

function replaceDutyRosterForDate(dateStr, dutyNames, offNames, meta) {
  return new Promise((resolve) => {
    const date = String(dateStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      resolve({ success: false, msg: '날짜 형식이 올바르지 않습니다.' });
      return;
    }
    const cleanedDuty = [...new Set((dutyNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
    const cleanedOff = [...new Set((offNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
    const updatedAt = new Date().toISOString();
    const byName = (meta && meta.byName) || '';
    const byIp = (meta && meta.byIp) || MY_IP;

    db.run(`DELETE FROM duty_roster WHERE date_str = ?`, [date], (err) => {
      if (err) {
        resolve({ success: false, msg: err.message });
        return;
      }
      broadcastToOnlinePeers({ type: 'DUTY_ROSTER_SYNC', replaceDate: date, dutyNames: cleanedDuty, offNames: cleanedOff, updated_at: updatedAt, updated_by_name: byName, updated_by_ip: byIp });

      const rows = [
        ...cleanedDuty.map((name) => ({ date_str: date, kind: 'duty', name, note: '', updated_at: updatedAt, updated_by_name: byName, updated_by_ip: byIp })),
        ...cleanedOff.map((name) => ({ date_str: date, kind: 'off', name, note: '', updated_at: updatedAt, updated_by_name: byName, updated_by_ip: byIp }))
      ];
      let left = rows.length;
      if (!left) {
        if (mainWindow) safeWebContentsSend('duty-roster-update');
        resolve({ success: true });
        return;
      }
      rows.forEach((row) => {
        db.run(
          `INSERT OR REPLACE INTO duty_roster (date_str, kind, name, note, updated_at, updated_by_name, updated_by_ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [row.date_str, row.kind, row.name, row.note, row.updated_at, row.updated_by_name, row.updated_by_ip],
          () => {
            left -= 1;
            if (left <= 0) {
              if (mainWindow) safeWebContentsSend('duty-roster-update');
              resolve({ success: true });
            }
          }
        );
      });
    });
  });
}

function handleDutyRosterSync(payload) {
  if (!payload) return;
  if (payload.replaceDate) {
    const date = String(payload.replaceDate);
    db.run(`DELETE FROM duty_roster WHERE date_str = ?`, [date], () => {
      const dutyNames = payload.dutyNames || [];
      const offNames = payload.offNames || [];
      const updatedAt = payload.updated_at || new Date().toISOString();
      const byName = payload.updated_by_name || '';
      const byIp = payload.updated_by_ip || '';
      const rows = [
        ...dutyNames.map((name) => [date, 'duty', String(name), '', updatedAt, byName, byIp]),
        ...offNames.map((name) => [date, 'off', String(name), '', updatedAt, byName, byIp])
      ];
      let left = rows.length;
      const done = () => {
        if (mainWindow) safeWebContentsSend('duty-roster-update');
      };
      if (!left) { done(); return; }
      rows.forEach((params) => {
        db.run(
          `INSERT OR REPLACE INTO duty_roster (date_str, kind, name, note, updated_at, updated_by_name, updated_by_ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params,
          () => { left -= 1; if (left <= 0) done(); }
        );
      });
    });
    return;
  }
  if (payload.row) upsertDutyRosterRow(payload.row, false);
}

function handleOperatorDelete(username) {
  if (!username) return;
  db.run(`DELETE FROM notice_operators WHERE username = ?`, [username], () => {
    if (mainWindow) safeWebContentsSend('notice-operators-update');
  });
}

function schedulePatientMetaFromPayload(p) {
  const o = p || {};
  return {
    ward: String(o.ward || '').trim(),
    rm_team: String(o.rmTeam || o.rm_team || '').trim(),
    room_no: String(o.roomNo || o.room_no || '').trim(),
    patient_name: String(o.patientName || o.patient_name || '').trim()
  };
}

function scheduleTimeUndecidedFromPayload(p) {
  const o = p || {};
  return {
    time_start_undecided: (o.timeStartUndecided || o.time_start_undecided) ? 1 : 0,
    time_end_undecided: (o.timeEndUndecided || o.time_end_undecided) ? 1 : 0
  };
}

function scheduleMealCancelFromPayload(p) {
  const o = p || {};
  return {
    meal_cancel_breakfast: (o.mealCancelBreakfast || o.meal_cancel_breakfast) ? 1 : 0,
    meal_cancel_lunch: (o.mealCancelLunch || o.meal_cancel_lunch) ? 1 : 0,
    meal_cancel_dinner: (o.mealCancelDinner || o.meal_cancel_dinner) ? 1 : 0
  };
}

function scheduleGuardianOnlyFromPayload(p) {
  const o = p || {};
  const type = String(o.type || '').trim().toUpperCase();
  if (type !== 'OUTPATIENT') return 0;
  return (o.guardianOnly || o.guardian_only) ? 1 : 0;
}

function scheduleRemarkFromPayload(p) {
  const o = p || {};
  return String(o.remark || o.memo || '').trim();
}

function handleScheduleAdd(s) {
  if (!s || !s.uid) return;
  const meta = schedulePatientMetaFromPayload(s);
  const und = scheduleTimeUndecidedFromPayload(s);
  const meal = scheduleMealCancelFromPayload(s);
  const remark = scheduleRemarkFromPayload(s);
  const guardianOnly = scheduleGuardianOnlyFromPayload(s);
  db.run(
    `INSERT OR IGNORE INTO hospital_schedules (uid, type, title, time_str, author_name, author_ip, created_at, remind_before, attending_physician, time_end_str, ward, rm_team, room_no, patient_name, time_start_undecided, time_end_undecided, meal_cancel_breakfast, meal_cancel_lunch, meal_cancel_dinner, remark, guardian_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.uid, s.type, s.title, s.time_str, s.author_name, s.author_ip, s.created_at, s.remind_before || 0, s.attending_physician || '', s.time_end_str || '', meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly],
    () => { notifySchedulesChanged(); }
  );
}

function handleScheduleDelete(uid) {
  if (!uid) return;
  db.run(`DELETE FROM hospital_schedules WHERE uid = ?`, [uid], () => {
    notifySchedulesChanged();
  });
}

function handleScheduleEdit(s) {
  if (!s || !s.uid) return;
  const meta = schedulePatientMetaFromPayload(s);
  const und = scheduleTimeUndecidedFromPayload(s);
  const meal = scheduleMealCancelFromPayload(s);
  const remark = scheduleRemarkFromPayload(s);
  const guardianOnly = scheduleGuardianOnlyFromPayload(s);
  const modAt = s.modified_at || '';
  const modName = s.modified_by_name || '';
  const modIp = s.modified_by_ip || '';
  db.run(
    `UPDATE hospital_schedules SET type = ?, title = ?, time_str = ?, remind_before = ?, attending_physician = ?, time_end_str = ?, ward = ?, rm_team = ?, room_no = ?, patient_name = ?, time_start_undecided = ?, time_end_undecided = ?, meal_cancel_breakfast = ?, meal_cancel_lunch = ?, meal_cancel_dinner = ?, remark = ?, guardian_only = ?, modified_at = ?, modified_by_name = ?, modified_by_ip = ? WHERE uid = ?`,
    [s.type, s.title, s.time_str, s.remind_before || 0, s.attending_physician || '', s.time_end_str || '', meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly, modAt, modName, modIp, s.uid],
    () => { notifySchedulesChanged(); }
  );
}

function handleGroupSync(g) {
  if (!g || !g.uid) return;
  let members = [];
  try { members = JSON.parse(g.members); } catch (e) {}
  const stillMember = members.some(m => m.ip === MY_IP);
  if (!stillMember) {
    db.run(`DELETE FROM group_chats WHERE uid = ?`, [g.uid], (err) => {
      if (!err && mainWindow) safeWebContentsSend('group-chats-update');
    });
    return;
  }
  db.run(
    `INSERT OR REPLACE INTO group_chats (uid, name, members, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
    [g.uid, g.name, enrichGroupMembersJson(g.members), g.created_by, g.created_at],
    (err) => {
      logDbErr(err);
      if (!err && mainWindow) safeWebContentsSend('group-chats-update');
    }
  );
}

function handleIncomingGroupMessage(payload, senderIP) {
  const receiverKey = `GROUP:${payload.uid}`;
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const senderName = formatSenderDisplay(payload.sender, senderIP);
  const msgUid = payload.msgUid || null;

  shouldSkipDuplicateChannelMessage(msgUid, () => {
    const storedMessage = compactStoredMessageHtml(payload.message);
    if (mainWindow) {
      safeWebContentsSend('receive-group-message', {
        uid: payload.uid,
        senderName,
        senderIP: senderIP,
        message: payload.message,
        createdAt: currentTime,
        msgUid,
        messageId: null
      });
      notifyIncomingMessageNotification({
        title: `👥 [${payload.groupName || '그룹'}] ${senderName}님의 메시지`,
        body: previewBody(payload.message),
        channelKey: receiverKey
      });
    }

    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [senderName, senderIP, receiverKey, storedMessage, msgUid],
      (err) => {
        logDbErr(err);
        if (!err && msgUid) markIncomingChatUid(msgUid);
      }
    );
    appendChatLog(receiverKey, payload.groupName || '그룹', payload.sender, payload.message);
  });
}

function handleGroupRenameNotice(payload) {
  const receiverKey = `GROUP:${payload.uid}`;
  const noticeText = payload.noticeText || `대화방 이름이 '${payload.newName}'(으)로 변경되었습니다.`;
  db.run(
    `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status) VALUES (?, ?, ?, ?, 'SENT')`,
    ['시스템', MY_IP, receiverKey, noticeText],
    logDbErr
  );
  appendChatLog(receiverKey, payload.newName || '그룹', '시스템', noticeText);
  if (mainWindow) {
    const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    safeWebContentsSend('receive-group-message', {
      uid: payload.uid,
      senderName: '시스템',
      senderIP: MY_IP,
      message: noticeText,
      createdAt: currentTime
    });
  }
}

function requestNoticeSync(targetIP) {
  const client = new net.Socket();
  client.setTimeout(1200);
  client.connect(TCP_PORT, targetIP, () => {
    client.write(JSON.stringify({ type: 'NOTICE_SYNC_REQUEST' }) + '\n');
    client.end();
  });
  client.on('error', () => {});
  client.on('timeout', () => client.destroy());
}

function broadcastToOnlinePeers(payloadObj) {
  const wireData = JSON.stringify(payloadObj) + '\n';
  onlineUsers.forEach((u, ip) => {
    if (ip === MY_IP) return;
    const client = new net.Socket();
    client.setTimeout(1200);
    client.connect(TCP_PORT, ip, () => {
      client.write(wireData);
      client.end();
    });
    client.on('error', () => {});
    client.on('timeout', () => client.destroy());
  });
}

function sendToIps(ipList, payloadObj) {
  const wireData = JSON.stringify(payloadObj) + '\n';
  (ipList || []).forEach(ip => {
    if (!ip || ip === MY_IP) return;
    if (!onlineUsers.has(ip)) return;
    const client = new net.Socket();
    client.setTimeout(1200);
    client.connect(TCP_PORT, ip, () => {
      client.write(wireData);
      client.end();
    });
    client.on('error', () => {});
    client.on('timeout', () => client.destroy());
  });
}

// sendToIps는 onlineUsers에 등록된 상대에게만 보내는데, 방금 TCP 연결을 받은 상대는 그 자체로
// "지금 연결 가능하다"는 확실한 증거이므로 onlineUsers 등록 여부와 무관하게 바로 응답을 보낸다.
// (그렇지 않으면, UDP 프레즌스가 아직 서로를 인식하기 전 타이밍에 메시지를 주고받을 경우
//  ACK 같은 응답이 조용히 유실될 수 있다.)
function sendToIpDirect(ip, payloadObj) {
  if (!ip || ip === MY_IP) return;
  const wireData = JSON.stringify(payloadObj) + '\n';
  const client = new net.Socket();
  client.setTimeout(1200);
  client.connect(TCP_PORT, ip, () => {
    client.write(wireData);
    client.end();
  });
  client.on('error', () => {});
  client.on('timeout', () => client.destroy());
}

function syncGroupsWithPeer(peerIP) {
  db.all(`SELECT * FROM group_chats`, [], (err, rows) => {
    if (err || !rows) return;
    rows.forEach(g => {
      let members = [];
      try { members = JSON.parse(g.members); } catch (e) { return; }
      if (members.some(m => m.ip === peerIP)) {
        sendToIps([peerIP], { type: 'GROUP_SYNC', group: g });
      }
    });
  });
}

ipcMain.handle('send-file-transfer', async (event, opts) => {
  try {
    const o = opts || {};
    const fileName = String(o.fileName || 'file').trim() || 'file';
    const mime = String(o.mime || 'application/octet-stream');
    const chatTarget = o.chatTarget || null;
    const sizeHint = Number(o.size) || 0;

    if (!chatTarget || (chatTarget.kind !== 'dm' && chatTarget.kind !== 'group')) {
      return { status: 'ERROR', error: '큰 파일은 1:1 또는 그룹에서 보내 주세요.' };
    }

    let buf;
    try {
      if (Buffer.isBuffer(o.data)) buf = o.data;
      else if (o.data instanceof Uint8Array) buf = Buffer.from(o.data.buffer, o.data.byteOffset, o.data.byteLength);
      else if (o.data && (o.data instanceof ArrayBuffer || ArrayBuffer.isView(o.data))) {
        buf = Buffer.from(o.data);
      } else {
        return { status: 'ERROR', error: '파일 데이터가 없습니다.' };
      }
    } catch (e) {
      return { status: 'ERROR', error: '파일을 읽지 못했습니다.' };
    }

    if (!buf.length) return { status: 'ERROR', error: '빈 파일은 보낼 수 없습니다.' };
    if (buf.length > MAX_FILE_XFER_BYTES || sizeHint > MAX_FILE_XFER_BYTES) {
      return {
        status: 'ERROR',
        error: '파일이 너무 커서 전송할 수 없습니다.\n공유 폴더를 이용해 주세요.'
      };
    }

    const targets = await resolveFileXferTargets(chatTarget);
    if (targets.error) return { status: 'ERROR', error: targets.error };

    const msgUid = generateMsgUid();
    const xferUid = `${MY_IP}_xf_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const storedName = makeStoredFileName(fileName, msgUid);
    await writeReceivedFileAsync(storedName, buf);
    const messageHtml = buildChatFileBoxHtml(fileName, buf.length, storedName);

    const wireChatTarget = chatTarget.kind === 'group'
      ? { kind: 'group', groupUid: chatTarget.groupUid, groupName: targets.groupName || chatTarget.groupName || '그룹' }
      : { kind: 'dm' };

    const payloads = buildFileXferPayloads(buf, {
      xferUid,
      fileName,
      mime,
      chatTarget: wireChatTarget,
      sender: myProfile.username,
      msgUid
    });

    let okCount = 0;
    for (const ip of targets.ips) {
      const ok = await writeJsonLinesToIp(ip, payloads, FILE_XFER_SEND_TIMEOUT_MS);
      if (ok) okCount += 1;
      await new Promise((r) => setImmediate(r));
    }

    if (okCount === 0) {
      return { status: 'ERROR', error: '파일 전송에 실패했습니다. 상대가 오프라인이거나 연결할 수 없습니다.' };
    }

    const sentAt = new Date();
    const createdAt = sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const createdAtFull = sentAt.toLocaleString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    const receiverKey = targets.receiverKey;
    const partnerName = targets.partnerName || receiverKey;

    const localId = await new Promise((resolve) => {
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
        [senderLabelForMe(), MY_IP, receiverKey, messageHtml, msgUid],
        function (err) {
          logDbErr(err);
          if (chatTarget.kind === 'dm') {
            appendChatLog(`DM_${receiverKey}`, partnerName, myProfile.username, messageHtml);
            armDmReadReceiptNotify(receiverKey);
          } else {
            appendChatLog(receiverKey, partnerName, myProfile.username, messageHtml);
          }
          resolve(err ? null : this.lastID);
        }
      );
    });

    return {
      status: 'SENT',
      messageHtml,
      uid: msgUid,
      id: localId,
      createdAt,
      createdAtFull,
      deliveredPeers: okCount,
      totalPeers: targets.ips.length
    };
  } catch (e) {
    console.error('send-file-transfer 오류:', e.message || e);
    return { status: 'ERROR', error: e.message || '파일 전송에 실패했습니다.' };
  }
});

ipcMain.handle('send-message', async (event, { targetIP, message, urgent }) => {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let isConnected = false;
    let settled = false;
    client.setTimeout(900);
    const partnerName = (allKnownUsers.get(targetIP) || {}).username || targetIP;
    const msgUid = generateMsgUid();
    const sentAt = new Date();
    const createdAt = sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const createdAtFull = sentAt.toLocaleString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, createdAt, createdAtFull });
    };

    const chatPayload = {
      type: 'CHAT',
      sender: myProfile.username,
      message,
      urgent: !!urgent,
      uid: msgUid
    };
    if (isChatWireTooLarge(chatPayload)) {
      finish({
        status: 'ERROR',
        error: '첨부/메시지가 너무 큽니다. 네트워크 전송 한도(약 400KB)를 초과합니다. 이미지는 자동 압축되며, 큰 파일은 공유 폴더를 이용해 주세요.',
        uid: msgUid
      });
      return;
    }

    const startTcpSend = (localRowId) => {
      extractAndSaveAttachments(message, { msgUid });
      appendChatLog(`DM_${targetIP}`, partnerName, myProfile.username, message);

      client.connect(TCP_PORT, targetIP, () => {
        isConnected = true;
        try {
          client.write(JSON.stringify(chatPayload) + '\n');
          client.end();
          armDmReadReceiptNotify(targetIP);
          // wire는 원본 전송. DB는 바로 compact 가능(재전송 시 파일→data 복원)
          compactMessageRowById(localRowId, msgUid, message);
          finish({ status: 'SENT', createdAt, uid: msgUid, id: localRowId });
        } catch (writeErr) {
          console.error('DM write 오류:', writeErr.message);
          db.run(
            `UPDATE messages SET status = 'PENDING' WHERE msg_uid = ? AND sender_ip = ?`,
            [msgUid, MY_IP],
            () => finish({ status: 'PENDING', id: localRowId, createdAt, uid: msgUid })
          );
        }
      });

      const handleFailure = () => {
        if (isConnected || settled) return;
        client.destroy();
        db.run(
          `UPDATE messages SET status = 'PENDING' WHERE msg_uid = ? AND sender_ip = ?`,
          [msgUid, MY_IP],
          (updErr) => {
            logDbErr(updErr);
            armDmReadReceiptNotify(targetIP);
            finish({ status: 'PENDING', id: localRowId, createdAt, uid: msgUid });
          }
        );
      };

      client.on('timeout', handleFailure);
      client.on('error', handleFailure);
    };

    // TCP 연결 전에 먼저 저장 → 루프백 수신과의 msg_uid 레이스·보관함 중복 방지
    // wire/재전송용으로는 원본(message)을 유지. ACK 후 compact.
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [senderLabelForMe(), MY_IP, targetIP, message, msgUid],
      function (insertErr) {
        if (insertErr) {
          logDbErr(insertErr);
          // 가짜 PENDING 금지: 실제 PENDING 행을 남기거나 ERROR 반환
          db.run(
            `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [senderLabelForMe(), MY_IP, targetIP, message, msgUid],
            function (insertErr2) {
              if (insertErr2) {
                logDbErr(insertErr2);
                finish({ status: 'ERROR', error: insertErr.message || 'DB 저장 실패', uid: msgUid });
                return;
              }
              startTcpSend(this.lastID);
            }
          );
          return;
        }
        startTcpSend(this.lastID);
      }
    );
  });
});

ipcMain.handle('send-broadcast-message', async (event, message) => {
  const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgUid = generateMsgUid();
  broadcastToOnlinePeers({ type: 'BROADCAST', sender: myProfile.username, message, msgUid });
  allKnownUsers.forEach((u, ip) => {
    if (ip === MY_IP) return;
    if (isSyntheticReceiverKey(ip) || !looksLikeIpv4(ip)) return;
    if (onlineUsers.has(ip)) return;
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
      [senderLabelForMe(), MY_IP, `BCAST:${ip}`, message, msgUid],
      logDbErr
    );
  });
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, 'BROADCAST', ?, 'SENT', ?)`,
      [senderLabelForMe(), MY_IP, message, msgUid],
      function (err) {
        logDbErr(err);
        appendChatLog('BROADCAST', '전체공지', myProfile.username, message);
        if (!err) compactMessageRowById(this.lastID, msgUid, message);
        resolve({ status: 'SENT', createdAt, uid: msgUid, id: this.lastID });
      }
    );
  });
});

ipcMain.handle('send-dept-message', async (event, { dept, message }) => {
  const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgUid = generateMsgUid();
  const deptPayload = { type: 'DEPT_MESSAGE', dept, sender: myProfile.username, message, msgUid };
  if (isChatWireTooLarge(deptPayload)) {
    return {
      status: 'ERROR',
      error: '첨부/메시지가 너무 큽니다. 네트워크 전송 한도(약 400KB)를 초과합니다. 이미지는 자동 압축되며, 큰 파일은 공유 폴더를 이용해 주세요.',
      createdAt,
      uid: msgUid
    };
  }
  const wireData = JSON.stringify(deptPayload) + '\n';
  onlineUsers.forEach((u, ip) => {
    if (ip === MY_IP) return;
    if (u.dept !== dept) return;
    const client = new net.Socket();
    let delivered = false;
    client.setTimeout(1200);
    client.connect(TCP_PORT, ip, () => {
      delivered = true;
      client.write(wireData);
      client.end();
    });
    const queueIfFailed = () => {
      if (delivered) return;
      enqueuePendingPeerMessage(encodeDeptPeerKey(ip, dept), message, msgUid);
    };
    client.on('error', queueIfFailed);
    client.on('timeout', () => {
      client.destroy();
      queueIfFailed();
    });
  });
  // 오프라인 동료: 전체공지와 같이 PENDING 큐 (켜지면 재전송)
  allKnownUsers.forEach((u, ip) => {
    if (ip === MY_IP) return;
    if (isSyntheticReceiverKey(ip) || !looksLikeIpv4(ip)) return;
    if ((u.dept || '') !== dept) return;
    if (onlineUsers.has(ip)) return;
    enqueuePendingPeerMessage(encodeDeptPeerKey(ip, dept), message, msgUid);
  });
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [senderLabelForMe(), MY_IP, `DEPT:${dept}`, message, msgUid],
      function (err) {
        logDbErr(err);
        appendChatLog(`DEPT:${dept}`, `부서_${dept}`, myProfile.username, message);
        if (!err) compactMessageRowById(this.lastID, msgUid, message);
        resolve({ status: 'SENT', createdAt, uid: msgUid, id: this.lastID });
      }
    );
  });
});

ipcMain.handle('send-floor-message', async (event, { floor, message }) => {
  const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgUid = generateMsgUid();
  const floorPayload = { type: 'FLOOR_MESSAGE', floor, sender: myProfile.username, message, msgUid };
  if (isChatWireTooLarge(floorPayload)) {
    return {
      status: 'ERROR',
      error: '첨부/메시지가 너무 큽니다. 네트워크 전송 한도(약 400KB)를 초과합니다. 이미지는 자동 압축되며, 큰 파일은 공유 폴더를 이용해 주세요.',
      createdAt,
      uid: msgUid
    };
  }
  const wireData = JSON.stringify(floorPayload) + '\n';
  onlineUsers.forEach((u, ip) => {
    if (ip === MY_IP) return;
    if (u.floor !== floor) return;
    const client = new net.Socket();
    let delivered = false;
    client.setTimeout(1200);
    client.connect(TCP_PORT, ip, () => {
      delivered = true;
      client.write(wireData);
      client.end();
    });
    const queueIfFailed = () => {
      if (delivered) return;
      enqueuePendingPeerMessage(encodeFloorPeerKey(ip, floor), message, msgUid);
    };
    client.on('error', queueIfFailed);
    client.on('timeout', () => {
      client.destroy();
      queueIfFailed();
    });
  });
  allKnownUsers.forEach((u, ip) => {
    if (ip === MY_IP) return;
    if (isSyntheticReceiverKey(ip) || !looksLikeIpv4(ip)) return;
    if ((u.floor || '') !== floor) return;
    if (onlineUsers.has(ip)) return;
    enqueuePendingPeerMessage(encodeFloorPeerKey(ip, floor), message, msgUid);
  });
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [senderLabelForMe(), MY_IP, `FLOOR:${floor}`, message, msgUid],
      function (err) {
        logDbErr(err);
        appendChatLog(`FLOOR:${floor}`, `${floor}`, myProfile.username, message);
        if (!err) compactMessageRowById(this.lastID, msgUid, message);
        resolve({ status: 'SENT', createdAt, uid: msgUid, id: this.lastID });
      }
    );
  });
});

// 🚑 이동요청시스템(mirae-transport) 연동
function httpsRequestJson(method, targetUrl, body, redirectsLeft, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      resolve({ success: false, msg: '잘못된 주소입니다.' });
      return;
    }
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers,
      timeout: opts.timeout != null ? opts.timeout : 8000,
      agent: opts.agent
    }, (res) => {
      // 구글 앱스크립트는 POST 처리 후 결과를 302 리디렉션으로 돌려주는 경우가 많다.
      // Node의 https 모듈은 자동으로 따라가지 않으므로 직접 따라가야 한다.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume(); // 현재 응답 body는 버림
        resolve(httpsRequestJson('GET', res.headers.location, null, redirectsLeft - 1, opts));
        return;
      }
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.ok) {
            resolve({ success: true, result: parsed.result });
          } else {
            resolve({ success: false, msg: parsed.error || '알 수 없는 오류' });
          }
        } catch (e) {
          resolve({ success: false, msg: '응답을 해석할 수 없습니다 (상태 코드 ' + res.statusCode + ')' });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, msg: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, msg: '요청 시간이 초과되었습니다.' }); });
    if (body) req.write(body);
    req.end();
  });
}

const TRANSPORT_HTTP_OPTS = { agent: transportHttpsAgent, timeout: 12000 };

function callTransportWebapp(action, data) {
  if (!transportWebappUrl) return Promise.resolve({ success: false, msg: '이동요청 주소가 설정되지 않았습니다.' });
  const body = JSON.stringify({ action, data });
  return httpsRequestJson('POST', transportWebappUrl, body, 3, TRANSPORT_HTTP_OPTS);
}

function callTransportWebappInBackground(action, data) {
  if (!transportWebappUrl) return;
  callTransportWebapp(action, data).catch(() => {});
}

ipcMain.handle('send-transport-request', async (event, { ward, patientName, treatmentName, treatmentLocation, treatmentTime, remarks }) => {
  const createdAt = new Date().toLocaleString('ko-KR');
  const result = await callTransportWebapp('createRequest', {
    ward: ward || '',
    patientName: patientName || '',
    treatmentName: treatmentName || '',
    treatmentLocation: treatmentLocation || '',
    treatmentTime: treatmentTime || '',
    registeredBy: myProfile.username,
    remarks: remarks || '',
    deferNotify: true
  });
  const remoteId = (result.success && result.result && result.result.id) ? result.result.id : '';
  if (result.success && remoteId) {
    callTransportWebappInBackground('notifyRequest', { id: remoteId });
  }
  db.run(
    `INSERT INTO transport_requests (patient_name, from_loc, to_loc, request_time, requested_by, created_at, status, remote_id, treatment_name, driver_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [patientName || '', ward || '', treatmentLocation || '', treatmentTime || '', myProfile.username, createdAt, result.success ? 'SENT' : 'FAILED', remoteId, treatmentName || '', result.success ? '대기' : ''],
    logDbErr
  );
  return result;
});

ipcMain.handle('edit-transport-request', async (event, { localId, remoteId, ward, patientName, treatmentName, treatmentLocation, treatmentTime, remarks }) => {
  if (!remoteId) return { success: false, msg: '이 요청은 서버에 등록된 기록이 없어 수정할 수 없습니다.' };
  const result = await callTransportWebapp('editRequest', {
    id: remoteId,
    ward: ward || '',
    patientName: patientName || '',
    treatmentName: treatmentName || '',
    treatmentLocation: treatmentLocation || '',
    treatmentTime: treatmentTime || '',
    remarks: remarks || ''
  });
  if (result.success) {
    db.run(
      `UPDATE transport_requests SET patient_name = ?, from_loc = ?, to_loc = ?, request_time = ?, treatment_name = ? WHERE id = ?`,
      [patientName || '', ward || '', treatmentLocation || '', treatmentTime || '', treatmentName || '', localId],
      logDbErr
    );
  }
  return result;
});

ipcMain.handle('delete-transport-request', async (event, { localId, remoteId }) => {
  if (!remoteId) {
    // 서버에 등록되지 못했던(전송 실패) 기록은 로컬 목록에서만 지운다.
    db.run(`DELETE FROM transport_requests WHERE id = ?`, [localId], logDbErr);
    return { success: true };
  }
  const result = await callTransportWebapp('deleteRequest', { id: remoteId });
  if (result.success) {
    db.run(`DELETE FROM transport_requests WHERE id = ?`, [localId], logDbErr);
  }
  return result;
});

ipcMain.handle('sync-transport-request-statuses', async () => {
  const remote = await callTransportWebapp('listRecent', { limit: 80 });
  if (!remote.success || !Array.isArray(remote.result)) {
    return { success: false, msg: remote.msg || '원격 목록을 가져오지 못했습니다.' };
  }
  const byRemoteId = {};
  remote.result.forEach((row) => {
    if (row && row.id) byRemoteId[row.id] = row;
  });
  return new Promise((resolve) => {
    db.all(`SELECT id, remote_id FROM transport_requests WHERE remote_id IS NOT NULL AND remote_id != ''`, [], (err, locals) => {
      const tasks = (locals || []).map((local) => new Promise((res) => {
        const r = byRemoteId[local.remote_id];
        if (!r) { res(); return; }
        db.run(
          `UPDATE transport_requests SET driver_status = ?, processed_by = ?, cancel_reason = ? WHERE id = ?`,
          [r.status || '', r.processedBy || '', r.cancelReason || '', local.id],
          () => res()
        );
      }));
      Promise.all(tasks).then(() => resolve({ success: true }));
    });
  });
});

ipcMain.handle('get-transport-request-history', async (event, keyword) => {
  return new Promise((resolve) => {
    if (keyword) {
      const like = `%${keyword}%`;
      db.all(
        `SELECT * FROM transport_requests WHERE patient_name LIKE ? OR from_loc LIKE ? OR to_loc LIKE ? OR treatment_name LIKE ? ORDER BY id DESC LIMIT 50`,
        [like, like, like, like],
        (err, rows) => resolve(rows || [])
      );
    } else {
      db.all(`SELECT * FROM transport_requests ORDER BY id DESC LIMIT 50`, [], (err, rows) => {
        resolve(rows || []);
      });
    }
  });
});

ipcMain.handle('get-transport-webapp-url', async () => transportWebappUrl);

ipcMain.handle('set-transport-webapp-url', async (event, url) => {
  transportWebappUrl = url || '';
  db.run(`UPDATE app_settings SET transport_webapp_url = ? WHERE id = 1`, [transportWebappUrl], logDbErr);
  return true;
});

ipcMain.handle('get-download-folder', async () => downloadFolderPath || app.getPath('downloads'));

ipcMain.handle('choose-download-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  downloadFolderPath = result.filePaths[0];
  db.run(`UPDATE app_settings SET download_folder_path = ? WHERE id = 1`, [downloadFolderPath], logDbErr);
  return downloadFolderPath;
});

ipcMain.handle('notify-read', async (event, arg) => {
  const targetIP = typeof arg === 'string' ? arg : (arg && arg.targetIP);
  const intentional = typeof arg === 'object' && arg && !!arg.intentional;
  if (!targetIP || targetIP === 'BROADCAST' || String(targetIP).startsWith('DEPT:') ||
      String(targetIP).startsWith('FLOOR:') || String(targetIP).startsWith('GROUP:')) {
    return { success: false };
  }
  // 토스트「읽기」등 의도적 확인이 아니면, 창 포커스 없을 때 읽음 차단
  if (!intentional && !toastUiState.focused) {
    return { success: false, reason: 'window-not-focused' };
  }
  return new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch (e) {}
      resolve({ success: !!ok });
    };
    client.setTimeout(1200);
    client.connect(TCP_PORT, targetIP, () => {
      try {
        client.write(JSON.stringify({ type: 'READ_RECEIPT', readerName: senderLabelForMe() }) + '\n', () => {
          client.end();
          finish(true);
        });
      } catch (e) {
        finish(false);
      }
    });
    client.on('error', () => finish(false));
    client.on('timeout', () => finish(false));
  });
});

ipcMain.handle('notify-channel-read', async (event, { channelKey, lastReadMsgUid }) => {
  const uid = String(lastReadMsgUid || '').trim();
  if (!channelKey || !uid) return true;
  if (!(channelKey === 'BROADCAST' || String(channelKey).startsWith('DEPT:') || String(channelKey).startsWith('FLOOR:') || String(channelKey).startsWith('GROUP:'))) {
    return true;
  }
  await upsertChannelReadCursorMaxUid(channelKey, MY_IP, uid);
  relayChannelRead(channelKey, uid);
  return true;
});

ipcMain.handle('get-message-unread-counts', async (event, { channelKey, messages }) => {
  const items = (messages || []).filter((m) => m && m.msgUid);
  if (!channelKey || !items.length) return {};
  const audience = await getAudienceIpsForChannel(channelKey);
  if (!audience.length) {
    const empty = {};
    items.forEach((m) => { empty[m.msgUid] = 0; });
    return empty;
  }
  const msgUids = items.map((m) => m.msgUid);
  return new Promise((resolve) => {
    const placeholders = audience.map(() => '?').join(',');
    db.all(
      `SELECT reader_ip, last_read_msg_uid FROM channel_read_cursors WHERE channel_key = ? AND reader_ip IN (${placeholders})`,
      [channelKey, ...audience],
      (err, cursorRows) => {
        if (err) {
          logDbErr(err);
          resolve({});
          return;
        }
        const cursorMap = {};
        (cursorRows || []).forEach((r) => { cursorMap[r.reader_ip] = r.last_read_msg_uid || ''; });
        db.all(
          `SELECT msg_uid, id FROM messages WHERE receiver_ip = ? AND msg_uid IN (${msgUids.map(() => '?').join(',')})`,
          [channelKey, ...msgUids],
          (err2, msgRows) => {
            if (err2) {
              logDbErr(err2);
              resolve({});
              return;
            }
            const idByUid = {};
            (msgRows || []).forEach((r) => { idByUid[r.msg_uid] = r.id; });
            const readIdByIp = {};
            const cursorUids = [...new Set(Object.values(cursorMap).filter(Boolean))];
            if (!cursorUids.length) {
              const result = {};
              items.forEach((m) => { result[m.msgUid] = audience.length; });
              resolve(result);
              return;
            }
            db.all(
              `SELECT msg_uid, id FROM messages WHERE receiver_ip = ? AND msg_uid IN (${cursorUids.map(() => '?').join(',')})`,
              [channelKey, ...cursorUids],
              (err3, cursorMsgRows) => {
                if (err3) {
                  logDbErr(err3);
                  resolve({});
                  return;
                }
                const idByCursorUid = {};
                (cursorMsgRows || []).forEach((r) => { idByCursorUid[r.msg_uid] = r.id; });
                audience.forEach((ip) => {
                  const cu = cursorMap[ip] || '';
                  readIdByIp[ip] = cu ? (idByCursorUid[cu] || 0) : 0;
                });
                const result = {};
                items.forEach((m) => {
                  const targetId = idByUid[m.msgUid] || 0;
                  let count = 0;
                  audience.forEach((ip) => {
                    const readId = readIdByIp[ip] || 0;
                    if (!targetId || readId < targetId) count++;
                  });
                  result[m.msgUid] = count;
                });
                resolve(result);
              }
            );
          }
        );
      }
    );
  });
});

function deliverPendingChatRow(row, targetIP) {
  if (!row || !targetIP) return;
  const inflightKey = row.msg_uid ? String(row.msg_uid) : `id:${row.id}`;
  if (pendingResendInflight.has(inflightKey)) return;
  pendingResendInflight.add(inflightKey);
  const releaseInflight = () => pendingResendInflight.delete(inflightKey);
  setTimeout(releaseInflight, 15000);

  if (row.status === 'SENT' && row.msg_uid) {
    const tries = sentAckRetryCount.get(String(row.msg_uid)) || 0;
    if (tries >= SENT_ACK_MAX_RETRIES) {
      releaseInflight();
      return;
    }
    sentAckRetryCount.set(String(row.msg_uid), tries + 1);
  }

  const wireMessage = messageHtmlForWire(row.message);
  const client = new net.Socket();
  client.setTimeout(2500);
  const senderLogin = (myProfile && myProfile.username) ? myProfile.username : row.sender_name;
  client.connect(TCP_PORT, targetIP, () => {
    client.write(JSON.stringify({
      type: 'CHAT',
      sender: senderLogin,
      message: wireMessage,
      urgent: false,
      uid: row.msg_uid || undefined
    }) + '\n');
    client.end();
  });
  client.on('error', releaseInflight);
  client.on('timeout', () => {
    client.destroy();
    releaseInflight();
  });
}

function deliverPendingBroadcastRow(row, targetIP) {
  if (!row || !targetIP) return;
  const inflightKey = row.msg_uid ? `bc:${row.msg_uid}:${targetIP}` : `bcid:${row.id}:${targetIP}`;
  if (pendingResendInflight.has(inflightKey)) return;
  pendingResendInflight.add(inflightKey);
  const releaseInflight = () => pendingResendInflight.delete(inflightKey);
  setTimeout(releaseInflight, 15000);

  const wireMessage = messageHtmlForWire(row.message);
  const client = new net.Socket();
  client.setTimeout(2500);
  client.connect(TCP_PORT, targetIP, () => {
    client.write(JSON.stringify({
      type: 'BROADCAST',
      sender: myProfile.username || row.sender_name,
      message: wireMessage,
      msgUid: row.msg_uid || undefined
    }) + '\n');
    client.end();
    db.run(`UPDATE messages SET status = 'SENT' WHERE id = ? AND status = 'PENDING'`, [row.id], (err) => {
      logDbErr(err);
      if (!err) compactMessageRowById(row.id, row.msg_uid, wireMessage);
    });
  });
  client.on('error', releaseInflight);
  client.on('timeout', () => {
    client.destroy();
    releaseInflight();
  });
}

function deliverPendingDeptPeerRow(row, targetIP, dept) {
  if (!row || !targetIP || !dept) return;
  const inflightKey = row.msg_uid ? `dp:${row.msg_uid}:${targetIP}` : `dpid:${row.id}:${targetIP}`;
  if (pendingResendInflight.has(inflightKey)) return;
  pendingResendInflight.add(inflightKey);
  const releaseInflight = () => pendingResendInflight.delete(inflightKey);
  setTimeout(releaseInflight, 15000);

  const wireMessage = messageHtmlForWire(row.message);
  const client = new net.Socket();
  client.setTimeout(2500);
  client.connect(TCP_PORT, targetIP, () => {
    client.write(JSON.stringify({
      type: 'DEPT_MESSAGE',
      dept,
      sender: myProfile.username || row.sender_name,
      message: wireMessage,
      msgUid: row.msg_uid || undefined
    }) + '\n');
    client.end();
    db.run(`UPDATE messages SET status = 'SENT' WHERE id = ? AND status = 'PENDING'`, [row.id], (err) => {
      logDbErr(err);
      if (!err) compactMessageRowById(row.id, row.msg_uid, wireMessage);
    });
  });
  client.on('error', releaseInflight);
  client.on('timeout', () => {
    client.destroy();
    releaseInflight();
  });
}

function deliverPendingFloorPeerRow(row, targetIP, floor) {
  if (!row || !targetIP || !floor) return;
  const inflightKey = row.msg_uid ? `fp:${row.msg_uid}:${targetIP}` : `fpid:${row.id}:${targetIP}`;
  if (pendingResendInflight.has(inflightKey)) return;
  pendingResendInflight.add(inflightKey);
  const releaseInflight = () => pendingResendInflight.delete(inflightKey);
  setTimeout(releaseInflight, 15000);

  const wireMessage = messageHtmlForWire(row.message);
  const client = new net.Socket();
  client.setTimeout(2500);
  client.connect(TCP_PORT, targetIP, () => {
    client.write(JSON.stringify({
      type: 'FLOOR_MESSAGE',
      floor,
      sender: myProfile.username || row.sender_name,
      message: wireMessage,
      msgUid: row.msg_uid || undefined
    }) + '\n');
    client.end();
    db.run(`UPDATE messages SET status = 'SENT' WHERE id = ? AND status = 'PENDING'`, [row.id], (err) => {
      logDbErr(err);
      if (!err) compactMessageRowById(row.id, row.msg_uid, wireMessage);
    });
  });
  client.on('error', releaseInflight);
  client.on('timeout', () => {
    client.destroy();
    releaseInflight();
  });
}

function resendPendingMessages(targetIP) {
  if (!targetIP || !onlineUsers.has(targetIP)) return;

  db.all(
    `SELECT id, sender_name, message, msg_uid, status, created_at FROM messages
     WHERE sender_ip = ? AND receiver_ip = ?
       AND (
         status = 'PENDING'
         OR (
           status = 'SENT'
           AND msg_uid IS NOT NULL AND trim(msg_uid) != ''
           AND created_at <= datetime('now', '-8 seconds')
         )
       )
     ORDER BY id ASC`,
    [MY_IP, targetIP],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        return;
      }
      (rows || []).forEach((row) => deliverPendingChatRow(row, targetIP));
    }
  );

  db.all(
    `SELECT id, sender_name, message, msg_uid FROM messages
     WHERE sender_ip = ? AND receiver_ip = ? AND status = 'PENDING' ORDER BY id ASC`,
    [MY_IP, `BCAST:${targetIP}`],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        return;
      }
      (rows || []).forEach((row) => deliverPendingBroadcastRow(row, targetIP));
    }
  );

  db.all(
    `SELECT id, sender_name, message, msg_uid, receiver_ip FROM messages
     WHERE sender_ip = ? AND status = 'PENDING' AND receiver_ip LIKE ?
     ORDER BY id ASC`,
    [MY_IP, `DEPTPEER:${targetIP}|%`],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        return;
      }
      (rows || []).forEach((row) => {
        const parsed = parseDeptPeerKey(row.receiver_ip);
        if (parsed && parsed.dept) deliverPendingDeptPeerRow(row, targetIP, parsed.dept);
      });
    }
  );

  db.all(
    `SELECT id, sender_name, message, msg_uid, receiver_ip FROM messages
     WHERE sender_ip = ? AND status = 'PENDING' AND receiver_ip LIKE ?
     ORDER BY id ASC`,
    [MY_IP, `FLOORPEER:${targetIP}|%`],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        return;
      }
      (rows || []).forEach((row) => {
        const parsed = parseFloorPeerKey(row.receiver_ip);
        if (parsed && parsed.floor) deliverPendingFloorPeerRow(row, targetIP, parsed.floor);
      });
    }
  );
}

function flushAllPendingOutboundMessages() {
  if (!profileLoaded) return;
  db.all(
    `SELECT DISTINCT receiver_ip FROM messages
     WHERE sender_ip = ?
       AND (
         status = 'PENDING'
         OR (
           status = 'SENT'
           AND msg_uid IS NOT NULL AND trim(msg_uid) != ''
           AND receiver_ip NOT IN ('BROADCAST')
           AND receiver_ip NOT LIKE 'DEPT:%'
           AND receiver_ip NOT LIKE 'FLOOR:%'
           AND receiver_ip NOT LIKE 'GROUP:%'
           AND receiver_ip NOT LIKE 'BCAST:%'
           AND receiver_ip NOT LIKE 'DEPTPEER:%'
           AND receiver_ip NOT LIKE 'FLOORPEER:%'
           AND created_at <= datetime('now', '-8 seconds')
         )
       )
       AND receiver_ip NOT IN ('BROADCAST')
       AND receiver_ip NOT LIKE 'DEPT:%'
       AND receiver_ip NOT LIKE 'FLOOR:%'
       AND receiver_ip NOT LIKE 'GROUP:%'`,
    [MY_IP],
    (err, rows) => {
      if (err) {
        logDbErr(err);
        return;
      }
      (rows || []).forEach((r) => {
        const key = r.receiver_ip;
        if (!key) return;
        if (key.startsWith('BCAST:')) {
          const peerIp = key.slice('BCAST:'.length);
          if (peerIp && onlineUsers.has(peerIp)) resendPendingMessages(peerIp);
          return;
        }
        if (key.startsWith('DEPTPEER:')) {
          const parsed = parseDeptPeerKey(key);
          if (parsed && parsed.ip && onlineUsers.has(parsed.ip)) resendPendingMessages(parsed.ip);
          return;
        }
        if (key.startsWith('FLOORPEER:')) {
          const parsed = parseFloorPeerKey(key);
          if (parsed && parsed.ip && onlineUsers.has(parsed.ip)) resendPendingMessages(parsed.ip);
          return;
        }
        if (onlineUsers.has(key)) resendPendingMessages(key);
      });
    }
  );
}

function isChannelReceiverKey(targetIP) {
  return (
    targetIP === 'BROADCAST' ||
    (typeof targetIP === 'string' &&
      (targetIP.startsWith('DEPT:') || targetIP.startsWith('FLOOR:') || targetIP.startsWith('GROUP:')))
  );
}

function chatHistoryScopeSql(targetIP) {
  if (isChannelReceiverKey(targetIP)) {
    return {
      where: 'receiver_ip = ?',
      params: [targetIP]
    };
  }
  return {
    where: '((sender_ip = ? AND receiver_ip = ?) OR (sender_ip = ? AND receiver_ip = ?))',
    params: [MY_IP, targetIP, targetIP, MY_IP]
  };
}

function getChatViewHideUpToId(channelKey) {
  return new Promise((resolve) => {
    db.get(`SELECT hide_up_to_id FROM chat_view_clears WHERE channel_key = ?`, [channelKey], (err, row) => {
      if (err) {
        logDbErr(err);
        resolve(0);
        return;
      }
      resolve(row && row.hide_up_to_id ? row.hide_up_to_id : 0);
    });
  });
}

function getMaxMessageIdForChannel(targetIP) {
  return new Promise((resolve) => {
    const scope = chatHistoryScopeSql(targetIP);
    db.get(`SELECT MAX(id) as maxId FROM messages WHERE ${scope.where}`, scope.params, (err, row) => {
      if (err) {
        logDbErr(err);
        resolve(0);
        return;
      }
      resolve(row && row.maxId ? row.maxId : 0);
    });
  });
}

function dedupeArchiveMessageRows(rows) {
  const seenUid = new Set();
  const seenContent = new Set();
  const out = [];
  for (const r of rows || []) {
    if (r.msg_uid) {
      const k = String(r.msg_uid);
      if (seenUid.has(k)) continue;
      seenUid.add(k);
      out.push(r);
      continue;
    }
    const msg = r.message || '';
    const contentKey = `${r.sender_ip}|${r.created_at_local}|${msg.length}|${msg.slice(0, 96)}`;
    if (seenContent.has(contentKey)) continue;
    seenContent.add(contentKey);
    out.push(r);
  }
  return out;
}

ipcMain.handle('get-chat-shared-archive', async (event, targetIP) => {
  const key = String(targetIP || '').trim();
  if (!key) return [];
  const scope = chatHistoryScopeSql(key);
  const mediaWhere = ` AND (
    message LIKE '%chat-img-preview%' OR message LIKE '%chat-file-box%' OR
    message LIKE '%http://%' OR message LIKE '%https://%'
  )`;
  return new Promise((resolve) => {
    const sql = `SELECT id, sender_name, sender_ip, message, msg_uid,
      strftime('%Y-%m-%d %H:%M', created_at, 'localtime') as created_at_local
      FROM messages WHERE ${scope.where}${mediaWhere} ORDER BY id DESC LIMIT 2500`;
    db.all(sql, scope.params, (err, rows) => {
      if (err) {
        logDbErr(err);
        resolve([]);
        return;
      }
      const mineLabel = senderLabelForMe();
      const deduped = dedupeArchiveMessageRows(rows || []);
      resolve(deduped.map(r => ({
        id: r.id,
        sender_name: formatSenderDisplay(r.sender_name, r.sender_ip),
        sender_ip: r.sender_ip,
        message: r.message,
        msg_uid: r.msg_uid,
        created_at_local: r.created_at_local,
        isMe: r.sender_ip === MY_IP || (mineLabel && r.sender_name === mineLabel)
      })));
    });
  });
});

ipcMain.handle('open-external-url', async (event, url) => {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return { success: false, msg: '잘못된 주소입니다.' };
  try {
    await shell.openExternal(raw);
    return { success: true };
  } catch (e) {
    return { success: false, msg: e.message || '링크를 열 수 없습니다.' };
  }
});

ipcMain.handle('get-chat-history', async (event, args) => {
  const targetIP = (args && typeof args === 'object') ? args.targetIP : args;
  const keyword = args && typeof args === 'object' ? args.keyword : null;
  const hideUpToId = await getChatViewHideUpToId(targetIP);
  const scope = chatHistoryScopeSql(targetIP);

  return new Promise((resolve) => {
    let sql = `SELECT DISTINCT id, sender_name, sender_ip, receiver_ip, message, status, msg_uid, strftime('%H:%M', created_at, 'localtime') as created_time, strftime('%Y-%m-%d %H:%M', created_at, 'localtime') as sent_at_full FROM messages WHERE ${scope.where}`;
    const params = [...scope.params];

    if (hideUpToId > 0) {
      sql += ` AND id > ?`;
      params.push(hideUpToId);
    }

    if (keyword) {
      sql += ` AND message LIKE ?`;
      params.push(`%${keyword}%`);
    }
    sql += ` ORDER BY id DESC LIMIT 200`;

    db.all(sql, params, (err, rows) => {
      const mineLabel = senderLabelForMe();
      const ordered = (rows || []).slice().reverse();
      resolve(ordered.map(r => ({
        ...r,
        isMe: r.sender_ip === MY_IP || (mineLabel && r.sender_name === mineLabel),
        sender_name: formatSenderDisplay(r.sender_name, r.sender_ip)
      })));
    });
  });
});

ipcMain.handle('clear-chat-view', async (event, channelKey) => {
  const key = String(channelKey || '').trim();
  if (!key) return { success: false, msg: '대화방 정보가 없습니다.' };
  try {
    const maxId = await getMaxMessageIdForChannel(key);
    return new Promise((resolve) => {
      db.run(
        `INSERT INTO chat_view_clears (channel_key, hide_up_to_id, cleared_at) VALUES (?, ?, datetime('now','localtime'))
         ON CONFLICT(channel_key) DO UPDATE SET hide_up_to_id = excluded.hide_up_to_id, cleared_at = excluded.cleared_at`,
        [key, maxId],
        (err) => {
          if (err) {
            resolve({ success: false, msg: err.message });
            return;
          }
          resolve({ success: true, hideUpToId: maxId });
        }
      );
    });
  } catch (e) {
    return { success: false, msg: e.message || '대화창을 비우지 못했습니다.' };
  }
});

ipcMain.handle('get-all-chat-history', async (event, opts) => {
  return new Promise((resolve) => {
    const keyword = typeof opts === 'string' ? opts : ((opts && opts.keyword) || '');
    const kind = typeof opts === 'object' && opts && opts.kind ? String(opts.kind) : 'all';
    const clauses = [];
    const params = [];

    if (keyword) {
      clauses.push(`(message LIKE ? OR sender_name LIKE ?)`);
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (kind === 'photo') {
      clauses.push(`(message LIKE '%chat-img-preview%' OR message LIKE '%data:image%')`);
    } else if (kind === 'file') {
      clauses.push(`(message LIKE '%chat-file-box%')`);
    } else if (kind === 'link') {
      clauses.push(`(message LIKE '%http://%' OR message LIKE '%https://%')`);
    }

    let sql = `SELECT id, sender_name, sender_ip, receiver_ip, message, status, strftime('%Y-%m-%d %H:%M', created_at, 'localtime') as created_time FROM messages`;
    if (clauses.length) sql += ` WHERE ` + clauses.join(' AND ');
    sql += ` ORDER BY id DESC LIMIT ${kind === 'all' ? 300 : 500}`;

    db.all(sql, params, (err, rows) => {
      if (err) { logDbErr(err); resolve([]); return; }
      let list = (rows || []).map(r => ({
        ...r,
        sender_name: formatSenderDisplay(r.sender_name, r.sender_ip),
        isMe: r.sender_ip === MY_IP || r.sender_name === senderLabelForMe()
      }));
      // 링크 탭: 파일 첨부 박스 안의 다운로드 링크만 있는 항목은 제외
      if (kind === 'link') {
        list = list.filter((r) => {
          const html = String(r.message || '');
          const stripped = html.replace(/<div[^>]*class="[^"]*chat-file-box[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ');
          return /https?:\/\//i.test(stripped);
        });
      }
      resolve(list);
    });
  });
});

ipcMain.handle('get-my-profile', async () => ({ ...myProfile, ip: MY_IP }));

function waitForProfileLoaded(timeoutMs) {
  return new Promise((resolve) => {
    if (profileLoaded) { resolve(); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (profileLoaded || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve();
      }
    }, 30);
  });
}

ipcMain.handle('save-my-profile', async (event, newProfile) => {
  // 아직 DB에서 실제 저장된 프로필을 다 불러오기 전에 저장하면, 하드코딩된 기본값 위에 새 값만
  // 얹은 상태로 덮어써서 나머지 정보가 기본값으로 되돌아갈 수 있어, 로딩이 끝날 때까지 잠깐 기다린다.
  await waitForProfileLoaded(2000);
  const photoChanged = typeof newProfile.photo === 'string' && newProfile.photo !== myProfile.photo;
  myProfile = { ...myProfile, ...newProfile };
  console.log('[프로필] 저장:', myProfile.username, myProfile.rank, myProfile.dept, myProfile.floor, myProfile.extNo);
  logToRendererConsole('info', `[프로필] 저장: ${myProfile.username} ${myProfile.rank} ${myProfile.dept} ${myProfile.floor} ${myProfile.extNo}`);
  db.run(`INSERT OR REPLACE INTO user_profile (id, username, rank, dept, floor, ext_no, phone_no, status_state, photo) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [myProfile.username, myProfile.rank, myProfile.dept, myProfile.floor, myProfile.extNo, myProfile.phone, myProfile.statusState, myProfile.photo || ''], logDbErr);
  registerSelf();
  if (globalUdpSocket) broadcastPresence(globalUdpSocket);
  if (photoChanged) {
    broadcastToOnlinePeers({ type: 'PROFILE_PHOTO_SYNC', ip: MY_IP, photo: myProfile.photo || '' });
  }
  return myProfile;
});

// 🔑 마스터 아이디 + 비밀번호 검증 IPC 핸들러
ipcMain.handle('verify-master-auth', async (event, { id, password }) => {
  return new Promise((resolve) => {
    db.get(`SELECT master_id, master_password FROM master_config WHERE id = 1`, (err, row) => {
      const currentId = row && row.master_id ? row.master_id : 'admin';
      if (row && currentId === id && row.master_password === password) {
        masterSessionActive = true;
        resolve({ success: true });
      } else {
        resolve({ success: false, msg: '마스터 아이디 또는 비밀번호가 올바르지 않습니다.' });
      }
    });
  });
});

// 기존 호환성을 위해 유지
ipcMain.handle('verify-master-password', async (event, inputPassword) => {
  return new Promise((resolve) => {
    db.get(`SELECT master_password FROM master_config WHERE id = 1`, (err, row) => {
      if (row && row.master_password === inputPassword) resolve({ success: true });
      else resolve({ success: false, msg: '마스터 비밀번호가 올바르지 않습니다.' });
    });
  });
});

ipcMain.handle('clear-master-session', async () => {
  masterSessionActive = false;
  return { success: true };
});

ipcMain.handle('master-update-user-profile', async (event, payload) => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  }
  const p = payload || {};
  const ip = String(p.ip || '').trim();
  if (!ip) return { success: false, msg: '대상 IP가 없습니다.' };
  const patch = {
    ip,
    username: p.username != null ? String(p.username).trim() : '',
    rank: p.rank != null ? String(p.rank).trim() : '',
    dept: p.dept != null ? String(p.dept).trim() : '',
    floor: p.floor != null ? String(p.floor).trim() : '',
    extNo: p.extNo != null ? String(p.extNo).trim() : (p.ext_no != null ? String(p.ext_no).trim() : ''),
    phone: p.phone != null ? String(p.phone).trim() : (p.phone_no != null ? String(p.phone_no).trim() : '')
  };
  if (!patch.username) {
    const known = allKnownUsers.get(ip);
    if (known && known.username) patch.username = known.username;
  }
  storeProfileOverride(patch);
  refreshUserAfterProfileOverride(ip);
  broadcastToOnlinePeers({ type: 'PROFILE_OVERRIDE_SYNC', profile: patch });
  return { success: true };
});

// 👥 그룹 대화방 이름 변경 등 "시스템 알림"을 일반 대화와 구분하기 위한 표식.
// 화면(index.html)에서는 이 표식이 붙은 메시지를 말풍선이 아니라 가운데 정렬된 안내문으로 보여준다.
const SYSTEM_NOTICE_PREFIX = '<span class="system-notice-flag" style="display:none"></span>';

function logGroupSystemNotice(uid, groupName, noticeText) {
  const receiverKey = `GROUP:${uid}`;
  db.run(
    `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status) VALUES (?, ?, ?, ?, 'SENT')`,
    ['시스템', MY_IP, receiverKey, noticeText],
    logDbErr
  );
  appendChatLog(receiverKey, groupName || '그룹', '시스템', noticeText);
}

function pushGroupSystemNoticeLive(uid, noticeText) {
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  safeWebContentsSend('receive-group-message', {
    uid,
    senderName: '시스템',
    senderIP: MY_IP,
    message: noticeText,
    createdAt: currentTime
  });
}

function broadcastGroupJoinNotice(uid, groupName, memberDisplayName, memberIps) {
  const name = (memberDisplayName || '').trim() || '새 멤버';
  const noticeText = `${SYSTEM_NOTICE_PREFIX}${name}님이 입장했습니다.`;
  logGroupSystemNotice(uid, groupName, noticeText);
  pushGroupSystemNoticeLive(uid, noticeText);
  const targets = (memberIps || []).filter((ip) => ip && ip !== MY_IP);
  if (targets.length) {
    sendToIps(targets, { type: 'GROUP_JOIN_NOTICE', uid, groupName, noticeText });
  }
}

function generateNoticeUid() {
  return `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

function generateMsgUid() {
  return `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

ipcMain.handle('get-notices', async () => {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM notices ORDER BY created_at DESC`, [], (err, rows) => resolve(rows || []));
  });
});

ipcMain.handle('add-notice', async (event, { title, content, authorName }) => {
  return new Promise((resolve) => {
    const fallbackAuthor = displayNameFromParts(myProfile.rank, myProfile.username, '관리자') || '관리자';
    const record = {
      uid: generateNoticeUid(),
      title,
      content,
      author_name: (authorName && String(authorName).trim()) || fallbackAuthor,
      author_ip: MY_IP,
      created_at: new Date().toISOString()
    };
    db.run(
      `INSERT OR REPLACE INTO notices (uid, title, content, author_name, author_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [record.uid, record.title, record.content, record.author_name, record.author_ip, record.created_at],
      (err) => {
        if (err) {
          console.error('공지사항 저장 실패:', err.message);
          resolve({ success: false, error: err.message });
          return;
        }
        broadcastToOnlinePeers({ type: 'NOTICE_ADD', notice: record });
        resolve({ success: true, notice: record });
      }
    );
  });
});

ipcMain.handle('update-notice', async (event, { uid, title, content }) => {
  return new Promise((resolve) => {
    db.run(`UPDATE notices SET title = ?, content = ? WHERE uid = ?`, [title, content, uid], (err) => {
      if (!err) broadcastToOnlinePeers({ type: 'NOTICE_UPDATE', notice: { uid, title, content } });
      resolve({ success: !err });
    });
  });
});

ipcMain.handle('delete-notice', async (event, uid) => {
  return new Promise((resolve) => {
    db.run(`DELETE FROM notices WHERE uid = ?`, [uid], (err) => {
      if (!err) broadcastToOnlinePeers({ type: 'NOTICE_DELETE', uid });
      resolve({ success: !err });
    });
  });
});

ipcMain.handle('get-notice-operators', async () => {
  return new Promise((resolve) => {
    db.all(`SELECT username, display_name, added_at, COALESCE(can_manage_duty, 0) AS can_manage_duty FROM notice_operators ORDER BY added_at DESC`, [], (err, rows) => resolve(rows || []));
  });
});

ipcMain.handle('add-notice-operator', async (event, { username, password, displayName, canManageDuty }) => {
  return new Promise((resolve) => {
    const added_at = new Date().toISOString();
    const password_hash = hashPassword(password);
    const dutyFlag = canManageDuty ? 1 : 0;
    db.run(
      `INSERT OR REPLACE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty) VALUES (?, ?, ?, ?, ?)`,
      [username, password_hash, displayName, added_at, dutyFlag],
      (err) => {
        if (!err) {
          broadcastToOnlinePeers({
            type: 'OPERATOR_ADD',
            operator: { username, password_hash, display_name: displayName, added_at, can_manage_duty: dutyFlag }
          });
        }
        resolve({ success: !err });
      }
    );
  });
});

ipcMain.handle('set-notice-operator-duty-perm', async (event, { username, canManageDuty }) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 인증이 필요합니다.' };
  return new Promise((resolve) => {
    const flag = canManageDuty ? 1 : 0;
    db.run(`UPDATE notice_operators SET can_manage_duty = ? WHERE username = ?`, [flag, username], (err) => {
      if (!err) broadcastToOnlinePeers({ type: 'OPERATOR_DUTY_PERM', username, canManageDuty: !!flag });
      resolve({ success: !err });
    });
  });
});

ipcMain.handle('delete-notice-operator', async (event, username) => {
  return new Promise((resolve) => {
    db.run(`DELETE FROM notice_operators WHERE username = ?`, [username], (err) => {
      if (!err) broadcastToOnlinePeers({ type: 'OPERATOR_DELETE', username });
      resolve({ success: !err });
    });
  });
});

ipcMain.handle('notice-operator-login', async (event, { username, password }) => {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM notice_operators WHERE username = ?`, [username], (err, row) => {
      if (!row || row.password_hash !== hashPassword(password)) {
        resolve({ success: false, msg: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        return;
      }
      resolve({
        success: true,
        displayName: row.display_name,
        canManageDuty: !!(row.can_manage_duty)
      });
    });
  });
});

ipcMain.handle('get-chat-pin', async (event, channelKey) => {
  const key = String(channelKey || '').trim();
  if (!key) return null;
  return new Promise((resolve) => {
    db.get(`SELECT * FROM chat_pins WHERE channel_key = ?`, [key], (err, row) => resolve(row || null));
  });
});

ipcMain.handle('set-chat-pin', async (event, payload) => {
  const pin = payload || {};
  const channel_key = String(pin.channelKey || pin.channel_key || '').trim();
  if (!channel_key) return { success: false, msg: '채널을 찾을 수 없습니다.' };
  const row = {
    channel_key,
    msg_uid: String(pin.msgUid || pin.msg_uid || ''),
    message_html: String(pin.messageHtml || pin.message_html || ''),
    preview_text: String(pin.previewText || pin.preview_text || '').slice(0, 240),
    sender_name: String(pin.senderName || pin.sender_name || ''),
    pinned_at: new Date().toISOString(),
    pinned_by_name: String(pin.pinnedByName || pin.pinned_by_name || myProfile.username || ''),
    pinned_by_ip: MY_IP
  };
  upsertChatPinRow(row, true);
  return { success: true, pin: row };
});

ipcMain.handle('clear-chat-pin', async (event, channelKey) => {
  const key = String(channelKey || '').trim();
  if (!key) return { success: false };
  upsertChatPinRow({ channel_key: key, _clear: true }, true);
  return { success: true };
});

ipcMain.handle('get-duty-roster', async (event, dateStr) => {
  const date = String(dateStr || '').trim();
  return new Promise((resolve) => {
    if (date) {
      db.all(`SELECT * FROM duty_roster WHERE date_str = ? ORDER BY kind ASC, name ASC`, [date], (err, rows) => {
        resolve(rows || []);
      });
      return;
    }
    db.all(`SELECT * FROM duty_roster ORDER BY date_str DESC, kind ASC, name ASC`, [], (err, rows) => {
      resolve(rows || []);
    });
  });
});

ipcMain.handle('set-duty-roster-for-date', async (event, payload) => {
  const p = payload || {};
  return replaceDutyRosterForDate(p.dateStr, p.dutyNames || [], p.offNames || [], {
    byName: p.byName || myProfile.username || '',
    byIp: MY_IP
  });
});

ipcMain.handle('get-schedules', async () => {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM hospital_schedules ORDER BY time_str ASC`, [], (err, rows) => {
      if (err) {
        logDbErr(err);
        resolve([]);
        return;
      }
      resolve(rows || []);
    });
  });
});

const SCHEDULE_EXCEL_HEADERS = ['RM', '병동', '호실', '환자명', '구분', '목적', '비고', '출발시간', '귀원시간', '등록자'];

function buildScheduleCsvContent(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [SCHEDULE_EXCEL_HEADERS.join(',')];
  (rows || []).forEach((r) => {
    lines.push(SCHEDULE_EXCEL_HEADERS.map((h) => esc(r[h])).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

ipcMain.handle('export-schedule-board-excel', async (event, payload) => {
  const { dateFileLabel, sheets, boardDate, includeSampleSheets } = payload || {};
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return { success: false, msg: '내보낼 일정이 없습니다.' };
  }
  const label = (dateFileLabel || 'export').replace(/[^\d-]/g, '') || 'export';
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const dialogParent =
    senderWin && !senderWin.isDestroyed()
      ? senderWin
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : undefined;
  const { canceled, filePath } = await dialog.showSaveDialog(dialogParent, {
    title: '병동 일정 엑셀 저장',
    defaultPath: path.join(app.getPath('downloads'), `병동일정_${label}.xlsx`),
    filters: [
      { name: 'Excel 통합 문서', extensions: ['xlsx'] },
      { name: 'CSV (엑셀 호환)', extensions: ['csv'] }
    ]
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv') {
      const allRows = sheets.flatMap((s) => s.rows || []);
      await fs.promises.writeFile(filePath, buildScheduleCsvContent(allRows), 'utf8');
      return { success: true, path: filePath, format: 'csv' };
    }
    const outPath = ext === '.xlsx' ? filePath : `${filePath}.xlsx`;
    const buildXlsxBuffer = loadScheduleXlsxBuilder();
    if (!buildXlsxBuffer) {
      return {
        success: false,
        msg: '엑셀 생성 파일(lib/minimal-xlsx.js)이 없습니다. 공유폴더에 lib 폴더가 있는지 확인하거나 ZIP으로 다시 설치해 주세요.'
      };
    }
    const buf = buildXlsxBuffer(sheets, SCHEDULE_EXCEL_HEADERS, {
      boardDate: boardDate || '',
      includeSampleSheets: includeSampleSheets === true
    });
    await fs.promises.writeFile(outPath, buf);
    return { success: true, path: outPath, format: 'xlsx' };
  } catch (err) {
    return { success: false, msg: err.message || String(err) };
  }
});

ipcMain.handle('set-notice-operator-session', async (event, active) => {
  noticeOperatorSessionActive = !!active;
  return { success: true };
});

function scheduleModifyAllowed(uid) {
  return new Promise((resolve) => {
    if (noticeOperatorSessionActive || masterSessionActive) {
      resolve(true);
      return;
    }
    resolve(false);
  });
}

ipcMain.handle('add-schedule', async (event, payload) => {
  return new Promise((resolve) => {
    if (!noticeOperatorSessionActive && !masterSessionActive) {
      resolve({ success: false, msg: '작성 권한자로 로그인한 뒤 일정을 등록할 수 있습니다.' });
      return;
    }
    const p = payload || {};
    const meta = schedulePatientMetaFromPayload(p);
    const und = scheduleTimeUndecidedFromPayload(p);
    const meal = scheduleMealCancelFromPayload(p);
    const remark = scheduleRemarkFromPayload(p);
    const guardianOnly = scheduleGuardianOnlyFromPayload(p);
    const record = {
      uid: `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: p.type,
      title: p.title,
      time_str: p.timeStr,
      author_name: myProfile.username,
      author_ip: MY_IP,
      created_at: new Date().toISOString(),
      remind_before: p.remindBefore ? 1 : 0,
      attending_physician: p.attendingPhysician || '',
      time_end_str: p.timeEndStr || '',
      ward: meta.ward,
      rm_team: meta.rm_team,
      room_no: meta.room_no,
      patient_name: meta.patient_name,
      time_start_undecided: und.time_start_undecided,
      time_end_undecided: und.time_end_undecided,
      meal_cancel_breakfast: meal.meal_cancel_breakfast,
      meal_cancel_lunch: meal.meal_cancel_lunch,
      meal_cancel_dinner: meal.meal_cancel_dinner,
      remark,
      guardian_only: guardianOnly
    };
    db.run(
      `INSERT INTO hospital_schedules (uid, type, title, time_str, author_name, author_ip, created_at, remind_before, attending_physician, time_end_str, ward, rm_team, room_no, patient_name, time_start_undecided, time_end_undecided, meal_cancel_breakfast, meal_cancel_lunch, meal_cancel_dinner, remark, guardian_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.uid, record.type, record.title, record.time_str, record.author_name, record.author_ip, record.created_at, record.remind_before, record.attending_physician, record.time_end_str, record.ward, record.rm_team, record.room_no, record.patient_name, record.time_start_undecided, record.time_end_undecided, record.meal_cancel_breakfast, record.meal_cancel_lunch, record.meal_cancel_dinner, record.remark, record.guardian_only],
      (err) => {
        if (!err) {
          broadcastToOnlinePeers({ type: 'SCHEDULE_ADD', schedule: record });
          notifySchedulesChanged();
        }
        resolve(err ? { success: false, msg: err.message || '등록 실패' } : { success: true, ...record });
      }
    );
  });
});

ipcMain.handle('delete-schedule', async (event, uid) => {
  const allowed = await scheduleModifyAllowed(uid);
  if (!allowed) {
    return { success: false, msg: '작성 권한자로 로그인한 뒤 일정을 삭제할 수 있습니다.' };
  }
  return new Promise((resolve) => {
    db.run(`DELETE FROM hospital_schedules WHERE uid = ?`, [uid], (err) => {
      if (!err) {
        broadcastToOnlinePeers({ type: 'SCHEDULE_DELETE', uid });
        notifySchedulesChanged();
      }
      resolve({ success: !err });
    });
  });
});

ipcMain.handle('edit-schedule', async (event, payload) => {
  const p = payload || {};
  const uid = p.uid;
  if (!uid) return { success: false, msg: '일정 ID가 없습니다.' };
  const allowed = await scheduleModifyAllowed(uid);
  if (!allowed) {
    return { success: false, msg: '작성 권한자로 로그인한 뒤 일정을 수정할 수 있습니다.' };
  }
  return new Promise((resolve) => {
    const meta = schedulePatientMetaFromPayload(p);
    const und = scheduleTimeUndecidedFromPayload(p);
    const meal = scheduleMealCancelFromPayload(p);
    const remark = scheduleRemarkFromPayload(p);
    const guardianOnly = scheduleGuardianOnlyFromPayload(p);
    const attending = p.attendingPhysician || '';
    const timeEnd = p.timeEndStr || '';
    const audit = scheduleModificationAudit();
    db.run(
      `UPDATE hospital_schedules SET type = ?, title = ?, time_str = ?, remind_before = ?, attending_physician = ?, time_end_str = ?, ward = ?, rm_team = ?, room_no = ?, patient_name = ?, time_start_undecided = ?, time_end_undecided = ?, meal_cancel_breakfast = ?, meal_cancel_lunch = ?, meal_cancel_dinner = ?, remark = ?, guardian_only = ?, modified_at = ?, modified_by_name = ?, modified_by_ip = ? WHERE uid = ?`,
      [p.type, p.title, p.timeStr, p.remindBefore ? 1 : 0, attending, timeEnd, meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly, audit.modified_at, audit.modified_by_name, audit.modified_by_ip, p.uid],
      (err) => {
        if (!err) {
          broadcastToOnlinePeers({
            type: 'SCHEDULE_EDIT',
            schedule: {
              uid: p.uid, type: p.type, title: p.title, time_str: p.timeStr,
              remind_before: p.remindBefore ? 1 : 0, attending_physician: attending, time_end_str: timeEnd,
              ward: meta.ward, rm_team: meta.rm_team, room_no: meta.room_no, patient_name: meta.patient_name,
              time_start_undecided: und.time_start_undecided, time_end_undecided: und.time_end_undecided,
              meal_cancel_breakfast: meal.meal_cancel_breakfast, meal_cancel_lunch: meal.meal_cancel_lunch, meal_cancel_dinner: meal.meal_cancel_dinner,
              remark,
              guardian_only: guardianOnly,
              modified_at: audit.modified_at, modified_by_name: audit.modified_by_name, modified_by_ip: audit.modified_by_ip
            }
          });
          notifySchedulesChanged();
        }
        resolve({ success: !err });
      }
    );
  });
});

ipcMain.handle('create-group-chat', async (event, { name, memberIps }) => {
  return new Promise((resolve) => {
    const memberSet = new Map();
    memberSet.set(MY_IP, memberSnapshotFromIp(MY_IP));
    (memberIps || []).forEach(ip => {
      memberSet.set(ip, memberSnapshotFromIp(ip));
    });
    const record = {
      uid: `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name: name || '그룹 대화방',
      members: JSON.stringify([...memberSet.values()]),
      created_by: myProfile.username,
      created_at: new Date().toISOString()
    };
    db.run(
      `INSERT INTO group_chats (uid, name, members, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      [record.uid, record.name, record.members, record.created_by, record.created_at],
      (err) => {
        logDbErr(err);
        if (!err) {
          const memberIpsOnly = [...memberSet.keys()];
          sendToIps(memberIpsOnly, { type: 'GROUP_SYNC', group: record });
          memberIpsOnly.forEach((ip) => {
            if (ip === MY_IP) return;
            const m = memberSet.get(ip);
            broadcastGroupJoinNotice(record.uid, record.name, m ? m.username : ip, memberIpsOnly);
          });
        }
        resolve(record);
      }
    );
  });
});

ipcMain.handle('get-group-chats', async () => {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM group_chats`, [], (err, rows) => {
      if (err) { logDbErr(err); resolve([]); return; }
      const mine = (rows || []).filter(g => {
        try { return JSON.parse(g.members).some(m => m.ip === MY_IP); } catch (e) { return false; }
      });
      resolve(mine.map((g) => ({ ...g, members: enrichGroupMembersJson(g.members) })));
    });
  });
});

ipcMain.handle('add-group-member', async (event, { uid, ip }) => {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM group_chats WHERE uid = ?`, [uid], (err, row) => {
      if (err || !row) { resolve({ success: false }); return; }
      let members = [];
      try { members = JSON.parse(row.members); } catch (e) {}
      const alreadyMember = members.some((m) => m.ip === ip);
      if (!alreadyMember) {
        members.push(memberSnapshotFromIp(ip));
      }
      const membersJson = enrichGroupMembersJson(JSON.stringify(members));
      const addedMember = members.find((m) => m.ip === ip);
      db.run(`UPDATE group_chats SET members = ? WHERE uid = ?`, [membersJson, uid], (err2) => {
        logDbErr(err2);
        if (!err2) {
          const updated = { ...row, members: membersJson };
          const memberIps = members.map((m) => m.ip);
          sendToIps(memberIps, { type: 'GROUP_SYNC', group: updated });
          if (!alreadyMember && addedMember) {
            broadcastGroupJoinNotice(uid, row.name, addedMember.username, memberIps);
          }
        }
        resolve({ success: !err2 });
      });
    });
  });
});

ipcMain.handle('rename-group-chat', async (event, { uid, name }) => {
  return new Promise((resolve) => {
    const newName = (name || '').trim();
    if (!newName) { resolve({ success: false, msg: '대화방 이름을 입력해 주세요.' }); return; }
    db.get(`SELECT * FROM group_chats WHERE uid = ?`, [uid], (err, row) => {
      if (err || !row) { resolve({ success: false }); return; }
      const oldName = row.name;
      db.run(`UPDATE group_chats SET name = ? WHERE uid = ?`, [newName, uid], (err2) => {
        logDbErr(err2);
        if (!err2) {
          let members = [];
          try { members = JSON.parse(row.members); } catch (e) {}
          const updated = { ...row, name: newName };
          sendToIps(members.map(m => m.ip), { type: 'GROUP_SYNC', group: updated });
          // 이름 변경 사실을 다른 참여자들에게도 대화창에 눈에 띄게 남긴다.
          const noticeText = `${SYSTEM_NOTICE_PREFIX}${myProfile.username}님이 대화방 이름을 '${oldName}'에서 '${newName}'(으)로 변경했습니다.`;
          logGroupSystemNotice(uid, newName, noticeText);
          if (mainWindow) {
            const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            safeWebContentsSend('receive-group-message', {
              uid, senderName: '시스템', senderIP: MY_IP, message: noticeText, createdAt: currentTime
            });
          }
          sendToIps(members.map(m => m.ip).filter(ip => ip !== MY_IP), { type: 'GROUP_RENAME_NOTICE', uid, newName, noticeText });
        }
        resolve({ success: !err2, name: newName });
      });
    });
  });
});

ipcMain.handle('leave-group-chat', async (event, { uid }) => {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM group_chats WHERE uid = ?`, [uid], (err, row) => {
      if (err || !row) { resolve({ success: false }); return; }
      let members = [];
      try { members = JSON.parse(row.members); } catch (e) {}
      const remainingMembers = members.filter(m => m.ip !== MY_IP);
      const membersJson = JSON.stringify(remainingMembers);
      db.run(`DELETE FROM group_chats WHERE uid = ?`, [uid], (err2) => {
        logDbErr(err2);
        if (!err2) {
          // 남은 멤버들에게는 내가 빠진 최신 멤버 목록을 보내 화면에 반영시킨다.
          const updated = { ...row, members: membersJson };
          sendToIps(remainingMembers.map(m => m.ip), { type: 'GROUP_SYNC', group: updated });
        }
        resolve({ success: !err2 });
      });
    });
  });
});

ipcMain.handle('send-group-message', async (event, { uid, groupName, message }) => {
  return new Promise((resolve) => {
    const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgUid = generateMsgUid();
    extractAndSaveAttachments(message);
    db.get(`SELECT * FROM group_chats WHERE uid = ?`, [uid], (err, row) => {
      if (!err && row) {
        let members = [];
        try { members = JSON.parse(row.members); } catch (e) {}
        sendToIps(members.map(m => m.ip), { type: 'GROUP_MESSAGE', uid, groupName: row.name, sender: myProfile.username, message, msgUid });
      }
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
        [senderLabelForMe(), MY_IP, `GROUP:${uid}`, message, msgUid],
        function (err) {
          logDbErr(err);
          appendChatLog(`GROUP:${uid}`, (row && row.name) || groupName || '그룹', myProfile.username, message);
          resolve({ status: 'SENT', createdAt, uid: msgUid, id: this.lastID });
        }
      );
    });
  });
});

ipcMain.handle('get-notification-preview-setting', async () => showNotificationPreview);

ipcMain.handle('get-spellcheck-enabled', async () => spellCheckerEnabled);
ipcMain.handle('set-spellcheck-enabled', async (event, enabled) => {
  spellCheckerEnabled = !!enabled;
  initSpellCheckerSession();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.session.setSpellCheckerEnabled(spellCheckerEnabled);
    } catch (e) { /* ignore */ }
  }
  return spellCheckerEnabled;
});

ipcMain.handle('get-profile-photo', async (event, ip) => profilePhotoForIp(ip));

// ✏️ 메시지 수정/삭제: targetIP는 1:1·채널(BROADCAST/DEPT:/FLOOR:)일 때, groupUid는 그룹일 때.
// newMessage에 화면 쪽에서 만든 "삭제됨" 표시 문구를 넣어서 호출하면 사실상 "삭제"가 된다 (기록은 남기되 내용만 대체).
ipcMain.handle('edit-message', async (event, { msgUid, targetIP, groupUid, newMessage }) => {
  return new Promise((resolve) => {
    if (!msgUid) { resolve({ success: false, msg: '메시지를 찾을 수 없습니다.' }); return; }
    db.run(`UPDATE messages SET message = ? WHERE msg_uid = ? AND sender_ip = ?`, [newMessage, msgUid, MY_IP], function (err) {
      if (err) { resolve({ success: false, msg: err.message }); return; }
      if (this.changes === 0) {
        resolve({ success: false, msg: '메시지를 찾을 수 없습니다. (오래된 메시지이거나 다른 PC에서 보낸 경우 수정할 수 없습니다.)' });
        return;
      }
      const editPayload = { type: 'MESSAGE_EDIT', msgUid, newMessage };
      const resolvedGroupUid = groupUid || (typeof targetIP === 'string' && targetIP.startsWith('GROUP:') ? targetIP.slice(6) : null);
      if (resolvedGroupUid) {
        db.get(`SELECT * FROM group_chats WHERE uid = ?`, [resolvedGroupUid], (err2, row) => {
          if (!err2 && row) {
            let members = [];
            try { members = JSON.parse(row.members); } catch (e) {}
            sendToIps(members.map(m => m.ip), editPayload);
          }
        });
      } else if (targetIP === 'BROADCAST') {
        broadcastToOnlinePeers(editPayload);
      } else if (typeof targetIP === 'string' && targetIP.startsWith('DEPT:')) {
        const dept = targetIP.slice(5);
        const ips = [];
        onlineUsers.forEach((u, ip) => {
          if (ip !== MY_IP && u.dept === dept) ips.push(ip);
        });
        sendToIps(ips, editPayload);
      } else if (typeof targetIP === 'string' && targetIP.startsWith('FLOOR:')) {
        const floor = targetIP.slice(6);
        const ips = [];
        onlineUsers.forEach((u, ip) => {
          if (ip !== MY_IP && u.floor === floor) ips.push(ip);
        });
        sendToIps(ips, editPayload);
      } else if (targetIP) {
        sendToIps([targetIP], editPayload);
      }
      resolve({ success: true });
    });
  });
});

function handleIncomingMessageEdit(payload) {
  if (!payload || !payload.msgUid) return;
  db.run(`UPDATE messages SET message = ? WHERE msg_uid = ?`, [payload.newMessage, payload.msgUid], logDbErr);
  if (mainWindow) {
    safeWebContentsSend('message-edited', { msgUid: payload.msgUid, newMessage: payload.newMessage });
  }
}

function fetchReactionSummariesForKeys(keys, callback) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  if (!unique.length) { callback({}); return; }
  const placeholders = unique.map(() => '?').join(',');
  db.all(
    `SELECT msg_key, emoji, reactor_ip, reactor_name FROM message_reactions WHERE msg_key IN (${placeholders})`,
    unique,
    (err, rows) => {
      if (err) { logDbErr(err); callback({}); return; }
      const byKey = {};
      (rows || []).forEach(r => {
        if (!byKey[r.msg_key]) byKey[r.msg_key] = [];
        byKey[r.msg_key].push(r);
      });
      const result = {};
      unique.forEach(k => { result[k] = summarizeReactionsForKey(byKey[k] || []); });
      callback(result);
    }
  );
}

function summarizeReactionsForKey(rows) {
  const byEmoji = {};
  let myEmoji = null;
  (rows || []).forEach(r => {
    if (!byEmoji[r.emoji]) byEmoji[r.emoji] = { emoji: r.emoji, count: 0, names: [] };
    byEmoji[r.emoji].count += 1;
    byEmoji[r.emoji].names.push(r.reactor_name || r.reactor_ip);
    if (r.reactor_ip === MY_IP) myEmoji = r.emoji;
  });
  return { chips: Object.values(byEmoji), myEmoji };
}

function broadcastReactionSync(payload, targetIP, groupUid) {
  const editPayload = { type: 'MESSAGE_REACTION', ...payload };
  const resolvedGroupUid = groupUid || (typeof targetIP === 'string' && targetIP.startsWith('GROUP:') ? targetIP.slice(6) : null);
  if (resolvedGroupUid) {
    db.get(`SELECT * FROM group_chats WHERE uid = ?`, [resolvedGroupUid], (err2, row) => {
      if (!err2 && row) {
        let members = [];
        try { members = JSON.parse(row.members); } catch (e) {}
        sendToIps(members.map(m => m.ip), editPayload);
      }
    });
  } else if (targetIP === 'BROADCAST') {
    broadcastToOnlinePeers(editPayload);
  } else if (typeof targetIP === 'string' && targetIP.startsWith('DEPT:')) {
    const dept = targetIP.slice(5);
    const ips = [];
    onlineUsers.forEach((u, ip) => { if (ip !== MY_IP && u.dept === dept) ips.push(ip); });
    sendToIps(ips, editPayload);
  } else if (typeof targetIP === 'string' && targetIP.startsWith('FLOOR:')) {
    const floor = targetIP.slice(6);
    const ips = [];
    onlineUsers.forEach((u, ip) => { if (ip !== MY_IP && u.floor === floor) ips.push(ip); });
    sendToIps(ips, editPayload);
  } else if (targetIP) {
    sendToIps([targetIP], editPayload);
  }
}

function handleIncomingMessageReaction(payload, senderIP) {
  if (!payload || !payload.msgKey) return;
  const reactorIP = payload.reactorIP || senderIP;
  const reactorName = formatSenderDisplay(payload.reactorName, reactorIP);
  if (payload.action === 'remove') {
    db.run(`DELETE FROM message_reactions WHERE msg_key = ? AND reactor_ip = ?`, [payload.msgKey, reactorIP], (err) => {
      logDbErr(err);
      fetchReactionSummariesForKeys([payload.msgKey], (map) => {
        if (mainWindow) {
          safeWebContentsSend('message-reaction-update', { msgKey: payload.msgKey, summary: map[payload.msgKey] || { chips: [], myEmoji: null } });
        }
      });
    });
    return;
  }
  if (!payload.emoji) return;
  db.run(
    `INSERT OR REPLACE INTO message_reactions (msg_key, emoji, reactor_ip, reactor_name) VALUES (?, ?, ?, ?)`,
    [payload.msgKey, payload.emoji, reactorIP, reactorName],
    (err) => {
      logDbErr(err);
      fetchReactionSummariesForKeys([payload.msgKey], (map) => {
        if (mainWindow) {
          safeWebContentsSend('message-reaction-update', { msgKey: payload.msgKey, summary: map[payload.msgKey] || { chips: [], myEmoji: null } });
        }
      });
    }
  );
}

ipcMain.handle('get-message-reactions', async (event, { keys }) => {
  return new Promise((resolve) => {
    fetchReactionSummariesForKeys(keys, resolve);
  });
});

ipcMain.handle('toggle-message-reaction', async (event, { msgKey, emoji, targetIP, groupUid }) => {
  return new Promise((resolve) => {
    if (!msgKey || !emoji) { resolve({ success: false }); return; }
    db.get(`SELECT emoji FROM message_reactions WHERE msg_key = ? AND reactor_ip = ?`, [msgKey, MY_IP], (err, row) => {
      if (err) { resolve({ success: false }); return; }
      // 같은 이모지를 다시 누르면 해제, 다른 이모지면 교체
      const remove = !!(row && String(row.emoji) === String(emoji));
      if (remove) {
        db.run(`DELETE FROM message_reactions WHERE msg_key = ? AND reactor_ip = ?`, [msgKey, MY_IP], (err2) => {
          if (err2) { resolve({ success: false }); return; }
          broadcastReactionSync({ msgKey, action: 'remove', reactorIP: MY_IP, reactorName: senderLabelForMe() }, targetIP, groupUid);
          fetchReactionSummariesForKeys([msgKey], (map) => {
            const summary = map[msgKey] || { chips: [], myEmoji: null };
            if (mainWindow) safeWebContentsSend('message-reaction-update', { msgKey, summary });
            resolve({ success: true, msgKey, reactions: summary });
          });
        });
        return;
      }
      db.run(
        `INSERT OR REPLACE INTO message_reactions (msg_key, emoji, reactor_ip, reactor_name) VALUES (?, ?, ?, ?)`,
        [msgKey, emoji, MY_IP, senderLabelForMe()],
        (err2) => {
          if (err2) { resolve({ success: false }); return; }
          broadcastReactionSync({ msgKey, action: 'set', emoji, reactorIP: MY_IP, reactorName: senderLabelForMe() }, targetIP, groupUid);
          fetchReactionSummariesForKeys([msgKey], (map) => {
            const summary = map[msgKey] || { chips: [], myEmoji: null };
            if (mainWindow) safeWebContentsSend('message-reaction-update', { msgKey, summary });
            resolve({ success: true, msgKey, reactions: summary });
          });
        }
      );
    });
  });
});

function handleMsgAck(payload) {
  if (!payload || !payload.msgUid) return;
  pendingResendInflight.delete(String(payload.msgUid));
  sentAckRetryCount.delete(String(payload.msgUid));
  db.run(
    `UPDATE messages SET status = 'DELIVERED' WHERE msg_uid = ? AND sender_ip = ? AND status IN ('PENDING', 'SENT')`,
    [payload.msgUid, MY_IP],
    (err) => {
      logDbErr(err);
      maybeCompactMessageRowByUid(payload.msgUid);
    }
  );
  if (mainWindow) {
    safeWebContentsSend('message-delivered', { msgUid: payload.msgUid });
    safeWebContentsSend('pending-status-update', { msgUid: payload.msgUid, status: 'DELIVERED' });
  }
}

ipcMain.handle('set-notification-preview-setting', async (event, enabled) => {
  showNotificationPreview = !!enabled;
  db.run(`UPDATE app_settings SET show_notification_preview = ? WHERE id = 1`, [showNotificationPreview ? 1 : 0], logDbErr);
  return true;
});

ipcMain.handle('get-message-notification-settings', async () => ({
  notifyIncomingMessages,
  notifyReadReceipts,
  toastDurationSeconds,
  incomingNotifyMode
}));

ipcMain.handle('set-message-notification-settings', async (event, settings) => {
  if (settings && typeof settings.notifyIncomingMessages === 'boolean') {
    notifyIncomingMessages = settings.notifyIncomingMessages;
  }
  if (settings && typeof settings.notifyReadReceipts === 'boolean') {
    notifyReadReceipts = settings.notifyReadReceipts;
  }
  if (settings && settings.toastDurationSeconds != null) {
    const n = parseInt(settings.toastDurationSeconds, 10);
    if (Number.isFinite(n)) toastDurationSeconds = Math.max(2, Math.min(60, n));
  }
  if (settings && (settings.incomingNotifyMode === 'toast' || settings.incomingNotifyMode === 'desktop')) {
    incomingNotifyMode = settings.incomingNotifyMode;
  }
  db.run(
    `UPDATE app_settings SET notify_incoming_messages = ?, notify_read_receipts = ?, toast_duration_seconds = ?, incoming_notify_mode = ? WHERE id = 1`,
    [notifyIncomingMessages ? 1 : 0, notifyReadReceipts ? 1 : 0, toastDurationSeconds, incomingNotifyMode],
    logDbErr
  );
  return { notifyIncomingMessages, notifyReadReceipts, toastDurationSeconds, incomingNotifyMode };
});

ipcMain.handle('get-app-version', async () => APP_VERSION);

ipcMain.handle('get-update-source-path', async () => {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  return updateSourcePath;
});

ipcMain.handle('set-update-source-path', async (event, folderPath) => {
  const next = normalizeUpdateSourcePath(folderPath || DEFAULT_UPDATE_SOURCE_PATH);
  const meta = parseUpdateSource(next);
  if (meta.kind !== 'github' && meta.kind !== 'folder') {
    return { success: false, msg: 'GitHub 주소 또는 Z/공유폴더 경로를 입력해 주세요.' };
  }
  persistUpdateSourcePath(next);
  // 옛 PC 브리지: Z 경로를 함께 알려 주면 Z만 아는 버전도 따라올 수 있다.
  const syncPath = meta.kind === 'folder' ? updateSourcePath : Z_BRIDGE_UPDATE_SOURCE_PATH;
  broadcastToOnlinePeers({ type: 'CONFIG_SYNC', updateSourcePath: syncPath });
  if (meta.kind === 'github') {
    // GitHub도 저장돼 있으니 로컬은 GitHub 유지. 피어에는 Z 브리지를 보낸다.
  }
  return { success: true, path: updateSourcePath };
});

ipcMain.handle('check-for-update', async () => {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  if (!updateSourcePath) return { available: false, msg: '업데이트 소스가 아직 설정되지 않았습니다.' };
  try {
    const raw = (await readUpdateSourceBytes('version.json')).toString('utf8');
    const remote = parseUpdateJsonText(raw);
    const available = compareVersions(remote.version, APP_VERSION) > 0;
    const src = parseUpdateSource(updateSourcePath);
    return {
      available,
      remoteVersion: remote.version,
      currentVersion: APP_VERSION,
      notes: remote.notes || '',
      sourceKind: src.kind
    };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { available: false, msg: '업데이트 소스에서 version.json을 찾을 수 없습니다. 경로(Z:\\...\\messenger)를 확인해 주세요.' };
    }
    const msg = String(e.message || e);
    if (/401|403|404|Bad credentials|Requires authentication|Not Found/i.test(msg)) {
      return {
        available: false,
        msg: 'GitHub 인증이 필요합니다. 「토큰 폴더 열기」→ github-update-token.txt 파일을 만들고 PAT(Contents 읽기)를 한 줄로 저장한 뒤 다시 확인해 주세요. (또는 업데이트 소스를 Z:\\...\\messenger 로 두세요)'
      };
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|응답 시간 초과/i.test(msg)) {
      return { available: false, msg: '업데이트 서버에 연결할 수 없습니다. 인터넷 또는 Z드라이브 연결을 확인해 주세요.' };
    }
    return { available: false, msg: '업데이트 확인 중 오류가 발생했습니다: ' + msg };
  }
});

async function applyUpdateFiles() {
  // package.json을 포함해야 버전 번호(APP_VERSION)도 함께 갱신된다.
  const filesToUpdate = ['main.js', 'preload.js', 'index.html', 'package.json', 'version.json', 'toast.html', 'toast-preload.js', 'lib/minimal-xlsx.js'];
  const optionalAssets = ['assets/splash.png'];
  const backupDir = path.join(app.getPath('userData'), `pre_update_backup_${Date.now()}`);
  await fs.promises.mkdir(backupDir, { recursive: true });
  const fileResults = [];
  let expectedVersion = null;

  for (const f of filesToUpdate) {
    let remoteBuf;
    try {
      remoteBuf = await readUpdateSourceBytes(f);
    } catch (e) {
      fileResults.push({ file: f, copied: false, reason: `GitHub에 없음/접근실패(${e.message})` });
      continue;
    }
    const localPath = path.join(__dirname, f);
    if (f === 'package.json') {
      try {
        const remotePkg = parseUpdateJsonText(remoteBuf.toString('utf8'));
        expectedVersion = remotePkg.version;
      } catch (e) {}
    }
    try {
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      await fs.promises.access(localPath);
      await fs.promises.copyFile(localPath, path.join(backupDir, f.replace(/\//g, '_')));
    } catch (e) {}
    try {
      await writeBufferWithRetry(localPath, remoteBuf);
      fileResults.push({ file: f, copied: true });
    } catch (e) {
      const lockErr = e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
      if (lockErr) {
        try {
          await stagePendingUpdateBuffer(f, remoteBuf);
          fileResults.push({ file: f, copied: true, pendingRestart: true });
          console.warn(`[업데이트] ${f} 사용 중 — 재시작 후 적용 예약됨`);
          continue;
        } catch (e2) {
          fileResults.push({ file: f, copied: false, reason: e2.message });
          console.error(`[업데이트] ${f} 보류 저장 실패:`, e2.message);
          continue;
        }
      }
      fileResults.push({ file: f, copied: false, reason: e.message });
      console.error(`[업데이트] ${f} 복사 실패:`, e.message);
    }
  }

  for (const rel of optionalAssets) {
    let remoteBuf;
    try {
      remoteBuf = await readUpdateSourceBytes(rel);
    } catch (e) {
      fileResults.push({ file: rel, copied: false, reason: 'GitHub에 없음(선택)' });
      continue;
    }
    const localPath = path.join(__dirname, rel);
    try {
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      try {
        await fs.promises.access(localPath);
        await fs.promises.copyFile(localPath, path.join(backupDir, rel.replace(/\//g, '_')));
      } catch (e) {}
      await writeBufferWithRetry(localPath, remoteBuf);
      fileResults.push({ file: rel, copied: true });
    } catch (e) {
      const lockErr = e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
      if (lockErr) {
        try {
          await stagePendingUpdateBuffer(rel, remoteBuf);
          fileResults.push({ file: rel, copied: true, pendingRestart: true });
          continue;
        } catch (e2) {
          fileResults.push({ file: rel, copied: false, reason: e2.message });
          continue;
        }
      }
      fileResults.push({ file: rel, copied: false, reason: e.message });
      console.error(`[업데이트] ${rel} 복사 실패:`, e.message);
    }
  }

  // 핵심 JS/HTML/package만 모두 복사되면 성공으로 본다. assets는 없으면 경고만.
  const requiredResults = fileResults.filter((r) => filesToUpdate.includes(r.file));
  // (예외 없이 끝났다고 해서 실제로 반영됐다는 보장은 없다 — 파일 잠금 등으로 조용히 실패할 수 있다.)
  let verifiedVersion = null;
  try {
    const localPkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'package.json'), 'utf8'));
    verifiedVersion = localPkg.version;
  } catch (e) {}

  const allCopied = requiredResults.every(r => r.copied);
  const versionMatches = !expectedVersion || verifiedVersion === expectedVersion;
  if (!allCopied || !versionMatches) {
    const failedFiles = fileResults.filter(r => !r.copied).map(r => `${r.file}(${r.reason})`).join(', ');
    console.error('[업데이트] 검증 실패 — 예상 버전:', expectedVersion, '/ 실제 버전:', verifiedVersion, '/ 실패한 파일:', failedFiles || '없음');
    throw new Error(
      !versionMatches
        ? `파일은 복사됐지만 버전이 반영되지 않았습니다 (예상 ${expectedVersion}, 실제 ${verifiedVersion}). 프로그램이 설치된 폴더의 쓰기 권한을 확인해 주세요.`
        : `다음 파일을 복사하지 못했습니다: ${failedFiles} (쓰기 권한을 확인해 주세요)`
    );
  }
}

ipcMain.handle('apply-update', async () => {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  if (!updateSourcePath) return { success: false, msg: '업데이트 소스가 설정되지 않았습니다.' };
  try {
    await applyUpdateFiles();
    setTimeout(() => { broadcastGoodbye(); isQuitting = true; app.relaunch(); app.exit(); }, 600);
    return { success: true };
  } catch (e) {
    return { success: false, msg: '업데이트 적용 중 오류가 발생했습니다: ' + e.message + ' (파일 접근 권한을 확인해 주세요)' };
  }
});

function verifyLocalMasterPassword(password) {
  return new Promise((resolve) => {
    db.get(`SELECT master_password FROM master_config WHERE id = 1`, (err, row) => {
      resolve(!!(row && String(row.master_password) === String(password || '')));
    });
  });
}

let forceUpdateInFlight = false;

async function handleForceUpdateCommand(payload, senderIP) {
  if (forceUpdateInFlight) {
    if (senderIP) {
      sendToIps([senderIP], {
        type: 'FORCE_UPDATE_RESULT',
        success: false,
        msg: '이미 강제 업데이트 진행 중',
        fromIp: MY_IP,
        version: APP_VERSION
      });
    }
    return;
  }
  const ok = await verifyLocalMasterPassword(payload && payload.masterPassword);
  if (!ok) {
    if (senderIP) {
      sendToIps([senderIP], {
        type: 'FORCE_UPDATE_RESULT',
        success: false,
        msg: '마스터 비밀번호가 올바르지 않습니다(대상 PC 설정과 동일해야 함)',
        fromIp: MY_IP,
        version: APP_VERSION
      });
    }
    return;
  }

  forceUpdateInFlight = true;
  safeWebContentsSend('force-update-started', {
    fromIp: senderIP || '',
    targetVersion: (payload && payload.targetVersion) || '',
    local: false
  });

  try {
    updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
    if (!updateSourcePath) throw new Error('업데이트 소스가 설정되지 않았습니다.');
    await applyUpdateFiles();
    if (senderIP) {
      sendToIps([senderIP], {
        type: 'FORCE_UPDATE_RESULT',
        success: true,
        msg: '업데이트 적용 후 재시작',
        fromIp: MY_IP,
        version: APP_VERSION
      });
    }
    setTimeout(() => { broadcastGoodbye(); isQuitting = true; app.relaunch(); app.exit(); }, 1200);
  } catch (e) {
    forceUpdateInFlight = false;
    safeWebContentsSend('force-update-failed', { msg: e.message || String(e) });
    if (senderIP) {
      sendToIps([senderIP], {
        type: 'FORCE_UPDATE_RESULT',
        success: false,
        msg: e.message || String(e),
        fromIp: MY_IP,
        version: APP_VERSION
      });
    }
  }
}

ipcMain.handle('master-force-update', async (event, payload) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  const p = payload || {};
  const password = String(p.password || '');
  if (!(await verifyLocalMasterPassword(password))) {
    return { success: false, msg: '마스터 비밀번호가 올바르지 않습니다.' };
  }

  const targetIp = String(p.targetIp || '').trim();
  const forcePayload = {
    type: 'FORCE_UPDATE',
    masterPassword: password,
    targetVersion: APP_VERSION,
    fromIp: MY_IP
  };

  // 이 PC
  if (!targetIp || targetIp === MY_IP || targetIp === 'SELF') {
    safeWebContentsSend('force-update-started', { fromIp: MY_IP, targetVersion: APP_VERSION, local: true });
    try {
      updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
      if (!updateSourcePath) return { success: false, msg: '업데이트 소스가 설정되지 않았습니다.' };
      await applyUpdateFiles();
      setTimeout(() => { broadcastGoodbye(); isQuitting = true; app.relaunch(); app.exit(); }, 800);
      return { success: true, local: true };
    } catch (e) {
      return { success: false, msg: e.message || String(e) };
    }
  }

  // 온라인 전체 (자기 자신 제외)
  if (targetIp === 'ALL' || targetIp === 'ALL_OUTDATED') {
    const ips = [];
    onlineUsers.forEach((u, ip) => {
      if (!ip || ip === MY_IP) return;
      if (targetIp === 'ALL_OUTDATED') {
        const ver = (u && u.appVersion) || '';
        if (!ver || ver === APP_VERSION) return;
        if (compareVersions(APP_VERSION, ver) <= 0) return;
      }
      ips.push(ip);
    });
    if (!ips.length) return { success: false, msg: targetIp === 'ALL_OUTDATED' ? '구버전으로 접속 중인 PC가 없습니다.' : '온라인 대상이 없습니다.' };
    sendToIps(ips, forcePayload);
    return { success: true, count: ips.length, ips };
  }

  if (!onlineUsers.has(targetIp)) {
    return { success: false, msg: '해당 PC가 온라인 목록에 없습니다.' };
  }
  sendToIps([targetIp], forcePayload);
  return { success: true, targetIp };
});

async function autoCheckAndApplyUpdate() {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  if (!updateSourcePath || !mainWindow) return;
  if (autoUpdateAlreadyApplied) return; // 이미 파일을 갈아끼우고 재시작 대기 중이면 다시 검사하지 않음
  let remote;
  try {
    const raw = (await readUpdateSourceBytes('version.json')).toString('utf8');
    remote = parseUpdateJsonText(raw);
    if (compareVersions(remote.version, APP_VERSION) <= 0) return;
  } catch (e) {
    // GitHub 접근 실패·version.json 없음은 조용히 넘어간다
    return;
  }

  try {
    // 새 버전을 발견하면 바로 파일을 교체해 둔다. (실제 반영은 재시작해야 이루어짐)
    await applyUpdateFiles();
    autoUpdateAlreadyApplied = true;
    pendingUpdateRemoteVersion = remote.version;
    safeWebContentsSend('auto-update-ready', {
      remoteVersion: remote.version,
      currentVersion: APP_VERSION,
      notes: remote.notes || '',
      countdownSeconds: 30
    });
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = setTimeout(() => {
      broadcastGoodbye();
      isQuitting = true;
      app.relaunch();
      app.exit();
    }, 30000);
  } catch (e) {
    // 파일 복사/검증이 실제로 실패한 경우는 화면에도 알려서 "준비됐다고 떴는데 반영이 안 된다"는
    // 혼란이 생기지 않도록 한다.
    safeWebContentsSend('auto-update-failed', { msg: e.message });
  }
}

ipcMain.handle('snooze-pending-restart', async (event, minutes) => {
  clearTimeout(pendingRestartTimer);
  const snoozeMs = (minutes || 30) * 60 * 1000;
  pendingRestartTimer = setTimeout(() => {
    if (mainWindow) {
      safeWebContentsSend('auto-update-ready', {
        remoteVersion: pendingUpdateRemoteVersion,
        currentVersion: APP_VERSION,
        countdownSeconds: 30
      });
    }
    pendingRestartTimer = setTimeout(() => { broadcastGoodbye(); isQuitting = true; app.relaunch(); app.exit(); }, 30000);
  }, snoozeMs);
  return true;
});

ipcMain.handle('restart-now-for-update', async () => {
  broadcastGoodbye();
  isQuitting = true;
  app.relaunch();
  app.exit();
});

function startUpdateChecker() {
  setTimeout(autoCheckAndApplyUpdate, 8000);
  setInterval(autoCheckAndApplyUpdate, 10 * 60 * 1000);
}

ipcMain.handle('set-auto-launch', async (event, enable) => {
  app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath('exe') });
  return true;
});

ipcMain.handle('get-auto-launch', async () => app.getLoginItemSettings().openAtLogin);

function getDefaultCompactBounds(width = COMPACT_DEFAULT_WIDTH, height = COMPACT_DEFAULT_HEIGHT) {
  const current = mainWindow ? mainWindow.getBounds() : { x: 0, y: 0, width, height };
  const display = screen.getDisplayNearestPoint({
    x: current.x + Math.min(80, Math.max(0, current.width / 2)),
    y: current.y + Math.min(80, Math.max(0, current.height / 2))
  });
  const area = display.workArea;
  return {
    x: area.x + Math.max(0, area.width - width - 20),
    y: area.y + Math.max(0, area.height - height - 20),
    width,
    height
  };
}

function clampBoundsToWorkArea(bounds, { minWidth = COMPACT_MIN_WIDTH, minHeight = COMPACT_MIN_HEIGHT, defaultWidth = COMPACT_DEFAULT_WIDTH, defaultHeight = COMPACT_DEFAULT_HEIGHT } = {}) {
  let width = Math.max(minWidth, Math.round(bounds.width || defaultWidth));
  let height = Math.max(minHeight, Math.round(bounds.height || defaultHeight));
  let x = Math.round(bounds.x);
  let y = Math.round(bounds.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return getDefaultCompactBounds(width, height);
  }

  let display = screen.getDisplayMatching({ x, y, width: 1, height: 1 });
  if (!display) display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;

  width = Math.min(width, area.width);
  height = Math.min(height, area.height);

  const visibleW = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
  const visibleH = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
  if (visibleW < 80 || visibleH < 80) {
    return getDefaultCompactBounds(width, height);
  }

  x = Math.min(Math.max(x, area.x), area.x + area.width - width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function prepareWindowForBoundsChange() {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  if (mainWindow.isMinimized()) mainWindow.restore();
}

ipcMain.handle('set-window-view-mode', async (event, mode, savedBounds) => {
  if (!mainWindow) return { success: false };
  prepareWindowForBoundsChange();
  currentViewMode = mode;

  if (mode === 'compact') {
    savedNormalWindowBounds = mainWindow.getBounds();
    mainWindow.setMinimumSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT);
    mainWindow.setAlwaysOnTop(false);

    let bounds;
    if (savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)) {
      bounds = clampBoundsToWorkArea({
        x: savedBounds.x,
        y: savedBounds.y,
        width: savedBounds.width || COMPACT_DEFAULT_WIDTH,
        height: savedBounds.height || COMPACT_DEFAULT_HEIGHT
      });
    } else {
      bounds = getDefaultCompactBounds();
    }
    mainWindow.setBounds(bounds);
    showAndFocusWindow();
    return { success: true, bounds };
  }

  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT);

  if (savedNormalWindowBounds) {
    const restored = clampBoundsToWorkArea(savedNormalWindowBounds, {
      minWidth: NORMAL_MIN_WIDTH,
      minHeight: NORMAL_MIN_HEIGHT,
      defaultWidth: 1200,
      defaultHeight: 800
    });
    mainWindow.setBounds(restored);
    savedNormalWindowBounds = null;
  } else {
    mainWindow.setSize(1200, 800);
    mainWindow.center();
  }
  showAndFocusWindow();
  return { success: true };
});

ipcMain.handle('get-window-bounds', async () => {
  if (!mainWindow) return null;
  return mainWindow.getBounds();
});

ipcMain.handle('backup-database', async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '데이터베이스 백업 저장',
    defaultPath: path.join(app.getPath('downloads'), `mirae_messenger_backup_${Date.now()}.db`),
    filters: [{ name: 'Database Files', extensions: ['db'] }]
  });
  if (filePath) {
    await checkpointWal();
    await fs.promises.copyFile(dbPath, filePath);
    return { success: true, path: filePath };
  }
  return { success: false };
});

ipcMain.handle('backup-chat-history', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '대화 백업을 저장할 폴더 선택',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths || !filePaths[0]) {
    return { success: false, canceled: true };
  }
  try {
    const parentDir = filePaths[0];
    const destRoot = path.join(parentDir, `mirae_chat_backup_${backupFolderTimestamp()}`);
    await fs.promises.mkdir(destRoot, { recursive: true });

    const messages = await queryAllMessagesForExport();
    const exportMeta = {
      app: 'Mirae Messenger',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: senderLabelForMe(),
      myIp: MY_IP,
      messageCount: messages.length
    };
    await fs.promises.writeFile(
      path.join(destRoot, 'messages.json'),
      JSON.stringify({ ...exportMeta, messages }, null, 2),
      'utf8'
    );
    await fs.promises.writeFile(path.join(destRoot, 'messages_readable.txt'), buildReadableChatExport(messages), 'utf8');
    await fs.promises.writeFile(path.join(destRoot, 'messages.csv'), buildCsvChatExport(messages), 'utf8');

    const logFileCount = await copyChatLogsDirectory(path.join(destRoot, 'chat_logs'));

    const readme = [
      'Mirae Messenger — 대화 내용 백업',
      '',
      `내보낸 시각: ${new Date().toLocaleString('ko-KR')}`,
      `메시지 ${messages.length}건 · 일별 텍스트 로그 ${logFileCount}개`,
      '',
      'messages.json — 전체 대화(원본 HTML 포함)',
      'messages_readable.txt — 채팅방별로 읽기 쉬운 텍스트',
      'messages.csv — 엑셀 등에서 열 수 있는 표 형식',
      'chat_logs/ — 대화별 일별 누적 텍스트 로그',
      '',
      '※ 첨부 파일·이미지는 별도 다운로드 폴더에 저장됩니다. 필요하면 환경설정의 파일 수신 폴더도 함께 백업하세요.'
    ].join('\n');
    await fs.promises.writeFile(path.join(destRoot, 'README.txt'), readme, 'utf8');

    return {
      success: true,
      path: destRoot,
      messageCount: messages.length,
      logFileCount
    };
  } catch (e) {
    console.error('대화 백업 오류:', e.message);
    return { success: false, msg: e.message || '백업 중 오류가 발생했습니다.' };
  }
});

const AUTO_BACKUP_RETENTION_DAYS = 14;

async function getAutoBackupDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  try {
    await fs.promises.access(dir);
  } catch (e) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  return dir;
}

async function performAutoBackupIfNeeded() {
  try {
    const dir = await getAutoBackupDir();
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayFile = path.join(dir, `auto_backup_${todayStr}.db`);
    let alreadyExists = true;
    try { await fs.promises.access(todayFile); } catch (e) { alreadyExists = false; }
    if (!alreadyExists) {
      await checkpointWal();
      await fs.promises.copyFile(dbPath, todayFile);
    }
    const cutoff = Date.now() - AUTO_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const names = await fs.promises.readdir(dir);
    for (const name of names) {
      if (!name.startsWith('auto_backup_')) continue;
      const filePath = path.join(dir, name);
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoff) await fs.promises.unlink(filePath);
    }
  } catch (e) {
    console.error('자동 백업 오류:', e.message);
  }
}

function startAutoBackup() {
  performAutoBackupIfNeeded();
  cleanupOldLogFiles();
  setInterval(performAutoBackupIfNeeded, 6 * 60 * 60 * 1000);
  setInterval(cleanupOldLogFiles, 6 * 60 * 60 * 1000);
}

ipcMain.handle('get-network-status', async () => ({
  myIp: MY_IP, udpStatus, tcpStatus, onlineCount: onlineUsers.size
}));

ipcMain.handle('refresh-users', async () => {
  registerSelf();
  loadProfileOverrides(() => loadPersistedKnownUsers(() => notifyUserList()));
  if (globalUdpSocket) broadcastPresence(globalUdpSocket);
  return true;
});

ipcMain.handle('open-user-data-folder', async () => {
  shell.showItemInFolder(dbPath);
  return true;
});

ipcMain.handle('open-files-folder', async () => {
  shell.openPath(getReceivedFilesDir());
  return true;
});

ipcMain.handle('schedule-message', async (event, { targetIP, isBroadcast, message, sendAt }) => {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO scheduled_messages (target_ip, is_broadcast, message, send_at, sent) VALUES (?, ?, ?, ?, 0)`,
      [targetIP, isBroadcast ? 1 : 0, message, sendAt],
      function (err) {
        resolve({ success: !err, id: err ? null : this.lastID });
      }
    );
  });
});

ipcMain.handle('get-scheduled-messages', async (event, targetIP) => {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM scheduled_messages WHERE target_ip = ? AND sent = 0 ORDER BY send_at ASC`, [targetIP], (err, rows) => resolve(rows || []));
  });
});

ipcMain.handle('cancel-scheduled-message', async (event, id) => {
  return new Promise((resolve) => {
    db.run(`DELETE FROM scheduled_messages WHERE id = ?`, [id], (err) => resolve({ success: !err }));
  });
});

function startScheduledMessageChecker() {
  checkAndSendDueScheduledMessages();
  setInterval(checkAndSendDueScheduledMessages, 15000);
}

function checkAndSendDueScheduledMessages() {
  const nowIso = new Date().toISOString();
  db.all(`SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?`, [nowIso], (err, rows) => {
    if (err || !rows || rows.length === 0) return;
    rows.forEach(dispatchScheduledMessage);
  });
}

function dispatchScheduledMessage(row) {
  db.run(`UPDATE scheduled_messages SET sent = 1 WHERE id = ?`, [row.id], logDbErr);
  const notifyRenderer = () => {
    if (mainWindow) {
      safeWebContentsSend('scheduled-message-sent', {
        targetIP: row.is_broadcast ? 'BROADCAST' : row.target_ip,
        message: row.message,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  };

  if (row.is_broadcast) {
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status) VALUES (?, ?, 'BROADCAST', ?, 'SENT')`,
      [senderLabelForMe(), MY_IP, row.message],
      () => {
        broadcastToOnlinePeers({ type: 'BROADCAST', sender: myProfile.username, message: row.message });
        notifyRenderer();
      }
    );
    appendChatLog('BROADCAST', '전체공지', myProfile.username, row.message);
    return;
  }

  const client = new net.Socket();
  let isConnected = false;
  client.setTimeout(900);
  const partnerName = (allKnownUsers.get(row.target_ip) || {}).username || row.target_ip;

  client.connect(TCP_PORT, row.target_ip, () => {
    isConnected = true;
    client.write(JSON.stringify({ type: 'CHAT', sender: myProfile.username, message: row.message }) + '\n');
    client.end();
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status) VALUES (?, ?, ?, ?, 'SENT')`,
      [senderLabelForMe(), MY_IP, row.target_ip, row.message],
      notifyRenderer
    );
    appendChatLog(`DM_${row.target_ip}`, partnerName, myProfile.username, row.message);
  });

  const handleFailure = () => {
    if (isConnected) return;
    client.destroy();
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status) VALUES (?, ?, ?, ?, 'PENDING')`,
      [senderLabelForMe(), MY_IP, row.target_ip, row.message],
      notifyRenderer
    );
    appendChatLog(`DM_${row.target_ip}`, partnerName, myProfile.username, row.message);
  };
  client.on('timeout', handleFailure);
  client.on('error', handleFailure);
}