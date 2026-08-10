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
let startMobileServer = null;
try {
  startMobileServer = require('./mobile_server').startMobileServer;
} catch (e) {
  console.warn('[mobile] mobile_server.js 로드 실패:', e && e.message ? e.message : e);
}

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

try {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} catch (e) { /* ignore */ }
if (process.env.MIRAE_DISABLE_GPU === '1') {
  try { app.disableHardwareAcceleration(); } catch (e) { /* ignore */ }
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
// ⚠️ 실사고: 아래 두 핸들러가 console.error로만 남기고 있어서, 원인 모를 재시작이 실제로
// 일어나도 로그 파일(messenger_*.log)에는 아무 흔적이 없었다 — 사용자가 보내준 로그를 봐도
// 원인을 알 수 없었던 이유. writeToLogFile은 함수 선언(hoisting)이라 이 시점에 이미 호출 가능.
process.on('uncaughtException', (err) => {
  console.error('❌ 처리되지 않은 예외(무시하고 계속 진행):', err);
  try { writeToLogFile('error', '처리되지 않은 예외: ' + (err && err.stack ? err.stack : err)); } catch (e) { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ 처리되지 않은 Promise 거부(무시하고 계속 진행):', reason);
  try { writeToLogFile('error', '처리되지 않은 Promise 거부: ' + (reason && reason.stack ? reason.stack : reason)); } catch (e) { /* ignore */ }
});

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

let mainWindow;
let scheduleBoardWindow = null;
let excalidrawWindow = null;
let excalidrawSession = null;
/** 렌더러 작성자/공지 작성 권한 로그인 — 타인 일정 수정·삭제 허용 */
let noticeOperatorSessionActive = false;
/** 마스터 관리자 UI 로그인 (렌더러 verify-master-auth 성공 시) */
let masterSessionActive = false;
/** 이 PC 메신저 사용 중지(잠금) — true면 접속·프레즌스 중단, 마스터 인증으로만 해제 */
let localUsageDisabled = false;
let localUsageLockMeta = { disabledAt: '', disabledByIp: '', reason: '' };
/** 전체 서비스 일시중지 — 마스터가 켜고 끔(기본 OFF). 메시지·재개일은 관리자 창에서 편집 */
const SERVICE_PAUSE_DEFAULTS = {
  title: '메신저 일시 중지 안내',
  body: '현재 작동하고 있는 메신저는 8월 18일 이후에 사용 예정되어 있습니다.',
  contact: '문의 및 요청사항이 있는 경우 내선번호 1030(물리치료실장)으로 연락주시면 감사하겠습니다.',
  untilLabel: '2026년 8월 18일'
};
let servicePause = {
  enabled: false,
  title: SERVICE_PAUSE_DEFAULTS.title,
  body: SERVICE_PAUSE_DEFAULTS.body,
  contact: SERVICE_PAUSE_DEFAULTS.contact,
  untilLabel: SERVICE_PAUSE_DEFAULTS.untilLabel,
  updatedAt: '',
  revision: 0
};
/** 이 PC에서 마스터로 해제한 revision — 현재 revision과 같으면 잠금 해제 */
let servicePauseBypassRevision = 0;
/** 마스터가 사용 중지한 다른 PC (IP → meta) — 관리 화면 표시·원격 명령용 */
const disabledClients = new Map();
/** 작성자 세션이 당직·주치의 OFF(일정등록) 권한을 갖는지 */
let noticeOperatorCanManageDutySession = false;
/** 작성 권한자 세션 표시 이름·아이디 — 본인 작성물 수정/삭제 판별용 */
let noticeOperatorDisplayNameSession = '';
let noticeOperatorUsernameSession = '';
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

/** Promise에 타임아웃을 건다. 만료 시 reject (원본 작업은 백그라운드에 남을 수 있음). */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timeout ${ms}ms`)), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    timeoutPromise
  ]);
}

/** OneDrive·Dropbox 등 클라우드 동기화 경로 — 파일 잠금으로 Electron '응답 없음' 유발 */
function isCloudSyncedPath(p) {
  const s = String(p || '').replace(/\//g, '\\').toLowerCase();
  if (!s) return false;
  return (
    s.includes('\\onedrive')
    || s.includes('\\dropbox')
    || s.includes('\\google drive')
    || s.includes('\\googledrive')
    || s.includes('\\icloud')
    || s.includes('\\box\\')
    || /\\box sync\\/i.test(s)
  );
}

function isCloudSyncedInstallPath() {
  try {
    return isCloudSyncedPath(__dirname) || isCloudSyncedPath(process.execPath || '');
  } catch (e) {
    return false;
  }
}

function getInstallPathInfo() {
  const root = String(__dirname || '');
  const cloud = isCloudSyncedInstallPath();
  return {
    root,
    cloudSynced: cloud,
    oneDrive: /onedrive/i.test(root.replace(/\//g, '\\')),
    warning: cloud
      ? '설치 폴더가 OneDrive/클라우드 동기화 경로입니다. 파일 잠금으로 응답 없음이 날 수 있으니 로컬 디스크(예: C:\\Apps)로 옮겨 주세요.'
      : ''
  };
}

/**
 * AppData가 OneDrive면 SQLite/preload마다 메인스레드가 멈춰 로딩 커서만 돈다.
 * C:\\Apps\\Mirae Messenger 설치본은 userData를 같은 디스크의 userdata로 고정한다.
 */
function ensureAppsLocalUserData() {
  if (process.platform !== 'win32') return;
  try {
    const preferred = 'C:\\Apps\\Mirae Messenger\\userdata';
    const exec = String(process.execPath || '').replace(/\//g, '\\').toLowerCase();
    const dirn = String(__dirname || '').replace(/\//g, '\\').toLowerCase();
    const underApps = exec.includes('\\apps\\mirae messenger\\') || dirn.includes('\\apps\\mirae messenger\\');
    let prev = '';
    try { prev = app.getPath('userData'); } catch (e) { prev = ''; }
    const cloudPrev = isCloudSyncedPath(prev) || isCloudSyncedPath(process.env.APPDATA || '');
    if (!underApps && !cloudPrev) return;

    try { fs.mkdirSync(preferred, { recursive: true }); } catch (e) { /* ignore */ }
    app.setPath('userData', preferred);
    console.log('[userdata] local:', preferred, underApps ? '(Apps install)' : '(cloud AppData redirect)');

    if (prev && path.resolve(prev) !== path.resolve(preferred)) {
      const names = [
        'mirae_messenger.db',
        'mirae_messenger.db-wal',
        'mirae_messenger.db-shm',
        'last-integrity-check.txt'
      ];
      for (const name of names) {
        const src = path.join(prev, name);
        const dst = path.join(preferred, name);
        try {
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.copyFileSync(src, dst);
            console.log('[userdata] migrated', name);
          }
        } catch (e) {
          console.warn('[userdata] migrate skip', name, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[userdata] redirect failed:', e && e.message ? e.message : e);
  }
}

ensureAppsLocalUserData();

async function copyFileWithRetry(sourcePath, destPath, retries = 10) {
  const cloud = isCloudSyncedPath(destPath) || isCloudSyncedPath(sourcePath);
  const maxRetries = cloud ? Math.min(retries, 3) : retries;
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
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
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) && i < maxRetries - 1) {
        await sleepMs((cloud ? 80 : 120) * (i + 1));
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
  const cloud = isCloudSyncedInstallPath();
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
      // OneDrive 설치본: 파일당 상한 — hang 시 부팅 전체를 막지 않음
      await withTimeout(copyFileWithRetry(from, to, cloud ? 2 : 10), cloud ? 8000 : 30000, `pending-apply ${rel}`);
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

// 미니 모드 상단 툴바(공지·관리·파일·기록·새로고침 등)가 잘리지 않도록 최소 너비 확보
const COMPACT_DEFAULT_WIDTH = 480;
const COMPACT_DEFAULT_HEIGHT = 680;
const COMPACT_MIN_WIDTH = 480;
const COMPACT_MIN_HEIGHT = 520;
const NORMAL_MIN_WIDTH = 1040;
const NORMAL_MIN_HEIGHT = 600;

const UDP_PORT = 41234;
const TCP_PORT = 41235;
/** 하트비트(PRESENCE_HEARTBEAT_MS)보다 짧으면 온라인↔오프라인 깜빡임·목록 재렌더 폭주 */
const PRESENCE_STALE_MS = 45000;
/** UDP로 한 번이라도 본 동료는 이 기간 동안 목록에 유지 (프로그램 미실행·오프라인 포함) */
const KNOWN_USER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_TCP_LINE_BUFFER = 512 * 1024;
/** NOTICE_SYNC 한 줄이 이 값을 넘지 않도록 청크로 나눔 (구버전도 RESPONSE 병합 가능) */
const NOTICE_SYNC_SAFE_LINE_BYTES = 400 * 1024;
/** CHAT 등 단일 TCP 라인 안전 상한 (수신 버퍼 512KB 미만 여유) */
const MAX_CHAT_WIRE_BYTES = 400 * 1024;
/** 분할 파일 전송 최대 크기 (이보다 크면 공유 폴더 안내) */
const MAX_FILE_XFER_BYTES = 50 * 1024 * 1024;
/** 청크 원본 바이트 — base64(~373KB)+JSON 이 MAX_TCP_LINE_BUFFER(512KB) 아래 */
const FILE_XFER_CHUNK_RAW_BYTES = 280 * 1024;
/** 수신 조립 타임아웃 (50MB·느린 망 여유) */
const FILE_XFER_ASSEMBLE_TIMEOUT_MS = 8 * 60 * 1000;
/** 전송 TCP 타임아웃 (피어당, 50MB 여유) */
const FILE_XFER_SEND_TIMEOUT_MS = 6 * 60 * 1000;
/** DM SENT인데 ACK 없으면 이 시간 후 재전송 (수신측 msg_uid 중복 차단) */
const SENT_ACK_RETRY_AFTER_MS = 8000;
const SENT_ACK_MAX_RETRIES = 4;
/** 사용자 목록 IPC 디바운스 — 프레즌스 폭주 시 렌더러 재렌더 완화 */
const USER_LIST_NOTIFY_DEBOUNCE_MS = 900;
/** 평소 하트비트 간격 — 4초×508유니캐스트는 메인루프를 막아 클릭이 안 됨 */
const PRESENCE_HEARTBEAT_MS = 15000;
/** 전체 서브넷 508 스캔 OFF (1.0.486). 브로드캐스트 + 온라인 동료만 */
const PRESENCE_FULL_SCAN_ENABLED = false;
/** 수신 UDP 폭주 보호: 초당 전역/IP 상한 (병원망 구버전 508스캔 대비) */
const UDP_RX_MAX_PER_SEC = 30;
const UDP_RX_MAX_PER_IP_PER_SEC = 3;
/** 수신이 이 값을 넘으면 잠시 송신 유니캐스트 중단(브로드캐스트만) */
const UDP_STORM_THRESHOLD_PER_SEC = 20;
const UDP_STORM_COOLDOWN_MS = 12000;

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
let lastSelfRegisterSig = '';
let udpRxWindowStart = 0;
let udpRxWindowCount = 0;
/** @type {Map<string, { start: number, count: number }>} */
const udpRxPerIpWindow = new Map();
let udpStormUntil = 0;
let udpDropLoggedAt = 0;
/** 부팅 직후 이 시각까지 대용량 TCP 동기화(NOTICE_SYNC/FILE)를 막아 UI 프리징 방지 */
let networkQuietUntil = 0;
let tcpActiveConnections = 0;
const TCP_MAX_CONNECTIONS = 8;
const NETWORK_QUIET_MS = 45000;

/** 피어별 수신 트래픽(이 PC 기준) — 마스터 「부하 감시」용 */
const PEER_TRAFFIC_WINDOW_MS = 60 * 1000;
const peerTrafficByIp = new Map();

function getPeerTrafficEntry(ip) {
  const key = String(ip || '').trim();
  if (!key) return null;
  let e = peerTrafficByIp.get(key);
  if (!e) {
    e = {
      ip: key,
      bytesTotal: 0,
      msgsTotal: 0,
      overflowCount: 0,
      largeChunkCount: 0,
      lastAt: 0,
      samples: [],
      byType: Object.create(null)
    };
    peerTrafficByIp.set(key, e);
  }
  return e;
}

function prunePeerTrafficSamples(e, now) {
  if (!e || !e.samples) return;
  const cut = now - PEER_TRAFFIC_WINDOW_MS;
  while (e.samples.length && e.samples[0].t < cut) e.samples.shift();
}

function recordPeerTraffic(ip, opts = {}) {
  try {
    const e = getPeerTrafficEntry(ip);
    if (!e) return;
    const now = Date.now();
    const bytes = Math.max(0, Number(opts.bytes) || 0);
    const msgs = Math.max(0, Number(opts.msgs) || 0);
    e.bytesTotal += bytes;
    e.msgsTotal += msgs;
    e.lastAt = now;
    if (opts.overflow) e.overflowCount += 1;
    if (opts.largeChunk) e.largeChunkCount += 1;
    if (opts.type) {
      const t = String(opts.type).slice(0, 40);
      e.byType[t] = (e.byType[t] || 0) + 1;
    }
    if (bytes || msgs) e.samples.push({ t: now, bytes, msgs });
    prunePeerTrafficSamples(e, now);
  } catch (_) { /* ignore */ }
}

function peerTrafficLevel(bytes1m, msgs1m, overflowCount) {
  if (overflowCount >= 2 || msgs1m >= 300 || bytes1m >= 5 * 1024 * 1024) return 'hot';
  if (overflowCount >= 1 || msgs1m >= 120 || bytes1m >= 1.5 * 1024 * 1024) return 'warn';
  return 'ok';
}

/** 부하 감시 화면에서 통신 유형 코드를 관리자가 바로 알아볼 수 있는 말로 바꿔 보여준다 */
const TRAFFIC_TYPE_LABELS = {
  CHAT: '1:1 채팅', GROUP_MESSAGE: '그룹 채팅', DEPT_MESSAGE: '부서 메시지', FLOOR_MESSAGE: '층 메시지',
  BROADCAST: '전체 공지 메시지', MESSAGE_EDIT: '메시지 수정', MESSAGE_REACTION: '메시지 반응(이모지)',
  MSG_ACK: '전송 확인', READ_RECEIPT: '읽음 확인', CHANNEL_READ: '채널 읽음',
  NOTICE_ADD: '공지 등록', NOTICE_UPDATE: '공지 수정', NOTICE_DELETE: '공지 삭제',
  NOTICE_SYNC_REQUEST: '공지 동기화 요청', NOTICE_SYNC_RESPONSE: '공지 동기화 응답',
  CHAT_PIN_SYNC: '고정 공지 동기화', CONFIG_SYNC: '설정 동기화', GROUP_SYNC: '그룹방 동기화',
  DUTY_ROSTER_SYNC: '당직표 동기화', PROFILE_OVERRIDE_SYNC: '프로필 동기화',
  PROFILE_PHOTO_REQUEST: '프로필 사진 요청', PROFILE_PHOTO_SYNC: '프로필 사진 동기화',
  SCHEDULE_ADD: '일정 등록', SCHEDULE_EDIT: '일정 수정', SCHEDULE_DELETE: '일정 삭제',
  SERVICE_PAUSE_SYNC: '일시중지 동기화', USAGE_ENABLE: '사용 허용', USAGE_DISABLE: '사용 중지',
  USAGE_LOCK_SYNC: '사용 잠금 동기화', USAGE_LOCK_RESULT: '사용 잠금 결과',
  GROUP_JOIN_NOTICE: '그룹 참여 알림', GROUP_RENAME_NOTICE: '그룹 이름변경 알림',
  OPERATOR_ADD: '운영자 추가', OPERATOR_DELETE: '운영자 삭제', OPERATOR_DUTY_PERM: '운영자 권한변경',
  FILE_XFER_START: '파일 전송 시작', FILE_XFER_CHUNK: '파일 전송 중', FILE_XFER_END: '파일 전송 완료', FILE_XFER_ABORT: '파일 전송 취소',
  FORCE_UPDATE: '강제 업데이트', FORCE_UPDATE_RESULT: '강제 업데이트 결과',
  WIPE_CHAT_HISTORY: '대화 기록 삭제', WIPE_CHAT_HISTORY_RESULT: '대화 기록 삭제 결과',
  WIPE_CLAIM: '삭제 작업 선점', WIPE_QUEUE_CLEAR: '삭제 대기열 정리', WIPE_QUEUE_SYNC: '삭제 대기열 동기화',
  TCP_BUFFER_OVERFLOW: '수신 버퍼 초과', TCP_CHUNK_OVERSIZE: '수신 데이터 과대',
  LOADTEST_CMD: '부하 테스트 명령', PING: '연결 확인', GOODBYE: '접속 종료'
};
function trafficTypeLabel(t) { return TRAFFIC_TYPE_LABELS[t] || t; }

function listPeerTrafficStats() {
  const now = Date.now();
  const rows = [];
  peerTrafficByIp.forEach((e) => {
    prunePeerTrafficSamples(e, now);
    let bytes1m = 0;
    let msgs1m = 0;
    for (const s of e.samples) {
      bytes1m += s.bytes;
      msgs1m += s.msgs;
    }
    const typeEntries = Object.entries(e.byType || {}).sort((a, b) => b[1] - a[1]);
    const topTypes = typeEntries.slice(0, 3).map(([t, n]) => `${trafficTypeLabel(t)}×${n}`).join(', ');
    const known = allKnownUsers.get(e.ip) || onlineUsers.get(e.ip) || null;
    const level = peerTrafficLevel(bytes1m, msgs1m, e.overflowCount);
    rows.push({
      ip: e.ip,
      username: known ? `${known.rank || ''} ${known.username || ''}`.trim() : '',
      dept: known ? (known.dept || '') : '',
      online: !!(known && (onlineUsers.has(e.ip) || known.online)),
      bytes1m,
      msgs1m,
      bytesTotal: e.bytesTotal,
      msgsTotal: e.msgsTotal,
      overflowCount: e.overflowCount,
      largeChunkCount: e.largeChunkCount,
      lastAt: e.lastAt,
      topTypes,
      level
    });
  });
  const order = { hot: 0, warn: 1, ok: 2 };
  rows.sort((a, b) => {
    const lo = (order[a.level] ?? 9) - (order[b.level] ?? 9);
    if (lo !== 0) return lo;
    if (b.bytes1m !== a.bytes1m) return b.bytes1m - a.bytes1m;
    return b.msgs1m - a.msgs1m;
  });
  return rows;
}

const MY_IP = getMyIP();

let myProfile = {
  username: '',
  rank: '',
  dept: '',
  floor: '',
  extNo: '',
  phone: '',
  statusState: 'ONLINE',
  photo: ''
};
// DB에서 실제 저장된 프로필(직급 등)을 불러오기 전까지는 위 하드코딩된 기본값이 임시로 들어있는
// 상태다. 이 값이 다른 PC로 전파되면 잘못된 값이 잠깐 보였다가 실제 값으로 바뀌는 것처럼
// 보이므로, 로딩이 끝나기 전에는 내 정보를 내보내지 않는다.
// 직급·내선·휴대폰은 선택 항목 — 비워 둔 채 이름(예: 물리치료실1)만으로도 사용 가능하다.
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
let APP_VERSION = require('./package.json').version;
// 마스터가 지정한 공유 폴더(예: 병원 공유 드라이브) 경로. 여기 최신 파일을 올려두면
// 전 직원 PC가 자동으로 새 버전이 있는지 확인하고, 원할 때 한 번에 업데이트할 수 있다.
let updateSourcePath = '';
// 기본: GitHub. 옛 버전 브리지용으로 Z/공유폴더 경로도 계속 지원한다.
const DEFAULT_UPDATE_SOURCE_PATH = 'https://github.com/dragotigree/mirae-messenger';
const Z_BRIDGE_UPDATE_SOURCE_PATH = 'Z:\\9.재활치료실(PT&OT&언어&임상심리)\\물리치료실\\messenger';
const Z_BRIDGE_MIRROR_FILES = [
  'main.js',
  'preload.js',
  'index.html',
  'package.json',
  'version.json',
  'toast.html',
  'toast-preload.js',
  'lib/minimal-xlsx.js',
  'excalidraw-editor.html',
  'preload-excalidraw.js',
  'lib/excalidraw-app.js',
  'lib/excalidraw-app.css'
];
const Z_BRIDGE_MIRROR_OPTIONAL = ['assets/splash.png', 'vendor/excalidraw/asset-list.json'];
let pendingRestartTimer = null;
let pendingUpdateRemoteVersion = '';
let autoUpdateAlreadyApplied = false;
/** 업데이트 파일 적용 중 중복 진입 방지 */
let updateApplyInFlight = false;
/** 'auto' | 'manual' — 자동 적용·재시작 vs 설정에서만 수동 업데이트. 기본값은 manual(자동 업데이트 없음). */
let updateMode = 'manual';

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

/** 수동/자동 적용 시 실제 fetch 소스 (Z가 구버전이면 GitHub로 전환) */
let pendingUpdateFetchPath = '';

async function probeUpdateVersionFromSource(sourcePath) {
  const prev = updateSourcePath;
  const normalized = normalizeUpdateSourcePath(sourcePath);
  if (!normalized) return { ok: false, error: new Error('empty source') };
  try {
    updateSourcePath = normalized;
    const raw = (await readUpdateSourceBytes('version.json')).toString('utf8');
    const remote = parseUpdateJsonText(raw);
    const ver = String((remote && remote.version) || '');
    if (!ver) return { ok: false, error: new Error('version.json에 version 없음') };
    return {
      ok: true,
      version: ver,
      notes: (remote && remote.notes) || '',
      sourcePath: normalized,
      kind: parseUpdateSource(normalized).kind
    };
  } catch (e) {
    return { ok: false, error: e, sourcePath: normalized };
  } finally {
    updateSourcePath = prev;
  }
}

/** 설정 소스 + GitHub 중 더 새 version.json 선택 (Z 브리지가  lagged 일 때 대비) */
async function findNewestUpdateCandidate() {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  const seen = new Set();
  const paths = [];
  const pushPath = (p) => {
    const n = normalizeUpdateSourcePath(p);
    if (!n || seen.has(n)) return;
    seen.add(n);
    paths.push(n);
  };
  pushPath(updateSourcePath);
  pushPath(DEFAULT_UPDATE_SOURCE_PATH);

  const candidates = [];
  for (const p of paths) {
    const probed = await probeUpdateVersionFromSource(p);
    if (probed.ok) candidates.push(probed);
  }
  if (!candidates.length) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (compareVersions(candidates[i].version, best.version) > 0) best = candidates[i];
  }
  best.candidates = candidates; // 호출부가 GitHub 후보를 재조회 없이 재사용할 수 있도록
  return best;
}

/** Z드라이브 브리지 폴더에 현재 설치본을 미러 (가능하면). GitHub 배포 후 옛 PC도 따라오게 함. */
async function mirrorLocalInstallToZBridge(opts = {}) {
  const force = !!(opts && opts.force);
  const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12000;
  try {
    return await withTimeout(mirrorLocalInstallToZBridgeInner({ force }), timeoutMs, 'Z-bridge mirror');
  } catch (e) {
    return { mirrored: false, reason: e && e.message ? e.message : String(e) };
  }
}

async function mirrorLocalInstallToZBridgeInner(opts = {}) {
  const force = !!(opts && opts.force);
  const destRoot = Z_BRIDGE_UPDATE_SOURCE_PATH;
  let localVer = APP_VERSION;
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg && pkg.version) localVer = String(pkg.version);
  } catch (e) {}

  try {
    await withTimeout(fs.promises.access(path.dirname(destRoot)), 4000, 'Z-drive access');
  } catch (e) {
    return { mirrored: false, reason: 'Z드라이브에 연결되지 않았습니다.' };
  }
  try {
    await fs.promises.mkdir(destRoot, { recursive: true });
  } catch (e) {
    return { mirrored: false, reason: 'Z 브리지 폴더를 만들 수 없습니다: ' + (e.message || e) };
  }

  let remoteVer = '';
  try {
    const raw = await withTimeout(
      fs.promises.readFile(path.join(destRoot, 'version.json'), 'utf8'),
      5000,
      'Z version.json'
    );
    remoteVer = String((parseUpdateJsonText(raw) || {}).version || '');
  } catch (e) {
    remoteVer = '';
  }
  if (!force && remoteVer && compareVersions(localVer, remoteVer) <= 0) {
    return { mirrored: false, reason: 'already-latest', version: remoteVer };
  }

  const copied = [];
  const failed = [];
  for (const rel of Z_BRIDGE_MIRROR_FILES) {
    const src = path.join(__dirname, rel);
    const dst = path.join(destRoot, rel);
    try {
      await fs.promises.access(src);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      await copyFileWithRetry(src, dst, 3);
      try { await fs.promises.utimes(dst, new Date(), new Date()); } catch (e) {}
      copied.push(rel);
    } catch (e) {
      failed.push(`${rel}(${e.message || e})`);
    }
  }
  const optionalMirror = Z_BRIDGE_MIRROR_OPTIONAL.slice();
  try {
    const listRaw = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'vendor', 'excalidraw', 'asset-list.json'), 'utf8'));
    const files = Array.isArray(listRaw && listRaw.files) ? listRaw.files : [];
    for (const f of files) {
      const rel = `vendor/excalidraw/${String(f || '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
      if (rel && !optionalMirror.includes(rel)) optionalMirror.push(rel);
    }
  } catch (e) { /* optional */ }
  for (const rel of optionalMirror) {
    const src = path.join(__dirname, rel);
    const dst = path.join(destRoot, rel);
    try {
      await fs.promises.access(src);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      await copyFileWithRetry(src, dst, 2);
      copied.push(rel);
    } catch (e) {
      /* optional */
    }
  }

  if (failed.length) {
    console.warn('[Z브리지] 일부 파일 미러 실패:', failed.join(', '));
    return { mirrored: false, reason: failed.join(', '), copied, version: localVer };
  }

  try {
    const note = [
      'Mirae Messenger - Z bridge (auto)',
      `version: ${localVer}`,
      `time: ${new Date().toISOString()}`,
      '',
      'GitHub 업데이트 후 자동으로 이 폴더에 미러됩니다.',
      '옛 PC: Z 연결 후 메신저 실행 / 설정 > 업데이트 확인'
    ].join('\n');
    await fs.promises.writeFile(path.join(destRoot, 'Z-BRIDGE-README.txt'), note, 'utf8');
  } catch (e) {}

  console.log(`[Z브리지] ${destRoot} 에 v${localVer} 미러 완료 (${copied.length}개)`);
  return { mirrored: true, version: localVer, copied };
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

function httpsGetBuffer(url, headers = {}, opts = {}) {
  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || 25000);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGetBuffer(res.headers.location, headers, opts).then(resolve, reject);
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
  const isLargeHint = /excalidraw-app\.(js|css)$/i.test(filePath) || /^vendor\//i.test(filePath);
  // version.json: raw CDN이 수 분~수 시간 stale 할 수 있음 → API 우선, 둘 다 받으면 더 새 버전 선택
  const isVersionMeta = /^(version|package)\.json$/i.test(filePath);
  const timeoutMs = isLargeHint ? 180000 : (isVersionMeta ? 15000 : 45000);
  const ua = { 'User-Agent': 'MiraeMessenger-Updater' };
  const noCache = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };

  const bust = Date.now();
  const rawUrl = `https://raw.githubusercontent.com/${meta.owner}/${meta.repo}/${meta.ref}/${filePath}?t=${bust}`;
  const rawHeaders = { ...ua, ...noCache };
  if (token) rawHeaders.Authorization = `Bearer ${token}`;

  const apiUrl = `https://api.github.com/repos/${meta.owner}/${meta.repo}/contents/${filePath}?ref=${encodeURIComponent(meta.ref)}`;
  const apiHeaders = {
    ...ua,
    ...noCache,
    Accept: 'application/vnd.github.raw+json'
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;

  const looksLikeGithubMetaOnly = (buf) => {
    if (!buf || buf.length >= 4000) return false;
    const head = buf.toString('utf8', 0, Math.min(buf.length, 80)).trim();
    return head.startsWith('{') && /"encoding"\s*:\s*"none"/.test(buf.toString('utf8'));
  };

  // version/package.json 은 API·raw 둘 다 시도 후 더 높은 version 채택 (CDN stale 방지)
  if (isVersionMeta) {
    let apiBuf = null;
    let rawBuf = null;
    let lastErr = null;
    try {
      apiBuf = await httpsGetBuffer(apiUrl, apiHeaders, { timeoutMs });
      if (looksLikeGithubMetaOnly(apiBuf)) apiBuf = null;
    } catch (e) { lastErr = e; }
    try {
      rawBuf = await httpsGetBuffer(rawUrl, rawHeaders, { timeoutMs });
    } catch (e) { lastErr = e; }
    if (apiBuf && rawBuf) {
      try {
        const av = String((parseUpdateJsonText(apiBuf.toString('utf8')) || {}).version || '');
        const rv = String((parseUpdateJsonText(rawBuf.toString('utf8')) || {}).version || '');
        if (av && rv && compareVersions(av, rv) > 0) return apiBuf;
        if (av && rv && compareVersions(rv, av) > 0) return rawBuf;
      } catch (_) { /* fall through */ }
      return apiBuf; // 같으면 API(원본) 우선
    }
    if (apiBuf) return apiBuf;
    if (rawBuf) return rawBuf;
    throw lastErr || new Error('GitHub version.json 다운로드 실패');
  }

  const tryOrder = isLargeHint
    ? [
        () => httpsGetBuffer(rawUrl, rawHeaders, { timeoutMs }),
        () => httpsGetBuffer(apiUrl, apiHeaders, { timeoutMs })
      ]
    : [
        () => httpsGetBuffer(apiUrl, apiHeaders, { timeoutMs }),
        () => httpsGetBuffer(rawUrl, rawHeaders, { timeoutMs })
      ];

  let lastErr;
  for (const run of tryOrder) {
    try {
      const buf = await run();
      if (looksLikeGithubMetaOnly(buf)) {
        throw new Error('GitHub Contents API가 대용량 파일 본문을 주지 않았습니다.');
      }
      return buf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('GitHub 파일 다운로드 실패');
}

async function readUpdateSourceBytes(relPath) {
  const meta = parseUpdateSource(updateSourcePath);
  if (meta.kind === 'github') {
    return fetchGithubUpdateFile(meta, relPath);
  }
  if (meta.kind === 'folder') {
    // Z:/공유폴더 행 시 UI 프리징 방지
    return withTimeout(
      fs.promises.readFile(path.join(meta.dir, relPath)),
      12000,
      `update-read ${relPath}`
    );
  }
  throw new Error('업데이트 소스가 설정되지 않았습니다.');
}

/** PowerShell Set-Content -Encoding utf8 등이 붙인 UTF-8 BOM 제거 후 JSON 파싱 */
function parseUpdateJsonText(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  return JSON.parse(text);
}

async function writeBufferWithRetry(destPath, buffer, retries = 10) {
  const cloud = isCloudSyncedPath(destPath);
  const maxRetries = cloud ? Math.min(retries, 3) : retries;
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
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
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) && i < maxRetries - 1) {
        await sleepMs((cloud ? 80 : 120) * (i + 1));
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

function isServicePauseLocked() {
  return !!servicePause.enabled && servicePauseBypassRevision !== Number(servicePause.revision || 0);
}

/** 사용 중지 또는 서비스 일시중지 — 메시지 전송·프레즌스 차단 */
function isMessengerUsageBlocked() {
  return localUsageDisabled || isServicePauseLocked();
}

function getServicePauseState() {
  return {
    enabled: !!servicePause.enabled,
    active: !!servicePause.enabled,
    locked: isServicePauseLocked(),
    bypassed: !!servicePause.enabled && servicePauseBypassRevision === Number(servicePause.revision || 0),
    revision: Number(servicePause.revision || 0),
    updatedAt: servicePause.updatedAt || '',
    untilLabel: servicePause.untilLabel || SERVICE_PAUSE_DEFAULTS.untilLabel,
    title: servicePause.title || SERVICE_PAUSE_DEFAULTS.title,
    body: servicePause.body || SERVICE_PAUSE_DEFAULTS.body,
    contact: servicePause.contact || SERVICE_PAUSE_DEFAULTS.contact,
    myIp: MY_IP
  };
}

function buildServicePauseSyncPayload() {
  return {
    type: 'SERVICE_PAUSE_SYNC',
    enabled: !!servicePause.enabled,
    title: servicePause.title || SERVICE_PAUSE_DEFAULTS.title,
    body: servicePause.body || SERVICE_PAUSE_DEFAULTS.body,
    contact: servicePause.contact || SERVICE_PAUSE_DEFAULTS.contact,
    untilLabel: servicePause.untilLabel || SERVICE_PAUSE_DEFAULTS.untilLabel,
    updatedAt: servicePause.updatedAt || '',
    revision: Number(servicePause.revision || 0),
    fromIp: MY_IP
  };
}

function persistServicePauseState() {
  db.run(
    `INSERT INTO service_pause (id, enabled, title, body, contact, until_label, updated_at, revision, bypass_revision)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled, title = excluded.title, body = excluded.body,
       contact = excluded.contact, until_label = excluded.until_label,
       updated_at = excluded.updated_at, revision = excluded.revision,
       bypass_revision = excluded.bypass_revision`,
    [
      servicePause.enabled ? 1 : 0,
      servicePause.title || '',
      servicePause.body || '',
      servicePause.contact || '',
      servicePause.untilLabel || '',
      servicePause.updatedAt || '',
      Number(servicePause.revision || 0),
      Number(servicePauseBypassRevision || 0)
    ],
    logDbErr
  );
}

function persistServicePauseBypass() {
  persistServicePauseState();
}

function notifyServicePauseState() {
  safeWebContentsSend('service-pause-state', getServicePauseState());
}

function applyServicePausePresenceSideEffects() {
  if (isMessengerUsageBlocked()) {
    try { broadcastGoodbye(); } catch (_) {}
    onlineUsers.delete(MY_IP);
    registerSelf();
  } else {
    registerSelf();
    if (globalUdpSocket) broadcastPresence(globalUdpSocket);
  }
  notifyUserList();
}

function applyServicePauseConfig(next, opts) {
  const o = opts || {};
  const wasLocked = isServicePauseLocked();
  servicePause = {
    enabled: !!next.enabled,
    title: String(next.title || SERVICE_PAUSE_DEFAULTS.title).trim() || SERVICE_PAUSE_DEFAULTS.title,
    body: String(next.body || SERVICE_PAUSE_DEFAULTS.body).trim() || SERVICE_PAUSE_DEFAULTS.body,
    contact: String(next.contact || SERVICE_PAUSE_DEFAULTS.contact).trim() || SERVICE_PAUSE_DEFAULTS.contact,
    untilLabel: String(next.untilLabel || SERVICE_PAUSE_DEFAULTS.untilLabel).trim() || SERVICE_PAUSE_DEFAULTS.untilLabel,
    updatedAt: next.updatedAt || new Date().toISOString(),
    revision: Number(next.revision || 0)
  };
  if (o.clearBypass) servicePauseBypassRevision = -1;
  if (o.setBypass) servicePauseBypassRevision = Number(servicePause.revision || 0);
  if (!servicePause.enabled) servicePauseBypassRevision = 0;
  persistServicePauseState();
  const nowLocked = isServicePauseLocked();
  if (wasLocked !== nowLocked || o.forcePresence) applyServicePausePresenceSideEffects();
  notifyServicePauseState();
}

function handleServicePauseSync(payload, senderIP) {
  if (!payload) return;
  const remoteRev = Number(payload.revision || 0);
  const localRev = Number(servicePause.revision || 0);
  if (remoteRev < localRev) {
    if (senderIP) sendToIpDirect(senderIP, buildServicePauseSyncPayload());
    return;
  }
  if (remoteRev === localRev) {
    const remoteAt = String(payload.updatedAt || '');
    const localAt = String(servicePause.updatedAt || '');
    if (remoteAt && localAt && remoteAt < localAt) {
      if (senderIP) sendToIpDirect(senderIP, buildServicePauseSyncPayload());
      return;
    }
    if (
      !!payload.enabled === !!servicePause.enabled &&
      String(payload.body || '') === String(servicePause.body || '') &&
      String(payload.contact || '') === String(servicePause.contact || '') &&
      String(payload.untilLabel || '') === String(servicePause.untilLabel || '')
    ) {
      return;
    }
  }
  applyServicePauseConfig({
    enabled: !!payload.enabled,
    title: payload.title,
    body: payload.body,
    contact: payload.contact,
    untilLabel: payload.untilLabel,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    revision: remoteRev
  }, { forcePresence: true });
}

function maybeSyncServicePauseToPeer(ip) {
  if (!ip || ip === MY_IP) return;
  if (!servicePause.enabled && !servicePause.revision) return;
  sendToIps([ip], buildServicePauseSyncPayload());
}

function messengerBlockedResponse() {
  if (isServicePauseLocked()) {
    const msg = '메신저가 일시 중지 상태입니다. 마스터 아이디·비밀번호로 해제하거나 관리자가 일시 중지를 끌 때까지 기다려 주세요.';
    return { success: false, status: 'ERROR', msg, error: msg };
  }
  return usageLockBlockedResponse();
}

function previewBody(rawMessage) {
  if (showNotificationPreview) {
    return String(rawMessage).replace(/<[^>]*>?/gm, '');
  }
  return '메시지가 도착했습니다. 확인해 주세요.';
}

/** 코드블루/코드레드 메시지 판별 (플래그 또는 본문 표기) */
function detectCodeAlertType(message) {
  const s = String(message || '');
  if (s.indexOf('code-blue-flag') !== -1 || s.indexOf('[코드블루]') !== -1) return 'blue';
  if (s.indexOf('code-red-flag') !== -1 || s.indexOf('[코드레드]') !== -1) return 'red';
  return null;
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

function showMessageToast({ title, body, urgent, channelKey, codeType, force }) {
  if (!force && !notifyIncomingMessages) return;
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

  const code = codeType === 'blue' || codeType === 'red' ? codeType : '';
  const q = new URLSearchParams({
    title: truncateToastText(title || '새 메시지', 48),
    body: truncateToastText(body || '', 72),
    urgent: urgent || code ? '1' : '0',
    codeType: code
  });

  toastWindow.loadFile(path.join(__dirname, 'toast.html'), { search: `?${q.toString()}` });
  toastWindow.once('ready-to-show', () => {
    if (toastWindow && !toastWindow.isDestroyed()) toastWindow.showInactive();
  });
  toastWindow.on('closed', () => { toastWindow = null; });

  const secs = Math.max(2, Math.min(60, Number(toastDurationSeconds) || 7));
  const ms = (code ? Math.max(secs + 8, 15) : urgent ? secs + 2 : secs) * 1000;
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
  const o = opts || {};
  const force = !!o.force;
  if (!force && !notifyIncomingMessages) return;
  // 코드 발령은 해당 채널을 보고 있어도 토스트·알림을 숨기지 않음
  if (!force && shouldSuppressMessageToast(o.channelKey)) return;
  const key = String(o.channelKey || '').trim() || '__unknown__';
  const now = Date.now();
  const until = activeIncomingNotifyUntil.get(key) || 0;
  // 동일 발신/채널: 알림 유지 시간 동안은 추가 알림 없음 (토스트·데스크탑 공통)
  // 코드 발령은 매번 알림 (생명·안전)
  if (!force && until > now) return;

  const secs = Math.max(2, Math.min(60, Number(toastDurationSeconds) || 7));
  const code = o.codeType === 'blue' || o.codeType === 'red' ? o.codeType : '';
  const ms = (code ? Math.max(secs + 8, 15) : (o.urgent ? secs + 2 : secs)) * 1000;
  activeIncomingNotifyUntil.set(key, now + ms);

  const mode = incomingNotifyMode === 'desktop' ? 'desktop' : 'toast';
  if (mode === 'desktop') {
    showDesktopNotification({
      title: o.title || '새 메시지',
      body: o.body || '메시지가 도착했습니다.',
      urgent: !!o.urgent || !!code,
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
  const cleaned = String(name || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return cleaned || 'unknown';
}

/** MIME → 확장자. subtype 전체를 확장자로 쓰면 xlsx가 vnd.openxmlformats… 로 깨짐 */
function extensionFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const map = {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-excel': 'xls',
    'application/msword': 'doc',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/html': 'html',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'application/octet-stream': 'bin'
  };
  if (map[mime]) return map[mime];
  const sub = (mime.split('/')[1] || '').trim();
  if (!sub) return 'bin';
  // 벤더 MIME subtype은 확장자로 쓰지 않음
  if (sub.length > 8 || sub.includes('.') || sub.includes('openxmlformats') || sub.startsWith('vnd.')) {
    return 'bin';
  }
  return sub.replace(/[^a-z0-9]+/gi, '') || 'bin';
}

/** 이미 잘못 저장된 …vnd.openxmlformats… 파일명을 교정 */
function repairMimeDisguisedFileName(fileName) {
  let name = String(fileName || '').trim();
  if (!name) return name;
  const repairs = [
    [/\.vnd\.openxmlformats-officedocument\.spreadsheetml(?:\.sheet)?$/i, '.xlsx'],
    [/\.vnd\.openxmlformats-officedocument\.wordprocessingml(?:\.document)?$/i, '.docx'],
    [/\.vnd\.openxmlformats-officedocument\.presentationml(?:\.presentation)?$/i, '.pptx'],
    [/\.vnd\.ms-excel$/i, '.xls'],
    [/\.msword$/i, '.doc']
  ];
  for (const [re, ext] of repairs) {
    if (re.test(name)) return name.replace(re, ext);
  }
  return name;
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
  return `<div class="chat-file-box"><span class="chat-file-icon" aria-hidden="true">📄</span><div class="chat-file-meta"><div class="chat-file-name">${safeName}</div><div class="chat-file-size">${sizeLabel}</div></div><a class="chat-file-dl" href="${href}" download="${safeName}">받기</a></div>`;
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
            if (err) {
              logDbErr(err);
              finishIncomingChatUid(msgUid, isMsgUidUniqueConflict(err));
              return;
            }
            finishIncomingChatUid(msgUid, true);
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
          if (err) {
            logDbErr(err);
            if (msgUid && isMsgUidUniqueConflict(err)) {
              finishIncomingChatUid(msgUid, true);
              if (msgUid) sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
              return;
            }
            finishIncomingChatUid(msgUid, false);
            return;
          }
          finishIncomingChatUid(msgUid, true);
          if (msgUid) sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
        }
      );
    };
    if (msgUid && isIncomingChatUidBusy(msgUid)) {
      db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [msgUid], (err, row) => {
        if (err) { logDbErr(err); return; }
        if (row) {
          markIncomingChatUid(msgUid);
          sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
          return;
        }
        if (incomingChatUidInflight.has(String(msgUid))) return;
        if (!claimIncomingChatUid(msgUid)) return;
        persistDm({ showUi: false });
      });
      return;
    }
    if (msgUid) {
      if (!claimIncomingChatUid(msgUid)) {
        sendToIpDirect(senderIP, { type: 'MSG_ACK', msgUid });
        return;
      }
      db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [msgUid], (err, row) => {
        if (err) { logDbErr(err); persistDm({ showUi: true }); return; }
        if (row) {
          finishIncomingChatUid(msgUid, true);
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
  const downloadPatches = [];
  let match;
  let fileIndex = 0;
  while ((match = regex.exec(messageHtml)) !== null) {
    const full = match[0];
    const prefix = match[1];
    const mimeType = match[3];
    const base64Data = match[4];
    const suffix = match[5];
    let fileName = '';
    const before = messageHtml.slice(Math.max(0, match.index - 600), match.index);
    const after = messageHtml.slice(match.index, Math.min(messageHtml.length, match.index + full.length + 220));
    const around = before + after;
    const dlMatch = after.match(/\bdownload="([^"]+)"/i) || before.match(/\bdownload="([^"]+)"/i);
    if (dlMatch) fileName = dlMatch[1];
    if (!fileName) {
      const nameMatch =
        before.match(/class="[^"]*chat-file-name[^"]*"[^>]*>\s*([^<]+?)\s*</i) ||
        before.match(/chat-file-name[^>]*>\s*([^<]+?)\s*</i);
      if (nameMatch) fileName = nameMatch[1];
    }
    if (!fileName) {
      const altMatch = around.match(/\balt="([^"]*)"/i);
      if (altMatch) fileName = altMatch[1];
    }
    if (!fileName) {
      // 구버전 인라인 스타일 파일명
      const legacy = before.match(/font-size:\s*1[23](?:\.\d+)?px;">\s*([^<]+?)\s*</i);
      if (legacy) fileName = legacy[1];
    }
    if (!fileName) fileName = `file_${Date.now()}`;
    fileName = sanitizeFileName(fileName);
    try {
      const ext = extensionFromMime(mimeType);
      const safeName = fileName;
      const finalName = path.extname(safeName)
        ? safeName
        : `${safeName}.${ext}`;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const uidPart = opts.msgUid ? `${sanitizeFileName(String(opts.msgUid).slice(0, 40))}_` : '';
      const storedName = `${uidPart}${timestamp}_${fileIndex}_${finalName}`;
      fileIndex += 1;
      const filePath = path.join(dir, storedName);
      // sync 파일쓰기는 메인 스레드를 막아 '응답 없음'을 유발한다 — 백신 실시간 검사가 파일마다
      // 지연을 더하면 첨부 몇 개짜리 메시지 하나로도 수십 초씩 전체가 멈출 수 있었음(실제 발생 확인).
      // 크기와 무관하게 항상 비동기로 저장한다. 저장 파일명은 쓰기 전에 이미 확정되므로
      // 압축 표기(mirae-file://)로 즉시 바꿔도 안전하다.
      const bin = Buffer.from(base64Data, 'base64');
      fs.promises.writeFile(filePath, bin).catch((e) => {
        console.error('첨부파일 저장 오류:', e.message);
      });
      if (compact) {
        replacements.push({
          from: full,
          to: `${prefix}mirae-file://${encodeURIComponent(storedName)}${suffix}`
        });
        downloadPatches.push({ storedName, displayName: finalName });
      }
    } catch (e) {
      console.error('첨부파일 처리 오류:', e.message);
    }
  }
  if (compact && replacements.length) {
    replacements.forEach((r) => { out = out.split(r.from).join(r.to); });
    downloadPatches.forEach((p) => {
      const enc = encodeURIComponent(p.storedName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const safeDl = String(p.displayName).replace(/"/g, '');
      out = out.replace(
        new RegExp(`(href="mirae-file://${enc}")(\\s+download="[^"]*")?`, 'i'),
        (full, hrefPart, dlPart) => {
          if (!dlPart) return `${hrefPart} download="${safeDl}"`;
          const cur = (dlPart.match(/download="([^"]*)"/i) || [])[1] || '';
          if (!cur || cur === 'download' || /\.vnd\.|openxmlformats/i.test(cur)) {
            return `${hrefPart} download="${safeDl}"`;
          }
          return full;
        }
      );
    });
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
  const MAX_SYNC_EXPAND_BYTES = 2 * 1024 * 1024;
  return messageHtml.replace(/((?:src|href)=")mirae-file:\/\/([^"]+)(")/gi, (full, prefix, encName, suffix) => {
    try {
      const name = path.basename(decodeURIComponent(encName.split(/[?#]/)[0]));
      const filePath = path.join(dir, name);
      if (!fs.existsSync(filePath)) return full;
      let st;
      try { st = fs.statSync(filePath); } catch (e) { return full; }
      // 대용량 sync readFileSync는 메인 스레드 정지 → 응답 없음
      if (st && st.size > MAX_SYNC_EXPAND_BYTES) return full;
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

/** RFC 5737 테스트망 — load-sim 가상 피어 */
function isLoadTestPeerIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return false;
  const known = onlineUsers.get(s) || allKnownUsers.get(s);
  if (known && known.isLoadTest) return true;
  return /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(s);
}

function isLoopbackIp(ip) {
  const s = String(ip || '').replace('::ffff:', '').trim();
  return s === '127.0.0.1' || s === '::1' || s === 'localhost';
}

function buildLoadTestIpForIndex(i) {
  const nets = ['192.0.2', '198.51.100', '203.0.113'];
  const idx = Math.max(0, (Number(i) || 1) - 1);
  const netPart = nets[Math.floor(idx / 254) % nets.length];
  const host = (idx % 254) + 1;
  return `${netPart}.${host}`;
}

function countLoadTestPeers() {
  let n = 0;
  allKnownUsers.forEach((u, ip) => {
    if ((u && u.isLoadTest) || isLoadTestPeerIp(ip)) n += 1;
  });
  return n;
}

function listLoadTestIps() {
  const ips = [];
  allKnownUsers.forEach((u, ip) => {
    if ((u && u.isLoadTest) || isLoadTestPeerIp(ip)) ips.push(ip);
  });
  return ips;
}

let loadTestSustainTimer = null;
let loadTestLastReport = null;

function summarizeMs(arr) {
  const s = (arr || []).slice().sort((a, b) => a - b);
  if (!s.length) return { count: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sum = s.reduce((a, b) => a + b, 0);
  const pct = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return {
    count: s.length,
    avg: +(sum / s.length).toFixed(2),
    p50: +pct(50).toFixed(2),
    p95: +pct(95).toFixed(2),
    max: +s[s.length - 1].toFixed(2)
  };
}

function probeEventLoopLag(durationMs = 1500) {
  return new Promise((resolve) => {
    const samples = [];
    let last = process.hrtime.bigint();
    const handle = setInterval(() => {
      const now = process.hrtime.bigint();
      const gapMs = Number(now - last) / 1e6;
      samples.push(Math.max(0, gapMs - 50));
      last = now;
    }, 50);
    setTimeout(() => {
      clearInterval(handle);
      resolve(summarizeMs(samples));
    }, Math.max(300, durationMs));
  });
}

function buildSyntheticLoadUsers(count) {
  const users = [];
  const n = Math.max(0, Math.min(500, count));
  for (let i = 1; i <= n; i++) {
    users.push({
      ip: buildLoadTestIpForIndex(i),
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

function injectLoadTestUsers(users, persist) {
  const now = Date.now();
  let injected = 0;
  (users || []).slice(0, 500).forEach((raw, idx) => {
    const ip = String((raw && raw.ip) || buildLoadTestIpForIndex(idx + 1)).trim();
    if (!ip || ip === MY_IP || isSyntheticReceiverKey(ip)) return;
    const previouslyKnown = allKnownUsers.get(ip);
    const overlay = {
      ip,
      username: (raw && raw.username) || `모의직원${idx + 1}`,
      rank: (raw && raw.rank) || '',
      dept: (raw && raw.dept) || '부하테스트',
      floor: (raw && raw.floor) || '',
      extNo: (raw && raw.extNo) || '',
      phone: (raw && raw.phone) || '',
      statusState: (raw && raw.statusState) || 'ONLINE',
      appVersion: (raw && raw.appVersion) || 'load-sim',
      photo: (previouslyKnown && previouslyKnown.photo) || '',
      lastPingAt: now,
      online: true,
      isMe: false,
      isLoadTest: true
    };
    const userObj = mergeUserProfile(previouslyKnown, overlay, true);
    userObj.lastPingAt = now;
    userObj.online = true;
    userObj.isLoadTest = true;
    onlineUsers.set(ip, userObj);
    allKnownUsers.set(ip, userObj);
    if (persist) {
      try { persistKnownUserSnapshot(userObj); } catch (_) {}
    }
    injected += 1;
  });
  notifyUserList(true);
  return injected;
}

function clearLoadTestUsers() {
  const removeIps = listLoadTestIps();
  removeIps.forEach((ip) => {
    onlineUsers.delete(ip);
    allKnownUsers.delete(ip);
    try {
      if (db) db.run(`DELETE FROM known_users WHERE ip = ?`, [ip], () => {});
    } catch (_) {}
  });
  notifyUserList(true);
  return removeIps.length;
}

function touchLoadTestUsers(ips) {
  const now = Date.now();
  let touched = 0;
  const list = Array.isArray(ips) && ips.length ? ips : listLoadTestIps();
  list.forEach((ip) => {
    const key = String(ip || '').trim();
    if (!key || !isLoadTestPeerIp(key)) return;
    const u = onlineUsers.get(key) || allKnownUsers.get(key);
    if (!u) return;
    u.lastPingAt = now;
    u.online = true;
    u.isLoadTest = true;
    onlineUsers.set(key, u);
    allKnownUsers.set(key, u);
    touched += 1;
  });
  return touched;
}

function stopLoadTestSustain() {
  if (loadTestSustainTimer) {
    clearInterval(loadTestSustainTimer);
    loadTestSustainTimer = null;
  }
}

function startLoadTestSustain(intervalMs) {
  stopLoadTestSustain();
  const ms = Math.max(2000, Math.min(30000, parseInt(intervalMs, 10) || 10000));
  loadTestSustainTimer = setInterval(() => {
    touchLoadTestUsers();
  }, ms);
  if (typeof loadTestSustainTimer.unref === 'function') loadTestSustainTimer.unref();
  return ms;
}

/**
 * 부하 모의/검사 스위트
 * @returns {Promise<object>|object}
 */
function runLoadTestCommand(payload) {
  const action = String((payload && payload.action) || '').trim();
  if (!action) return { success: false, msg: 'action 필요' };

  if (action === 'clear') {
    stopLoadTestSustain();
    const cleared = clearLoadTestUsers();
    writeToLogFile('info', `[loadtest] cleared ${cleared} synthetic peers`);
    const res = { success: true, cleared, onlineLoadTest: 0, sustain: false };
    loadTestLastReport = { action, at: Date.now(), ...res };
    return res;
  }

  if (action === 'touch') {
    const touched = touchLoadTestUsers(payload.ips);
    return { success: true, touched, onlineLoadTest: countLoadTestPeers(), sustain: !!loadTestSustainTimer };
  }

  if (action === 'inject' || action === 'burst') {
    let users = Array.isArray(payload.users) ? payload.users : [];
    const count = Math.max(0, Math.min(500, parseInt(payload.usersCount || payload.count || users.length || 0, 10) || 0));
    if (!users.length && count > 0) users = buildSyntheticLoadUsers(count);
    const persist = payload.persist !== false && payload.persist !== 0 && payload.persist !== '0';
    const t0 = Date.now();
    const injected = injectLoadTestUsers(users, persist);
    const wallMs = Date.now() - t0;
    writeToLogFile('info', `[loadtest] injected ${injected} synthetic peers (persist=${persist}, ${wallMs}ms)`);
    const res = {
      success: true,
      action: 'inject',
      injected,
      wallMs,
      persist,
      onlineLoadTest: countLoadTestPeers(),
      sustain: !!loadTestSustainTimer
    };
    loadTestLastReport = { action: 'inject', at: Date.now(), ...res };
    return res;
  }

  if (action === 'sustain_start') {
    if (countLoadTestPeers() === 0) {
      const n = Math.max(1, Math.min(500, parseInt(payload.usersCount || payload.count || 200, 10) || 200));
      injectLoadTestUsers(buildSyntheticLoadUsers(n), payload.persist !== false);
    }
    const intervalMs = startLoadTestSustain(payload.intervalMs || payload.interval || 10000);
    touchLoadTestUsers();
    const res = {
      success: true,
      action: 'sustain_start',
      intervalMs,
      onlineLoadTest: countLoadTestPeers(),
      sustain: true
    };
    loadTestLastReport = { action, at: Date.now(), ...res };
    return res;
  }

  if (action === 'sustain_stop') {
    stopLoadTestSustain();
    return { success: true, action: 'sustain_stop', sustain: false, onlineLoadTest: countLoadTestPeers() };
  }

  if (action === 'status') {
    return {
      success: true,
      onlineLoadTest: countLoadTestPeers(),
      sustain: !!loadTestSustainTimer,
      lastReport: loadTestLastReport
    };
  }

  if (action === 'list_rerender') {
    const rounds = Math.max(1, Math.min(200, parseInt(payload.rounds || payload.count || 50, 10) || 50));
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = process.hrtime.bigint();
      notifyUserListNow();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const res = {
      success: true,
      action: 'list_rerender',
      rounds,
      notifyMs: summarizeMs(samples),
      onlineLoadTest: countLoadTestPeers()
    };
    loadTestLastReport = { action, at: Date.now(), ...res };
    return res;
  }

  if (action === 'profile_churn') {
    const rounds = Math.max(1, Math.min(30, parseInt(payload.rounds || 5, 10) || 5));
    let ips = listLoadTestIps();
    if (!ips.length) {
      const n = Math.max(1, Math.min(500, parseInt(payload.usersCount || 100, 10) || 100));
      injectLoadTestUsers(buildSyntheticLoadUsers(n), true);
      ips = listLoadTestIps();
    }
    const samples = [];
    const tAll = Date.now();
    for (let r = 0; r < rounds; r++) {
      const t0 = process.hrtime.bigint();
      ips.forEach((ip, idx) => {
        const u = onlineUsers.get(ip) || allKnownUsers.get(ip);
        if (!u) return;
        u.dept = `부서${((idx + r) % 12) + 1}`;
        u.floor = `${((idx + r) % 8) + 1}층`;
        u.lastPingAt = Date.now();
        u.isLoadTest = true;
        onlineUsers.set(ip, u);
        allKnownUsers.set(ip, u);
        try { persistKnownUserSnapshot(u); } catch (_) {}
      });
      notifyUserList(true);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const res = {
      success: true,
      action: 'profile_churn',
      peers: ips.length,
      rounds,
      wallMs: Date.now() - tAll,
      roundMs: summarizeMs(samples),
      onlineLoadTest: countLoadTestPeers()
    };
    loadTestLastReport = { action, at: Date.now(), ...res };
    return res;
  }

  if (action === 'db_persist_bench') {
    const count = Math.max(1, Math.min(500, parseInt(payload.usersCount || payload.count || 200, 10) || 200));
    const users = buildSyntheticLoadUsers(count);
    const samples = [];
    const tAll = Date.now();
    users.forEach((raw) => {
      const t0 = process.hrtime.bigint();
      const u = {
        ip: raw.ip,
        username: raw.username,
        rank: raw.rank,
        dept: raw.dept,
        floor: raw.floor,
        extNo: raw.extNo,
        phone: '',
        statusState: 'ONLINE',
        photo: '',
        lastSeen: Date.now(),
        lastPingAt: Date.now(),
        online: true,
        isLoadTest: true
      };
      try { persistKnownUserSnapshot(u); } catch (_) {}
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    });
    const res = {
      success: true,
      action: 'db_persist_bench',
      users: count,
      wallMs: Date.now() - tAll,
      queryMs: summarizeMs(samples),
      note: 'known_users UPSERT만 측정 (목록 주입 없음). 끝나면 clear로 테스트망 row를 지울 수 있습니다.'
    };
    // 벤치로 쓴 row도 isLoadTest로 안 올라갈 수 있어 IP로 정리 가능하게 올려둠
    users.forEach((raw) => {
      const prev = allKnownUsers.get(raw.ip) || {};
      allKnownUsers.set(raw.ip, { ...prev, ...raw, isLoadTest: true, online: false });
    });
    loadTestLastReport = { action, at: Date.now(), ...res };
    return res;
  }

  if (action === 'event_loop_probe') {
    const durationMs = Math.max(500, Math.min(10000, parseInt(payload.durationMs || 1500, 10) || 1500));
    return probeEventLoopLag(durationMs).then((lag) => {
      const res = {
        success: true,
        action: 'event_loop_probe',
        durationMs,
        eventLoopLagMs: lag,
        verdict: lag.p95 > 80 ? 'HIGH' : (lag.p95 > 25 ? 'MEDIUM' : 'LOW')
      };
      loadTestLastReport = { action, at: Date.now(), ...res };
      return res;
    });
  }

  if (action === 'udp_limiter_bench') {
    const packets = Math.max(10, Math.min(5000, parseInt(payload.count || 300, 10) || 300));
    const uniqueIps = Math.max(1, Math.min(200, parseInt(payload.ips || 50, 10) || 50));
    let accepted = 0;
    let rejected = 0;
    const t0 = Date.now();
    for (let i = 0; i < packets; i++) {
      const ip = buildLoadTestIpForIndex((i % uniqueIps) + 1);
      if (allowUdpReceive(ip)) accepted += 1;
      else rejected += 1;
    }
    const res = {
      success: true,
      action: 'udp_limiter_bench',
      packets,
      uniqueIps,
      accepted,
      rejected,
      wallMs: Date.now() - t0,
      limits: {
        perSec: UDP_RX_MAX_PER_SEC,
        perIpPerSec: UDP_RX_MAX_PER_IP_PER_SEC,
        stormThreshold: UDP_STORM_THRESHOLD_PER_SEC
      },
      stormActive: Date.now() < udpStormUntil,
      note: '실제 UDP 소켓 없이 allowUdpReceive 제한만 측정합니다.'
    };
    loadTestLastReport = { action, at: Date.now(), ...res };
    return res;
  }

  if (action === 'tcp_connect_burst') {
    const attempts = Math.max(1, Math.min(40, parseInt(payload.count || 20, 10) || 20));
    const host = '127.0.0.1';
    const t0 = Date.now();
    const results = [];
    const workers = [];
    for (let i = 0; i < attempts; i++) {
      workers.push(new Promise((resolve) => {
        const started = Date.now();
        const sock = net.connect({ host, port: TCP_PORT }, () => {
          results.push({ ok: true, ms: Date.now() - started });
          try { sock.end(); } catch (_) {}
          try { sock.destroy(); } catch (_) {}
          resolve();
        });
        sock.setTimeout(2000, () => {
          results.push({ ok: false, ms: Date.now() - started, err: 'timeout' });
          try { sock.destroy(); } catch (_) {}
          resolve();
        });
        sock.on('error', (e) => {
          results.push({ ok: false, ms: Date.now() - started, err: (e && e.code) || 'error' });
          resolve();
        });
      }));
    }
    return Promise.all(workers).then(() => {
      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      const res = {
        success: true,
        action: 'tcp_connect_burst',
        attempts,
        ok,
        fail,
        wallMs: Date.now() - t0,
        connectMs: summarizeMs(results.map((r) => r.ms)),
        tcpMaxConnections: TCP_MAX_CONNECTIONS,
        tcpActiveConnections,
        note: `메신저 TCP 동시 연결 상한은 ${TCP_MAX_CONNECTIONS}입니다. 초과분은 거절되는 것이 정상입니다.`
      };
      loadTestLastReport = { action, at: Date.now(), ...res };
      return res;
    });
  }

  if (action === 'suite') {
    const users = Math.max(1, Math.min(500, parseInt(payload.usersCount || 200, 10) || 200));
    const steps = [];
    const runStep = async (name, fn) => {
      const t0 = Date.now();
      try {
        const out = await Promise.resolve(fn());
        steps.push({ name, ok: !!(out && out.success !== false), wallMs: Date.now() - t0, result: out });
      } catch (e) {
        steps.push({ name, ok: false, wallMs: Date.now() - t0, error: (e && e.message) || String(e) });
      }
    };
    return (async () => {
      await runStep('inject', () => runLoadTestCommand({ action: 'inject', usersCount: users, persist: true }));
      await runStep('list_rerender', () => runLoadTestCommand({ action: 'list_rerender', rounds: 30 }));
      await runStep('profile_churn', () => runLoadTestCommand({ action: 'profile_churn', rounds: 3, usersCount: users }));
      await runStep('udp_limiter_bench', () => runLoadTestCommand({ action: 'udp_limiter_bench', count: 300, ips: 50 }));
      await runStep('tcp_connect_burst', () => runLoadTestCommand({ action: 'tcp_connect_burst', count: 16 }));
      await runStep('event_loop_probe', () => runLoadTestCommand({ action: 'event_loop_probe', durationMs: 1200 }));
      await runStep('db_persist_bench', () => runLoadTestCommand({ action: 'db_persist_bench', usersCount: Math.min(users, 120) }));
      const failed = steps.filter((s) => !s.ok).length;
      const res = {
        success: failed === 0,
        action: 'suite',
        users,
        failed,
        steps,
        onlineLoadTest: countLoadTestPeers(),
        sustain: !!loadTestSustainTimer,
        note: '종합 검사 후 모의 접속이 남아 있을 수 있습니다. 필요하면 clear 하세요.'
      };
      loadTestLastReport = { action, at: Date.now(), success: res.success, failed, users };
      return res;
    })();
  }

  return { success: false, msg: `unknown action: ${action}` };
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

/** 잘못된 인코딩으로 저장된 한글 복구 시도 (UTF-8을 Latin-1로 오인한 경우 등) */
function tryRepairMojibakeText(str) {
  const s = String(str || '');
  if (!s) return s;
  const hasLatin = /[\u00C0-\u00FF]/.test(s);
  if (!hasLatin) return s;
  try {
    const repaired = Buffer.from(s, 'latin1').toString('utf8');
    if (!repaired || repaired.includes('\uFFFD')) return s;
    const hangul = (t) => (String(t).match(/[\uAC00-\uD7A3]/g) || []).length;
    if (hangul(repaired) > hangul(s)) return repaired;
    if (hangul(repaired) > 0 && hangul(s) === 0) return repaired;
  } catch (_) { /* ignore */ }
  return s;
}

/**
 * 표시용 문자열 정리.
 * 1) 복구 가능한 모지베이크는 한글로 되돌림
 * 2) 복구 불가 대체문자(U+FFFD)만 제거 (성이 통째로 사라진 경우는 복구 불가 → 다시 입력 필요)
 */
function scrubBrokenDisplayChars(str) {
  return tryRepairMojibakeText(str)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\uFFFD+/g, '')
    .replace(/[ \t\u00A0]{2,}/g, ' ')
    .replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
}

/** 미설정·기본 플레이스홀더 이름 (말풍선에 그대로 노출하지 않음) */
function isPlaceholderUsername(name) {
  const s = scrubBrokenDisplayChars(name);
  if (!s) return true;
  return /^(이름없음|이름\s*없음|미설정|unnamed|unknown|n\/?a)$/i.test(s);
}

function displayNameFromParts(rank, username, fallback) {
  const r = normalizeRankText(rank);
  let n = scrubBrokenDisplayChars(username);
  if (isPlaceholderUsername(n)) n = '';
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
              is_me: r.sender_ip === MY_IP || r.sender_ip === 'SELF'
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
  // OneDrive 등에서 existsSync/createFromPath가 멈출 수 있음 → 생성 아이콘 사용
  if (isCloudSyncedInstallPath()) {
    cachedAppIcon = createMessengerIcon(256);
    return cachedAppIcon;
  }
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
  if (isCloudSyncedInstallPath()) {
    cachedTrayIcon = createMessengerIcon(16);
    return cachedTrayIcon;
  }
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

// ⚠️ 핵심 발견: sqlite_master 카탈로그에 chat_pins 항목이 중복 손상되어 있으면, chat_pins를
// 건드리지 않는 아무 쿼리(메시지 전송, 접속 알림 등)를 실행해도 SQLite가 스키마 전체를 먼저
// 읽어야 하기 때문에 "malformed database schema (chat_pins)" 오류가 똑같이 난다. 즉 이 손상이
// 남아있으면 이 DB 연결로 하는 모든 작업이 매번(재전송 루프 등으로 초당 여러 번) 실패하고,
// 그때마다 감지→복구→재시작을 반복해 "껐다 켜졌다"처럼 보인다. 그래서 다른 어떤 쿼리보다도
// 먼저, DB를 연 직후 이 시점에 손상된 카탈로그 행을 지운다 — 아래에서 나중에 벌어질 수 있는
// 오류를 기다렸다가 고치는 게 아니라, 애초에 그 오류가 날 기회 자체를 없앤다.
// 콜백을 반드시 넘겨야 한다 — 콜백 없이 db.run이 실패하면 sqlite3 모듈이 이 오류를 db의
// 'error' 이벤트로 흘려보내는데, 그 전역 핸들러(db.on('error', ...))는 아래에서 아직 등록되기
// 전이라 처리되지 않거나, 등록된 뒤라도 이 시점의 오류를 "진짜 손상"으로 오판해 파괴적인
// 백업 복구(scheduleDbCorruptRecovery)를 곧바로 트리거할 수 있다. 이 정리 작업 자체의 실패는
// 절대 그 경로를 타면 안 되므로, 여기서는 그냥 조용히 기록만 하고 넘어간다.
// chat_pins/deleted_chat_pins 테이블뿐 아니라, 그 테이블의 PRIMARY KEY가 자동으로 만든
// 인덱스(sqlite_autoindex_chat_pins_1 같은 이름)도 카탈로그에 별도 행으로 남아있다.
// 테이블 행만 지우고 이 인덱스 행을 안 지우면 "orphan index" 손상이 새로 생긴다(실제로 발생함) —
// 그래서 이름이 완전히 같은 것뿐 아니라 이 두 테이블에서 비롯된 자동 인덱스까지 전부 지운다.
db.serialize(() => {
  db.run('PRAGMA writable_schema = ON', () => {});
  db.run(
    `DELETE FROM sqlite_master WHERE
       name IN ('chat_pins','deleted_chat_pins')
       OR name LIKE 'sqlite_autoindex_chat_pins%'
       OR name LIKE 'sqlite_autoindex_deleted_chat_pins%'`,
    (err) => { if (err) console.error('[DB] 부팅 시 chat_pins 카탈로그 정리 실패(무시):', err.message); }
  );
  db.run('PRAGMA writable_schema = OFF', () => {});
});

const DB_CORRUPT_USER_MSG =
  '로컬 데이터베이스가 손상되었습니다. 백업에서 복구한 뒤 앱을 다시 시작합니다. 복구가 끝나면 공지를 다시 작성해 주세요.';

let dbCorruptRecoveryScheduled = false;

/**
 * "malformed database schema (X) - table X already exists" 형태는 sqlite_master에 X 하나만
 * 중복/충돌 기록된 국소 손상이지 DB 전체 페이지 손상이 아니다. 그런데도 실제로는 이 메시지에
 * "malformed"가 들어있어 전체 DB 복구(백업 복원→재시작)를 반복 유발한 적이 있다 — 복원한 백업에도
 * 같은 X가 이미 있으니 또 같은 에러가 나서 몇 시간 동안 재시작만 반복하며 디스크를 19GB 채운 사고.
 * 이런 국소 스키마 충돌은 해당 테이블만 지우고 다시 만들면 끝나므로 전체 DB를 버릴 필요가 없다.
 */
/** chat_pins/deleted_chat_pins 테이블 자체이거나, 거기서 비롯된 자동 인덱스인지 확인 */
function isChatPinRelatedSchemaName(name) {
  if (!name) return false;
  return (
    name === 'chat_pins' ||
    name === 'deleted_chat_pins' ||
    name.startsWith('sqlite_autoindex_chat_pins') ||
    name.startsWith('sqlite_autoindex_deleted_chat_pins')
  );
}

function parseBenignSchemaConflict(err) {
  const msg = String((err && err.message) || err || '');
  // "table X already exists" / "index X already exists" 형태
  const m1 = msg.match(/malformed database schema \((\S+)\)\s*-\s*(?:table|index)\s+\S+\s+already exists/i);
  if (m1) return m1[1];
  // "orphan index" 형태 — 테이블 행은 지워졌는데 그 테이블의 자동 인덱스 카탈로그 행이 남은 경우
  // (실제로 chat_pins 정리 과정에서 발생) — 이름 자체(예: sqlite_autoindex_chat_pins_1)로 판단한다.
  const m2 = msg.match(/malformed database schema \((\S+)\)\s*-\s*orphan index/i);
  if (m2 && isChatPinRelatedSchemaName(m2[1])) return m2[1];
  return null;
}

function isSqliteCorruptError(err) {
  if (parseBenignSchemaConflict(err)) return false;
  const msg = String((err && err.message) || err || '');
  return /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|disk image is malformed|file is not a database|database disk image/i.test(msg);
}

/** parseBenignSchemaConflict로 찾아낸 테이블만 좁혀서 재생성 — 알려진 테이블만 지원 */
const RECREATABLE_SCHEMA_SQL = {
  chat_pins: `CREATE TABLE chat_pins (
    channel_key TEXT PRIMARY KEY,
    msg_uid TEXT,
    message_html TEXT,
    preview_text TEXT,
    sender_name TEXT,
    pinned_at TEXT,
    pinned_by_name TEXT,
    pinned_by_ip TEXT
  )`,
  deleted_chat_pins: `CREATE TABLE deleted_chat_pins (
    channel_key TEXT PRIMARY KEY,
    cleared_at TEXT NOT NULL
  )`
};
const schemaHardRepairInProgress = new Set();

/**
 * sqlite_master의 손상된 스키마 행을 저수준으로 직접 정리한다.
 * 일반 DROP TABLE은 실행 전에 손상된 카탈로그 행 자체를 먼저 읽어야 하므로, 그 손상 때문에
 * DROP도 같이 조용히 실패하는 경우가 있다(재생성 안 되고 같은 오류만 매 부팅 재발).
 * 손상이 "중복 행"인지 "행 내용 자체 손상"인지 구분하지 않고, 이름이 일치하는 스키마 행을
 * PRAGMA writable_schema로 통째로 지운 뒤, 새 연결로 다시 열어 알려진 정상 SQL로 재생성한다.
 * (writable_schema로 바꾼 스키마는 같은 연결에 바로 반영되지 않을 수 있어 연결을 새로 연다.)
 */
function hardRepairSchemaRow(table) {
  return new Promise((resolve) => {
    // 원래 연결이 열려 있으면 WAL 락 경합으로 저수준 복구용 연결이 SQLITE_BUSY로 조용히
    // 실패할 수 있다 — 먼저 닫고 단독으로 접근한다(어차피 성공/실패와 무관하게 곧 재시작함).
    db.close(() => {
      try {
        const repairDb = new sqlite3.Database(dbPath, (openErr) => {
          if (openErr) { resolve(false); return; }
          repairDb.run(`PRAGMA busy_timeout = 5000`);
          repairDb.serialize(() => {
            repairDb.run(`PRAGMA writable_schema = ON`);
            repairDb.run(`DELETE FROM sqlite_master WHERE type IN ('table','index') AND name = ?`, [table], (delErr) => {
              if (delErr) console.error(`[DB] "${table}" writable_schema 삭제 실패:`, delErr.message);
            });
            repairDb.run(`PRAGMA writable_schema = OFF`);
            repairDb.close(() => {
              const finalDb = new sqlite3.Database(dbPath, (reopenErr) => {
                if (reopenErr) { resolve(false); return; }
                finalDb.run(`PRAGMA busy_timeout = 5000`);
                finalDb.run(RECREATABLE_SCHEMA_SQL[table], (createErr) => {
                  if (createErr) {
                    console.error(`[DB] "${table}" 저수준 재생성 실패:`, createErr.message);
                    finalDb.close(() => resolve(false));
                    return;
                  }
                  // chat_pins처럼 작고 지엽적인(메시지 고정 등) 테이블 하나를 고친 건데,
                  // 성공 판정을 대형 DB 전체를 훑는 PRAGMA integrity_check로 하고 있었다.
                  // 이 검사는 몇 초~몇십 초 걸릴 수 있고(실제로 이벤트 루프 지연과 시간대가
                  // 겹쳐 나타남), DB의 다른 무관한 부분에 사소한 문제가 있어도 여기서
                  // "실패"로 판정돼 훨씬 무거운 백업 복구·재시작 사이클로 확대됐다.
                  // 방금 고친 그 테이블만 정상 조회되는지 확인하는 것으로 충분하다.
                  finalDb.get(`SELECT COUNT(*) AS n FROM ${table}`, (checkErr) => {
                    const ok = !checkErr;
                    finalDb.close(() => resolve(ok));
                  });
                });
              });
            });
          });
        });
      } catch (e) {
        resolve(false);
      }
    });
  });
}

// 메시지 고정(chat_pins) 관련 테이블은 핵심 기능(메시지 송수신)과 무관한 부가 기능이다.
// 예전에는 이 테이블 하나가 깨지면 "복구 실패"로 판정해 며칠 전 백업으로 전체 DB를
// 통째로 덮어쓰는 scheduleDbCorruptRecovery까지 확대됐고, 그 과정에서 그 사이 주고받은
// 메시지가 통째로 사라지는 사고가 실제로 있었다. 이제 이 테이블은 그 파괴적인 경로
// (백업으로 전체 DB 교체)를 절대 타지 않는다 — 재시작은 하되(db가 const라 재연결하려면
// 불가피함), 백업으로 되돌리지는 않는다.
const NON_FATAL_SCHEMA_TABLES = new Set(['chat_pins', 'deleted_chat_pins']);

/** 백업 복구 없이 지금 이 DB 파일 그대로 다시 여는 가벼운 재시작 — 메시지는 그대로 둔 채
 * db 연결만 새로 맺기 위해서다(db가 const라 재할당 불가 → 새 프로세스로 재연결). */
function relaunchWithoutBackupRestore() {
  app.relaunch();
  app.exit(0);
}

/**
 * chat_pins/deleted_chat_pins 기능은 완전히 제거됐으므로, 이 테이블이나 그 자동 인덱스와
 * 관련된 스키마 손상은 "다시 만들" 필요가 없다 — 카탈로그에서 관련 행을 전부 지우기만 하면
 * 된다(테이블 행 자체 손상이든, 그 테이블의 orphan index 손상이든 동일하게 처리 가능).
 * 이렇게 하면 hardRepairSchemaRow처럼 재생성 → 재생성한 인덱스가 다시 orphan이 되는 식의
 * 반복을 원천적으로 피할 수 있다.
 */
function hardWipeChatPinArtifacts() {
  return new Promise((resolve) => {
    db.close(() => {
      try {
        const repairDb = new sqlite3.Database(dbPath, (openErr) => {
          if (openErr) { resolve(false); return; }
          repairDb.run(`PRAGMA busy_timeout = 5000`);
          repairDb.serialize(() => {
            repairDb.run(`PRAGMA writable_schema = ON`);
            repairDb.run(
              `DELETE FROM sqlite_master WHERE
                 name IN ('chat_pins','deleted_chat_pins')
                 OR name LIKE 'sqlite_autoindex_chat_pins%'
                 OR name LIKE 'sqlite_autoindex_deleted_chat_pins%'`,
              (delErr) => {
                if (delErr) console.error('[DB] chat_pins 관련 카탈로그 정리 실패:', delErr.message);
              }
            );
            repairDb.run(`PRAGMA writable_schema = OFF`);
            repairDb.close((closeErr) => resolve(!closeErr));
          });
        });
      } catch (e) {
        resolve(false);
      }
    });
  });
}

function tryRepairBenignSchemaConflict(err) {
  const table = parseBenignSchemaConflict(err);
  if (!table) return false;
  if (isChatPinRelatedSchemaName(table)) {
    if (schemaHardRepairInProgress.has('chat_pins_artifacts')) return true;
    schemaHardRepairInProgress.add('chat_pins_artifacts');
    const attempt = bumpDbRecoveryAttemptCount();
    if (attempt > DB_RECOVERY_MAX_ATTEMPTS) {
      console.error(`[DB] chat_pins 관련 복구 ${attempt}회째 반복 — 부가 기능이라 백업 복구 없이 그대로 재연결만 시도`);
      relaunchWithoutBackupRestore();
      return true;
    }
    console.error(`[DB] chat_pins 관련 스키마 손상 감지("${table}") — 관련 카탈로그 행 정리 시도:`, err && err.message);
    hardWipeChatPinArtifacts().then(() => {
      // 성공/실패와 무관하게 재연결이 필요하다(db가 위에서 close됨) — 부가 기능이라
      // 정리가 설사 실패해도 백업 복구로 확대하지 않는다.
      resetDbRecoveryAttemptCount();
      relaunchWithoutBackupRestore();
    });
    return true;
  }
  if (!RECREATABLE_SCHEMA_SQL[table]) return false;
  if (schemaHardRepairInProgress.has(table)) return true; // 이미 진행 중 — 재시도 폭주 방지
  schemaHardRepairInProgress.add(table);
  const nonFatal = NON_FATAL_SCHEMA_TABLES.has(table);
  const attempt = bumpDbRecoveryAttemptCount();
  if (attempt > DB_RECOVERY_MAX_ATTEMPTS) {
    if (nonFatal) {
      console.error(`[DB] "${table}" 복구 ${attempt}회째 반복 — 부가 기능이라 백업 복구 없이 그대로 재연결만 시도`);
      relaunchWithoutBackupRestore();
      return true;
    }
    console.error(`[DB] "${table}" 복구 ${attempt}회째 반복 — 백업 복구로 전환`);
    scheduleDbCorruptRecovery(`schema-repair-loop:${table}`);
    return true;
  }
  console.error(`[DB] "${table}" 스키마 손상 감지 — writable_schema 저수준 재생성 시도:`, err && err.message);
  hardRepairSchemaRow(table).then((ok) => {
    console.error(`[DB] "${table}" 저수준 재생성 ${ok ? '성공' : '실패'}`);
    if (!ok) {
      if (nonFatal) {
        console.error(`[DB] "${table}" 저수준 재생성 실패 — 부가 기능이라 백업 복구 없이 그대로 재연결만 시도`);
        relaunchWithoutBackupRestore();
        return;
      }
      scheduleDbCorruptRecovery(`hard-repair-failed:${table}`);
      return;
    }
    resetDbRecoveryAttemptCount();
    app.relaunch();
    app.exit(0);
  });
  return true;
}

function userFacingDbError(err) {
  if (isSqliteCorruptError(err)) return DB_CORRUPT_USER_MSG;
  return String((err && err.message) || err || '알 수 없는 DB 오류');
}

function integrityCheckMarkerPath() {
  return path.join(app.getPath('userData'), 'last-integrity-check.txt');
}

function shouldRunIntegrityCheck() {
  // 매 시작 PRAGMA integrity_check는 대형 DB에서 수 초~수십 초 UI 정지 유발 → 주 1회만
  try {
    const raw = fs.readFileSync(integrityCheckMarkerPath(), 'utf8').trim();
    const t = parseInt(raw, 10);
    if (Number.isFinite(t) && Date.now() - t < 7 * 24 * 60 * 60 * 1000) return false;
  } catch (e) { /* first run */ }
  return true;
}

function markIntegrityCheckDone() {
  try {
    fs.writeFileSync(integrityCheckMarkerPath(), String(Date.now()), 'utf8');
  } catch (e) { /* ignore */ }
}

function clearIntegrityCheckMarker() {
  try { fs.unlinkSync(integrityCheckMarkerPath()); } catch (e) { /* ignore */ }
}

/** 손상 복구가 계속 실패해 재시작만 반복하는 것을 막는 안전장치용 카운터 파일 */
function dbRecoveryAttemptCountPath() {
  return path.join(app.getPath('userData'), 'db-recovery-attempts.txt');
}

function readDbRecoveryAttemptCount() {
  try {
    return parseInt(fs.readFileSync(dbRecoveryAttemptCountPath(), 'utf8').trim(), 10) || 0;
  } catch (e) {
    return 0;
  }
}

function bumpDbRecoveryAttemptCount() {
  const next = readDbRecoveryAttemptCount() + 1;
  try { fs.writeFileSync(dbRecoveryAttemptCountPath(), String(next), 'utf8'); } catch (e) { /* ignore */ }
  return next;
}

function resetDbRecoveryAttemptCount() {
  try { fs.unlinkSync(dbRecoveryAttemptCountPath()); } catch (e) { /* ignore */ }
}

/** 이 이상 연속으로 복구를 시도했으면 백업 탐색을 건너뛰고 바로 빈 DB로 확정해 루프를 끊는다 */
const DB_RECOVERY_MAX_ATTEMPTS = 3;

function sqliteCheckRowOk(row) {
  if (!row) return false;
  const v = row.integrity_check != null ? row.integrity_check
    : (row.quick_check != null ? row.quick_check : Object.values(row)[0]);
  return String(v || '') === 'ok';
}

function probeSqliteFileHealthy(filePath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(!!ok);
    };
    // ⚠️ quick_check는 integrity_check보다 느슨해서, 여기서 "건강하다"고 통과시킨 백업이
    // 다음 부팅의 (더 엄격한) integrity_check에서 다시 손상으로 판정되면 복원↔재감염을
    // 끝없이 반복하는 켜짐/꺼짐 루프가 생긴다. 부팅 시 검사와 동일한 기준을 쓴다.
    // 대용량 DB는 검사에 8초 넘게 걸릴 수 있어 타임아웃도 넉넉히 잡는다.
    const timer = setTimeout(() => finish(false), 25000);
    try {
      const testDb = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (openErr) => {
        if (openErr) {
          clearTimeout(timer);
          finish(false);
          return;
        }
        testDb.get('PRAGMA integrity_check', (err, row) => {
          testDb.close(() => {
            clearTimeout(timer);
            finish(!err && sqliteCheckRowOk(row));
          });
        });
      });
    } catch (e) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

async function findHealthyAutoBackup() {
  const dir = path.join(app.getPath('userData'), 'backups');
  const names = (await fs.promises.readdir(dir).catch(() => []))
    .filter((n) => n.startsWith('auto_backup_') && n.endsWith('.db'))
    .sort()
    .reverse();
  for (const name of names) {
    const p = path.join(dir, name);
    if (await probeSqliteFileHealthy(p)) return { path: p, name };
  }
  return null;
}

/** corrupted_ 안전 사본은 최근 N개만 남기고 지운다 — 복구가 반복될 때마다
 * 300MB대 사본이 무한정 쌓여 디스크를 채우는 것을 막는다(실사고: 하루 만에 11개, 3.5GB). */
const CORRUPTED_STASH_KEEP = 2;
async function pruneCorruptedStashCopies() {
  try {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const names = (await fs.promises.readdir(dir).catch(() => []))
      .filter((n) => n.startsWith(`${base}.corrupted_`) && !n.endsWith('-wal') && !n.endsWith('-shm'))
      .sort()
      .reverse();
    const stale = names.slice(CORRUPTED_STASH_KEEP);
    for (const name of stale) {
      const p = path.join(dir, name);
      await fs.promises.unlink(p).catch(() => {});
      await fs.promises.unlink(`${p}-wal`).catch(() => {});
      await fs.promises.unlink(`${p}-shm`).catch(() => {});
    }
    if (stale.length) console.error(`[DB] 오래된 손상 사본 ${stale.length}개 정리`);
  } catch (e) { /* ignore */ }
}

async function stashAndReplaceMessengerDb(sourcePathOrNull) {
  const stamp = Date.now();
  const corruptedCopy = `${dbPath}.corrupted_${stamp}`;
  await fs.promises.copyFile(dbPath, corruptedCopy).catch(() => {});
  await fs.promises.copyFile(`${dbPath}-wal`, `${corruptedCopy}-wal`).catch(() => {});
  await fs.promises.copyFile(`${dbPath}-shm`, `${corruptedCopy}-shm`).catch(() => {});
  if (sourcePathOrNull) {
    await fs.promises.copyFile(sourcePathOrNull, dbPath);
  } else {
    await fs.promises.unlink(dbPath).catch(() => {});
  }
  await fs.promises.unlink(`${dbPath}-wal`).catch(() => {});
  await fs.promises.unlink(`${dbPath}-shm`).catch(() => {});
  await pruneCorruptedStashCopies();
  return corruptedCopy;
}

/**
 * SQLITE_CORRUPT 등 감지 시: 연결 종료 → 건전한 자동백업으로 교체 → 재시작.
 * 백업이 없으면 WAL 정리 후, 본파일이 여전히 나쁘면 빈 DB로 재시작.
 */
function scheduleDbCorruptRecovery(reason) {
  if (dbCorruptRecoveryScheduled) return;
  dbCorruptRecoveryScheduled = true;
  clearIntegrityCheckMarker();
  console.error('[DB] corrupt recovery scheduled:', reason || '');
  if (mainWindow) {
    try {
      safeWebContentsSend('db-corrupt-recovery', {
        reason: String(reason || ''),
        message: DB_CORRUPT_USER_MSG
      });
    } catch (_) { /* ignore */ }
  }
  setTimeout(() => {
    // db.close() 전에 마지막으로 한 번 체크포인트를 시도한다 — 아직 -wal에만 있고
    // 본 파일에 합쳐지지 않은 최신 메시지가, 뒤이은 "백업 없음 → WAL/SHM 삭제" 경로에서
    // 그대로 날아가는 사고(실제 발생)를 막기 위함. 진짜로 손상됐으면 이 체크포인트도
    // 실패하거나 의미가 없을 뿐, 더 나빠지지는 않는다.
    checkpointWalPassive().finally(() => {
    db.close(async () => {
      try {
        // 백업을 복원해도 다음 부팅에서 다시 "손상"으로 판정되면 복원↔재감염이 끝없이
        // 반복된다(실제로 326MB 백업 하나를 반복 복원하며 디스크를 19GB까지 채운 사고가 있었음).
        // 연속 실패가 이 횟수를 넘으면 더는 백업을 믿지 않고 바로 빈 DB로 확정해 루프를 끊는다.
        const attempt = bumpDbRecoveryAttemptCount();
        const giveUpOnBackups = attempt > DB_RECOVERY_MAX_ATTEMPTS;
        if (giveUpOnBackups) {
          console.error(`[DB] 복구 ${attempt}회째 반복 — 백업 신뢰 중단, 빈 DB로 확정`);
        }
        const healthy = giveUpOnBackups ? null : await findHealthyAutoBackup();
        if (healthy) {
          const kept = await stashAndReplaceMessengerDb(healthy.path);
          console.error(`[DB] restored from ${healthy.name}; corrupt kept as ${path.basename(kept)}`);
        } else {
          await fs.promises.unlink(`${dbPath}-wal`).catch(() => {});
          await fs.promises.unlink(`${dbPath}-shm`).catch(() => {});
          if (!giveUpOnBackups && await probeSqliteFileHealthy(dbPath)) {
            console.error('[DB] no backup; cleared WAL/SHM and main DB looks healthy');
          } else {
            const kept = await stashAndReplaceMessengerDb(null);
            console.error(`[DB] no healthy backup — empty DB on next launch; corrupt kept as ${path.basename(kept)}`);
          }
        }
        app.relaunch();
        app.exit(0);
      } catch (e) {
        console.error('[DB] automatic recovery failed:', e && e.message);
        app.exit(1);
      }
    });
    });
  }, 500);
}

db.on('error', (err) => {
  console.error('❌ 데이터베이스 오류:', err && err.message);
  if (tryRepairBenignSchemaConflict(err)) return;
  if (isSqliteCorruptError(err)) scheduleDbCorruptRecovery('db-event');
});

// 🛡 SQLite 안정성 강화: PC가 강제 종료(정전, 블루스크린)되어도 DB가 깨지지 않도록.
// (아래 세 문장은 순서가 중요해서 serialize()로 묶는다 — WAL 모드 설정 → 동기화 설정 → (선택) 무결성 검사.
//  단, serialize()는 SQLite 문장끼리의 순서만 보장할 뿐, 그 안의 콜백에서 하는 파일 복사 같은
//  비-SQLite 비동기 작업까지 기다려주지는 않으므로 복구 로직은 아래에서 별도로 안전하게 처리한다.)
db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA synchronous = NORMAL`);
  db.run(`PRAGMA busy_timeout = 5000`);
});

// ⚠️ 실사고: integrity_check가 부팅 직후(창이 뜨자마자 렌더러가 보내는 사용자 목록·공지·일정
// 조회와) 같은 DB 연결을 두고 경쟁하면, 대형 DB에서 몇 초~몇십 초 동안 그 조회들이 줄 서서
// 기다리게 되어 "응답 없음"으로 보인다. 안전 점검 자체는 유지하되, 창이 다 그려지고 초기 데이터
// 요청이 끝났을 시점(8초 뒤)으로 미뤄 시작 화면과 경쟁하지 않게 한다.
setTimeout(() => {
  if (!shouldRunIntegrityCheck()) {
    console.log('[DB] integrity_check 생략 (최근 7일 이내 검사함)');
    return;
  }
  db.get(`PRAGMA integrity_check`, (err, row) => {
    const ok = !err && sqliteCheckRowOk(row);
    if (ok) {
      markIntegrityCheckDone();
      resetDbRecoveryAttemptCount();
      return;
    }
    // ⚠️ 실사고: chat_pins류의 국소 스키마 카탈로그 손상이면 integrity_check 자체도 스키마를
    // 읽다가 똑같은 "malformed database schema (chat_pins)..." 오류로 실패한다. 여기서는 그걸
    // 구분하지 않고 바로 백업 복구로 넘어가고 있었는데, 복원한 백업에도 같은 손상이 있으면
    // 다음 부팅에 또 실패해서 반복 재시작(오늘 실제로 겪은 문제)이 된다. logDbErr와 똑같이
    // 먼저 국소 수리를 시도하고, 그걸로 해결 안 되는 진짜 손상일 때만 백업 복구로 넘어간다.
    if (err && tryRepairBenignSchemaConflict(err)) return;
    console.error('⚠️ 데이터베이스 손상 감지 — 백업 복구를 시작합니다:', err ? err.message : row);
    scheduleDbCorruptRecovery('startup-integrity');
  });
}, 8000);

// 💾 journal_mode=WAL이면 최근 쓰기 내용이 mirae_messenger.db-wal 파일에 잠깐 남아있을 수 있다.
// 그 상태에서 mirae_messenger.db 파일만 그대로 복사하면 최신 내용이 빠진 백업이 만들어질 수 있으므로,
// 백업 직전에는 항상 이걸 먼저 실행해서 -wal 내용을 본 파일로 합쳐(checkpoint) 넣는다.
function checkpointWal() {
  return new Promise((resolve) => {
    db.run(`PRAGMA wal_checkpoint(TRUNCATE)`, () => resolve());
  });
}

// TRUNCATE는 완전히 합쳐질 때까지 기다리는 무거운 방식이라, 디스크가 느린 PC에서는
// 몇 초~몇십 초씩 이벤트 루프를 막을 수 있다(실제로 이 정황과 겹쳐 DB 손상이
// 반복된 사례가 있었음). 주기적/종료 시 체크포인트처럼 "가능한 만큼만, 안 막고"
// 합치면 충분한 경우에는 PASSIVE를 쓴다.
function checkpointWalPassive() {
  return new Promise((resolve) => {
    db.run(`PRAGMA wal_checkpoint(PASSIVE)`, () => resolve());
  });
}

function logDbErr(err) {
  if (!err) return;
  const msg = String(err.message || err);
  // 동일 오류가 초당 수십 번 찍히면 콘솔/IPC만으로 CPU가 올라감 — 10초에 1회만
  const now = Date.now();
  if (!logDbErr._last) logDbErr._last = { msg: '', at: 0 };
  if (logDbErr._last.msg === msg && now - logDbErr._last.at < 10000) return;
  logDbErr._last = { msg, at: now };
  console.error('DB 오류:', msg);
  logToRendererConsole('error', 'DB 오류: ' + msg);
  if (tryRepairBenignSchemaConflict(err)) return;
  if (isSqliteCorruptError(err)) scheduleDbCorruptRecovery('logDbErr');
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

/** 진단용: 메인 프로세스 JS 이벤트 루프가 실제로 막혀있었는지 측정 — "응답없음" 원인이
 * JS 쪽(무한루프 등)인지 네이티브/GPU 쪽인지 구분하기 위한 임시 계측. */
(function startEventLoopLagMonitor() {
  const INTERVAL_MS = 200;
  const LAG_THRESHOLD_MS = 300;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - last - INTERVAL_MS;
    last = now;
    if (drift > LAG_THRESHOLD_MS) {
      writeToLogFile('warn', `[진단] 이벤트 루프 지연 ${drift}ms`);
    }
  }, INTERVAL_MS);
})();

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

/** 대화 내용(messages 테이블)은 절대 자동 삭제하지 않는다 — 몇 년 전 대화도 「전체 대화
 * 기록」에서 그대로 조회된다. 이 함수가 지우는 채팅로그 .txt는 그 DB 내용과 완전히
 * 중복되는 사본이고(메시지 보낼 때마다 한 줄씩 추가되는 텍스트 백업, 화면에 다시
 * 읽어서 보여주는 곳이 없음 — 「채팅 기록 내보내기」할 때만 복사됨), IP가 바뀔 때마다
 * DM_<IP>.txt로 새 파일이 또 생겨 상대방 IP가 여러 번 바뀌면 계속 늘어나기만 했다.
 * 오래 안 쓰인(=상대가 더 이상 활성 대화 상대가 아닌) 파일만 정리한다. */
function cleanupOldChatLogFiles() {
  const dir = getChatLogDir();
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  fs.readdir(dir, (err, names) => {
    if (err || !names) return;
    names.forEach(name => {
      if (!name.endsWith('.txt')) return;
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
  // 예전 DB에는 phone_no 등이 없을 수 있음 — 없으면 INSERT마다 SQLITE_ERROR로 CPU/콘솔 폭주
  ['username TEXT', 'rank TEXT', 'dept TEXT', 'floor TEXT', 'ext_no TEXT', 'phone_no TEXT', 'status_state TEXT', 'photo TEXT', 'last_seen_at INTEGER'].forEach((colDef) => {
    db.run(`ALTER TABLE known_users ADD COLUMN ${colDef}`, () => {});
  });
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

  // 이 PC의 메신저 사용 중지(잠금) 상태 — 재시작 후에도 유지
  db.run(`CREATE TABLE IF NOT EXISTS usage_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    disabled INTEGER DEFAULT 0,
    disabled_at TEXT DEFAULT '',
    disabled_by_ip TEXT DEFAULT '',
    reason TEXT DEFAULT ''
  )`, logDbErr);
  db.run(`INSERT OR IGNORE INTO usage_lock (id, disabled) VALUES (1, 0)`, () => {});

  // 서비스 일시중지(전체) — 마스터가 켜고 끔. 기본 OFF
  db.run(`CREATE TABLE IF NOT EXISTS service_pause (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER DEFAULT 0,
    title TEXT DEFAULT '',
    body TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    until_label TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    revision INTEGER DEFAULT 0,
    bypass_revision INTEGER DEFAULT 0
  )`, logDbErr);
  db.run(
    `INSERT OR IGNORE INTO service_pause (id, enabled, title, body, contact, until_label, revision, bypass_revision)
     VALUES (1, 0, ?, ?, ?, ?, 0, 0)`,
    [
      SERVICE_PAUSE_DEFAULTS.title,
      SERVICE_PAUSE_DEFAULTS.body,
      SERVICE_PAUSE_DEFAULTS.contact,
      SERVICE_PAUSE_DEFAULTS.untilLabel
    ],
    () => {}
  );

  // 마스터가 다른 PC 사용을 중지한 목록 (관리 화면용)
  db.run(`CREATE TABLE IF NOT EXISTS disabled_clients (
    ip TEXT PRIMARY KEY,
    username TEXT DEFAULT '',
    disabled_at TEXT DEFAULT '',
    disabled_by_ip TEXT DEFAULT '',
    reason TEXT DEFAULT ''
  )`, logDbErr);
  db.run(`ALTER TABLE disabled_clients ADD COLUMN reason TEXT DEFAULT ''`, () => {});

  db.get(
    `SELECT enabled, title, body, contact, until_label, updated_at, revision, bypass_revision FROM service_pause WHERE id = 1`,
    (errPause, pauseRow) => {
      if (!errPause && pauseRow) {
        servicePause = {
          enabled: !!pauseRow.enabled,
          title: pauseRow.title || SERVICE_PAUSE_DEFAULTS.title,
          body: pauseRow.body || SERVICE_PAUSE_DEFAULTS.body,
          contact: pauseRow.contact || SERVICE_PAUSE_DEFAULTS.contact,
          untilLabel: pauseRow.until_label || SERVICE_PAUSE_DEFAULTS.untilLabel,
          updatedAt: pauseRow.updated_at || '',
          revision: Number(pauseRow.revision || 0)
        };
        servicePauseBypassRevision = Number(pauseRow.bypass_revision || 0);
      }
      db.get(`SELECT disabled, disabled_at, disabled_by_ip, reason FROM usage_lock WHERE id = 1`, (err, row) => {
        if (!err && row) {
          localUsageDisabled = !!row.disabled;
          localUsageLockMeta = {
            disabledAt: row.disabled_at || '',
            disabledByIp: row.disabled_by_ip || '',
            reason: row.reason || ''
          };
        }
        if (isMessengerUsageBlocked()) {
          try { broadcastGoodbye(); } catch (_) {}
          onlineUsers.delete(MY_IP);
        }
        try { notifyUsageLockState(); } catch (_) {}
        try { notifyServicePauseState(); } catch (_) {}
      });
    }
  );
  db.all(`SELECT ip, username, disabled_at, disabled_by_ip, reason FROM disabled_clients`, [], (err, rows) => {
    if (err || !rows) return;
    rows.forEach((r) => {
      if (!r || !r.ip) return;
      disabledClients.set(r.ip, {
        ip: r.ip,
        username: r.username || '',
        disabledAt: r.disabled_at || '',
        disabledByIp: r.disabled_by_ip || '',
        reason: r.reason || ''
      });
    });
  });

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
    created_at TEXT,
    images TEXT DEFAULT '',
    category TEXT DEFAULT '전체'
  )`, logDbErr);
  // 예전 버전에서 이미 notices 테이블이 만들어져 있던 PC는 위 CREATE TABLE이 그냥 무시되므로,
  // 없을 수 있는 컬럼들을 하나씩 추가해서 최신 구조로 맞춰준다. (이미 있으면 에러가 나지만 무시됨)
  ['uid TEXT', 'title TEXT', 'content TEXT', 'author_name TEXT', 'author_ip TEXT', 'created_at TEXT', 'images TEXT', 'category TEXT'].forEach(colDef => {
    db.run(`ALTER TABLE notices ADD COLUMN ${colDef}`, () => {});
  });
  // 카테고리 컬럼 보장 후 빈 값 보정 (기존 PC에서 INSERT 실패 방지)
  setTimeout(() => {
    ensureNoticesCategoryColumn(() => {
      db.run(`UPDATE notices SET category = '전체' WHERE category IS NULL OR TRIM(COALESCE(category, '')) = ''`, () => {});
    });
  }, 300);
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
  // 신규 컬럼만 DEFAULT — 부팅마다 0→1로 덮지 않음 (마스터가 끈 권한 유지)

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

  /** 삭제된 일정 UID — 피어 NOTICE_SYNC 가 INSERT OR IGNORE 로 되살리는 것 방지 */
  db.run(`CREATE TABLE IF NOT EXISTS deleted_schedules (
    uid TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
  )`, (err) => {
    logDbErr(err);
    db.all(`SELECT uid FROM deleted_schedules`, (loadErr, rows) => {
      if (loadErr) {
        logDbErr(loadErr);
        return;
      }
      rememberScheduleTombstones((rows || []).map((r) => r && r.uid).filter(Boolean));
    });
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_deleted_schedules_at ON deleted_schedules(deleted_at)`, () => {});

  /** 삭제된 공지 UID — NOTICE_SYNC 가 되살리는 것 방지 */
  db.run(`CREATE TABLE IF NOT EXISTS deleted_notices (
    uid TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
  )`, (err) => {
    logDbErr(err);
    db.all(`SELECT uid FROM deleted_notices`, (loadErr, rows) => {
      if (loadErr) {
        logDbErr(loadErr);
        return;
      }
      rememberNoticeTombstones((rows || []).map((r) => r && r.uid).filter(Boolean));
    });
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_deleted_notices_at ON deleted_notices(deleted_at)`, () => {});

  /** 오프라인 PC 원격 로그 삭제 예약 — 대상이 켜져 접속하면 즉시 전달 */
  db.run(`CREATE TABLE IF NOT EXISTS pending_remote_wipes (
    target_ip TEXT PRIMARY KEY,
    master_password TEXT NOT NULL,
    reason TEXT DEFAULT '',
    requested_by_ip TEXT DEFAULT '',
    requested_at TEXT NOT NULL
  )`, logDbErr);

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
  db.run(`ALTER TABLE app_settings ADD COLUMN update_mode TEXT DEFAULT 'manual'`, () => {});
  db.get(`SELECT * FROM app_settings WHERE id = 1`, (err, row) => {
    if (!row) {
      updateSourcePath = DEFAULT_UPDATE_SOURCE_PATH;
      transportWebappUrl = DEFAULT_TRANSPORT_WEBAPP_URL;
      downloadFolderPath = app.getPath('downloads');
      updateMode = 'manual';
      db.run(`INSERT INTO app_settings (id, show_notification_preview, update_source_path, transport_webapp_url, download_folder_path, update_mode) VALUES (1, 1, ?, ?, ?, ?)`, [updateSourcePath, transportWebappUrl, downloadFolderPath, updateMode], logDbErr);
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
      // 자동 업데이트를 전면 폐지 — 예전에 'auto'로 저장돼 있던 PC도 이번 실행부터 강제로 수동 전환.
      updateMode = 'manual';
      if (row.update_mode !== 'manual') {
        db.run(`UPDATE app_settings SET update_mode = 'manual' WHERE id = 1`, [], logDbErr);
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

  // 과거「나에게 보내기」실패분이 PENDING으로 남은 경우 SENT로 정리
  db.run(
    `UPDATE messages SET status = 'SENT' WHERE sender_ip = ? AND receiver_ip = ? AND status = 'PENDING'`,
    [MY_IP, MY_IP],
    logDbErr
  );
  // 마이그레이션: 예전에는 「나에게 보내기」를 그때그때의 현재 IP(sender_ip=receiver_ip=
  // 같은 값)로 저장했다. IP가 DHCP 재할당 등으로 바뀌면 재시작 후 「나에게」 대화창을
  // 열어도 예전 IP로 저장된 메시지를 못 찾아 사라진 것처럼 보였다(실제 사용자 보고).
  // sender_ip와 receiver_ip가 서로 같은 값인 행은 정의상 셀프 메시지뿐이므로,
  // IP가 바뀌어도 항상 찾을 수 있는 고정 키 'SELF'로 옮겨준다.
  // 전체 테이블을 스캔하는 UPDATE라 디스크가 느린 PC에서 매 부팅 반복하면 부담이
  // 될 수 있어, 마커 파일로 한 번만 실행한다.
  const selfMigrationMarker = path.join(app.getPath('userData'), 'self-chat-migrated.txt');
  if (!fs.existsSync(selfMigrationMarker)) {
    db.run(
      `UPDATE messages SET sender_ip = 'SELF', receiver_ip = 'SELF'
       WHERE sender_ip = receiver_ip AND sender_ip IS NOT NULL AND sender_ip != '' AND sender_ip != 'SELF'`,
      [],
      (err) => {
        logDbErr(err);
        if (!err) { try { fs.writeFileSync(selfMigrationMarker, '1', 'utf8'); } catch (e) { /* ignore */ } }
      }
    );
  }
  // 마이그레이션: 메시지 고정(chat_pins) 기능은 1.0.566에서 완전히 제거했지만, 이미 설치된
  // PC들의 DB 파일에는 그 이전에 만들어진 chat_pins/deleted_chat_pins 테이블이 그대로 남아
  // 있다. 이 테이블의 스키마 카탈로그가 손상되면 tryRepairBenignSchemaConflict가 감지해서
  // 고친 뒤 앱을 재시작하는데, 손상이 계속 재발하는 PC에서는 이게 "껐다 켜졌다 하는" 반복
  // 재시작처럼 보인다(실제 사용자 보고, 1.0.571에서도 재발). 기능 자체가 없어졌으니 이
  // 테이블들을 아예 지워서 손상 감지가 다시는 발동하지 않게 한다. 한 번만 실행.
  const chatPinDropMarker = path.join(app.getPath('userData'), 'chat-pins-dropped.txt');
  if (!fs.existsSync(chatPinDropMarker)) {
    db.run(`DROP TABLE IF EXISTS chat_pins`, [], (err1) => {
      logDbErr(err1);
      db.run(`DROP TABLE IF EXISTS deleted_chat_pins`, [], (err2) => {
        logDbErr(err2);
        if (!err1 && !err2) { try { fs.writeFileSync(chatPinDropMarker, '1', 'utf8'); } catch (e) { /* ignore */ } }
      });
    });
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_ip, receiver_ip)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_ip)`, logDbErr);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_msg_uid ON messages(msg_uid)`, logDbErr);
  // 대화를 몇 년이고 안 지우는 정책이라, created_at으로 최근 N일만 훑는 조회(최근 대화
  // 상대 추출 등)가 인덱스 없이 매번 테이블 전체를 스캔하면 데이터가 쌓일수록 계속
  // 느려진다. 새로고침·부팅마다 실행되는 조회라 인덱스로 미리 막아둔다.
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`, logDbErr);
  // 동일 msg_uid 중복 INSERT 방지. unique index가 이미 있으면 매 부팅 DELETE GROUP BY 생략(대형 DB 프리즈 방지).
  db.get(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_msg_uid_unique'`,
    (idxLookupErr, idxRow) => {
      if (idxLookupErr) logDbErr(idxLookupErr);
      if (idxRow && idxRow.name) {
        return;
      }
      db.run(
        `DELETE FROM messages WHERE msg_uid IS NOT NULL AND trim(msg_uid) != ''
          AND id NOT IN (
            SELECT MIN(id) FROM messages
            WHERE msg_uid IS NOT NULL AND trim(msg_uid) != ''
            GROUP BY msg_uid
          )`,
        (delErr) => {
          if (delErr) logDbErr(delErr);
          db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg_uid_unique
             ON messages(msg_uid) WHERE msg_uid IS NOT NULL AND trim(msg_uid) != ''`,
            (idxErr) => {
              if (idxErr) console.error('msg_uid unique index:', idxErr.message || idxErr);
            }
          );
        }
      );
    }
  );
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
      // 빈 문자열로 저장한 직급·내선·휴대폰이 기본값으로 되살아나지 않게 nullish만 보정한다.
      const strOrEmpty = (v) => (v != null ? String(v) : '');
      myProfile = {
        username: (() => {
          const u = (row.username && String(row.username).trim()) || '';
          return isPlaceholderUsername(u) ? '' : u;
        })(),
        rank: strOrEmpty(row.rank),
        dept: strOrEmpty(row.dept),
        floor: strOrEmpty(row.floor),
        extNo: strOrEmpty(row.ext_no),
        phone: strOrEmpty(row.phone_no),
        statusState: row.status_state || 'ONLINE',
        photo: row.photo || ''
      };
      profileLoaded = true;
      logToRendererConsole('info', `[프로필] DB에서 불러옴: ${myProfile.username || '(이름 미설정)'} ${myProfile.rank} ${myProfile.dept} ${myProfile.floor} ${myProfile.extNo}`);
      // 예전 기본값「이름없음」이 DB에 남아 있으면 비워서 말풍선에 안 나오게
      if (row.username && isPlaceholderUsername(row.username)) {
        db.run(`UPDATE user_profile SET username = '' WHERE id = 1`, logDbErr);
      }
    } else {
      logToRendererConsole('info', `[프로필] DB에 저장된 프로필이 없어 기본값으로 새로 만듭니다: ${myProfile.username || '(이름 미설정)'} ${myProfile.rank}`);
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

// ⚠️ 이모지를 메뉴 라벨에 넣으면 Windows 네이티브 트레이 메뉴 폰트에서 깨진 사각형(□)으로
// 나오거나 다른 항목과 정렬이 흐트러져 "아이콘이 깨져 보인다"는 지적을 받음 — 순수 텍스트만 사용.
// 트레이·단축키 기본 화면 선택은 흐름을 끊는 비활성 라벨 대신 하위 메뉴로 묶어 정리했다.
function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: '메시지 보내기 (Ctrl+Alt+S)',
      click: () => openMainWindowWithViewMode(trayLaunchViewMode)
    },
    {
      label: '전체 대화 기록 열기 (Ctrl+Alt+E)',
      click: () => {
        openMainWindowWithViewMode(trayLaunchViewMode);
        safeWebContentsSend('trigger-open-all-logs');
      }
    },
    {
      label: '환경 설정',
      click: () => {
        openMainWindowWithViewMode(trayLaunchViewMode);
        safeWebContentsSend('trigger-open-settings');
      }
    },
    { type: 'separator' },
    {
      label: '기본 화면으로 열기',
      click: () => openMainWindowWithViewMode('normal')
    },
    {
      label: '미니 화면으로 열기',
      click: () => openMainWindowWithViewMode('compact')
    },
    {
      label: '트레이·단축키로 열 때 기본 화면',
      submenu: [
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
        }
      ]
    },
    { type: 'separator' },
    {
      label: '문제 진단 화면 열기',
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
    ses.setSpellCheckerLanguages(['en-US']);
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
    width: 1380,
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
  mainWindow.webContents.once('did-finish-load', () => {
    notifyUsageLockState();
  });

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
      // 트레이로 숨길 때 마지막 대화방을 유지하지 않음 (보안)
      safeWebContentsSend('main-window-hidden');
    }
    return false;
  });

  // 🛡 화면(렌더러 프로세스)이 죽어도(예: 메모리 부족) 창을 새로 띄워 계속 쓸 수 있게 한다.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('❌ 화면 프로세스가 종료됨(재생성 시도):', details.reason);
    // 이것도 로그 파일에 안 남고 있었다 — 창이 꺼졌다 켜지는데 DB 오류가 없다면
    // 이 경로(렌더러 크래시/응답없음/OOM 등)일 가능성이 높다.
    try { writeToLogFile('error', `화면 프로세스 종료(재생성 시도) — reason: ${details.reason}, exitCode: ${details.exitCode}`); } catch (e) { /* ignore */ }
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
      if (cw < 1480 || ch < 920) {
        scheduleBoardWindow.setSize(Math.max(cw, 1480), Math.max(ch, 920));
      }
    } catch (e) { /* ignore */ }
    scheduleBoardWindow.show();
    scheduleBoardWindow.focus();
    sendOpenPayload(scheduleBoardWindow);
    return;
  }

  await refreshPreloadScriptCacheIfNeeded();

  scheduleBoardWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 700,
    title: '병동 일정 현황판 — Mirae Messenger',
    icon: getAppNativeIcon(),
    frame: false,
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
  const sendScheduleBoardMaximizedState = () => {
    if (!scheduleBoardWindow || scheduleBoardWindow.isDestroyed()) return;
    try {
      scheduleBoardWindow.webContents.send('window-maximized-state', scheduleBoardWindow.isMaximized());
    } catch (_) { /* ignore */ }
  };
  scheduleBoardWindow.on('maximize', sendScheduleBoardMaximizedState);
  scheduleBoardWindow.on('unmaximize', sendScheduleBoardMaximizedState);
  scheduleBoardWindow.on('closed', () => {
    scheduleBoardWindow = null;
  });
}

function browserWindowFromEvent(event) {
  try {
    return BrowserWindow.fromWebContents(event.sender);
  } catch (_) {
    return null;
  }
}

// 🪟 프레임 없는 창(frame:false)이라 -/□/X 버튼을 직접 그려야 하므로, 그 버튼들이 호출하는 IPC.
// 메인·현황판 등 호출한 창을 대상으로 동작한다.
ipcMain.handle('window-minimize', (event) => {
  const win = browserWindowFromEvent(event);
  if (win && !win.isDestroyed()) win.minimize();
});
ipcMain.handle('window-maximize-toggle', (event) => {
  const win = browserWindowFromEvent(event);
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('window-close', (event) => {
  const win = browserWindowFromEvent(event);
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.handle('focus-main-window', () => { showAndFocusWindow(); });

ipcMain.handle('open-schedule-board-window', async (event, payload = {}) => {
  const data = typeof payload === 'string' ? { dateStr: payload } : payload;
  openScheduleBoardWindow(data);
  return { success: true };
});

function getExcalidrawPurposeMeta(purpose) {
  const p = String(purpose || 'chat');
  if (p === 'notice') {
    return {
      purpose: 'notice',
      title: '✏️ 공지용 그림 그리기',
      subtitle: '그린 뒤 「이미지로 보내기」를 누르면 공지 작성 화면에 사진으로 첨부됩니다.'
    };
  }
  if (p === 'ipmsg') {
    return {
      purpose: 'ipmsg',
      title: '✏️ 쪽지용 그림 그리기',
      subtitle: '그린 뒤 「이미지로 보내기」를 누르면 쪽지 내용에 이미지로 첨부됩니다.'
    };
  }
  return {
    purpose: 'chat',
    title: '✏️ 채팅용 그림 그리기',
    subtitle: '그린 뒤 「이미지로 보내기」를 누르면 현재 대화방에 PNG로 전송됩니다.'
  };
}

function getExcalidrawRequiredFiles() {
  return [
    'excalidraw-editor.html',
    'preload-excalidraw.js',
    'lib/excalidraw-app.js',
    'lib/excalidraw-app.css'
  ];
}

function inspectExcalidrawInstall() {
  const missing = [];
  const details = [];
  for (const rel of getExcalidrawRequiredFiles()) {
    const abs = path.join(__dirname, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size < 32) {
        missing.push(rel);
        details.push(`${rel}(비정상 크기)`);
        continue;
      }
      if (rel.endsWith('excalidraw-app.js') && st.size < 500000) {
        missing.push(rel);
        details.push(`${rel}(용량 부족 ${st.size}B — 업데이트 중 손상 가능)`);
      }
    } catch (e) {
      missing.push(rel);
      details.push(`${rel}(없음)`);
    }
  }
  return { ok: missing.length === 0, missing, details, root: __dirname };
}

function closeExcalidrawWindow() {
  if (excalidrawWindow && !excalidrawWindow.isDestroyed()) {
    try { excalidrawWindow.close(); } catch (e) {}
  }
  excalidrawWindow = null;
}

const EXCALIDRAW_LIBRARY_RETURN_HOST = 'mirae-excalidraw.local';

function parseExcalidrawLibraryReturnUrl(navUrl) {
  try {
    const parsed = new URL(String(navUrl || ''));
    const hashParams = new URLSearchParams((parsed.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(parsed.search || '');
    const libraryUrl = hashParams.get('addLibrary') || queryParams.get('addLibrary');
    if (!libraryUrl) return null;
    return {
      libraryUrl,
      idToken: hashParams.get('token') || queryParams.get('token') || ''
    };
  } catch (_) {
    return null;
  }
}

function deliverExcalidrawLibraryReturn(payload, childWin) {
  if (!payload || !payload.libraryUrl) return false;
  if (excalidrawWindow && !excalidrawWindow.isDestroyed()) {
    try {
      excalidrawWindow.webContents.send('excalidraw-add-library', payload);
      excalidrawWindow.focus();
    } catch (e) {
      console.error('[excalidraw] deliver library failed', e);
    }
  }
  if (childWin && !childWin.isDestroyed()) {
    try { childWin.close(); } catch (_) {}
  }
  return true;
}

function attachExcalidrawLibraryWindowHandlers(parentWin) {
  if (!parentWin || parentWin.isDestroyed()) return;

  parentWin.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || '');
    if (/^https:\/\/libraries\.excalidraw\.com/i.test(u)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1120,
          height: 820,
          minWidth: 720,
          minHeight: 520,
          title: 'Excalidraw 라이브러리',
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    if (/^https?:\/\//i.test(u)) {
      shell.openExternal(u).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  parentWin.webContents.on('did-create-window', (child) => {
    try { child.setMenu(null); } catch (_) {}

    const tryCapture = (navUrl, event) => {
      const payload = parseExcalidrawLibraryReturnUrl(navUrl);
      if (payload) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        deliverExcalidrawLibraryReturn(payload, child);
        return true;
      }
      try {
        const host = new URL(String(navUrl || '')).hostname;
        if (host === EXCALIDRAW_LIBRARY_RETURN_HOST) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          try { child.close(); } catch (_) {}
          return true;
        }
        if (/^file:/i.test(String(navUrl || ''))) {
          // file:// 복귀도 해시가 있으면 전달, 없으면 차단(에디터 중복 오픈 방지)
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          return true;
        }
      } catch (_) {}
      return false;
    };

    child.webContents.on('will-navigate', (e, navUrl) => { tryCapture(navUrl, e); });
    child.webContents.on('will-redirect', (e, navUrl) => { tryCapture(navUrl, e); });
    try {
      child.webContents.on('will-frame-navigate', (e) => {
        if (e && e.url) tryCapture(e.url, e);
      });
    } catch (_) {}
    child.webContents.on('did-navigate', (_e, navUrl) => { tryCapture(navUrl, null); });
    child.webContents.on('did-navigate-in-page', (_e, navUrl) => { tryCapture(navUrl, null); });
  });
}

function openExcalidrawWindow(purpose) {
  const meta = getExcalidrawPurposeMeta(purpose);
  excalidrawSession = { purpose: meta.purpose, title: meta.title, subtitle: meta.subtitle };

  const install = inspectExcalidrawInstall();
  if (!install.ok) {
    const msg = [
      '그림 그리기 파일이 아직 이 PC에 없습니다.',
      '',
      '설정 → 프로그램 업데이트로 최신판을 다시 받아 주세요.',
      '(lib/excalidraw-app.js 등 용량이 큰 파일이 포함됩니다.)',
      '',
      '부족한 파일:',
      ...install.details.slice(0, 8)
    ].join('\n');
    return { success: false, msg };
  }

  if (excalidrawWindow && !excalidrawWindow.isDestroyed()) {
    try {
      excalidrawWindow.focus();
      excalidrawWindow.webContents.send('excalidraw-context', excalidrawSession);
    } catch (e) {}
    return { success: true };
  }

  const preloadPath = path.join(__dirname, 'preload-excalidraw.js');
  const htmlPath = path.join(__dirname, 'excalidraw-editor.html');

  excalidrawWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: meta.title,
    icon: getAppNativeIcon(),
    frame: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  excalidrawWindow.setMenu(null);
  attachEditableContextMenu(excalidrawWindow.webContents);
  attachExcalidrawLibraryWindowHandlers(excalidrawWindow);

  const showWin = () => {
    if (!excalidrawWindow || excalidrawWindow.isDestroyed()) return;
    try { excalidrawWindow.show(); excalidrawWindow.focus(); } catch (e) {}
  };

  excalidrawWindow.once('ready-to-show', showWin);
  // ready-to-show가 늦거나 누락돼도 흰 화면으로 남지 않게
  setTimeout(showWin, 2500);

  excalidrawWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[excalidraw] did-fail-load', code, desc, url);
    try {
      const safe = String(desc || code || 'load failed').replace(/[<>&]/g, '');
      excalidrawWindow.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<!doctype html><meta charset="utf-8"><body style="font-family:Malgun Gothic,sans-serif;padding:28px;background:#f8fafc;color:#0f172a">
           <h2>그림 창을 불러오지 못했습니다</h2>
           <p style="color:#b91c1c;font-weight:700">${safe}</p>
           <p>설정에서 업데이트를 다시 적용한 뒤 재시작해 주세요.</p>
           <p style="font-size:12px;color:#64748b">${htmlPath}</p></body>`
        )
      );
      showWin();
    } catch (err) {}
  });

  excalidrawWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[excalidraw] render-process-gone', details);
  });

  excalidrawWindow.loadFile(htmlPath).catch((err) => {
    console.error('[excalidraw] loadFile failed', err);
    try {
      const safe = String(err && err.message ? err.message : err).replace(/[<>&]/g, '');
      excalidrawWindow.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<!doctype html><meta charset="utf-8"><body style="font-family:Malgun Gothic,sans-serif;padding:28px;background:#f8fafc">
           <h2>그림 창 HTML을 열 수 없습니다</h2>
           <p style="color:#b91c1c">${safe}</p>
           <p style="font-size:12px;color:#64748b">${htmlPath}</p></body>`
        )
      );
      showWin();
    } catch (e2) {}
  });

  excalidrawWindow.on('closed', () => {
    excalidrawWindow = null;
    excalidrawSession = null;
  });
  return { success: true };
}

ipcMain.handle('open-excalidraw-editor', async (event, purpose) => openExcalidrawWindow(purpose));

ipcMain.handle('excalidraw-get-context', async () => {
  return excalidrawSession || getExcalidrawPurposeMeta('chat');
});

ipcMain.handle('excalidraw-submit-png', async (event, payload) => {
  const dataUrl = payload && payload.dataUrl;
  const purpose = (payload && payload.purpose) || (excalidrawSession && excalidrawSession.purpose) || 'chat';
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) {
    return { ok: false, msg: '이미지 데이터가 없습니다.' };
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, msg: '메인 창을 찾을 수 없습니다.' };
  }
  try {
    mainWindow.webContents.send('excalidraw-png-ready', { purpose, dataUrl });
    closeExcalidrawWindow();
    try { showAndFocusWindow(); } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e.message || String(e) };
  }
});

ipcMain.handle('excalidraw-cancel', async () => {
  closeExcalidrawWindow();
  return { ok: true };
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
    safeWebContentsSend('main-window-hidden');
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
  // 보류 업데이트·preload 캐시는 타임아웃 — OneDrive/잠금 시 무한 대기 방지.
  // ⚠️ 되돌림(1.0.570→): 이 둘을 "독립적"이라 보고 동시 실행했었는데, 사실 보류 업데이트
  // 적용이 __dirname/preload.js를 새로 "쓰는" 도중에 preload 캐시가 같은 파일을 "읽어"
  // 캐시로 복사할 수 있는 경쟁 상태였다 — 그 결과로 깨진(잘린) preload.js가 캐시되면
  // 렌더러 IPC 브릿지가 통째로 깨져 창이 정상 동작을 못 하고 꺼짐/켜짐을 반복하는
  // 사고로 이어질 수 있다. 안전하게 순서대로 되돌린다.
  try {
    const pendingApplied = await withTimeout(applyPendingUpdatesOnStartup(), 8000, 'pending-update');
    if (pendingApplied > 0) {
      console.log(`[업데이트] 보류 파일 ${pendingApplied}개 적용됨`);
      // ⚠️ APP_VERSION은 파일 맨 위 require() 시점(=이 보류 적용보다 먼저)에 캐시된 값이라,
      // 방금 새 package.json을 디스크에 반영해도 이 값은 여전히 구버전을 가리킨다.
      // 갱신하지 않으면 자동 업데이트 검사가 "아직도 구버전"이라고 착각해 재적용→재시작을
      // 끝없이 반복하는 켜짐/꺼짐 루프가 생긴다.
      try {
        delete require.cache[require.resolve('./package.json')];
        APP_VERSION = require('./package.json').version;
      } catch (e) {
        console.warn('[업데이트] APP_VERSION 갱신 실패:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[업데이트] 보류 적용 스킵:', e && e.message ? e.message : e);
  }
  try {
    await withTimeout(initPreloadScriptCache(), 6000, 'preload-cache');
  } catch (e) {
    console.warn('[preload-cache] 타임아웃/실패 — 설치 폴더 preload 사용:', e && e.message ? e.message : e);
    resolvedMainPreloadPath = path.join(__dirname, 'preload.js');
    resolvedToastPreloadPath = path.join(__dirname, 'toast-preload.js');
  }
  try { initSpellCheckerSession(); } catch (e) { /* ignore */ }
  registerMiraeFileProtocol();
  // 창을 먼저 연다 — 네트워크/UDP보다 UI 응답이 우선
  createWindow();
  createTray();
  registerGlobalShortcuts();

  setTimeout(() => {
    if (isSafeUiMode()) {
      console.warn('[SAFE_UI] userdata\\SAFE_UI.txt 감지 — UDP/TCP/모바일 서버를 시작하지 않습니다.');
      udpStatus = 'safe-ui';
      tcpStatus = 'safe-ui';
      notifyNetworkStatus();
      return;
    }
    networkQuietUntil = Date.now() + NETWORK_QUIET_MS;
    console.log(`[network] quiet ${NETWORK_QUIET_MS / 1000}s — UDP only first; TCP deferred (prevents buffer flood)`);
    try { startUdpDiscovery(); } catch (e) { console.error('UDP start', e); }
    try {
      if (typeof startMobileServer === 'function') startMobileServer(db, MY_IP);
    } catch (e) { console.warn('[mobile]', e && e.message ? e.message : e); }
    // TCP는 quiet 끝난 뒤에만 — 부팅 중 대용량 sync가 버퍼 초과·클릭 불가를 만듦
    setTimeout(() => {
      try {
        startTcpServer();
        console.log('[network] TCP listening after quiet period');
        // quiet 동안 놓친 NOTICE_SYNC 를 보완 — 온라인 동료에게 재요청
        setTimeout(() => {
          try { requestNoticeSyncFromOnlinePeers(3); } catch (e) { /* ignore */ }
        }, 1200);
      } catch (e) { console.error('TCP start', e); }
    }, NETWORK_QUIET_MS);
  }, 1200);

  setTimeout(() => {
    try { startScheduledMessageChecker(); } catch (e) { /* ignore */ }
    try { startPresenceSweeper(); } catch (e) { /* ignore */ }
    try { startAutoBackup(); } catch (e) { /* ignore */ }
    try { startUpdateChecker(); } catch (e) { /* ignore */ }
    try { startPendingWipeRetryLoop(); } catch (e) { /* ignore */ }
    setTimeout(() => {
      try {
        broadcastWipeClaim();
        flushAllPendingWipesForOnlinePeers();
      } catch (e) { /* ignore */ }
    }, 2000);
  }, 3500);

  const installInfo = getInstallPathInfo();
  if (installInfo.cloudSynced) {
    console.warn('[설치경로]', installInfo.warning);
    writeToLogFile('warn', installInfo.warning + ' root=' + installInfo.root);
    setTimeout(() => {
      safeWebContentsSend('install-path-warning', installInfo);
    }, 2500);
  }
});

app.on('before-quit', () => {
  writeToLogFile('info', '[종료] before-quit');
  broadcastGoodbye();
  // 종료 시 WAL을 본 파일에 합쳐둔다 — 안 해도 다음 실행 시 WAL을 이어서 읽어 데이터
  // 자체는 안전하지만, DB 손상 복구 절차가 "백업 없음" 상황에서 WAL을 통째로 지우는
  // 경로를 타면 그 사이 방금 보낸 메시지가 사라질 수 있었다(실제 발생). 매번 종료 시
  // 체크포인트해두면 그 위험 구간을 최소화할 수 있다.
  try { db.run(`PRAGMA wal_checkpoint(PASSIVE)`); } catch (e) { /* ignore */ }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// GPU 프로세스 등 렌더러가 아닌 다른 하위 프로세스가 죽는 경우도 화면이 멈추거나
// 꺼졌다 켜진 것처럼 보일 수 있다 — 이것도 로그에 남겨야 원인을 알 수 있다.
app.on('child-process-gone', (event, details) => {
  console.error('❌ 하위 프로세스 종료:', details.type, details.reason);
  try { writeToLogFile('error', `하위 프로세스 종료 — type: ${details.type}, reason: ${details.reason}, exitCode: ${details.exitCode}`); } catch (e) { /* ignore */ }
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

/** 직급이 없으면 공용 컴퓨터(인원 집계에서 제외) */
function isSharedPcProfile(u) {
  return !normalizeRankText(u && u.rank);
}

/** 사이드바와 동일한 직원 목록(동일인 합침) */
function buildDirectoryUserList() {
  return dedupeUsersByPersonIdentity(
    Array.from(allKnownUsers.values())
      .filter((u) => u && u.ip && !isSyntheticReceiverKey(u.ip))
      .map(userListEntryForRenderer)
  );
}

/**
 * 실제 온라인 인원: 동일인 1명으로 합친 뒤, 공용 PC(직급 없음)는 제외.
 * (본인 PC는 직급이 없어도 포함)
 */
function countOnlinePeopleForStatus() {
  return buildDirectoryUserList().filter((u) => {
    if (!u || !u.online) return false;
    if (u.isMe || (MY_IP && u.ip === MY_IP)) return true;
    return !isSharedPcProfile(u);
  }).length;
}

function notifyNetworkStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeWebContentsSend('network-status-update', {
      myIp: MY_IP, udpStatus, tcpStatus, onlineCount: countOnlinePeopleForStatus()
    });
  }
}

function isNetworkQuietPeriod() {
  return Date.now() < networkQuietUntil;
}

function isSafeUiMode() {
  try {
    return fs.existsSync(path.join(app.getPath('userData'), 'SAFE_UI.txt'))
      || process.env.MIRAE_SAFE_UI === '1';
  } catch (e) {
    return process.env.MIRAE_SAFE_UI === '1';
  }
}

/** 재접속 시 공지·그룹·삭제예약 등 전체 재동기화 폭주 방지 — Wi-Fi 불안정 등으로 자주
 * 오프라인↔온라인을 오가는 PC 하나 때문에 이 PC 전체가 반복적으로 무거운 동기화를
 * 떠안는 것을 막는다(실제로 이 때문에 메인 프로세스가 반복적으로 수십 초씩 응답없음 상태에
 * 빠지는 것을 확인함). 대기 중인 메시지 재전송만은 매번 가볍게 시도한다. */
const RECONNECT_CASCADE_COOLDOWN_MS = 3 * 60 * 1000;
const lastReconnectCascadeAt = new Map();

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
      }, PRESENCE_HEARTBEAT_MS);
      setTimeout(() => flushAllPendingOutboundMessages(), 2500);
      setInterval(() => flushAllPendingOutboundMessages(), 15000);
    }
  });

  globalUdpSocket.on('message', (msg, rinfo) => {
    const __t0 = Date.now();
    try {
      return handleUdpMessage(msg, rinfo);
    } finally {
      const __dt = Date.now() - __t0;
      if (__dt > 300) writeToLogFile('warn', `[진단] UDP message from=${rinfo && rinfo.address} ${__dt}ms`);
    }
  });

  function handleUdpMessage(msg, rinfo) {
    if (rinfo.address === MY_IP) return;
    if (!allowUdpReceive(rinfo.address)) return;

    try {
      const data = JSON.parse(msg.toString('utf8'));
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
        const wasOffline = !onlineUsers.has(rinfo.address);

        // Fast path: 이미 온라인 + 프로필 동일 → lastPingAt만 (DB/IPC 없음)
        if (!wasOffline && previouslyKnown) {
          const rank = data.rank || '';
          const dept = data.dept || '';
          const floor = data.floor || '';
          const extNo = data.extNo || '';
          const phone = data.phone || '';
          const statusState = data.statusState || 'ONLINE';
          const appVersion = data.appVersion || previouslyKnown.appVersion || '';
          const same =
            previouslyKnown.username === data.username &&
            previouslyKnown.rank === rank &&
            previouslyKnown.dept === dept &&
            previouslyKnown.floor === floor &&
            previouslyKnown.extNo === extNo &&
            previouslyKnown.phone === phone &&
            previouslyKnown.statusState === statusState &&
            previouslyKnown.appVersion === appVersion;
          if (same) {
            previouslyKnown.lastPingAt = now;
            previouslyKnown.online = true;
            const live = onlineUsers.get(rinfo.address);
            if (live) {
              live.lastPingAt = now;
              live.online = true;
            } else {
              onlineUsers.set(rinfo.address, previouslyKnown);
            }
            return;
          }
        }

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
        if (wasOffline || profileChanged) {
          persistKnownUserSnapshot(userObj);
        }

        if (wasOffline || profileChanged) notifyUserList();

        if (wasOffline) {
          // 부팅 직후엔 대량 동기화 폭주를 피한다 (TCP 버퍼 초과·클릭 불가의 원인)
          if (!isNetworkQuietPeriod()) {
            resendPendingMessages(rinfo.address);
            // Wi-Fi 불안정 등으로 자주 깜빡이는 PC는 여기서 더 진행하지 않고 쿨다운만
            // 갱신 — 재접속마다 공지·그룹 전체 재동기화를 반복하면 이 PC가 계속 멈춘다.
            const nowTs = Date.now();
            const lastCascade = lastReconnectCascadeAt.get(rinfo.address) || 0;
            if (nowTs - lastCascade < RECONNECT_CASCADE_COOLDOWN_MS) {
              return;
            }
            lastReconnectCascadeAt.set(rinfo.address, nowTs);
            requestNoticeSync(rinfo.address);
            syncGroupsWithPeer(rinfo.address);
            tryDeliverPendingWipe(rinfo.address);
            maybeSyncServicePauseToPeer(rinfo.address);
            if (myProfile.photo) {
              sendToIps([rinfo.address], { type: 'PROFILE_PHOTO_SYNC', ip: MY_IP, photo: myProfile.photo });
            } else {
              sendToIps([rinfo.address], { type: 'PROFILE_PHOTO_REQUEST' });
            }
          }
        }
      }
    } catch (e) {}
  }

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
  if (isMessengerUsageBlocked()) {
    // 사용 중지 상태에서는 온라인으로 등록하지 않는다.
    onlineUsers.delete(MY_IP);
    const prev = allKnownUsers.get(MY_IP);
    if (prev) {
      allKnownUsers.set(MY_IP, { ...prev, online: false, isMe: true });
    }
    lastSelfRegisterSig = 'blocked';
    notifyUserList();
    return;
  }
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
  const sig = [
    me.username, me.rank, me.dept, me.floor, me.extNo, me.phone, me.statusState, me.appVersion,
    me.photo ? '1' : '0'
  ].join('|');
  const unchanged = onlineUsers.has(MY_IP) && sig === lastSelfRegisterSig;
  onlineUsers.set(MY_IP, me);
  allKnownUsers.set(MY_IP, me);
  if (unchanged) return; // 하트비트마다 DB/UI 갱신하지 않음 — 클릭 지연 방지
  lastSelfRegisterSig = sig;
  persistKnownUserSnapshot(me);
  notifyUserList();
}


function allowUdpReceive(fromIp) {
  const now = Date.now();
  if (now - udpRxWindowStart >= 1000) {
    udpRxWindowStart = now;
    udpRxWindowCount = 0;
  }
  if (udpRxWindowCount >= UDP_RX_MAX_PER_SEC) {
    udpStormUntil = Math.max(udpStormUntil, now + UDP_STORM_COOLDOWN_MS);
    if (now - udpDropLoggedAt > 10000) {
      udpDropLoggedAt = now;
      console.warn(`[udp] receive storm — dropping packets (>${UDP_RX_MAX_PER_SEC}/s)`);
    }
    return false;
  }
  const ip = String(fromIp || '');
  let bucket = udpRxPerIpWindow.get(ip);
  if (!bucket || now - bucket.start >= 1000) {
    bucket = { start: now, count: 0 };
    udpRxPerIpWindow.set(ip, bucket);
  }
  if (bucket.count >= UDP_RX_MAX_PER_IP_PER_SEC) {
    udpStormUntil = Math.max(udpStormUntil, now + UDP_STORM_COOLDOWN_MS);
    return false;
  }
  bucket.count += 1;
  udpRxWindowCount += 1;
  if (udpRxWindowCount >= UDP_STORM_THRESHOLD_PER_SEC) {
    udpStormUntil = Math.max(udpStormUntil, now + UDP_STORM_COOLDOWN_MS);
  }
  return true;
}

function collectPresenceHeartbeatIps() {
  const out = [];
  onlineUsers.forEach((_u, ip) => {
    if (ip && ip !== MY_IP && !isSyntheticReceiverKey(ip) && !isLoadTestPeerIp(ip)) out.push(ip);
  });
  return out;
}

function broadcastPresence(socket) {
  if (!socket) return;
  if (!profileLoaded) return; // 아직 DB에서 실제 프로필을 못 불러왔으면 기본값을 내보내지 않는다.
  if (isMessengerUsageBlocked()) return; // 사용 중지·서비스 일시중지 시 접속 신호를 보내지 않음
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
  try { socket.send(packet, 0, packet.length, UDP_PORT, '255.255.255.255'); } catch (e) { /* ignore */ }

  // 수신 UDP 폭주 중에는 유니캐스트 하트비트를 잠시 멈춰 메인루프를 지킨다
  if (Date.now() < udpStormUntil) return;

  // 1.0.486: 기본은 온라인 동료만. 전체 508 유니캐스트는 클릭/커서 프리징의 주원인.
  const ips = PRESENCE_FULL_SCAN_ENABLED ? KNOWN_SUBNET_HOST_IPS : collectPresenceHeartbeatIps();
  if (!ips.length) return;
  let i = 0;
  const BATCH = 24;
  const sendBatch = () => {
    if (!globalUdpSocket || globalUdpSocket !== socket) return;
    const end = Math.min(i + BATCH, ips.length);
    for (; i < end; i++) {
      try { socket.send(packet, 0, packet.length, UDP_PORT, ips[i]); } catch (e) { /* ignore */ }
    }
    if (i < ips.length) setImmediate(sendBatch);
  };
  sendBatch();
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
  // 전체 508 유니캐스트는 종료 순간 클릭 프리징만 키움 — 온라인 동료에게만
  onlineUsers.forEach((_u, ip) => {
    if (!ip || ip === MY_IP || isSyntheticReceiverKey(ip) || isLoadTestPeerIp(ip)) return;
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
  // 온라인 판정은 UDP PING만 사용한다.
  // TCP(채팅·동기화 등)로 lastPingAt을 갱신하면, 상대 PC가 이미 꺼진 뒤에도
  // 지연·재전송 패킷 때문에 온라인으로 남는 오탐이 생긴다.
  void ip;
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
    // overlay에 lastPingAt이 없으면 Date.now()로 채우지 않음 — 오탐 온라인 방지
    if (overlay.lastPingAt != null && Number(overlay.lastPingAt) > 0) {
      merged.lastPingAt = Number(overlay.lastPingAt);
    } else if (merged.lastPingAt) {
      // 유지
    } else {
      merged.lastPingAt = Date.now();
    }
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
           AND created_at >= datetime('now', '-180 days')
         UNION ALL
         SELECT receiver_ip AS ip, strftime('%s', created_at) AS last_ts FROM messages
         WHERE receiver_ip != ? AND receiver_ip != 'BROADCAST'
           AND receiver_ip NOT LIKE 'DEPT:%' AND receiver_ip NOT LIKE 'FLOOR:%' AND receiver_ip NOT LIKE 'GROUP:%'
           AND receiver_ip NOT LIKE 'BCAST:%' AND receiver_ip NOT LIKE 'DEPTPEER:%' AND receiver_ip NOT LIKE 'FLOORPEER:%'
           AND created_at >= datetime('now', '-180 days')
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
  const usageDisabled = disabledClients.has(u.ip) || (u.ip === MY_IP && localUsageDisabled);
  let usageLockReason = '';
  if (usageDisabled) {
    if (u.ip === MY_IP && localUsageDisabled) usageLockReason = localUsageLockMeta.reason || '';
    else {
      const dc = disabledClients.get(u.ip);
      usageLockReason = (dc && dc.reason) || '';
    }
  }
  return {
    ...rest,
    online: onlineUsers.has(u.ip),
    hasPhoto: !!photo,
    usageDisabled,
    usageLockReason
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
    safeWebContentsSend('user-list-update', buildDirectoryUserList());
    notifyNetworkStatus();
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
  safeWebContentsSend('user-list-update', buildDirectoryUserList());
  notifyNetworkStatus();
}

function startPresenceSweeper() {
  let ipChangeNoticeSent = false;
  setInterval(() => {
    const __t0 = Date.now();
    try {
      return presenceSweepTick();
    } finally {
      const __dt = Date.now() - __t0;
      if (__dt > 300) writeToLogFile('warn', `[진단] presenceSweepTick ${__dt}ms`);
    }
  }, 3000);

  function presenceSweepTick() {
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
      // lastSeen(마지막 종료 시각)은 온라인 heartbeat가 아님 — lastPingAt(UDP)만 본다
      const beat = Number(u && u.lastPingAt) || 0;
      if (!beat || now - beat > PRESENCE_STALE_MS) {
        if (markPeerOffline(ip, beat || now)) {
          changed = true;
          writeToLogFile('info', `[네트워크] ${u.username || ip}(${ip}) 오프라인 처리됨 (PING 없음 ${beat ? Math.round((now - beat) / 1000) : '?'}초)`);
        }
      }
    });

    if (changed) notifyUserList();
  }
}

function startTcpServer() {
  if (tcpServerInstance) {
    try { tcpServerInstance.close(); } catch (e) { /* ignore */ }
    tcpServerInstance = null;
  }
  const server = net.createServer((socket) => {
    if (tcpActiveConnections >= TCP_MAX_CONNECTIONS) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    tcpActiveConnections += 1;
    let buffer = '';
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      tcpActiveConnections = Math.max(0, tcpActiveConnections - 1);
    };
    socket.once('close', release);
    socket.once('error', release);

    const drain = () => {
      let idx;
      let processed = 0;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        parseAndRoute(line, socket);
        processed += 1;
        // 한 틱에 너무 많은 라인을 처리하면 UI가 멈춤 — 양보
        if (processed >= 8 && buffer.indexOf('\n') !== -1) {
          setImmediate(drain);
          return;
        }
      }
    };

    socket.on('data', (chunk) => {
      const from = String((socket.remoteAddress || '').replace('::ffff:', '') || '?');
      if (chunk.length > MAX_TCP_LINE_BUFFER) {
        console.error(`[TCP] 청크 과다 from=${from} bytes=${chunk.length} — 연결 종료`);
        recordPeerTraffic(from, { bytes: chunk.length, largeChunk: true, overflow: true, type: 'TCP_CHUNK_OVERSIZE' });
        buffer = '';
        try { socket.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      // quiet 중(이론상 TCP 미기동)이거나 비정상적으로 큰 미완성 라인은 조기 차단
      const softCap = isNetworkQuietPeriod() ? 64 * 1024 : MAX_TCP_LINE_BUFFER;
      buffer += chunk.toString('utf8');
      if (buffer.length > softCap && buffer.indexOf('\n') === -1) {
        console.error(`[TCP] 버퍼 초과(개행 없음) from=${from} bytes=${buffer.length} head=${JSON.stringify(buffer.slice(0, 80))} — 연결 종료`);
        recordPeerTraffic(from, { bytes: chunk.length, overflow: true, type: 'TCP_BUFFER_OVERFLOW' });
        buffer = '';
        try { socket.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      if (buffer.length > MAX_TCP_LINE_BUFFER) {
        console.error(`[TCP] 버퍼 초과 from=${from} bytes=${buffer.length} — 연결 종료`);
        recordPeerTraffic(from, { bytes: chunk.length, overflow: true, type: 'TCP_BUFFER_OVERFLOW' });
        buffer = '';
        try { socket.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      recordPeerTraffic(from, { bytes: chunk.length });
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
    if (payload && payload.type === 'LOADTEST_CMD') {
      if (!isLoopbackIp(senderIP)) {
        try {
          socket.write(JSON.stringify({ success: false, msg: 'LOADTEST는 로컬(127.0.0.1)만 허용' }) + '\n');
        } catch (_) {}
        return;
      }
      const result = runLoadTestCommand(payload);
      try { socket.write(JSON.stringify(result) + '\n'); } catch (_) {}
      return;
    }
    recordPeerTraffic(senderIP, {
      msgs: 1,
      type: payload && payload.type ? payload.type : 'CHAT'
    });
    routeIncomingPayload(payload, senderIP);
  } catch (e) {
    console.error('TCP 페이로드 파싱 오류:', e.message);
  }
}

function routeIncomingPayload(payload, senderIP) {
  const __t0 = Date.now();
  const __type = payload && payload.type;
  try {
    return routeIncomingPayloadInner(payload, senderIP);
  } finally {
    const __dt = Date.now() - __t0;
    if (__dt > 300) writeToLogFile('warn', `[진단] routeIncomingPayload(${__type}) from=${senderIP} ${__dt}ms`);
  }
}

function routeIncomingPayloadInner(payload, senderIP) {
  try {
    touchPeerPresence(senderIP);
    const type = payload.type || 'CHAT';
    // 부팅 직후 대용량 동기화는 UI 프리징의 주원인 — 조용히 드롭
    if (isNetworkQuietPeriod()) {
      if (
        type === 'NOTICE_SYNC_REQUEST'
        || type === 'NOTICE_SYNC_RESPONSE'
        || type === 'PROFILE_PHOTO_SYNC'
        || String(type).startsWith('FILE_XFER')
      ) {
        return;
      }
    }
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
    case 'NOTICE_SYNC_RESPONSE': handleNoticeSyncResponse(payload.notices, payload.operators, payload.schedules, payload.updateSourcePath, payload.profileOverrides, payload.dutyRoster, payload.deletedScheduleUids, payload.deletedNoticeUids); break;
    case 'OPERATOR_ADD': handleOperatorAdd(payload.operator); break;
    case 'OPERATOR_DELETE': handleOperatorDelete(payload.username); break;
    case 'SCHEDULE_ADD': handleScheduleAdd(payload.schedule); break;
    case 'SCHEDULE_DELETE': handleScheduleDelete(payload.uid); break;
    case 'SCHEDULE_EDIT': handleScheduleEdit(payload.schedule); break;
    case 'MESSAGE_EDIT': handleIncomingMessageEdit(payload, senderIP); break;
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
    case 'USAGE_DISABLE':
      handleUsageDisableCommand(payload, senderIP).catch((e) => {
        console.error('USAGE_DISABLE 처리 오류:', e.message || e);
      });
      break;
    case 'USAGE_ENABLE':
      handleUsageEnableCommand(payload, senderIP).catch((e) => {
        console.error('USAGE_ENABLE 처리 오류:', e.message || e);
      });
      break;
    case 'USAGE_LOCK_RESULT':
      safeWebContentsSend('usage-lock-result', {
        success: !!payload.success,
        disabled: !!payload.disabled,
        msg: payload.msg || '',
        fromIp: payload.fromIp || senderIP
      });
      break;
    case 'USAGE_LOCK_SYNC':
      handleUsageLockSync(payload, senderIP);
      break;
    case 'SERVICE_PAUSE_SYNC':
      handleServicePauseSync(payload, senderIP);
      break;
    case 'WIPE_CHAT_HISTORY':
      handleWipeChatHistoryCommand(payload, senderIP).catch((e) => {
        console.error('WIPE_CHAT_HISTORY 처리 오류:', e.message || e);
      });
      break;
    case 'WIPE_CHAT_HISTORY_RESULT':
      handleWipeChatHistoryResult(payload, senderIP);
      break;
    case 'WIPE_QUEUE_SYNC':
      handleWipeQueueSync(payload, senderIP);
      break;
    case 'WIPE_QUEUE_CLEAR':
      handleWipeQueueClear(payload, senderIP);
      break;
    case 'WIPE_CLAIM':
      // 대상 PC가 방금 켜짐 → 예약된 삭제가 있으면 즉시 전달
      tryDeliverPendingWipe(senderIP);
      break;
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

  // uid 없는 구버전 재전송: 같은 상대·같은 내용 짧은 시간 중복 UI 차단
  const contentKey = !uid
    ? `${senderIP}|${String(payload.message || '').slice(0, 2000)}`
    : '';
  if (contentKey && wasRecentIncomingChatContent(contentKey)) {
    return;
  }

  // ACK·영구 remember는 INSERT 성공 후. inflight는 재전송 레이스의 UI 중복만 막음.
  // 처리 중 재전송에는 즉시 ACK를 보내 발신측 재시도를 멈춘다.
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
      if (contentKey) markRecentIncomingChatContent(contentKey);
    }

    const storedMessage = compactStoredMessageHtml(payload.message);
    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
      [formatSenderDisplay(payload.sender, senderIP), senderIP, MY_IP, storedMessage, uid],
      (err) => {
        if (err) {
          logDbErr(err);
          if (uid && isMsgUidUniqueConflict(err)) {
            finishIncomingChatUid(uid, true);
            ackIfUid();
            return;
          }
          finishIncomingChatUid(uid, false);
          return;
        }
        finishIncomingChatUid(uid, true);
        ackIfUid();
      }
    );
  };

  if (uid && isIncomingChatUidBusy(uid)) {
    db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
      if (err) {
        logDbErr(err);
        ackIfUid();
        return;
      }
      if (row) {
        markIncomingChatUid(uid);
        ackIfUid();
        return;
      }
      // INSERT 진행 중 재전송 — UI 없이 즉시 ACK (발신 재시도 중지)
      if (incomingChatUidInflight.has(String(uid))) {
        ackIfUid();
        return;
      }
      incomingChatUidInflight.add(String(uid));
      persist({ showUi: false });
    });
    return;
  }

  if (uid) {
    if (!claimIncomingChatUid(uid)) {
      ackIfUid();
      return;
    }
    db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
      if (err) {
        logDbErr(err);
        persist({ showUi: true });
        return;
      }
      if (row) {
        finishIncomingChatUid(uid, true);
        ackIfUid();
        return;
      }
      // 수락 확정 직후 ACK → INSERT 완료 전 재전송 폭주 방지
      ackIfUid();
      persist({ showUi: true });
    });
    return;
  }

  // uid 없는 구버전·재전송: 메모리 창 + DB에 이미 있으면 UI/토스트 생략
  const storedMessage = compactStoredMessageHtml(payload.message);
  db.get(
    `SELECT id FROM messages
     WHERE sender_ip = ? AND receiver_ip = ?
       AND (message = ? OR message = ?)
       AND datetime(created_at) >= datetime('now', '-20 minutes')
     LIMIT 1`,
    [senderIP, MY_IP, payload.message, storedMessage],
    (err, row) => {
      if (err) logDbErr(err);
      if (row) {
        if (contentKey) markRecentIncomingChatContent(contentKey);
        return;
      }
      persist({ showUi: true });
    }
  );
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
        if (err) {
          logDbErr(err);
          finishIncomingChatUid(msgUid, isMsgUidUniqueConflict(err));
          return;
        }
        finishIncomingChatUid(msgUid, true);
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
        if (err) {
          logDbErr(err);
          finishIncomingChatUid(msgUid, isMsgUidUniqueConflict(err));
          return;
        }
        finishIncomingChatUid(msgUid, true);
      }
    );
    appendChatLog(receiverKey, `${payload.floor}`, payload.sender, payload.message);
  });
}

/** 1:1 읽음 데스크탑 알림은 상대당 앱 실행 중 딱 1회만 */
const dmAwaitingReadReceiptNotify = new Map();
const dmReadReceiptDesktopShown = new Set();
/** 세션 내 동일 수신 msg_uid — DB INSERT 성공 후에만 영구 기록 */
const recentIncomingChatUids = new Map();
/** INSERT 진행 중 UID — 재전송 레이스로 UI/DB 중복 방지 (실패 시 해제) */
const incomingChatUidInflight = new Set();
/** uid 없는 재전송용: sender|message 짧은 창 중복 차단 */
const recentIncomingChatContent = new Map();
const RECENT_CHAT_UID_TTL_MS = 15 * 60 * 1000;
/** uid 없는 재전송: 읽은 뒤에도 다시 토스트/말풍선이 뜨지 않도록 충분히 길게 */
const RECENT_CHAT_CONTENT_TTL_MS = 20 * 60 * 1000;

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

function pruneRecentIncomingChatContent(now = Date.now()) {
  if (recentIncomingChatContent.size <= 400) {
    recentIncomingChatContent.forEach((t, k) => {
      if (now - t > RECENT_CHAT_CONTENT_TTL_MS) recentIncomingChatContent.delete(k);
    });
    return;
  }
  recentIncomingChatContent.forEach((t, k) => {
    if (now - t > RECENT_CHAT_CONTENT_TTL_MS) recentIncomingChatContent.delete(k);
  });
}

function wasRecentIncomingChatContent(contentKey) {
  const key = String(contentKey || '');
  if (!key) return false;
  const now = Date.now();
  pruneRecentIncomingChatContent(now);
  const prev = recentIncomingChatContent.get(key);
  return !!(prev && (now - prev) < RECENT_CHAT_CONTENT_TTL_MS);
}

function markRecentIncomingChatContent(contentKey) {
  const key = String(contentKey || '');
  if (!key) return;
  pruneRecentIncomingChatContent();
  recentIncomingChatContent.set(key, Date.now());
}

function isIncomingChatUidBusy(uid) {
  const key = String(uid || '').trim();
  if (!key) return false;
  return hasRememberedIncomingChatUid(key) || incomingChatUidInflight.has(key);
}

function claimIncomingChatUid(uid) {
  const key = String(uid || '').trim();
  if (!key) return true;
  if (isIncomingChatUidBusy(key)) return false;
  incomingChatUidInflight.add(key);
  return true;
}

function finishIncomingChatUid(uid, ok) {
  const key = String(uid || '').trim();
  if (!key) return;
  if (ok) markIncomingChatUid(key);
  incomingChatUidInflight.delete(key);
}

function isMsgUidUniqueConflict(err) {
  const msg = String((err && err.message) || err || '');
  return /UNIQUE/i.test(msg);
}

function shouldSkipDuplicateChannelMessage(msgUid, onUnique) {
  const uid = msgUid ? String(msgUid).trim() : '';
  if (!uid) {
    onUnique();
    return;
  }
  if (isIncomingChatUidBusy(uid)) {
    // 이미 수신 중이거나 저장됨 — UI/INSERT 재실행 금지. DB만 없으면 복구 저장.
    db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
      if (err) {
        logDbErr(err);
        return;
      }
      if (row) {
        markIncomingChatUid(uid);
        return;
      }
      if (incomingChatUidInflight.has(uid)) return;
      if (!claimIncomingChatUid(uid)) return;
      onUnique();
    });
    return;
  }
  if (!claimIncomingChatUid(uid)) return;
  db.get(`SELECT id FROM messages WHERE msg_uid = ? LIMIT 1`, [uid], (err, row) => {
    if (err) {
      logDbErr(err);
      onUnique();
      return;
    }
    if (row) {
      finishIncomingChatUid(uid, true);
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
  const codeType = (payload.codeType === 'blue' || payload.codeType === 'red')
    ? payload.codeType
    : detectCodeAlertType(payload.message);
  const urgent = !!payload.urgent || !!codeType;

  shouldSkipDuplicateChannelMessage(msgUid, () => {
    const storedMessage = compactStoredMessageHtml(payload.message);
    if (mainWindow) {
      safeWebContentsSend('receive-broadcast', {
        senderName,
        senderIP: senderIP,
        message: payload.message,
        createdAt: currentTime,
        msgUid,
        messageId: null,
        urgent,
        codeType: codeType || null
      });
    }
    if (codeType) {
      try { showAndFocusWindow(); } catch (e) {}
    }
    const codeTitle = codeType === 'blue'
      ? `💙 [코드블루] ${senderName}`
      : (codeType === 'red' ? `❤️ [코드레드] ${senderName}` : `📢 전체공지 - ${senderName}`);
    notifyIncomingMessageNotification({
      title: codeTitle,
      body: previewBody(payload.message),
      channelKey: 'BROADCAST',
      urgent,
      codeType: codeType || undefined,
      force: !!codeType
    });

    db.run(
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, 'BROADCAST', ?, 'SENT', ?)`,
      [senderName, senderIP, storedMessage, msgUid],
      (err) => {
        if (err) {
          logDbErr(err);
          finishIncomingChatUid(msgUid, isMsgUidUniqueConflict(err));
          return;
        }
        finishIncomingChatUid(msgUid, true);
      }
    );
    appendChatLog('BROADCAST', '전체공지', payload.sender, payload.message);
  });
}

/** 공지 사진: JSON 배열 문자열로 정규화 (최대 3장) */
function normalizeNoticeImagesField(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch (_) {
      list = [];
    }
  }
  return JSON.stringify(
    list
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.dataUrl === 'string') return item.dataUrl;
        return '';
      })
      .filter((s) => typeof s === 'string' && s.indexOf('data:image') === 0)
      .slice(0, 2) // TCP 한도 고려하여 최대 2장
  );
}

/**
 * NOTICE_SYNC 대량 전송용 — base64 사진이 힙/CPU를 폭주시켜 PC가 뻗는 것을 막는다.
 * 최근 소수 공지만 사진을 싣고, 나머지는 본문만 동기화 (실시간 NOTICE_ADD 가 사진을 먼저 전달).
 */
const NOTICE_SYNC_IMAGES_BUDGET_BYTES = 600 * 1024;
const NOTICE_SYNC_RECENT_WITH_IMAGES = 8;

function slimNoticesForBulkSync(notices) {
  const list = Array.isArray(notices) ? notices.slice() : [];
  // 최신순으로 예산 배분
  list.sort((a, b) => String(b && b.created_at || '').localeCompare(String(a && a.created_at || '')));
  let used = 0;
  let withImg = 0;
  return list.map((n) => {
    if (!n) return n;
    const imgs = String(n.images || '');
    if (!imgs || imgs === '[]' || imgs.length < 32) return n;
    if (withImg >= NOTICE_SYNC_RECENT_WITH_IMAGES || used + imgs.length > NOTICE_SYNC_IMAGES_BUDGET_BYTES) {
      return Object.assign({}, n, { images: '[]' });
    }
    withImg += 1;
    used += imgs.length;
    return n;
  });
}

/** 목록 IPC용 — 거대 base64 를 렌더러에 그대로 넣지 않음 */
function mapNoticeRowForListIpc(r) {
  const row = r || {};
  const images = String(row.images || '[]');
  const hasImages = images.length > 8 && images !== '[]';
  const tooBig = images.length > 4096;
  return {
    uid: row.uid,
    title: row.title,
    content: row.content,
    author_name: row.author_name,
    author_ip: row.author_ip,
    created_at: row.created_at,
    category: normalizeNoticeCategory(row.category),
    images: tooBig ? '[]' : (images || '[]'),
    hasImages: hasImages || tooBig,
    imagesBytes: hasImages ? images.length : 0
  };
}

let noticesUpdateDebounceTimer = null;
function notifyNoticesChanged() {
  if (!mainWindow) return;
  if (noticesUpdateDebounceTimer) return;
  noticesUpdateDebounceTimer = setTimeout(() => {
    noticesUpdateDebounceTimer = null;
    if (mainWindow) safeWebContentsSend('notices-update');
  }, 450);
}

/** 피어별 NOTICE_SYNC 요청 쿨다운 — 온오프 깜빡임 때 폭주 방지 */
const noticeSyncLastRequestAt = new Map();
const NOTICE_SYNC_REQUEST_COOLDOWN_MS = 60 * 1000;
let noticeSyncResponsesInFlight = 0;
const NOTICE_SYNC_MAX_IN_FLIGHT = 1;
const noticeSyncRequestQueue = [];

/** 공지 카테고리: 전체 | 업데이트 | 부서명 */
function normalizeNoticeCategory(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '전체';
  return s.slice(0, 40);
}

let noticesSchemaReady = false;
let noticesSchemaEnsuring = null; // callback queue
/** 삭제된 공지 UID 즉시 기억 (DB 기록 전 레이스 방지) — 아래 const 재선언 없이 여기만 사용 */
let noticeTombstoneMemory = new Set();

let noticesUidUniqueEnsured = false;
/**
 * ⚠️ 실사고: uid에 UNIQUE 제약이 없어 upsertNoticeFromSync의 "SELECT로 확인 후 INSERT" 가
 * 레이스에 취약했고(sqlite3는 콜백 기반이라 원자적이지 않음), 공지 2건이 91,668번 중복
 * 삽입되며 DB가 328MB까지 불어난 걸 확인함. INSERT 쪽은 이미 UNIQUE 충돌을 잡아 UPDATE로
 * 전환하는 코드가 있었지만(제약이 없어 발동한 적이 없었을 뿐) — 그래서 새 upsert 로직을
 * 짜는 대신 누락됐던 인덱스만 채워서 그 기존 안전장치를 실제로 작동시킨다.
 * 인덱스 생성 전 기존 중복은 uid당 최신 행 하나만 남기고 정리(구버전 설치본 자동 치유).
 */
function ensureNoticesUidUnique(done) {
  const finish = typeof done === 'function' ? done : () => {};
  if (noticesUidUniqueEnsured) {
    finish();
    return;
  }
  noticesUidUniqueEnsured = true;
  db.run(
    `DELETE FROM notices WHERE uid IS NOT NULL AND uid != '' AND id NOT IN (
       SELECT MAX(id) FROM notices WHERE uid IS NOT NULL AND uid != '' GROUP BY uid
     )`,
    function onDedup(dedupErr) {
      if (dedupErr) {
        console.error('notices uid 중복 정리 실패:', dedupErr.message);
      } else if (this && this.changes) {
        console.warn(`[notices] uid 중복 ${this.changes}건 정리`);
      }
      db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_notices_uid_unique ON notices(uid) WHERE uid IS NOT NULL AND uid != ''`,
        (idxErr) => {
          if (idxErr) console.error('notices uid UNIQUE 인덱스 생성 실패:', idxErr.message);
          finish();
        }
      );
    }
  );
}

function ensureNoticesTableSchema(done) {
  const finish = typeof done === 'function' ? done : () => {};
  if (!db) {
    finish(false);
    return;
  }
  if (noticesSchemaReady) {
    finish(true);
    return;
  }
  if (Array.isArray(noticesSchemaEnsuring)) {
    noticesSchemaEnsuring.push(finish);
    return;
  }
  noticesSchemaEnsuring = [finish];
  const complete = (ok) => {
    const waiters = noticesSchemaEnsuring || [];
    noticesSchemaEnsuring = null;
    if (ok) noticesSchemaReady = true;
    waiters.forEach((fn) => {
      try { fn(ok); } catch (_) { /* ignore */ }
    });
  };

  const required = [
    { name: 'uid', ddl: 'uid TEXT' },
    { name: 'title', ddl: 'title TEXT' },
    { name: 'content', ddl: 'content TEXT' },
    { name: 'author_name', ddl: 'author_name TEXT' },
    { name: 'author_ip', ddl: 'author_ip TEXT' },
    { name: 'created_at', ddl: 'created_at TEXT' },
    { name: 'images', ddl: "images TEXT DEFAULT ''" },
    { name: 'category', ddl: "category TEXT DEFAULT '전체'" }
  ];

  db.run(
    `CREATE TABLE IF NOT EXISTS notices (
      uid TEXT PRIMARY KEY,
      title TEXT,
      content TEXT,
      author_name TEXT,
      author_ip TEXT,
      created_at TEXT,
      images TEXT DEFAULT '',
      category TEXT DEFAULT '전체'
    )`,
    (createErr) => {
      if (createErr) {
        console.error('notices 테이블 생성 실패:', createErr.message);
        if (isSqliteCorruptError(createErr)) scheduleDbCorruptRecovery('notices-schema');
        complete(false);
        return;
      }
      db.all(`PRAGMA table_info(notices)`, [], (err, rows) => {
        if (err) {
          if (isSqliteCorruptError(err)) scheduleDbCorruptRecovery('notices-schema-info');
          console.error('notices schema 확인 실패:', err.message);
          complete(false);
          return;
        }
        const cols = new Set((rows || []).map((r) => String(r.name || '').toLowerCase()));
        const missing = required.filter((c) => !cols.has(c.name));
        const addNext = (idx) => {
          if (idx >= missing.length) {
            db.run(
              `UPDATE notices SET category = '전체' WHERE category IS NULL OR TRIM(COALESCE(category, '')) = ''`,
              () => ensureNoticesUidUnique(() => complete(true))
            );
            return;
          }
          const col = missing[idx];
          db.run(`ALTER TABLE notices ADD COLUMN ${col.ddl}`, (alterErr) => {
            if (alterErr && !/duplicate column/i.test(String(alterErr.message || ''))) {
              console.error(`notices.${col.name} 추가 실패:`, alterErr.message);
              // 다음 컬럼도 시도 (부분 스키마라도 INSERT 폴백 가능)
            }
            addNext(idx + 1);
          });
        };
        addNext(0);
      });
    }
  );
}

/** @deprecated 호환용 — ensureNoticesTableSchema 사용 */
function ensureNoticesCategoryColumn(done) {
  ensureNoticesTableSchema(done);
}

function insertNoticeRecord(record, callback, opts) {
  const cb = typeof callback === 'function' ? callback : () => {};
  const o = opts || {};
  // sync/수신: 같은 uid면 갱신. 로컬 새 작성: INSERT만 (REPLACE 금지 → 다른 카테고리 공지 덮어쓰기 방지)
  const allowReplace = !!o.allowReplace;
  const row = record || {};
  const category = normalizeNoticeCategory(row.category);
  const images = normalizeNoticeImagesField(row.images);
  let saved = { ...row, images, category };
  const baseOf = (uid) => [uid, row.title, row.content, row.author_name, row.author_ip, row.created_at];

  const verb = allowReplace ? 'INSERT OR REPLACE' : 'INSERT';
  const attemptsFor = (uid) => [
    {
      sql: `${verb} INTO notices (uid, title, content, author_name, author_ip, created_at, images, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [...baseOf(uid), images, category]
    },
    {
      sql: `${verb} INTO notices (uid, title, content, author_name, author_ip, created_at, images) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [...baseOf(uid), images]
    },
    {
      sql: `${verb} INTO notices (uid, title, content, author_name, author_ip, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [...baseOf(uid), category]
    },
    {
      sql: `${verb} INTO notices (uid, title, content, author_name, author_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      params: baseOf(uid)
    }
  ];

  const tryAt = (uid, idx, uidAttempt) => {
    const attempts = attemptsFor(uid);
    if (idx >= attempts.length) {
      cb(new Error('공지 저장 실패: DB 스키마를 맞출 수 없습니다'));
      return;
    }
    const a = attempts[idx];
    db.run(a.sql, a.params, (err) => {
      if (!err) {
        saved = { ...saved, uid };
        if (idx > 0) {
          noticesSchemaReady = false;
          ensureNoticesTableSchema(() => {
            db.run(`UPDATE notices SET category = ? WHERE uid = ?`, [category, uid], (fixErr) => {
              if (fixErr) console.error(`[공지] "${uid}" 카테고리 보정 실패(category="${category}"):`, fixErr.message);
            });
            db.run(`UPDATE notices SET images = ? WHERE uid = ?`, [images, uid], (fixErr) => {
              if (fixErr) console.error(`[공지] "${uid}" 이미지 보정 실패:`, fixErr.message);
            });
          });
        }
        cb(null, saved);
        return;
      }
      const msg = String(err.message || '');
      if (isSqliteCorruptError(err)) {
        scheduleDbCorruptRecovery('notice-insert');
        cb(new Error(DB_CORRUPT_USER_MSG));
        return;
      }
      if (/no such column|has no column named/i.test(msg)) {
        noticesSchemaReady = false;
        tryAt(uid, idx + 1, uidAttempt);
        return;
      }
      // 로컬 새 작성 중 uid 충돌 → 새 uid로 재시도 (기존 공지는 유지)
      // sync 경로(forbidNewUidOnConflict)는 절대 새 uid를 만들지 않음 — 중복 공지 방지
      if (!allowReplace && /UNIQUE|constraint|PRIMARY KEY/i.test(msg) && uidAttempt < 3) {
        if (o.forbidNewUidOnConflict) {
          cb(err);
          return;
        }
        tryAt(generateNoticeUid(), 0, uidAttempt + 1);
        return;
      }
      cb(err);
    });
  };

  ensureNoticesTableSchema(() => {
    if (!row.uid) {
      cb(new Error('공지 uid 없음'));
      return;
    }
    tryAt(row.uid, 0, 0);
  });
}

function clearNoticeTombstone(uid, done) {
  const finish = typeof done === 'function' ? done : () => {};
  if (!uid) {
    finish();
    return;
  }
  const key = String(uid);
  noticeTombstoneMemory.delete(key);
  if (!db) {
    finish();
    return;
  }
  db.run(`DELETE FROM deleted_notices WHERE uid = ?`, [key], () => finish());
}

function handleNoticeAdd(n) {
  if (!n || !n.uid) return;
  // 실시간 추가도 tombstone에 막히지 않도록 정리 후 저장 (작성 PC → 전 직원 전파)
  clearNoticeTombstone(n.uid, () => {
    db.get(`SELECT uid FROM notices WHERE uid = ?`, [n.uid], (err, row) => {
      if (row) {
        // 이미 있으면 내용만 갱신 (다른 공지 REPLACE 금지)
        upsertNoticeFromSync(n);
        notifyNoticesChanged();
        return;
      }
      insertNoticeRecord(n, (insErr) => {
        if (insErr) {
          console.error('NOTICE_ADD 저장 실패:', insErr.message);
          return;
        }
        notifyNoticesChanged();
      }, { allowReplace: false });
    });
  });
}

function handleNoticeUpdate(n) {
  if (!n || !n.uid) return;
  isNoticeTombstoned(n.uid, (tombstoned) => {
    if (tombstoned) {
      db.run(`DELETE FROM notices WHERE uid = ?`, [String(n.uid)], () => {
        notifyNoticesChanged();
      });
      return;
    }
    // images 필드가 없는 구버전 업데이트는 기존 사진을 지우지 않음
    const hasImagesField = n && Object.prototype.hasOwnProperty.call(n, 'images');
    const hasCategoryField = n && Object.prototype.hasOwnProperty.call(n, 'category');
    const category = hasCategoryField ? normalizeNoticeCategory(n.category) : null;
    if (hasImagesField && hasCategoryField) {
      const images = normalizeNoticeImagesField(n.images);
      db.run(`UPDATE notices SET title = ?, content = ?, images = ?, category = ? WHERE uid = ?`, [n.title, n.content, images, category, n.uid], () => {
        notifyNoticesChanged();
      });
    } else if (hasImagesField) {
      const images = normalizeNoticeImagesField(n.images);
      db.run(`UPDATE notices SET title = ?, content = ?, images = ? WHERE uid = ?`, [n.title, n.content, images, n.uid], () => {
        notifyNoticesChanged();
      });
    } else if (hasCategoryField) {
      db.run(`UPDATE notices SET title = ?, content = ?, category = ? WHERE uid = ?`, [n.title, n.content, category, n.uid], () => {
        notifyNoticesChanged();
      });
    } else {
      db.run(`UPDATE notices SET title = ?, content = ? WHERE uid = ?`, [n.title, n.content, n.uid], () => {
        notifyNoticesChanged();
      });
    }
  });
}

/** 공지 실시간 전파 — TCP 한도 초과 시 사진 제외하고 본문만 보내고, 사진은 NOTICE_SYNC로 보충 */
function broadcastNoticeWire(type, notice) {
  if (!notice || !notice.uid) return;
  const full = { type, notice };
  const fullBytes = Buffer.byteLength(JSON.stringify(full) + '\n', 'utf8');
  if (fullBytes <= MAX_TCP_LINE_BUFFER - 2048) {
    broadcastToOnlinePeers(full);
    return;
  }
  const slimNotice = Object.assign({}, notice, { images: '[]' });
  const slim = { type, notice: slimNotice };
  const slimBytes = Buffer.byteLength(JSON.stringify(slim) + '\n', 'utf8');
  if (slimBytes <= MAX_TCP_LINE_BUFFER - 2048) {
    console.warn(`[공지] ${notice.uid} 사진 포함 시 TCP 한도 초과 — 본문만 실시간 전송, 사진은 동기화로 전달`);
    broadcastToOnlinePeers(slim);
    return;
  }
  console.error(`[공지] ${notice.uid} 실시간 전송 실패(크기 초과)`);
}

function handleNoticeDelete(uid) {
  if (!uid) return;
  applyLocalNoticeDelete(uid, { notify: true });
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

function buildNoticeSyncPayloadChunks(notices, operators, schedules, profileOverridesRows, deletedScheduleUids, deletedNoticeUids) {
  const chunks = [];
  const baseMeta = {
    type: 'NOTICE_SYNC_RESPONSE',
    notices: [],
    operators: [],
    schedules: [],
    profileOverrides: [],
    deletedScheduleUids: [],
    deletedNoticeUids: [],
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

  // 1) 작성자+overrides+삭제목록 (공지는 사진 때문에 커질 수 있어 별도 청크)
  const head = {
    ...baseMeta,
    operators: operators || [],
    profileOverrides: profileOverridesRows || [],
    deletedScheduleUids: deletedScheduleUids || [],
    deletedNoticeUids: deletedNoticeUids || []
  };
  if (!tryPush(head)) {
    if ((operators || []).length) tryPush({ ...baseMeta, operators });
    if ((profileOverridesRows || []).length) tryPush({ ...baseMeta, profileOverrides: profileOverridesRows });
    if ((deletedScheduleUids || []).length) tryPush({ ...baseMeta, deletedScheduleUids });
    if ((deletedNoticeUids || []).length) tryPush({ ...baseMeta, deletedNoticeUids });
  }

  // 1b) 공지 — 사진 포함 시 단건 청크로 나눠 전송 (한도 초과면 사진 제외하고라도 본문은 전달)
  const noticeList = notices || [];
  let noticeBatch = [];
  const flushNoticeBatch = () => {
    if (!noticeBatch.length) return;
    const obj = { ...baseMeta, notices: noticeBatch, deletedNoticeUids: deletedNoticeUids || [] };
    if (tryPush(obj)) {
      noticeBatch = [];
      return;
    }
    if (noticeBatch.length === 1) {
      const only = noticeBatch[0];
      const slim = Object.assign({}, only, { images: '[]' });
      const slimObj = { ...baseMeta, notices: [slim], deletedNoticeUids: deletedNoticeUids || [] };
      if (!tryPush(slimObj)) {
        console.error('공지 단건이 TCP 한도를 초과해 동기화에서 제외:', only && only.uid);
      } else {
        console.warn(`[공지] ${only && only.uid} 사진 제외하고 본문만 동기화`);
      }
      noticeBatch = [];
      return;
    }
    const half = noticeBatch.slice(0, Math.ceil(noticeBatch.length / 2));
    const rest = noticeBatch.slice(Math.ceil(noticeBatch.length / 2));
    noticeBatch = half;
    flushNoticeBatch();
    noticeBatch = rest;
    flushNoticeBatch();
  };
  // ⚠️ 예전엔 매 공지마다 "지금까지 쌓인 배치 전체"를 JSON.stringify + byteLength로 다시
  // 측정했다(O(n²)). 공지가 9만 건대로 쌓이자(병원 입퇴원 이력이 계속 누적) 이 함수 하나가
  // 60~90초씩 메인 스레드를 통째로 잡아먹어 "응답없음"의 실제 원인이 됨을 CPU 프로파일로 확인함.
  // 봉투(baseMeta) 크기는 고정이므로 한 번만 재고, 공지 1건의 바이트만 누적으로 더한다.
  const noticeEnvelopeBytes = Buffer.byteLength(
    JSON.stringify({ ...baseMeta, notices: [], deletedNoticeUids: deletedNoticeUids || [] }) + '\n',
    'utf8'
  );
  let noticeBatchBytes = noticeEnvelopeBytes;
  noticeList.forEach((n) => {
    const itemBytes = Buffer.byteLength(JSON.stringify(n), 'utf8') + (noticeBatch.length ? 1 : 0);
    if (noticeBatch.length && noticeBatchBytes + itemBytes > NOTICE_SYNC_SAFE_LINE_BYTES) {
      flushNoticeBatch();
      noticeBatchBytes = noticeEnvelopeBytes;
    }
    noticeBatch.push(n);
    noticeBatchBytes += itemBytes;
  });
  flushNoticeBatch();

  // 2) 일정은 청크로 (삭제 UID도 함께 실어 청크만 먼저 도착해도 되살림 방지)
  const list = schedules || [];
  if (!list.length) {
    return chunks.length
      ? chunks
      : [{
          ...baseMeta,
          deletedScheduleUids: deletedScheduleUids || [],
          deletedNoticeUids: deletedNoticeUids || []
        }];
  }

  let batch = [];
  const flushBatch = () => {
    if (!batch.length) return;
    const obj = {
      ...baseMeta,
      schedules: batch,
      deletedScheduleUids: deletedScheduleUids || []
    };
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
    const probe = {
      ...baseMeta,
      schedules: batch,
      deletedScheduleUids: deletedScheduleUids || []
    };
    if (Buffer.byteLength(JSON.stringify(probe) + '\n', 'utf8') > NOTICE_SYNC_SAFE_LINE_BYTES) {
      batch.pop();
      flushBatch();
      batch.push(s);
    }
  });
  flushBatch();
  return chunks.length ? chunks : [{ ...baseMeta, schedules: list.slice(0, 1), deletedScheduleUids: deletedScheduleUids || [] }];
}

function handleNoticeSyncRequest(senderIP) {
  if (!senderIP) return;
  if (noticeSyncResponsesInFlight >= NOTICE_SYNC_MAX_IN_FLIGHT) {
    if (!noticeSyncRequestQueue.includes(senderIP)) {
      noticeSyncRequestQueue.push(senderIP);
      if (noticeSyncRequestQueue.length > 12) noticeSyncRequestQueue.shift();
    }
    return;
  }
  noticeSyncResponsesInFlight += 1;
  const finishSync = () => {
    noticeSyncResponsesInFlight = Math.max(0, noticeSyncResponsesInFlight - 1);
    const next = noticeSyncRequestQueue.shift();
    if (next) setTimeout(() => handleNoticeSyncRequest(next), 80);
  };
  db.all(`SELECT * FROM notices`, [], (err, notices) => {
    if (err) {
      finishSync();
      return;
    }
    const slimNotices = slimNoticesForBulkSync(notices || []);
    db.all(`SELECT * FROM notice_operators`, [], (err2, operators) => {
      db.all(`SELECT * FROM hospital_schedules`, [], (err3, schedules) => {
        db.all(`SELECT * FROM user_profile_overrides`, [], (err4, profileOverridesRows) => {
          db.all(`SELECT * FROM duty_roster`, [], (err6, dutyRoster) => {
            db.all(
              `SELECT uid FROM deleted_schedules ORDER BY deleted_at DESC LIMIT 5000`,
              [],
              (err7, deletedRows) => {
                db.all(
                  `SELECT uid FROM deleted_notices ORDER BY deleted_at DESC LIMIT 5000`,
                  [],
                  (err8, deletedNoticeRows) => {
                    try {
                      const deletedScheduleUids = (deletedRows || []).map((r) => r.uid).filter(Boolean);
                      const deletedNoticeUids = (deletedNoticeRows || []).map((r) => r.uid).filter(Boolean);
                      const chunks = buildNoticeSyncPayloadChunks(
                        slimNotices,
                        operators || [],
                        schedules || [],
                        profileOverridesRows || [],
                        deletedScheduleUids,
                        deletedNoticeUids
                      );
                      const dutyChunk = {
                        type: 'NOTICE_SYNC_RESPONSE',
                        notices: [],
                        operators: [],
                        schedules: [],
                        profileOverrides: [],
                        deletedScheduleUids: [],
                        deletedNoticeUids: [],
                        dutyRoster: dutyRoster || [],
                        updateSourcePath: updateSourcePath || ''
                      };
                      chunks.unshift(dutyChunk);
                      tcpWriteJsonLines(senderIP, chunks);
                    } finally {
                      finishSync();
                    }
                  }
                );
              }
            );
          });
        });
      });
    });
  });
}

function handleNoticeSyncResponse(notices, operators, schedules, remoteUpdateSourcePath, remoteProfileOverrides, dutyRoster, deletedScheduleUids, deletedNoticeUids) {
  // 같은 응답에 공지 본문이 있는 UID는 삭제 목록보다 우선 (방금 작성·재동기화 건 보호)
  const incomingNoticeUids = new Set(
    (Array.isArray(notices) ? notices : []).map((n) => n && n.uid).filter(Boolean).map(String)
  );
  // 공지 삭제 목록을 INSERT보다 먼저 적용해 되살림 방지
  if (Array.isArray(deletedNoticeUids) && deletedNoticeUids.length) {
    const toDelete = deletedNoticeUids.filter((uid) => uid && !incomingNoticeUids.has(String(uid)));
    rememberNoticeTombstones(toDelete);
    toDelete.forEach((uid) => {
      applyLocalNoticeDelete(uid, { notify: false, skipBroadcast: true });
    });
  }
  if (Array.isArray(notices)) {
    notices.forEach((n) => upsertNoticeFromSync(n));
    notifyNoticesChanged();
  } else if (Array.isArray(deletedNoticeUids) && deletedNoticeUids.length) {
    notifyNoticesChanged();
  }
  if (Array.isArray(operators)) {
    operators.forEach(o => {
      if (!o || !o.username) return;
      db.get(`SELECT can_manage_duty, display_name, password_hash FROM notice_operators WHERE username = ?`, [o.username], (err, row) => {
        let dutyFlag = 0;
        if (o.can_manage_duty === 1 || o.can_manage_duty === true || o.can_manage_duty === '1') dutyFlag = 1;
        else if (o.can_manage_duty === 0 || o.can_manage_duty === false || o.can_manage_duty === '0') dutyFlag = 0;
        else if (row && row.can_manage_duty) dutyFlag = 1;
        const incoming = scrubBrokenDisplayChars(o.display_name);
        const localName = scrubBrokenDisplayChars(row && row.display_name);
        const hangul = (t) => (String(t).match(/[\uAC00-\uD7A3]/g) || []).length;
        // 로컬에 더 온전한 한글 이름이 있으면 유지 (깨진 동기화로 덮어쓰지 않음)
        const cleanDisplayName = (hangul(localName) > hangul(incoming)) ? localName : (incoming || localName);
        const passwordHash = o.password_hash || (row && row.password_hash) || '';
        if (!passwordHash) return;
        db.run(
          `INSERT OR REPLACE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty) VALUES (?, ?, ?, ?, ?)`,
          [o.username, passwordHash, cleanDisplayName, o.added_at || (row && row.added_at) || new Date().toISOString(), dutyFlag],
          logDbErr
        );
      });
    });
    if (mainWindow) safeWebContentsSend('notice-operators-update');
  }
  // 삭제 목록을 일정 INSERT보다 먼저 적용해야 되살림을 막을 수 있음
  // (DB INSERT는 비동기이므로 메모리 tombstone을 먼저 올려 레이스를 차단)
  // 같은 응답에 일정 본문이 있는 UID는 삭제 목록보다 우선
  const incomingScheduleUids = new Set(
    (Array.isArray(schedules) ? schedules : []).map((s) => s && s.uid).filter(Boolean).map(String)
  );
  if (Array.isArray(deletedScheduleUids) && deletedScheduleUids.length) {
    const toDelete = deletedScheduleUids.filter((uid) => uid && !incomingScheduleUids.has(String(uid)));
    rememberScheduleTombstones(toDelete);
    toDelete.forEach((uid) => {
      if (!uid) return;
      applyLocalScheduleDelete(uid, { notify: false });
    });
  }
  if (Array.isArray(schedules)) {
    schedules.forEach((s) => upsertScheduleFromSync(s));
    if (mainWindow) notifySchedulesChanged();
  } else if (Array.isArray(deletedScheduleUids) && deletedScheduleUids.length) {
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
  db.get(`SELECT can_manage_duty, display_name, password_hash, added_at FROM notice_operators WHERE username = ?`, [o.username], (err, row) => {
    // 원격에 필드가 없으면(구버전 동기화) 기존 권한을 덮어쓰지 않음
    let dutyFlag = 0;
    if (o.can_manage_duty === 1 || o.can_manage_duty === true || o.can_manage_duty === '1') dutyFlag = 1;
    else if (o.can_manage_duty === 0 || o.can_manage_duty === false || o.can_manage_duty === '0') dutyFlag = 0;
    else if (row && row.can_manage_duty) dutyFlag = 1;
    const incoming = scrubBrokenDisplayChars(o.display_name);
    const localName = scrubBrokenDisplayChars(row && row.display_name);
    const hangul = (t) => (String(t).match(/[\uAC00-\uD7A3]/g) || []).length;
    const cleanDisplayName = (hangul(localName) > hangul(incoming)) ? localName : (incoming || localName);
    const passwordHash = o.password_hash || (row && row.password_hash) || '';
    if (!passwordHash) return;
    db.run(
      `INSERT OR REPLACE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty) VALUES (?, ?, ?, ?, ?)`,
      [o.username, passwordHash, cleanDisplayName, o.added_at || (row && row.added_at) || new Date().toISOString(), dutyFlag],
      () => {
        if (mainWindow) safeWebContentsSend('notice-operators-update');
      }
    );
  });
}

function handleOperatorDutyPerm(payload) {
  if (!payload || !payload.username) return;
  const flag = payload.canManageDuty ? 1 : 0;
  db.run(`UPDATE notice_operators SET can_manage_duty = ? WHERE username = ?`, [flag, payload.username], () => {
    if (mainWindow) safeWebContentsSend('notice-operators-update');
  });
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
    ward: scrubBrokenDisplayChars(o.ward || ''),
    rm_team: scrubBrokenDisplayChars(o.rmTeam || o.rm_team || ''),
    room_no: scrubBrokenDisplayChars(o.roomNo || o.room_no || ''),
    patient_name: scrubBrokenDisplayChars(o.patientName || o.patient_name || '')
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

/** 삭제 tombstone 보관 기간 (다른 PC가 오래된 삭제를 영원히 들고 있지 않도록) */
const SCHEDULE_TOMBSTONE_KEEP_MS = 120 * 24 * 60 * 60 * 1000;
/** DB 기록 전에도 동기화 INSERT 레이스를 막기 위한 즉시 기억 */
const scheduleTombstoneMemory = new Set();

const NOTICE_TOMBSTONE_KEEP_MS = 120 * 24 * 60 * 60 * 1000;
// noticeTombstoneMemory 는 ensureNoticesTableSchema 상단에서 선언

function pruneScheduleTombstones(done) {
  const cutoff = new Date(Date.now() - SCHEDULE_TOMBSTONE_KEEP_MS).toISOString();
  db.all(`SELECT uid FROM deleted_schedules WHERE deleted_at < ?`, [cutoff], (err, rows) => {
    // 메모리 Set 수명을 DB 보관 기간(120일)과 맞춰 무한 성장 방지
    if (!err && rows) rows.forEach((r) => scheduleTombstoneMemory.delete(String(r.uid)));
    db.run(`DELETE FROM deleted_schedules WHERE deleted_at < ?`, [cutoff], () => {
      if (typeof done === 'function') done();
    });
  });
}

function pruneNoticeTombstones(done) {
  const cutoff = new Date(Date.now() - NOTICE_TOMBSTONE_KEEP_MS).toISOString();
  db.all(`SELECT uid FROM deleted_notices WHERE deleted_at < ?`, [cutoff], (err, rows) => {
    // 메모리 Set 수명을 DB 보관 기간(120일)과 맞춰 무한 성장 방지
    if (!err && rows) rows.forEach((r) => noticeTombstoneMemory.delete(String(r.uid)));
    db.run(`DELETE FROM deleted_notices WHERE deleted_at < ?`, [cutoff], () => {
      if (typeof done === 'function') done();
    });
  });
}

function recordScheduleTombstone(uid, done) {
  if (!uid) {
    if (typeof done === 'function') done();
    return;
  }
  const key = String(uid);
  scheduleTombstoneMemory.add(key);
  const at = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO deleted_schedules (uid, deleted_at) VALUES (?, ?)`,
    [key, at],
    () => pruneScheduleTombstones(done)
  );
}

function recordNoticeTombstone(uid, done) {
  if (!uid) {
    if (typeof done === 'function') done();
    return;
  }
  const key = String(uid);
  noticeTombstoneMemory.add(key);
  const at = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO deleted_notices (uid, deleted_at) VALUES (?, ?)`,
    [key, at],
    () => pruneNoticeTombstones(done)
  );
}

function isScheduleTombstoned(uid, cb) {
  if (!uid) {
    cb(false);
    return;
  }
  const key = String(uid);
  if (scheduleTombstoneMemory.has(key)) {
    cb(true);
    return;
  }
  db.get(`SELECT 1 AS x FROM deleted_schedules WHERE uid = ?`, [key], (err, row) => {
    if (!err && row) scheduleTombstoneMemory.add(key);
    cb(!err && !!row);
  });
}

function isNoticeTombstoned(uid, cb) {
  if (!uid) {
    cb(false);
    return;
  }
  const key = String(uid);
  if (noticeTombstoneMemory.has(key)) {
    cb(true);
    return;
  }
  db.get(`SELECT 1 AS x FROM deleted_notices WHERE uid = ?`, [key], (err, row) => {
    if (!err && row) noticeTombstoneMemory.add(key);
    cb(!err && !!row);
  });
}

function rememberScheduleTombstones(uids) {
  (uids || []).forEach((uid) => {
    if (uid) scheduleTombstoneMemory.add(String(uid));
  });
}

function rememberNoticeTombstones(uids) {
  (uids || []).forEach((uid) => {
    if (uid) noticeTombstoneMemory.add(String(uid));
  });
}

function applyLocalScheduleDelete(uid, opts) {
  const o = opts || {};
  if (!uid) {
    if (typeof o.done === 'function') o.done(new Error('uid missing'));
    return;
  }
  recordScheduleTombstone(uid, () => {
    db.run(`DELETE FROM hospital_schedules WHERE uid = ?`, [String(uid)], (err) => {
      if (!err && o.notify !== false) notifySchedulesChanged();
      if (typeof o.done === 'function') o.done(err || null);
    });
  });
}

function applyLocalNoticeDelete(uid, opts) {
  const o = opts || {};
  if (!uid) {
    if (typeof o.done === 'function') o.done(new Error('uid missing'));
    return;
  }
  recordNoticeTombstone(uid, () => {
    db.run(`DELETE FROM notices WHERE uid = ?`, [String(uid)], (err) => {
      if (!err && o.notify !== false) notifyNoticesChanged();
      if (typeof o.done === 'function') o.done(err || null);
    });
  });
}

function upsertNoticeFromSync(n) {
  if (!n || !n.uid) return;
  // 동기화 응답에 본문이 온 공지는 tombstone보다 우선해 저장 (전체 직원이 읽을 수 있게)
  clearNoticeTombstone(n.uid, () => {
    const category = normalizeNoticeCategory(n.category);
    const images = normalizeNoticeImagesField(n.images);
    ensureNoticesTableSchema(() => {
      const applyUpdate = (onDone) => {
        db.run(
          `UPDATE notices SET title = ?, content = ?, author_name = ?, author_ip = ?, created_at = ?, images = ?, category = ? WHERE uid = ?`,
          [n.title, n.content, n.author_name, n.author_ip, n.created_at, images, category, n.uid],
          function onUpd(err) {
            if (!err) {
              if (typeof onDone === 'function') onDone(null, this && this.changes > 0);
              return;
            }
            // category/images 없는 구스키마 폴백
            if (/no such column|has no column named/i.test(String(err.message || ''))) {
              db.run(
                `UPDATE notices SET title = ?, content = ?, author_name = ?, author_ip = ?, created_at = ? WHERE uid = ?`,
                [n.title, n.content, n.author_name, n.author_ip, n.created_at, n.uid],
                function onUpd2(err2) {
                  if (typeof onDone === 'function') onDone(err2 || null, !err2 && this && this.changes > 0);
                }
              );
              return;
            }
            if (typeof onDone === 'function') onDone(err, false);
          }
        );
      };

      // 이미 있으면 UPDATE만 — changes===0(동일 내용)이어도 INSERT/새 uid 생성 금지
      db.get(`SELECT uid FROM notices WHERE uid = ?`, [n.uid], (selErr, existing) => {
        if (existing) {
          applyUpdate(() => {});
          return;
        }
        insertNoticeRecord({ ...n, images, category }, (insErr) => {
          if (!insErr) return;
          // 레이스로 UNIQUE 난 경우 새 uid 만들지 말고 기존 행 UPDATE
          if (/UNIQUE|constraint|PRIMARY KEY/i.test(String(insErr.message || ''))) {
            applyUpdate(() => {});
            return;
          }
          console.error('notice sync upsert 실패:', insErr.message);
        }, { allowReplace: false, forbidNewUidOnConflict: true });
      });
    });
  });
}

function insertScheduleRowIgnoringTombstone(s, notify) {
  if (!s || !s.uid) return;
  isScheduleTombstoned(s.uid, (tombstoned) => {
    if (tombstoned) {
      db.run(`DELETE FROM hospital_schedules WHERE uid = ?`, [String(s.uid)], logDbErr);
      return;
    }
    const meta = schedulePatientMetaFromPayload(s);
    const und = scheduleTimeUndecidedFromPayload(s);
    const meal = scheduleMealCancelFromPayload(s);
    const remark = scheduleRemarkFromPayload(s);
    const guardianOnly = scheduleGuardianOnlyFromPayload(s);
    db.run(
      `INSERT OR IGNORE INTO hospital_schedules (uid, type, title, time_str, author_name, author_ip, created_at, remind_before, attending_physician, time_end_str, ward, rm_team, room_no, patient_name, time_start_undecided, time_end_undecided, meal_cancel_breakfast, meal_cancel_lunch, meal_cancel_dinner, remark, guardian_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.uid, s.type, s.title, s.time_str, s.author_name, s.author_ip, s.created_at, s.remind_before || 0, s.attending_physician || '', s.time_end_str || '', meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly],
      () => { if (notify) notifySchedulesChanged(); }
    );
  });
}

function upsertScheduleFromSync(s) {
  if (!s || !s.uid) return;
  isScheduleTombstoned(s.uid, (tombstoned) => {
    if (tombstoned) {
      db.run(`DELETE FROM hospital_schedules WHERE uid = ?`, [String(s.uid)], logDbErr);
      return;
    }
    const meta = schedulePatientMetaFromPayload(s);
    const und = scheduleTimeUndecidedFromPayload(s);
    const meal = scheduleMealCancelFromPayload(s);
    const remark = scheduleRemarkFromPayload(s);
    const guardianOnly = scheduleGuardianOnlyFromPayload(s);
    const modAt = s.modified_at || '';
    const modName = s.modified_by_name || '';
    const modIp = s.modified_by_ip || '';
    db.get(`SELECT modified_at FROM hospital_schedules WHERE uid = ?`, [s.uid], (err, row) => {
      if (err) return;
      if (!row) {
        db.run(
          `INSERT INTO hospital_schedules (uid, type, title, time_str, author_name, author_ip, created_at, remind_before, attending_physician, time_end_str, ward, rm_team, room_no, patient_name, time_start_undecided, time_end_undecided, meal_cancel_breakfast, meal_cancel_lunch, meal_cancel_dinner, remark, guardian_only, modified_at, modified_by_name, modified_by_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.uid, s.type, s.title, s.time_str, s.author_name, s.author_ip, s.created_at, s.remind_before || 0, s.attending_physician || '', s.time_end_str || '', meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly, modAt, modName, modIp],
          logDbErr
        );
        return;
      }
      const localMod = String(row.modified_at || '');
      const remoteMod = String(modAt || '');
      // 원격에 수정 시각이 있고 로컬보다 같거나 더 최신이면 반영 (수정 동기화)
      if (remoteMod && (!localMod || remoteMod >= localMod)) {
        db.run(
          `UPDATE hospital_schedules SET type = ?, title = ?, time_str = ?, remind_before = ?, attending_physician = ?, time_end_str = ?, ward = ?, rm_team = ?, room_no = ?, patient_name = ?, time_start_undecided = ?, time_end_undecided = ?, meal_cancel_breakfast = ?, meal_cancel_lunch = ?, meal_cancel_dinner = ?, remark = ?, guardian_only = ?, modified_at = ?, modified_by_name = ?, modified_by_ip = ? WHERE uid = ?`,
          [s.type, s.title, s.time_str, s.remind_before || 0, s.attending_physician || '', s.time_end_str || '', meta.ward, meta.rm_team, meta.room_no, meta.patient_name, und.time_start_undecided, und.time_end_undecided, meal.meal_cancel_breakfast, meal.meal_cancel_lunch, meal.meal_cancel_dinner, remark, guardianOnly, modAt, modName, modIp, s.uid],
          logDbErr
        );
      }
    });
  });
}

function handleScheduleAdd(s) {
  if (!s || !s.uid) return;
  insertScheduleRowIgnoringTombstone(s, true);
}

function handleScheduleDelete(uid) {
  applyLocalScheduleDelete(uid, { notify: true });
}

function handleScheduleEdit(s) {
  if (!s || !s.uid) return;
  isScheduleTombstoned(s.uid, (tombstoned) => {
    if (tombstoned) return;
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
  });
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
        if (err) {
          logDbErr(err);
          finishIncomingChatUid(msgUid, isMsgUidUniqueConflict(err));
          return;
        }
        finishIncomingChatUid(msgUid, true);
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
  if (!targetIP || targetIP === MY_IP) return;
  const now = Date.now();
  const last = noticeSyncLastRequestAt.get(targetIP) || 0;
  if (now - last < NOTICE_SYNC_REQUEST_COOLDOWN_MS) return;
  noticeSyncLastRequestAt.set(targetIP, now);
  const client = new net.Socket();
  client.setTimeout(1200);
  client.connect(TCP_PORT, targetIP, () => {
    client.write(JSON.stringify({ type: 'NOTICE_SYNC_REQUEST' }) + '\n');
    client.end();
  });
  client.on('error', () => {});
  client.on('timeout', () => client.destroy());
}

/** 온라인 동료 몇 명에게 공지 동기화 요청 (게시판 열 때) */
function requestNoticeSyncFromOnlinePeers(limit) {
  const max = Math.max(1, Math.min(Number(limit) || 3, 8));
  const ips = [];
  onlineUsers.forEach((_u, ip) => {
    if (ip && ip !== MY_IP) ips.push(ip);
  });
  // 랜덤하게 소수만 요청 — 접속 많을 때 전원 sync 폭주 완화
  for (let i = ips.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = ips[i]; ips[i] = ips[j]; ips[j] = t;
  }
  ips.slice(0, max).forEach((ip, idx) => {
    setTimeout(() => requestNoticeSync(ip), idx * 120);
  });
}

ipcMain.handle('request-notice-sync', async () => {
  requestNoticeSyncFromOnlinePeers(5);
  return { success: true };
});

function broadcastToOnlinePeers(payloadObj) {
  let wireData;
  try {
    wireData = JSON.stringify(payloadObj) + '\n';
  } catch (e) {
    console.error('broadcastToOnlinePeers stringify 실패:', e && e.message);
    return;
  }
  const ips = [];
  onlineUsers.forEach((_u, ip) => {
    if (ip && ip !== MY_IP) ips.push(ip);
  });
  if (!ips.length) return;
  // 한꺼번에 connect 하면 작성 PC가 멈춘 것처럼 보이므로 소량씩 나눠 전송
  let i = 0;
  const BATCH = 6;
  const pump = () => {
    const end = Math.min(i + BATCH, ips.length);
    for (; i < end; i++) {
      const ip = ips[i];
      const client = new net.Socket();
      client.setTimeout(1200);
      client.connect(TCP_PORT, ip, () => {
        try {
          client.write(wireData);
          client.end();
        } catch (_) {
          client.destroy();
        }
      });
      client.on('error', () => {});
      client.on('timeout', () => client.destroy());
    }
    if (i < ips.length) setImmediate(pump);
  };
  setImmediate(pump);
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
  if (isMessengerUsageBlocked()) return messengerBlockedResponse();
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
        error: '파일이 너무 커서 전송할 수 없습니다. (최대 50MB)\n공유 폴더를 이용해 주세요.'
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
  if (isMessengerUsageBlocked()) return messengerBlockedResponse();
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

    // 나에게 보내기: 수신측이 senderIP===MY_IP 를 무시하므로 TCP 불필요. 로컬 SENT로 보관.
    // sender_ip/receiver_ip는 실제 현재 IP(MY_IP) 대신 고정 키 'SELF'로 저장한다 —
    // MY_IP는 DHCP 재할당·재접속 등으로 재시작마다 바뀔 수 있는데, 그대로 쓰면 IP가
    // 바뀐 다음 「나에게」 대화창을 열 때 예전 IP로 저장된 메시지들을 못 찾아 마치
    // 사라진 것처럼 보이는 문제가 있었다(실제 발생).
    if (targetIP === MY_IP) {
      extractAndSaveAttachments(message, { msgUid });
      appendChatLog(`DM_SELF`, partnerName || senderLabelForMe(), myProfile.username, message);
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, 'SENT', ?)`,
        [senderLabelForMe(), 'SELF', 'SELF', message, msgUid],
        function (insertErr) {
          if (insertErr) {
            logDbErr(insertErr);
            finish({ status: 'ERROR', error: insertErr.message || 'DB 저장 실패', uid: msgUid });
            return;
          }
          compactMessageRowById(this.lastID, msgUid, message);
          finish({ status: 'SENT', createdAt, uid: msgUid, id: this.lastID });
        }
      );
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

ipcMain.handle('send-broadcast-message', async (event, messageOrOpts) => {
  if (isMessengerUsageBlocked()) return messengerBlockedResponse();
  const opts = (messageOrOpts && typeof messageOrOpts === 'object' && !Array.isArray(messageOrOpts))
    ? messageOrOpts
    : { message: messageOrOpts };
  const message = opts.message;
  if (typeof message !== 'string') {
    return { status: 'ERROR', error: '메시지 내용이 없습니다.' };
  }
  const codeType = (opts.codeType === 'blue' || opts.codeType === 'red')
    ? opts.codeType
    : detectCodeAlertType(message);
  const urgent = !!opts.urgent || !!codeType;
  const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgUid = generateMsgUid();
  const wire = { type: 'BROADCAST', sender: myProfile.username, message, msgUid, urgent };
  if (codeType) wire.codeType = codeType;
  broadcastToOnlinePeers(wire);
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
        resolve({ status: 'SENT', createdAt, uid: msgUid, id: this.lastID, codeType: codeType || null, urgent });
      }
    );
  });
});

ipcMain.handle('send-dept-message', async (event, { dept, message }) => {
  if (isMessengerUsageBlocked()) return messengerBlockedResponse();
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
  if (isMessengerUsageBlocked()) return messengerBlockedResponse();
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

function uniqueSavePath(dir, fileName) {
  const safe = sanitizeFileName(fileName || 'download');
  let dest = path.join(dir, safe);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  for (let i = 1; i < 1000; i++) {
    dest = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

/** 채팅 「받기」: mirae-file:// 또는 data: URL을 다운로드 폴더에 저장 */
ipcMain.handle('save-chat-file-attachment', async (event, payload) => {
  try {
    const p = payload || {};
    const href = String(p.href || '').trim();
    const ask = !!p.ask;
    let preferredName = sanitizeFileName(p.fileName || '');
    preferredName = repairMimeDisguisedFileName(preferredName);
    if (!preferredName || preferredName === 'download' || preferredName === 'unknown') {
      preferredName = '';
    }
    if (!href) return { success: false, msg: '파일 경로가 없습니다.' };

    let sourcePath = '';
    let buffer = null;

    if (/^mirae-file:\/\//i.test(href)) {
      const raw = href.replace(/^mirae-file:\/\//i, '').split(/[?#]/)[0];
      const storedName = path.basename(decodeURIComponent(raw));
      if (!storedName || storedName === '.' || storedName === '..') {
        return { success: false, msg: '파일 이름을 확인할 수 없습니다.' };
      }
      sourcePath = path.join(getReceivedFilesDir(), storedName);
      if (!fs.existsSync(sourcePath)) {
        return { success: false, msg: '저장된 파일을 찾을 수 없습니다. 다시 받아 주세요.' };
      }
      if (!preferredName) {
        // storedName: uid_timestamp_idx_원본이름 → 원본 이름 추정
        let stripped = storedName
          .replace(/^[0-9a-f-]{8,}_/i, '')
          .replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_(\d+_)?/, '');
        stripped = repairMimeDisguisedFileName(stripped || storedName);
        preferredName = sanitizeFileName(stripped || storedName);
      }
    } else if (/^data:/i.test(href)) {
      const m = href.match(/^data:([^;]+);base64,(.+)$/i);
      if (!m) return { success: false, msg: '파일 데이터 형식이 올바르지 않습니다.' };
      buffer = Buffer.from(m[2], 'base64');
      if (!preferredName) preferredName = `file_${Date.now()}`;
      if (!path.extname(preferredName)) {
        preferredName = `${preferredName}.${extensionFromMime(m[1])}`;
      }
    } else if (/^file:\/\//i.test(href)) {
      try {
        sourcePath = decodeURIComponent(href.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1'));
      } catch (e) {
        return { success: false, msg: '로컬 파일 경로를 읽을 수 없습니다.' };
      }
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        return { success: false, msg: '로컬 파일을 찾을 수 없습니다.' };
      }
      if (!preferredName) preferredName = path.basename(sourcePath);
    } else {
      return { success: false, msg: '지원하지 않는 파일 링크입니다.' };
    }

    preferredName = repairMimeDisguisedFileName(sanitizeFileName(preferredName || 'download'));
    const targetDir = getReceivedFilesDir();
    let destPath = uniqueSavePath(targetDir, preferredName);

    if (ask && mainWindow && !mainWindow.isDestroyed()) {
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: destPath,
        filters: [{ name: 'All Files', extensions: ['*'] }]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      destPath = result.filePath;
    }

    if (buffer) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, buffer);
    } else if (sourcePath) {
      const same = path.resolve(sourcePath) === path.resolve(destPath);
      if (!same) {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(sourcePath, destPath);
      } else {
        destPath = sourcePath;
      }
    }

    try { shell.showItemInFolder(destPath); } catch (e) { /* ignore */ }
    return { success: true, path: destPath };
  } catch (err) {
    console.error('save-chat-file-attachment', err);
    return { success: false, msg: err.message || String(err) };
  }
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

  // SENT·PENDING 모두 재시도 상한 — ACK 실패 시 무한 재전송으로 수신측 폭주 방지
  const retryKey = row.msg_uid ? String(row.msg_uid) : inflightKey;
  const tries = sentAckRetryCount.get(retryKey) || 0;
  if (tries >= SENT_ACK_MAX_RETRIES) {
    // 상한에 도달한 항목은 더 조회되지 않으므로 카운터를 지운다 — 장시간 켜둔 채로
    // 오프라인 상대와의 메시지가 쌓이면 이 Map이 끝없이 커지는 것을 방지.
    sentAckRetryCount.delete(retryKey);
    releaseInflight();
    return;
  }
  sentAckRetryCount.set(retryKey, tries + 1);

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
  // 나에게 보내기: 메시지는 'SELF' 키로 저장되지만, 렌더러는 여전히 자기 자신의
  // 현재 IP(myProfile.ip === MY_IP)를 targetIP로 보낸다 — 여기서 맞춰준다.
  // (일부 호출부는 이미 'SELF'로 정규화해서 넘기므로 그 값도 그대로 받아준다.)
  if (targetIP === MY_IP || targetIP === 'SELF') {
    return { where: '(sender_ip = ? AND receiver_ip = ?)', params: ['SELF', 'SELF'] };
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
        isMe: r.sender_ip === MY_IP || r.sender_ip === 'SELF' || (mineLabel && r.sender_name === mineLabel)
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

ipcMain.handle('get-recent-conversations', async () => {
  const myIp = MY_IP;
  return new Promise((resolve) => {
    const sql = `
      SELECT x.peer_key, m.message, m.sender_name, m.sender_ip, m.id AS last_id,
             strftime('%Y-%m-%d %H:%M', m.created_at, 'localtime') AS created_at_local
      FROM (
        SELECT receiver_ip AS peer_key, MAX(id) AS last_id
        FROM messages
        WHERE receiver_ip = 'BROADCAST'
           OR receiver_ip LIKE 'DEPT:%'
           OR receiver_ip LIKE 'FLOOR:%'
           OR receiver_ip LIKE 'GROUP:%'
        GROUP BY receiver_ip
        UNION ALL
        SELECT CASE WHEN sender_ip = ? THEN receiver_ip ELSE sender_ip END AS peer_key,
               MAX(id) AS last_id
        FROM messages
        WHERE (sender_ip = ? OR receiver_ip = ? OR sender_ip = 'SELF')
          AND receiver_ip != 'BROADCAST'
          AND receiver_ip NOT LIKE 'DEPT:%'
          AND receiver_ip NOT LIKE 'FLOOR:%'
          AND receiver_ip NOT LIKE 'GROUP:%'
          AND receiver_ip NOT LIKE 'BCAST:%'
          AND receiver_ip NOT LIKE 'DEPTPEER:%'
          AND receiver_ip NOT LIKE 'FLOORPEER:%'
          AND sender_ip NOT LIKE 'BCAST:%'
          AND sender_ip NOT LIKE 'DEPTPEER:%'
          AND sender_ip NOT LIKE 'FLOORPEER:%'
        GROUP BY peer_key
      ) x
      JOIN messages m ON m.id = x.last_id
      ORDER BY x.last_id DESC
      LIMIT 200`;
    db.all(sql, [myIp, myIp, myIp], (err, rows) => {
      if (err) {
        logDbErr(err);
        resolve([]);
        return;
      }
      const mineLabel = senderLabelForMe();
      resolve((rows || []).map((r) => ({
        key: r.peer_key,
        message: r.message,
        sender_name: formatSenderDisplay(r.sender_name, r.sender_ip),
        sender_ip: r.sender_ip,
        last_id: r.last_id,
        created_at_local: r.created_at_local,
        isMe: r.sender_ip === myIp || r.sender_ip === 'SELF' || (mineLabel && r.sender_name === mineLabel)
      })));
    });
  });
});

ipcMain.handle('get-chat-history', async (event, args) => {
  const targetIP = (args && typeof args === 'object') ? args.targetIP : args;
  const keyword = args && typeof args === 'object' ? args.keyword : null;
  const dateStrRaw = args && typeof args === 'object' ? (args.dateStr || args.aroundDate || null) : null;
  const dateStr = (typeof dateStrRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStrRaw.trim()))
    ? dateStrRaw.trim()
    : null;
  const hideUpToId = await getChatViewHideUpToId(targetIP === MY_IP ? 'SELF' : targetIP);
  const scope = chatHistoryScopeSql(targetIP);

  const mapRows = (rows) => {
    const mineLabel = senderLabelForMe();
    return (rows || []).map((r) => ({
      ...r,
      isMe: r.sender_ip === MY_IP || r.sender_ip === 'SELF' || (mineLabel && r.sender_name === mineLabel),
      sender_name: formatSenderDisplay(r.sender_name, r.sender_ip)
    }));
  };

  const selectCols = `DISTINCT id, sender_name, sender_ip, receiver_ip, message, status, msg_uid, strftime('%H:%M', created_at, 'localtime') as created_time, strftime('%Y-%m-%d %H:%M', created_at, 'localtime') as sent_at_full, strftime('%Y-%m-%d', created_at, 'localtime') as date_key`;

  // 특정 날짜로 점프: 해당일(또는 가장 가까운 이전일) 첫 메시지부터 최대 200건
  if (dateStr && !keyword) {
    return new Promise((resolve) => {
      let findSql = `SELECT MIN(id) AS minId FROM messages WHERE ${scope.where} AND strftime('%Y-%m-%d', created_at, 'localtime') = ?`;
      const findParams = [...scope.params, dateStr];
      if (hideUpToId > 0) {
        findSql += ` AND id > ?`;
        findParams.push(hideUpToId);
      }
      db.get(findSql, findParams, (err, row) => {
        const finishFromAnchor = (anchorId, resolvedDate) => {
          if (!anchorId) {
            resolve({ rows: [], jumpedDate: null, requestedDate: dateStr, empty: true });
            return;
          }
          let sql = `SELECT ${selectCols} FROM messages WHERE ${scope.where} AND id >= ?`;
          const params = [...scope.params, anchorId];
          if (hideUpToId > 0) {
            sql += ` AND id > ?`;
            params.push(hideUpToId);
          }
          sql += ` ORDER BY id ASC LIMIT 200`;
          db.all(sql, params, (err2, rows) => {
            if (err2) {
              logDbErr(err2);
              resolve({ rows: [], jumpedDate: null, requestedDate: dateStr, empty: true });
              return;
            }
            resolve({
              rows: mapRows(rows),
              jumpedDate: resolvedDate || dateStr,
              requestedDate: dateStr,
              empty: !(rows && rows.length)
            });
          });
        };

        if (err) {
          logDbErr(err);
          resolve({ rows: [], jumpedDate: null, requestedDate: dateStr, empty: true });
          return;
        }
        if (row && row.minId) {
          finishFromAnchor(row.minId, dateStr);
          return;
        }
        // 해당일에 없으면 이전 → 없으면 이후 가장 가까운 대화일로 이동
        const findNearestDay = (cmp, order, next) => {
          let nearSql = `SELECT id, strftime('%Y-%m-%d', created_at, 'localtime') AS date_key FROM messages WHERE ${scope.where} AND strftime('%Y-%m-%d', created_at, 'localtime') ${cmp} ?`;
          const nearParams = [...scope.params, dateStr];
          if (hideUpToId > 0) {
            nearSql += ` AND id > ?`;
            nearParams.push(hideUpToId);
          }
          nearSql += ` ORDER BY id ${order} LIMIT 1`;
          db.get(nearSql, nearParams, (errNear, nearRow) => {
            if (errNear) logDbErr(errNear);
            if (nearRow && nearRow.id) {
              let dayStartSql = `SELECT MIN(id) AS minId FROM messages WHERE ${scope.where} AND strftime('%Y-%m-%d', created_at, 'localtime') = ?`;
              const dayStartParams = [...scope.params, nearRow.date_key];
              if (hideUpToId > 0) {
                dayStartSql += ` AND id > ?`;
                dayStartParams.push(hideUpToId);
              }
              db.get(dayStartSql, dayStartParams, (err3, dayRow) => {
                finishFromAnchor((dayRow && dayRow.minId) || nearRow.id, nearRow.date_key);
              });
              return;
            }
            if (typeof next === 'function') next();
            else resolve({ rows: [], jumpedDate: null, requestedDate: dateStr, empty: true });
          });
        };
        findNearestDay('<=', 'DESC', () => findNearestDay('>=', 'ASC'));
      });
    });
  }

  return new Promise((resolve) => {
    let sql = `SELECT ${selectCols} FROM messages WHERE ${scope.where}`;
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
      const ordered = (rows || []).slice().reverse();
      // 기존 호출부 호환: 배열 그대로 반환
      resolve(mapRows(ordered));
    });
  });
});

/** 채팅 달력: 해당 월에 대화가 있는 날짜 목록 */
ipcMain.handle('get-chat-message-dates', async (event, args) => {
  const targetIP = args && args.targetIP;
  const month = args && args.month; // YYYY-MM
  if (!targetIP || !month || !/^\d{4}-\d{2}$/.test(String(month))) return [];
  const hideUpToId = await getChatViewHideUpToId(targetIP === MY_IP ? 'SELF' : targetIP);
  const scope = chatHistoryScopeSql(targetIP);
  return new Promise((resolve) => {
    let sql = `SELECT DISTINCT strftime('%Y-%m-%d', created_at, 'localtime') AS date_key
      FROM messages WHERE ${scope.where}
      AND strftime('%Y-%m', created_at, 'localtime') = ?`;
    const params = [...scope.params, String(month)];
    if (hideUpToId > 0) {
      sql += ` AND id > ?`;
      params.push(hideUpToId);
    }
    db.all(sql, params, (err, rows) => {
      if (err) {
        logDbErr(err);
        resolve([]);
        return;
      }
      resolve((rows || []).map((r) => r.date_key).filter(Boolean));
    });
  });
});

ipcMain.handle('clear-chat-view', async (event, channelKey) => {
  const rawKey = String(channelKey || '').trim();
  const key = rawKey === MY_IP ? 'SELF' : rawKey;
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
        isMe: r.sender_ip === MY_IP || r.sender_ip === 'SELF' || r.sender_name === senderLabelForMe()
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
  const incoming = newProfile || {};
  if (Object.prototype.hasOwnProperty.call(incoming, 'username') && isPlaceholderUsername(incoming.username)) {
    incoming.username = '';
  }
  const photoChanged = typeof incoming.photo === 'string' && incoming.photo !== myProfile.photo;
  myProfile = { ...myProfile, ...incoming };
  console.log('[프로필] 저장:', myProfile.username || '(이름 미설정)', myProfile.rank, myProfile.dept, myProfile.floor, myProfile.extNo);
  logToRendererConsole('info', `[프로필] 저장: ${myProfile.username || '(이름 미설정)'} ${myProfile.rank} ${myProfile.dept} ${myProfile.floor} ${myProfile.extNo}`);
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

function normalizeNewPassword(raw) {
  const pw = String(raw == null ? '' : raw).trim();
  if (pw.length < 4) return { ok: false, msg: '새 비밀번호는 4자 이상이어야 합니다.' };
  if (pw.length > 64) return { ok: false, msg: '새 비밀번호는 64자 이하여야 합니다.' };
  return { ok: true, password: pw };
}

/** 마스터 로그인 상태에서 본인 비밀번호 변경 (이 PC의 master_config) */
ipcMain.handle('change-master-password', async (event, payload) => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  }
  const currentPassword = String((payload && payload.currentPassword) || '').trim();
  const normalized = normalizeNewPassword(payload && payload.newPassword);
  if (!normalized.ok) return { success: false, msg: normalized.msg };
  if (normalized.password === currentPassword) {
    return { success: false, msg: '새 비밀번호는 현재 비밀번호와 달라야 합니다.' };
  }
  return new Promise((resolve) => {
    db.get(`SELECT master_id, master_password FROM master_config WHERE id = 1`, (err, row) => {
      if (err || !row) {
        resolve({ success: false, msg: '마스터 설정을 찾을 수 없습니다.' });
        return;
      }
      if (String(row.master_password || '').trim() !== currentPassword) {
        resolve({ success: false, msg: '현재 비밀번호가 올바르지 않습니다.' });
        return;
      }
      db.run(
        `UPDATE master_config SET master_password = ? WHERE id = 1`,
        [normalized.password],
        (updErr) => {
          if (updErr) {
            logDbErr(updErr);
            resolve({ success: false, msg: '비밀번호 변경에 실패했습니다.' });
            return;
          }
          writeToLogFile('info', '[마스터] 비밀번호 변경됨');
          resolve({ success: true });
        }
      );
    });
  });
});

/** 작성 권한자: 본인 비밀번호 변경 (현재 비밀번호 확인) */
ipcMain.handle('change-notice-operator-password', async (event, payload) => {
  if (!noticeOperatorSessionActive) {
    return { success: false, msg: '작성 권한자로 로그인한 뒤 변경할 수 있습니다.' };
  }
  const username = String((payload && payload.username) || noticeOperatorUsernameSession || '').trim();
  if (!username || username !== noticeOperatorUsernameSession) {
    return { success: false, msg: '본인 계정만 비밀번호를 변경할 수 있습니다.' };
  }
  const currentPassword = String((payload && payload.currentPassword) || '');
  const normalized = normalizeNewPassword(payload && payload.newPassword);
  if (!normalized.ok) return { success: false, msg: normalized.msg };
  const currentHash = hashPassword(currentPassword);
  const newHash = hashPassword(normalized.password);
  if (currentHash === newHash) {
    return { success: false, msg: '새 비밀번호는 현재 비밀번호와 달라야 합니다.' };
  }
  return new Promise((resolve) => {
    db.get(`SELECT * FROM notice_operators WHERE username = ?`, [username], (err, row) => {
      if (err || !row) {
        resolve({ success: false, msg: '계정을 찾을 수 없습니다.' });
        return;
      }
      if (row.password_hash !== currentHash) {
        resolve({ success: false, msg: '현재 비밀번호가 올바르지 않습니다.' });
        return;
      }
      db.run(
        `UPDATE notice_operators SET password_hash = ? WHERE username = ?`,
        [newHash, username],
        (updErr) => {
          if (updErr) {
            logDbErr(updErr);
            resolve({ success: false, msg: '비밀번호 변경에 실패했습니다.' });
            return;
          }
          broadcastToOnlinePeers({
            type: 'OPERATOR_ADD',
            operator: {
              username: row.username,
              password_hash: newHash,
              display_name: row.display_name,
              added_at: row.added_at,
              can_manage_duty: row.can_manage_duty
            }
          });
          if (mainWindow) safeWebContentsSend('notice-operators-update');
          writeToLogFile('info', `[작성권한] ${username} 비밀번호 변경됨`);
          resolve({ success: true });
        }
      );
    });
  });
});

/** 마스터: 작성 권한자 비밀번호 재설정 (분실 시) */
ipcMain.handle('reset-notice-operator-password', async (event, payload) => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  }
  const username = String((payload && payload.username) || '').trim();
  if (!username) return { success: false, msg: '아이디가 없습니다.' };
  const normalized = normalizeNewPassword(payload && payload.newPassword);
  if (!normalized.ok) return { success: false, msg: normalized.msg };
  const newHash = hashPassword(normalized.password);
  return new Promise((resolve) => {
    db.get(`SELECT * FROM notice_operators WHERE username = ?`, [username], (err, row) => {
      if (err || !row) {
        resolve({ success: false, msg: '계정을 찾을 수 없습니다.' });
        return;
      }
      db.run(
        `UPDATE notice_operators SET password_hash = ? WHERE username = ?`,
        [newHash, username],
        (updErr) => {
          if (updErr) {
            logDbErr(updErr);
            resolve({ success: false, msg: '비밀번호 재설정에 실패했습니다.' });
            return;
          }
          broadcastToOnlinePeers({
            type: 'OPERATOR_ADD',
            operator: {
              username: row.username,
              password_hash: newHash,
              display_name: row.display_name,
              added_at: row.added_at,
              can_manage_duty: row.can_manage_duty
            }
          });
          if (mainWindow) safeWebContentsSend('notice-operators-update');
          writeToLogFile('info', `[마스터] 작성권한 ${username} 비밀번호 재설정`);
          resolve({ success: true, displayName: row.display_name || username });
        }
      );
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
  const rand = Math.floor(Math.random() * 1e12).toString(36);
  const salt = Math.floor(Math.random() * 1e6).toString(36);
  return `${MY_IP || 'ip'}_${Date.now()}_${rand}_${salt}`;
}

function generateMsgUid() {
  return `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

ipcMain.handle('get-notices', async () => {
  return new Promise((resolve) => {
    ensureNoticesTableSchema(() => {
      db.all(`SELECT * FROM notices ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) {
          console.error('get-notices 실패:', err.message);
          noticesSchemaReady = false;
          ensureNoticesTableSchema(() => {
            db.all(`SELECT uid, title, content, author_name, author_ip, created_at, images, category FROM notices ORDER BY created_at DESC`, [], (err2, rows2) => {
              if (err2) {
                db.all(`SELECT uid, title, content, author_name, author_ip, created_at FROM notices ORDER BY created_at DESC`, [], (err3, rows3) => {
                  if (err3) {
                    resolve([]);
                    return;
                  }
                  resolve((rows3 || []).map((r) => mapNoticeRowForListIpc({ ...r, images: '[]' })));
                });
                return;
              }
              resolve((rows2 || []).map((r) => mapNoticeRowForListIpc(r)));
            });
          });
          return;
        }
        resolve((rows || []).map((r) => mapNoticeRowForListIpc(r)));
      });
    });
  });
});

ipcMain.handle('get-notice', async (event, uid) => {
  const key = String(uid || '').trim();
  if (!key) return null;
  return new Promise((resolve) => {
    ensureNoticesTableSchema(() => {
      db.get(`SELECT * FROM notices WHERE uid = ?`, [key], (err, row) => {
        if (err || !row) {
          resolve(null);
          return;
        }
        resolve({
          ...row,
          category: normalizeNoticeCategory(row.category),
          images: row.images || '[]',
          hasImages: !!(row.images && String(row.images).length > 8 && String(row.images) !== '[]')
        });
      });
    });
  });
});

ipcMain.handle('add-notice', async (event, { title, content, authorName, images, category }) => {
  if (!masterSessionActive && !noticeOperatorSessionActive) {
    return { success: false, msg: '공지 작성 권한이 없습니다. 작성자 로그인 후 다시 시도해 주세요.' };
  }
  return new Promise((resolve) => {
    const fallbackAuthor = displayNameFromParts(myProfile.rank, myProfile.username, '관리자') || '관리자';
    const record = {
      uid: generateNoticeUid(),
      title,
      content,
      author_name: (authorName && String(authorName).trim()) || fallbackAuthor,
      author_ip: MY_IP,
      created_at: new Date().toISOString(),
      images,
      category
    };
    clearNoticeTombstone(record.uid, () => {
      insertNoticeRecord(record, (err, saved) => {
        if (err) {
          console.error('공지사항 저장 실패:', err.message);
          const msg = userFacingDbError(err);
          if (isSqliteCorruptError(err)) scheduleDbCorruptRecovery('add-notice');
          resolve({ success: false, error: msg, msg, corrupt: isSqliteCorruptError(err) });
          return;
        }
        // UI는 즉시 응답 — 동료 PC 전파는 다음 틱에 (다수 접속 시 딜레이 방지)
        notifyNoticesChanged();
        resolve({ success: true, notice: saved });
        setImmediate(() => {
          try { broadcastNoticeWire('NOTICE_ADD', saved); } catch (e) {
            console.error('공지 전파 실패:', e && e.message);
          }
        });
      });
    });
  });
});

ipcMain.handle('update-notice', async (event, { uid, title, content, images, category }) => {
  const allowed = await noticeModifyAllowed(uid);
  if (!allowed) {
    return { success: false, msg: '본인이 작성한 공지만 수정할 수 있습니다. (마스터는 전체 가능)' };
  }
  return new Promise((resolve) => {
    const imagesJson = normalizeNoticeImagesField(images);
    const categoryNorm = normalizeNoticeCategory(category);
    ensureNoticesCategoryColumn(() => {
      db.run(
        `UPDATE notices SET title = ?, content = ?, images = ?, category = ? WHERE uid = ?`,
        [title, content, imagesJson, categoryNorm, uid],
        (err) => {
          if (err && isSqliteCorruptError(err)) {
            scheduleDbCorruptRecovery('update-notice');
            resolve({ success: false, msg: DB_CORRUPT_USER_MSG, corrupt: true });
            return;
          }
          if (err && /no column.*category|category/i.test(String(err.message || ''))) {
            db.run(
              `UPDATE notices SET title = ?, content = ?, images = ? WHERE uid = ?`,
              [title, content, imagesJson, uid],
              (err2) => {
                if (err2 && isSqliteCorruptError(err2)) {
                  scheduleDbCorruptRecovery('update-notice');
                  resolve({ success: false, msg: DB_CORRUPT_USER_MSG, corrupt: true });
                  return;
                }
                if (!err2) notifyNoticesChanged();
                resolve({ success: !err2, msg: err2 ? userFacingDbError(err2) : undefined });
                if (!err2) {
                  setImmediate(() => broadcastNoticeWire('NOTICE_UPDATE', { uid, title, content, images: imagesJson, category: categoryNorm }));
                }
              }
            );
            return;
          }
          if (!err) notifyNoticesChanged();
          resolve({ success: !err, msg: err ? userFacingDbError(err) : undefined });
          if (!err) {
            setImmediate(() => broadcastNoticeWire('NOTICE_UPDATE', { uid, title, content, images: imagesJson, category: categoryNorm }));
          }
        }
      );
    });
  });
});

ipcMain.handle('delete-notice', async (event, uid) => {
  const allowed = await noticeModifyAllowed(uid);
  if (!allowed) {
    return { success: false, msg: '본인이 작성한 공지만 삭제할 수 있습니다. (마스터는 전체 가능)' };
  }
  return new Promise((resolve) => {
    applyLocalNoticeDelete(uid, {
      notify: true,
      done: (err) => {
        if (!err) broadcastToOnlinePeers({ type: 'NOTICE_DELETE', uid: String(uid) });
        resolve({ success: !err, msg: err ? (err.message || '삭제 실패') : undefined });
      }
    });
  });
});

ipcMain.handle('get-notice-operators', async () => {
  if (!masterSessionActive) return [];
  return new Promise((resolve) => {
    db.all(`SELECT username, display_name, added_at, COALESCE(can_manage_duty, 0) AS can_manage_duty FROM notice_operators ORDER BY added_at DESC`, [], (err, rows) => {
      const cleaned = (rows || []).map((row) => {
        const raw = String(row.display_name || '');
        const repaired = tryRepairMojibakeText(raw);
        const hangul = (t) => (String(t).match(/[\uAC00-\uD7A3]/g) || []).length;
        // 복구에 성공하면 로컬 DB에만 반영 (비밀번호 없는 불완전 sync 방지). 이후 NOTICE_SYNC로 전파.
        if (repaired && repaired !== raw && !repaired.includes('\uFFFD') && hangul(repaired) > hangul(raw)) {
          db.run(`UPDATE notice_operators SET display_name = ? WHERE username = ?`, [repaired, row.username], logDbErr);
          return { ...row, display_name: repaired };
        }
        return { ...row, display_name: scrubBrokenDisplayChars(raw) };
      });
      resolve(cleaned);
    });
  });
});

ipcMain.handle('update-notice-operator-display-name', async (event, { username, displayName }) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 인증이 필요합니다.' };
  const user = String(username || '').trim();
  const name = scrubBrokenDisplayChars(displayName);
  if (!user) return { success: false, msg: '아이디가 없습니다.' };
  if (!name) return { success: false, msg: '표시 이름을 입력해 주세요.' };
  return new Promise((resolve) => {
    db.get(`SELECT * FROM notice_operators WHERE username = ?`, [user], (err, row) => {
      if (err || !row) {
        resolve({ success: false, msg: '계정을 찾을 수 없습니다.' });
        return;
      }
      db.run(
        `UPDATE notice_operators SET display_name = ? WHERE username = ?`,
        [name, user],
        (updErr) => {
          if (!updErr) {
            broadcastToOnlinePeers({
              type: 'OPERATOR_ADD',
              operator: {
                username: row.username,
                password_hash: row.password_hash,
                display_name: name,
                added_at: row.added_at,
                can_manage_duty: row.can_manage_duty
              }
            });
            if (mainWindow) safeWebContentsSend('notice-operators-update');
          }
          resolve({ success: !updErr });
        }
      );
    });
  });
});

ipcMain.handle('add-notice-operator', async (event, { username, password, displayName, canManageDuty }) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 인증이 필요합니다.' };
  return new Promise((resolve) => {
    const added_at = new Date().toISOString();
    const password_hash = hashPassword(password);
    // 미지정·true → 당직·OFF 포함 (작성 권한자 기본)
    const dutyFlag = (canManageDuty === false || canManageDuty === 0 || canManageDuty === '0') ? 0 : 1;
    const cleanDisplayName = scrubBrokenDisplayChars(displayName);
    db.run(
      `INSERT OR REPLACE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty) VALUES (?, ?, ?, ?, ?)`,
      [username, password_hash, cleanDisplayName, added_at, dutyFlag],
      (err) => {
        if (!err) {
          broadcastToOnlinePeers({
            type: 'OPERATOR_ADD',
            operator: { username, password_hash, display_name: cleanDisplayName, added_at, can_manage_duty: dutyFlag }
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
  if (!masterSessionActive) return { success: false, msg: '마스터 인증이 필요합니다.' };
  return new Promise((resolve) => {
    db.run(`DELETE FROM notice_operators WHERE username = ?`, [username], (err) => {
      if (!err) broadcastToOnlinePeers({ type: 'OPERATOR_DELETE', username });
      resolve({ success: !err });
    });
  });
});

ipcMain.handle('notice-operator-login', async (event, { username, password }) => {
  return new Promise((resolve) => {
    const user = String(username || '').trim();
    db.get(`SELECT * FROM notice_operators WHERE username = ?`, [user], (err, row) => {
      if (!row || row.password_hash !== hashPassword(password)) {
        resolve({ success: false, msg: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        return;
      }
      // 작성 권한자 로그인 — 당직·OFF는 DB 플래그 존중
      noticeOperatorSessionActive = true;
      noticeOperatorCanManageDutySession = !!(row.can_manage_duty);
      noticeOperatorDisplayNameSession = String(row.display_name || '').trim();
      noticeOperatorUsernameSession = user;
      resolve({
        success: true,
        displayName: row.display_name,
        username: user,
        canManageDuty: !!(row.can_manage_duty)
      });
    });
  });
});

// 메시지 고정(pin) 기능은 반복되는 chat_pins 스키마 손상(1.0.527/528/564/565에서
// 계속 재발)의 근본 원인을 못 찾아, 설치 대수가 적은 점을 고려해 기능 자체를
// 제거했다. 렌더러가 혹시 옛 코드로 이 채널을 호출해도 조용히 빈 값을 반환한다.
ipcMain.handle('get-chat-pin', async () => null);
ipcMain.handle('set-chat-pin', async () => ({ success: false, msg: '메시지 고정 기능은 더 이상 지원하지 않습니다.' }));
ipcMain.handle('clear-chat-pin', async () => ({ success: true }));

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
  // 마스터 또는 작성 권한자 세션이면 당직·OFF 저장 가능
  if (!masterSessionActive && !noticeOperatorSessionActive) {
    return { success: false, msg: '마스터 또는 작성 권한자 계정으로 로그인한 뒤 저장할 수 있습니다.' };
  }
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
        // [] 대신 null → 렌더러가 기존 hospitalSchedules를 유지하도록
        resolve(null);
        return;
      }
      const list = rows || [];
      // tombstone과 불일치로 남은 행이 있으면 목록에서 제외·정리
      const visible = [];
      list.forEach((r) => {
        if (!r || !r.uid) return;
        if (scheduleTombstoneMemory.has(String(r.uid))) {
          db.run(`DELETE FROM hospital_schedules WHERE uid = ?`, [String(r.uid)], logDbErr);
          return;
        }
        visible.push(r);
      });
      resolve(visible);
    });
  });
});

const SCHEDULE_EXCEL_HEADERS = ['RM', '병동', '호실', '환자명', '구분', '목적', '비고', '출발시간', '귀원시간', '등록자'];

function buildScheduleCsvContent(rows, headers) {
  const hdrs = (Array.isArray(headers) && headers.length) ? headers : SCHEDULE_EXCEL_HEADERS;
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [hdrs.join(',')];
  (rows || []).forEach((r) => {
    lines.push(hdrs.map((h) => esc(r[h])).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

ipcMain.handle('export-schedule-board-excel', async (event, payload) => {
  const { dateFileLabel, sheets, boardDate, includeSampleSheets, headers: payloadHeaders } = payload || {};
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return { success: false, msg: '내보낼 일정이 없습니다.' };
  }
  const excelHeaders = (Array.isArray(payloadHeaders) && payloadHeaders.length)
    ? payloadHeaders
    : SCHEDULE_EXCEL_HEADERS;
  const label = (dateFileLabel || 'export').replace(/[^\d가-힣_-]/g, '') || 'export';
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
      await fs.promises.writeFile(filePath, buildScheduleCsvContent(allRows, excelHeaders), 'utf8');
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
    const buf = buildXlsxBuffer(sheets, excelHeaders, {
      boardDate: boardDate || '',
      includeSampleSheets: includeSampleSheets === true
    });
    await fs.promises.writeFile(outPath, buf);
    return { success: true, path: outPath, format: 'xlsx' };
  } catch (err) {
    return { success: false, msg: err.message || String(err) };
  }
});

ipcMain.handle('set-notice-operator-session', async (event, active, canManageDuty, meta) => {
  if (!active) {
    noticeOperatorSessionActive = false;
    noticeOperatorCanManageDutySession = false;
    noticeOperatorDisplayNameSession = '';
    noticeOperatorUsernameSession = '';
    return { success: true };
  }
  // 자동 로그인 복원: 계정이 DB에 있을 때만 세션 허용 (임의 권한 부여 방지)
  const m = (meta && typeof meta === 'object') ? meta : {};
  const user = String(m.username || '').trim();
  if (!user) {
    return { success: false, msg: '작성 권한자 정보가 없습니다.' };
  }
  return new Promise((resolve) => {
    db.get(`SELECT username, display_name, COALESCE(can_manage_duty, 0) AS can_manage_duty FROM notice_operators WHERE username = ?`, [user], (err, row) => {
      if (err || !row) {
        noticeOperatorSessionActive = false;
        noticeOperatorCanManageDutySession = false;
        noticeOperatorDisplayNameSession = '';
        noticeOperatorUsernameSession = '';
        resolve({ success: false, msg: '작성 권한자 계정을 찾을 수 없습니다.' });
        return;
      }
      noticeOperatorSessionActive = true;
      const duty = (canManageDuty === false || canManageDuty === 0 || canManageDuty === '0')
        ? false
        : !!(row.can_manage_duty);
      noticeOperatorCanManageDutySession = duty;
      noticeOperatorDisplayNameSession = String(m.displayName || m.display_name || row.display_name || '').trim();
      noticeOperatorUsernameSession = user;
      resolve({ success: true, canManageDuty: duty });
    });
  });
});

function isAuthorOfRecord(row) {
  if (!row) return false;
  const authorIp = String(row.author_ip || '').trim();
  const authorName = String(row.author_name || '').trim();
  const uid = String(row.uid || '').trim();
  if (authorIp && authorIp === MY_IP) return true;
  if (uid && uid.startsWith(`${MY_IP}_`)) return true;
  if (authorName && myProfile && myProfile.username && authorName === String(myProfile.username).trim()) return true;
  if (authorName && noticeOperatorDisplayNameSession && authorName === noticeOperatorDisplayNameSession) return true;
  if (authorName && noticeOperatorUsernameSession && authorName === noticeOperatorUsernameSession) return true;
  return false;
}

/** 마스터는 전체, 작성 권한자는 본인 작성분만 수정·삭제 */
function scheduleModifyAllowed(uid) {
  return new Promise((resolve) => {
    if (masterSessionActive) {
      resolve(true);
      return;
    }
    if (!noticeOperatorSessionActive) {
      resolve(false);
      return;
    }
    db.get(`SELECT uid, author_ip, author_name FROM hospital_schedules WHERE uid = ?`, [uid], (err, row) => {
      if (err || !row) {
        resolve(false);
        return;
      }
      resolve(isAuthorOfRecord(row));
    });
  });
}

function noticeModifyAllowed(uid) {
  return new Promise((resolve) => {
    if (masterSessionActive) {
      resolve(true);
      return;
    }
    if (!noticeOperatorSessionActive) {
      resolve(false);
      return;
    }
    db.get(`SELECT uid, author_ip, author_name FROM notices WHERE uid = ?`, [uid], (err, row) => {
      if (err || !row) {
        resolve(false);
        return;
      }
      resolve(isAuthorOfRecord(row));
    });
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
    const authorName = String(
      p.authorName ||
      noticeOperatorDisplayNameSession ||
      (myProfile && myProfile.username) ||
      ''
    ).trim() || (myProfile && myProfile.username) || '';
    const record = {
      uid: `${MY_IP}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: p.type,
      title: p.title,
      time_str: p.timeStr,
      author_name: authorName,
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
    return { success: false, msg: '본인이 작성한 일정만 삭제할 수 있습니다. (마스터는 전체 가능)' };
  }
  if (!uid) return { success: false, msg: '일정 ID가 없습니다.' };
  return new Promise((resolve) => {
    applyLocalScheduleDelete(uid, {
      notify: true,
      done: (err) => {
        if (!err) {
          broadcastToOnlinePeers({ type: 'SCHEDULE_DELETE', uid: String(uid) });
        }
        resolve(err ? { success: false, msg: err.message || '삭제 실패' } : { success: true });
      }
    });
  });
});

ipcMain.handle('edit-schedule', async (event, payload) => {
  const p = payload || {};
  const uid = p.uid;
  if (!uid) return { success: false, msg: '일정 ID가 없습니다.' };
  const allowed = await scheduleModifyAllowed(uid);
  if (!allowed) {
    return { success: false, msg: '본인이 작성한 일정만 수정할 수 있습니다. (마스터는 전체 가능)' };
  }
  return new Promise((resolve) => {
    isScheduleTombstoned(uid, (tombstoned) => {
      if (tombstoned) {
        resolve({ success: false, msg: '이미 삭제된 일정입니다.' });
        return;
      }
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
        function onEditSchedule(err) {
          if (err) {
            resolve({ success: false, msg: err.message || '수정 실패' });
            return;
          }
          if (this.changes === 0) {
            resolve({ success: false, msg: '일정을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.' });
            return;
          }
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
          resolve({ success: true });
        }
      );
    });
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
  if (isMessengerUsageBlocked()) return messengerBlockedResponse();
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

function handleIncomingMessageEdit(payload, senderIP) {
  if (!payload || !payload.msgUid || !senderIP) return;
  // 보낸 사람 IP와 일치하는 메시지만 수정 — LAN 스푸핑 방지
  db.run(
    `UPDATE messages SET message = ? WHERE msg_uid = ? AND sender_ip = ?`,
    [payload.newMessage, payload.msgUid, senderIP],
    function onEdit(err) {
      if (err) {
        logDbErr(err);
        return;
      }
      if (!this || !this.changes) return;
      if (mainWindow) {
        safeWebContentsSend('message-edited', { msgUid: payload.msgUid, newMessage: payload.newMessage });
      }
    }
  );
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

ipcMain.handle('get-install-path-info', async () => getInstallPathInfo());

ipcMain.handle('mirror-update-to-z-bridge', async () => {
  try {
    const res = await mirrorLocalInstallToZBridge({ force: true, timeoutMs: 15000 });
    if (res && res.mirrored) {
      return {
        success: true,
        version: res.version,
        path: Z_BRIDGE_UPDATE_SOURCE_PATH,
        copied: (res.copied || []).length
      };
    }
    return {
      success: false,
      msg: (res && res.reason) || 'Z 브리지에 공유하지 못했습니다.',
      path: Z_BRIDGE_UPDATE_SOURCE_PATH
    };
  } catch (e) {
    return { success: false, msg: String(e.message || e), path: Z_BRIDGE_UPDATE_SOURCE_PATH };
  }
});

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

function normalizeUpdateMode(mode) {
  return String(mode || '').toLowerCase() === 'manual' ? 'manual' : 'auto';
}

function persistUpdateMode(mode) {
  updateMode = normalizeUpdateMode(mode);
  db.run(`UPDATE app_settings SET update_mode = ? WHERE id = 1`, [updateMode], logDbErr);
  return updateMode;
}

ipcMain.handle('get-update-mode', async () => updateMode === 'manual' ? 'manual' : 'auto');

ipcMain.handle('set-update-mode', async (event, mode) => {
  const next = persistUpdateMode(mode);
  return { success: true, mode: next };
});

ipcMain.handle('check-for-update', async () => {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  if (!updateSourcePath) return { available: false, msg: '업데이트 소스가 아직 설정되지 않았습니다.' };
  try {
    // Z 브리지가 구버전이어도 GitHub에 새 버전이 있으면 그걸 최신으로 안내
    const best = await findNewestUpdateCandidate();
    if (!best) {
      return { available: false, msg: '업데이트 소스에서 version.json을 찾을 수 없습니다. 경로(Z:\\...\\messenger) 또는 GitHub 연결을 확인해 주세요.' };
    }
    const available = compareVersions(best.version, APP_VERSION) > 0;
    pendingUpdateFetchPath = available ? best.sourcePath : '';
    return {
      available,
      remoteVersion: best.version,
      currentVersion: APP_VERSION,
      notes: best.notes || '',
      sourceKind: best.kind,
      sourcePath: best.sourcePath
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

async function applyUpdateFiles(opts = {}) {
  // soft(자동업데이트): 실행 중 in-place/대용량/Z미러를 피해 '응답 없음' 완화
  const soft = !!(opts && opts.soft);
  const filesToUpdate = [
    'main.js',
    'preload.js',
    'index.html',
    'package.json',
    'version.json',
    'toast.html',
    'toast-preload.js',
    'lib/minimal-xlsx.js',
    'excalidraw-editor.html',
    'preload-excalidraw.js',
    'mobile_server.js'
  ];
  if (!soft) {
    filesToUpdate.push('lib/excalidraw-app.js', 'lib/excalidraw-app.css');
  }
  const FONT_ASSETS = [
    'assets/fonts/mirae-fonts.css',
    'assets/fonts/Eulyoo1945-Regular.woff2',
    'assets/fonts/Eulyoo1945-SemiBold.woff2',
    'assets/fonts/MaruBuri-Regular.woff2',
    'assets/fonts/MaruBuri-SemiBold.woff2',
    'assets/fonts/Pretendard-Bold.woff2',
    'assets/fonts/Pretendard-Regular.woff2',
    'assets/fonts/RIDIBatang.woff',
    'assets/fonts/SUIT-Bold.woff2',
    'assets/fonts/SUIT-Medium.woff2',
    'assets/fonts/SUIT-Regular.woff2'
  ];
  const optionalAssets = soft ? [...FONT_ASSETS] : ['assets/splash.png', 'vendor/excalidraw/asset-list.json', ...FONT_ASSETS];
  if (!soft) {
    try {
      const remoteListBuf = await readUpdateSourceBytes('vendor/excalidraw/asset-list.json');
      const remoteList = parseUpdateJsonText(remoteListBuf.toString('utf8'));
      const remoteFiles = Array.isArray(remoteList && remoteList.files) ? remoteList.files : [];
      for (const f of remoteFiles) {
        const rel = `vendor/excalidraw/${String(f || '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
        if (rel && rel !== 'vendor/excalidraw/asset-list.json') optionalAssets.push(rel);
      }
    } catch (e) { /* optional fonts/locales */ }
  }
  const backupDir = soft ? '' : path.join(app.getPath('userData'), `pre_update_backup_${Date.now()}`);
  if (backupDir) await fs.promises.mkdir(backupDir, { recursive: true });
  const fileResults = [];
  let expectedVersion = null;

  const LARGE_INPLACE_BYTES = 512 * 1024; // 실행 중 대용량 덮어쓰기 → Windows '응답 없음'
  const yieldUi = () => new Promise((r) => setImmediate(r));

  for (const f of filesToUpdate) {
    await yieldUi();
    if (soft) await sleepMs(20);
    safeWebContentsSend('app-update-progress', { phase: 'download', file: f });
    let remoteBuf;
    try {
      remoteBuf = await readUpdateSourceBytes(f);
    } catch (e) {
      // mobile_server 등은 구버전에 없을 수 있음 — soft에서는 선택
      if (soft && f === 'mobile_server.js') {
        fileResults.push({ file: f, copied: true, optionalMissing: true });
        continue;
      }
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
    if (backupDir) {
      try {
        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
        await fs.promises.access(localPath);
        await fs.promises.copyFile(localPath, path.join(backupDir, f.replace(/\//g, '_')));
      } catch (e) {}
    }
    try {
      // soft·OneDrive·대용량: 실행 중 in-place 덮어쓰기 금지 → 보류 폴더 후 재시작 적용
      const preferPending = soft || isCloudSyncedInstallPath() || (remoteBuf && remoteBuf.length >= LARGE_INPLACE_BYTES);
      if (preferPending) {
        await stagePendingUpdateBuffer(f, remoteBuf);
        fileResults.push({ file: f, copied: true, pendingRestart: true });
        console.warn(`[업데이트] ${soft ? 'soft' : (isCloudSyncedInstallPath() ? 'OneDrive' : '대용량')} — ${f} 재시작 후 적용 예약`);
        continue;
      }
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
    await yieldUi();
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
      if (backupDir) {
        try {
          await fs.promises.access(localPath);
          await fs.promises.copyFile(localPath, path.join(backupDir, rel.replace(/\//g, '_')));
        } catch (e) {}
      }
      if (isCloudSyncedInstallPath() || (remoteBuf && remoteBuf.length >= LARGE_INPLACE_BYTES)) {
        await stagePendingUpdateBuffer(rel, remoteBuf);
        fileResults.push({ file: rel, copied: true, pendingRestart: true });
        continue;
      }
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
  const requiredResults = fileResults.filter((r) => filesToUpdate.includes(r.file) && !r.optionalMissing);
  // (예외 없이 끝났다고 해서 실제로 반영됐다는 보장은 없다 — 파일 잠금 등으로 조용히 실패할 수 있다.)
  let verifiedVersion = null;
  const anyPending = requiredResults.some((r) => r.pendingRestart);
  try {
    if (anyPending) {
      // 보류만 된 경우 — 설치 폴더 package.json은 아직 구버전일 수 있음
      verifiedVersion = expectedVersion || APP_VERSION;
    } else {
      const localPkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'package.json'), 'utf8'));
      verifiedVersion = localPkg.version;
    }
  } catch (e) {}

  const allCopied = requiredResults.every(r => r.copied);
  const versionMatches = !expectedVersion || verifiedVersion === expectedVersion || anyPending;
  if (!allCopied || !versionMatches) {
    const failedFiles = fileResults.filter(r => !r.copied && filesToUpdate.includes(r.file) && !r.optionalMissing).map(r => `${r.file}(${r.reason})`).join(', ');
    console.error('[업데이트] 검증 실패 — 예상 버전:', expectedVersion, '/ 실제 버전:', verifiedVersion, '/ 실패한 파일:', failedFiles || '없음');
    throw new Error(
      !versionMatches
        ? `파일은 복사됐지만 버전이 반영되지 않았습니다 (예상 ${expectedVersion}, 실제 ${verifiedVersion}). 프로그램이 설치된 폴더의 쓰기 권한을 확인해 주세요.`
        : `다음 파일을 복사하지 못했습니다: ${failedFiles} (쓰기 권한을 확인해 주세요)`
    );
  }

  // soft(자동)에서는 Z 드라이브 미러를 하지 않음 — 공유폴더 hang이 '응답 없음'의 흔한 원인
  if (soft) return;

  // GitHub에서 받은 최신본을 Z 브리지에도 공유 (Z 연결된 PC만, 실패·타임아웃해도 업데이트는 성공)
  try {
    if (!isCloudSyncedInstallPath()) {
      const zRes = await mirrorLocalInstallToZBridge({ force: true, timeoutMs: 10000 });
      if (zRes && zRes.mirrored) {
        console.log('[업데이트] Z 브리지 미러 완료:', zRes.version);
      } else if (zRes && zRes.reason && zRes.reason !== 'already-latest') {
        console.warn('[업데이트] Z 브리지 미러 생략:', zRes.reason);
      }
    }
  } catch (e) {
    console.warn('[업데이트] Z 브리지 미러 오류:', e.message || e);
  }
}

ipcMain.handle('apply-update', async () => {
  if (updateApplyInFlight) return { success: false, msg: '업데이트가 이미 진행 중입니다.' };
  updateApplyInFlight = true;
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  if (!updateSourcePath) {
    updateApplyInFlight = false;
    return { success: false, msg: '업데이트 소스가 설정되지 않았습니다.' };
  }
  const prevSource = updateSourcePath;
  try {
    // 확인 단계에서 GitHub가 더 새로웠다면 그 경로에서 받는다
    if (pendingUpdateFetchPath) {
      updateSourcePath = normalizeUpdateSourcePath(pendingUpdateFetchPath);
    } else {
      const best = await findNewestUpdateCandidate();
      if (best && compareVersions(best.version, APP_VERSION) > 0) {
        updateSourcePath = best.sourcePath;
      }
    }
    await applyUpdateFiles();
    pendingUpdateFetchPath = '';
    setTimeout(() => { broadcastGoodbye(); isQuitting = true; app.relaunch(); app.exit(); }, 600);
    return { success: true };
  } catch (e) {
    updateSourcePath = prevSource;
    return { success: false, msg: '업데이트 적용 중 오류가 발생했습니다: ' + e.message + ' (파일 접근 권한을 확인해 주세요)' };
  } finally {
    updateApplyInFlight = false;
  }
});

function verifyLocalMasterPassword(password) {
  return new Promise((resolve) => {
    db.get(`SELECT master_password FROM master_config WHERE id = 1`, (err, row) => {
      resolve(!!(row && String(row.master_password) === String(password || '')));
    });
  });
}

function verifyLocalMasterAuth(id, password) {
  return new Promise((resolve) => {
    db.get(`SELECT master_id, master_password FROM master_config WHERE id = 1`, (err, row) => {
      const currentId = row && row.master_id ? String(row.master_id) : 'admin';
      resolve(!!(row && currentId === String(id || '') && String(row.master_password) === String(password || '')));
    });
  });
}

function persistLocalUsageLock(disabled, meta) {
  const m = meta || {};
  const disabledAt = m.disabledAt || (disabled ? new Date().toISOString() : '');
  const disabledByIp = m.disabledByIp || '';
  const reason = m.reason || '';
  localUsageDisabled = !!disabled;
  localUsageLockMeta = { disabledAt, disabledByIp, reason };
  db.run(
    `INSERT INTO usage_lock (id, disabled, disabled_at, disabled_by_ip, reason) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET disabled = excluded.disabled, disabled_at = excluded.disabled_at,
       disabled_by_ip = excluded.disabled_by_ip, reason = excluded.reason`,
    [disabled ? 1 : 0, disabledAt, disabledByIp, reason],
    logDbErr
  );
}

function persistDisabledClient(ip, meta) {
  const key = String(ip || '').trim();
  if (!key || key === MY_IP) return;
  const m = meta || {};
  const entry = {
    ip: key,
    username: m.username || '',
    disabledAt: m.disabledAt || new Date().toISOString(),
    disabledByIp: m.disabledByIp || MY_IP,
    reason: String(m.reason || '').trim()
  };
  disabledClients.set(key, entry);
  db.run(
    `INSERT INTO disabled_clients (ip, username, disabled_at, disabled_by_ip, reason) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET username = excluded.username, disabled_at = excluded.disabled_at,
       disabled_by_ip = excluded.disabled_by_ip, reason = excluded.reason`,
    [entry.ip, entry.username, entry.disabledAt, entry.disabledByIp, entry.reason],
    logDbErr
  );
}

function removeDisabledClient(ip) {
  const key = String(ip || '').trim();
  if (!key) return;
  disabledClients.delete(key);
  db.run(`DELETE FROM disabled_clients WHERE ip = ?`, [key], logDbErr);
}

function notifyUsageLockState() {
  safeWebContentsSend('usage-lock-state', {
    disabled: localUsageDisabled,
    disabledAt: localUsageLockMeta.disabledAt || '',
    disabledByIp: localUsageLockMeta.disabledByIp || '',
    reason: localUsageLockMeta.reason || '',
    myIp: MY_IP
  });
  notifyUserList();
}

function applyLocalUsageDisabled(disabled, meta) {
  const was = localUsageDisabled;
  persistLocalUsageLock(!!disabled, meta || {});
  if (disabled) {
    try { broadcastGoodbye(); } catch (_) {}
    onlineUsers.delete(MY_IP);
    registerSelf();
  } else if (was) {
    registerSelf();
    if (globalUdpSocket) broadcastPresence(globalUdpSocket);
  }
  notifyUsageLockState();
  writeToLogFile('info', disabled
    ? `[사용중지] 이 PC 메신저 사용이 중지되었습니다. (by ${localUsageLockMeta.disabledByIp || '?'})`
    : '[사용중지] 이 PC 메신저 사용이 다시 허용되었습니다.');
}

function handleUsageLockSync(payload, senderIP) {
  const ip = String((payload && payload.ip) || '').trim();
  if (!ip || ip === MY_IP) return;
  if (payload && payload.disabled) {
    persistDisabledClient(ip, {
      username: (payload && payload.username) || '',
      disabledAt: (payload && payload.disabledAt) || new Date().toISOString(),
      disabledByIp: (payload && payload.fromIp) || senderIP || '',
      reason: (payload && payload.reason) || ''
    });
  } else {
    removeDisabledClient(ip);
  }
  notifyUserList();
  safeWebContentsSend('disabled-clients-updated', { ip, disabled: !!(payload && payload.disabled) });
}

function replyUsageLockResult(senderIP, success, disabled, msg) {
  if (!senderIP || senderIP === MY_IP) return;
  sendToIpDirect(senderIP, {
    type: 'USAGE_LOCK_RESULT',
    success: !!success,
    disabled: !!disabled,
    msg: msg || '',
    fromIp: MY_IP
  });
}

async function handleUsageDisableCommand(payload, senderIP) {
  const ok = await verifyLocalMasterPassword(payload && payload.masterPassword);
  if (!ok) {
    replyUsageLockResult(senderIP, false, localUsageDisabled, '마스터 비밀번호가 올바르지 않습니다(대상 PC 설정과 동일해야 함)');
    return;
  }
  applyLocalUsageDisabled(true, {
    disabledAt: new Date().toISOString(),
    disabledByIp: (payload && payload.fromIp) || senderIP || '',
    reason: String((payload && payload.reason) || '').trim() || '마스터 관리자에 의해 사용 중지'
  });
  replyUsageLockResult(senderIP, true, true, '사용이 중지되었습니다');
}

async function handleUsageEnableCommand(payload, senderIP) {
  const ok = await verifyLocalMasterPassword(payload && payload.masterPassword);
  if (!ok) {
    replyUsageLockResult(senderIP, false, localUsageDisabled, '마스터 비밀번호가 올바르지 않습니다(대상 PC 설정과 동일해야 함)');
    return;
  }
  applyLocalUsageDisabled(false, {});
  replyUsageLockResult(senderIP, true, false, '사용이 허용되었습니다');
}

function usageLockBlockedResponse() {
  const msg = '이 PC의 메신저 사용이 중지된 상태입니다. 마스터 아이디·비밀번호로 해제해 주세요.';
  return { success: false, status: 'ERROR', msg, error: msg };
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

ipcMain.handle('get-usage-lock-state', async () => ({
  disabled: localUsageDisabled,
  disabledAt: localUsageLockMeta.disabledAt || '',
  disabledByIp: localUsageLockMeta.disabledByIp || '',
  reason: localUsageLockMeta.reason || '',
  myIp: MY_IP
}));

ipcMain.handle('get-service-pause-state', async () => getServicePauseState());

ipcMain.handle('set-service-pause', async (event, payload) => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  }
  const p = payload || {};
  const enabled = !!p.enabled;
  const nextRev = Number(servicePause.revision || 0) + 1;
  applyServicePauseConfig({
    enabled,
    title: p.title != null ? p.title : servicePause.title,
    body: p.body != null ? p.body : servicePause.body,
    contact: p.contact != null ? p.contact : servicePause.contact,
    untilLabel: p.untilLabel != null ? p.untilLabel : servicePause.untilLabel,
    updatedAt: new Date().toISOString(),
    revision: nextRev
  }, {
    // 켠 관리자 PC는 계속 조작할 수 있도록 자동 우회
    setBypass: true,
    forcePresence: true
  });
  broadcastToOnlinePeers(buildServicePauseSyncPayload());
  writeToLogFile('info', enabled
    ? `[서비스일시중지] 마스터가 전체 일시 중지를 켰습니다. (rev ${nextRev})`
    : `[서비스일시중지] 마스터가 전체 일시 중지를 껐습니다. (rev ${nextRev})`);
  return { success: true, state: getServicePauseState() };
});

ipcMain.handle('unlock-service-pause', async (event, payload) => {
  const p = payload || {};
  if (!servicePause.enabled) {
    servicePauseBypassRevision = 0;
    persistServicePauseState();
    notifyServicePauseState();
    return { success: true, locked: false, msg: '일시 중지가 꺼져 있습니다.' };
  }
  const ok = await verifyLocalMasterAuth(p.id, p.password);
  if (!ok) {
    return { success: false, msg: '마스터 아이디 또는 비밀번호가 올바르지 않습니다.' };
  }
  masterSessionActive = true;
  servicePauseBypassRevision = Number(servicePause.revision || 0);
  persistServicePauseBypass();
  applyServicePausePresenceSideEffects();
  notifyServicePauseState();
  writeToLogFile('info', '[서비스일시중지] 마스터 인증으로 이 PC 일시 중지를 해제했습니다.');
  return { success: true, locked: false };
});

ipcMain.handle('get-disabled-clients', async () => {
  if (!masterSessionActive) return [];
  return Array.from(disabledClients.values());
});

ipcMain.handle('unlock-usage-with-master', async (event, payload) => {
  const p = payload || {};
  const ok = await verifyLocalMasterAuth(p.id, p.password);
  if (!ok) {
    return { success: false, msg: '마스터 아이디 또는 비밀번호가 올바르지 않습니다.' };
  }
  applyLocalUsageDisabled(false, {});
  removeDisabledClient(MY_IP);
  broadcastToOnlinePeers({
    type: 'USAGE_LOCK_SYNC',
    ip: MY_IP,
    disabled: false,
    username: myProfile.username || '',
    fromIp: MY_IP
  });
  masterSessionActive = true;
  return { success: true };
});

ipcMain.handle('master-set-client-usage', async (event, payload) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  const p = payload || {};
  const password = String(p.password || '');
  if (!(await verifyLocalMasterPassword(password))) {
    return { success: false, msg: '마스터 비밀번호가 올바르지 않습니다.' };
  }
  const targetIp = String(p.targetIp || '').trim();
  const disabled = !!p.disabled;
  if (!targetIp) return { success: false, msg: '대상 IP가 없습니다.' };

  const known = allKnownUsers.get(targetIp);
  const username = (known && known.username) || String(p.username || '').trim() || '';
  const reason = disabled
    ? (String(p.reason || '').trim() || '마스터 관리자에 의해 사용 중지')
    : '';
  const lockPayload = {
    type: disabled ? 'USAGE_DISABLE' : 'USAGE_ENABLE',
    masterPassword: password,
    fromIp: MY_IP,
    reason,
    username
  };

  if (targetIp === MY_IP || targetIp === 'SELF') {
    applyLocalUsageDisabled(disabled, {
      disabledAt: new Date().toISOString(),
      disabledByIp: MY_IP,
      reason
    });
    if (disabled) {
      // 자기 자신은 disabled_clients에 넣지 않음 (로컬 usage_lock으로 관리)
    } else {
      removeDisabledClient(MY_IP);
    }
    broadcastToOnlinePeers({
      type: 'USAGE_LOCK_SYNC',
      ip: MY_IP,
      disabled,
      username: myProfile.username || username,
      disabledAt: localUsageLockMeta.disabledAt,
      reason,
      fromIp: MY_IP
    });
    return { success: true, local: true, disabled };
  }

  if (disabled) {
    persistDisabledClient(targetIp, {
      username,
      disabledAt: new Date().toISOString(),
      disabledByIp: MY_IP,
      reason
    });
  } else {
    removeDisabledClient(targetIp);
  }
  notifyUserList();
  broadcastToOnlinePeers({
    type: 'USAGE_LOCK_SYNC',
    ip: targetIp,
    disabled,
    username,
    disabledAt: disabled ? new Date().toISOString() : '',
    reason,
    fromIp: MY_IP
  });

  // 사용 중지된 PC는 온라인 목록에서 빠질 수 있으므로 직접 TCP 시도
  sendToIpDirect(targetIp, lockPayload);
  return { success: true, targetIp, disabled, sent: true };
});

async function autoCheckAndApplyUpdate() {
  updateSourcePath = normalizeUpdateSourcePath(updateSourcePath);
  if (!updateSourcePath || !mainWindow) return;
  if (updateMode === 'manual') return; // 수동 모드: 설정에서 「지금 확인」할 때만 적용
  if (autoUpdateAlreadyApplied) return; // 이미 파일을 갈아끼우고 재시작 대기 중이면 다시 검사하지 않음
  if (updateApplyInFlight) return;
  // 설정이 Z여도 GitHub에 새 버전이 있으면 자동 적용 (Z만 보면 영원히 구버전 "최신"으로 멈춤)
  let remote;
  const prevSource = updateSourcePath;
  try {
    const best = await findNewestUpdateCandidate();
    if (!best || compareVersions(best.version, APP_VERSION) <= 0) return;
    // 자동 적용은 GitHub를 우선 (Z hang 회피). GitHub에 새 버전이 있을 때만.
    // findNewestUpdateCandidate가 이미 GitHub를 조회해 뒀으므로 재조회하지 않고 재사용한다
    // (GitHub API 요청은 회당 2건 — 재조회 시 10분마다 PC당 최대 4건까지 늘어나
    // 비인증 API 시간당 한도를 불필요하게 앞당겨 소진시킬 수 있다).
    const gh = (best.candidates || []).find((c) => c.kind === 'github') || (best.kind === 'github' ? best : null);
    if (!gh || compareVersions(gh.version, APP_VERSION) <= 0) return;
    remote = { version: gh.version, notes: gh.notes || '' };
    pendingUpdateFetchPath = gh.sourcePath;
    updateSourcePath = gh.sourcePath;
  } catch (e) {
    updateSourcePath = prevSource;
    return;
  }

  updateApplyInFlight = true;
  autoUpdateAlreadyApplied = true; // 중복 적용 방지 (실패 시 아래에서 해제)
  try {
    // 진행 UI를 먼저 띄워 '응답 없음'처럼 보이지 않게 한다
    safeWebContentsSend('auto-update-started', {
      remoteVersion: remote.version,
      currentVersion: APP_VERSION,
      notes: remote.notes || ''
    });
    // soft: 핵심 파일만·보류폴더만 (Cursor 배포 직후 자동업데이트 프리즈 완화)
    await applyUpdateFiles({ soft: true });
    // soft 후에도 Z 브리지가 구버전이면 짧게 미러 시도 (다른 PC가 Z만 볼 때 대비)
    try {
      if (!isCloudSyncedInstallPath()) {
        await mirrorLocalInstallToZBridge({ force: true, timeoutMs: 8000 });
      }
    } catch (_) { /* ignore */ }
    pendingUpdateRemoteVersion = remote.version;
    pendingUpdateFetchPath = '';
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
    autoUpdateAlreadyApplied = false;
    updateSourcePath = prevSource;
    // 파일 복사/검증이 실제로 실패한 경우는 화면에도 알려서 "준비됐다고 떴는데 반영이 안 된다"는
    // 혼란이 생기지 않도록 한다.
    safeWebContentsSend('auto-update-failed', { msg: e.message });
  } finally {
    updateApplyInFlight = false;
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

/** 미니모드: 화면 가장자리로 창 스냅 (길게누르기 제외 · PC 배치용) */
ipcMain.handle('snap-compact-window', async (event, edge) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  if (currentViewMode !== 'compact') return { success: false, error: 'not-compact' };
  prepareWindowForBoundsChange();
  const b = mainWindow.getBounds();
  const display = screen.getDisplayMatching(b) || screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const area = display.workArea;
  const width = Math.min(Math.max(b.width, COMPACT_MIN_WIDTH), area.width);
  const height = Math.min(Math.max(b.height, COMPACT_MIN_HEIGHT), area.height);
  const side = String(edge || '').toLowerCase();
  let x = b.x;
  let y = area.y + Math.max(0, Math.round((area.height - height) / 2));
  if (side === 'left') x = area.x + 8;
  else if (side === 'right') x = area.x + area.width - width - 8;
  else if (side === 'top-right') {
    x = area.x + area.width - width - 8;
    y = area.y + 8;
  } else if (side === 'bottom-right') {
    x = area.x + area.width - width - 8;
    y = area.y + area.height - height - 8;
  } else {
    x = area.x + area.width - width - 8;
    y = area.y + area.height - height - 8;
  }
  const bounds = clampBoundsToWorkArea({ x, y, width, height });
  mainWindow.setBounds(bounds);
  return { success: true, bounds };
});

ipcMain.handle('set-compact-size-preset', async (event, preset) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  if (currentViewMode !== 'compact') return { success: false, error: 'not-compact' };
  prepareWindowForBoundsChange();
  const map = {
    narrow: { width: COMPACT_MIN_WIDTH, height: Math.max(COMPACT_MIN_HEIGHT, 560) },
    normal: { width: COMPACT_DEFAULT_WIDTH, height: COMPACT_DEFAULT_HEIGHT },
    wide: { width: Math.max(COMPACT_DEFAULT_WIDTH, 560), height: Math.max(COMPACT_DEFAULT_HEIGHT, 720) }
  };
  const size = map[String(preset || 'normal')] || map.normal;
  const cur = mainWindow.getBounds();
  const bounds = clampBoundsToWorkArea({
    x: cur.x,
    y: cur.y,
    width: size.width,
    height: size.height
  });
  mainWindow.setMinimumSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT);
  mainWindow.setBounds(bounds);
  return { success: true, bounds, preset: String(preset || 'normal') };
});

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

function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes || 0 });
    });
  });
}

async function deleteFilesInDir(dir, predicate) {
  let count = 0;
  try {
    const names = await fs.promises.readdir(dir);
    for (const name of names) {
      if (predicate && !predicate(name)) continue;
      try {
        await fs.promises.unlink(path.join(dir, name));
        count += 1;
      } catch (e) {
        console.error('파일 삭제 오류:', name, e.message);
      }
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error('폴더 읽기 오류:', dir, e.message);
  }
  return count;
}

/** 이 PC에 저장된 대화·채팅 로그·앱 로그·자동 DB 백업을 전부 삭제 (공지·일정·프로필 등은 유지) */
async function performClearAllChatHistory(opts) {
  const o = opts || {};
  const tables = [
    'message_reactions',
    'messages',
    'chat_view_clears',
    'scheduled_messages',
    'channel_read_cursors'
  ];
  const deleted = {};
  for (const table of tables) {
    const r = await dbRunAsync(`DELETE FROM ${table}`);
    deleted[table] = r.changes;
  }
  try {
    await dbRunAsync(`DELETE FROM sqlite_sequence WHERE name IN ('messages','message_reactions','scheduled_messages')`);
  } catch (_) { /* sqlite_sequence 없을 수 있음 */ }

  const chatLogFileCount = await deleteFilesInDir(getChatLogDir(), (name) => name.endsWith('.txt'));
  const appLogFileCount = await deleteFilesInDir(
    getLogsDir(),
    (name) => name.startsWith('messenger_') && (name.endsWith('.log') || name.endsWith('.txt'))
  );
  // 퇴사자 유출 방지: 자동 DB 백업에도 대화가 남아 있을 수 있음
  const backupDir = path.join(app.getPath('userData'), 'backups');
  const backupFileCount = await deleteFilesInDir(
    backupDir,
    (name) => name.startsWith('auto_backup_') && name.endsWith('.db')
  );

  const messageCount = deleted.messages || 0;
  const summary = `메시지 ${messageCount}건, 채팅로그 ${chatLogFileCount}개, 앱로그 ${appLogFileCount}개, 자동백업 ${backupFileCount}개`;
  writeToLogFile('info', `${o.logPrefix || '전체 대화 삭제'} 완료: ${summary}`);
  return {
    success: true,
    messageCount,
    chatLogFileCount,
    appLogFileCount,
    backupFileCount,
    deleted
  };
}

ipcMain.handle('clear-all-chat-history', async () => {
  try {
    const result = await performClearAllChatHistory({ logPrefix: '전체 대화 삭제' });
    safeWebContentsSend('chat-history-wiped', result);
    return result;
  } catch (e) {
    console.error('전체 대화 삭제 오류:', e.message);
    return { success: false, msg: e.message || '대화·로그 삭제에 실패했습니다.' };
  }
});

const pendingWipeDeliverAt = new Map(); // targetIp → last attempt ms
let pendingWipeRetryTimer = null;

function notifyPendingWipesChanged() {
  if (!masterSessionActive) return;
  listPendingRemoteWipes().then((rows) => {
    safeWebContentsSend('pending-remote-wipes-updated', rows);
  }).catch(() => {});
}

function upsertPendingRemoteWipe(row) {
  return new Promise((resolve) => {
    if (!row || !row.target_ip || !row.master_password) {
      resolve(false);
      return;
    }
    db.run(
      `INSERT OR REPLACE INTO pending_remote_wipes (target_ip, master_password, reason, requested_by_ip, requested_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(row.target_ip),
        String(row.master_password),
        String(row.reason || ''),
        String(row.requested_by_ip || MY_IP),
        String(row.requested_at || new Date().toISOString())
      ],
      (err) => {
        if (err) logDbErr(err);
        else notifyPendingWipesChanged();
        resolve(!err);
      }
    );
  });
}

function removePendingRemoteWipe(targetIp) {
  return new Promise((resolve) => {
    const ip = String(targetIp || '').trim();
    if (!ip) {
      resolve(false);
      return;
    }
    db.run(`DELETE FROM pending_remote_wipes WHERE target_ip = ?`, [ip], (err) => {
      if (err) logDbErr(err);
      else {
        pendingWipeDeliverAt.delete(ip);
        notifyPendingWipesChanged();
      }
      resolve(!err);
    });
  });
}

function getPendingRemoteWipe(targetIp) {
  return new Promise((resolve) => {
    const ip = String(targetIp || '').trim();
    if (!ip) {
      resolve(null);
      return;
    }
    db.get(`SELECT * FROM pending_remote_wipes WHERE target_ip = ?`, [ip], (err, row) => {
      if (err) {
        logDbErr(err);
        resolve(null);
        return;
      }
      resolve(row || null);
    });
  });
}

function listPendingRemoteWipes() {
  return new Promise((resolve) => {
    db.all(
      `SELECT target_ip, reason, requested_by_ip, requested_at FROM pending_remote_wipes ORDER BY requested_at DESC`,
      [],
      (err, rows) => {
        if (err) {
          logDbErr(err);
          resolve([]);
          return;
        }
        resolve(rows || []);
      }
    );
  });
}

function tryDeliverPendingWipe(targetIp) {
  const ip = String(targetIp || '').trim();
  if (!ip || ip === MY_IP) return;
  getPendingRemoteWipe(ip).then((row) => {
    if (!row) return;
    const now = Date.now();
    if ((pendingWipeDeliverAt.get(ip) || 0) + 8000 > now) return;
    pendingWipeDeliverAt.set(ip, now);
    writeToLogFile('info', `[원격삭제예약] ${ip} 에 로그 삭제 명령 전달 시도`);
    sendToIpDirect(ip, {
      type: 'WIPE_CHAT_HISTORY',
      masterPassword: row.master_password,
      fromIp: row.requested_by_ip || MY_IP,
      reason: row.reason || '마스터 관리자 원격 로그 삭제(예약)',
      queued: true
    });
  }).catch(() => {});
}

function flushAllPendingWipesForOnlinePeers() {
  listPendingRemoteWipes().then((rows) => {
    (rows || []).forEach((r) => {
      if (r && r.target_ip && onlineUsers.has(r.target_ip)) {
        tryDeliverPendingWipe(r.target_ip);
      }
    });
  }).catch(() => {});
}

function startPendingWipeRetryLoop() {
  if (pendingWipeRetryTimer) return;
  pendingWipeRetryTimer = setInterval(() => {
    flushAllPendingWipesForOnlinePeers();
  }, 20000);
}

function broadcastWipeClaim() {
  broadcastToOnlinePeers({ type: 'WIPE_CLAIM', fromIp: MY_IP });
}

function handleWipeQueueSync(payload, senderIP) {
  const p = payload || {};
  const targetIp = String(p.targetIp || '').trim();
  const password = String(p.masterPassword || '');
  if (!targetIp || !password || targetIp === MY_IP) return;
  // 잘못된 비밀번호로 예약을 덮어쓰면 정당한 삭제가 무력화되므로, 로컬 마스터 비밀번호와 일치할 때만 저장
  verifyLocalMasterPassword(password).then((ok) => {
    if (!ok) {
      writeToLogFile('warn', `[원격삭제예약] ${senderIP || '?'} 의 WIPE_QUEUE_SYNC 거부(비밀번호 불일치) target=${targetIp}`);
      return;
    }
    upsertPendingRemoteWipe({
      target_ip: targetIp,
      master_password: password,
      reason: p.reason || '',
      requested_by_ip: p.fromIp || senderIP || '',
      requested_at: p.requestedAt || new Date().toISOString()
    }).then(() => {
      if (onlineUsers.has(targetIp)) tryDeliverPendingWipe(targetIp);
    });
  }).catch(() => {});
}

function handleWipeQueueClear(payload, senderIP) {
  const targetIp = String((payload && payload.targetIp) || '').trim();
  if (!targetIp) return;
  const fromIp = String((payload && payload.fromIp) || senderIP || '').trim();
  getPendingRemoteWipe(targetIp).then((row) => {
    if (!row) return;
    const requester = String(row.requested_by_ip || '');
    // 요청자·대상 PC·발신 IP가 일치할 때만 취소 (임의 PC의 예약 취소 방지)
    const allowed = fromIp === targetIp
      || senderIP === targetIp
      || (requester && (fromIp === requester || senderIP === requester));
    if (!allowed) {
      writeToLogFile('warn', `[원격삭제예약] WIPE_QUEUE_CLEAR 거부 target=${targetIp} from=${fromIp || senderIP || '?'}`);
      return;
    }
    removePendingRemoteWipe(targetIp);
  }).catch(() => {});
}

function handleWipeChatHistoryResult(payload, senderIP) {
  const fromIp = (payload && payload.fromIp) || senderIP || '';
  const msg = String((payload && payload.msg) || '');
  safeWebContentsSend('wipe-chat-history-result', {
    success: !!payload.success,
    msg,
    fromIp,
    queued: !!(payload && payload.queued),
    messageCount: payload.messageCount || 0,
    chatLogFileCount: payload.chatLogFileCount || 0,
    appLogFileCount: payload.appLogFileCount || 0,
    backupFileCount: payload.backupFileCount || 0
  });
  // 성공 또는 비밀번호 불일치 시 예약 제거 (틀린 비밀번호로 무한 재시도 방지)
  const authFailed = /마스터 비밀번호/.test(msg);
  if (fromIp && (payload && payload.success || authFailed)) {
    removePendingRemoteWipe(fromIp).then(() => {
      broadcastToOnlinePeers({ type: 'WIPE_QUEUE_CLEAR', targetIp: fromIp, fromIp: MY_IP });
    });
  }
}

async function handleWipeChatHistoryCommand(payload, senderIP) {
  const ok = await verifyLocalMasterPassword(payload && payload.masterPassword);
  if (!ok) {
    if (senderIP) {
      sendToIpDirect(senderIP, {
        type: 'WIPE_CHAT_HISTORY_RESULT',
        success: false,
        msg: '마스터 비밀번호가 올바르지 않습니다(대상 PC 설정과 동일해야 함)',
        fromIp: MY_IP,
        queued: !!(payload && payload.queued)
      });
    }
    return;
  }
  try {
    safeWebContentsSend('chat-history-wipe-started', {
      fromIp: (payload && payload.fromIp) || senderIP || '',
      reason: (payload && payload.reason) || ''
    });
    const result = await performClearAllChatHistory({ logPrefix: '마스터 원격 로그 삭제' });
    safeWebContentsSend('chat-history-wiped', result);
    // 내 PC에 남아 있던 자기 자신 대상 예약도 정리
    removePendingRemoteWipe(MY_IP);
    const resultPayload = {
      type: 'WIPE_CHAT_HISTORY_RESULT',
      success: true,
      msg: '대화·로그 삭제 완료',
      fromIp: MY_IP,
      queued: !!(payload && payload.queued),
      messageCount: result.messageCount,
      chatLogFileCount: result.chatLogFileCount,
      appLogFileCount: result.appLogFileCount,
      backupFileCount: result.backupFileCount
    };
    const notifyIps = new Set();
    if (senderIP) notifyIps.add(senderIP);
    if (payload && payload.fromIp) notifyIps.add(String(payload.fromIp));
    notifyIps.forEach((ip) => {
      if (ip && ip !== MY_IP) sendToIpDirect(ip, resultPayload);
    });
    // 예약을 들고 있던 다른 PC에서는 대기열만 비움 (알림 스팸 방지)
    broadcastToOnlinePeers({ type: 'WIPE_QUEUE_CLEAR', targetIp: MY_IP, fromIp: MY_IP });
  } catch (e) {
    console.error('원격 로그 삭제 오류:', e.message);
    if (senderIP) {
      sendToIpDirect(senderIP, {
        type: 'WIPE_CHAT_HISTORY_RESULT',
        success: false,
        msg: e.message || '삭제 실패',
        fromIp: MY_IP,
        queued: !!(payload && payload.queued)
      });
    }
  }
}

ipcMain.handle('master-wipe-client-logs', async (event, payload) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  const p = payload || {};
  const password = String(p.password || '');
  if (!(await verifyLocalMasterPassword(password))) {
    return { success: false, msg: '마스터 비밀번호가 올바르지 않습니다.' };
  }
  const targetIp = String(p.targetIp || '').trim();
  if (!targetIp) return { success: false, msg: '대상 IP가 없습니다.' };

  const reason = p.reason || '마스터 관리자 원격 로그 삭제(퇴사자 등)';
  const wipePayload = {
    type: 'WIPE_CHAT_HISTORY',
    masterPassword: password,
    fromIp: MY_IP,
    reason
  };

  if (targetIp === MY_IP || targetIp === 'SELF') {
    try {
      safeWebContentsSend('chat-history-wipe-started', { fromIp: MY_IP, local: true, reason: wipePayload.reason });
      const result = await performClearAllChatHistory({ logPrefix: '마스터 로컬 로그 삭제' });
      safeWebContentsSend('chat-history-wiped', result);
      await removePendingRemoteWipe(MY_IP);
      return { success: true, local: true, ...result };
    } catch (e) {
      return { success: false, msg: e.message || String(e) };
    }
  }

  const isOnline = onlineUsers.has(targetIp);
  const requestedAt = new Date().toISOString();
  await upsertPendingRemoteWipe({
    target_ip: targetIp,
    master_password: password,
    reason,
    requested_by_ip: MY_IP,
    requested_at: requestedAt
  });

  // 다른 온라인 PC에도 예약을 공유 → 마스터 PC가 꺼져 있어도 대상이 켜지면 전달 가능
  broadcastToOnlinePeers({
    type: 'WIPE_QUEUE_SYNC',
    targetIp,
    masterPassword: password,
    reason,
    fromIp: MY_IP,
    requestedAt
  });

  // 사용 중지·오프라인 PC도 TCP로 시도. 실패해도 예약으로 재시도됨.
  sendToIpDirect(targetIp, { ...wipePayload, queued: !isOnline });
  if (isOnline) tryDeliverPendingWipe(targetIp);

  return {
    success: true,
    targetIp,
    sent: true,
    queued: true,
    online: isOnline
  };
});

ipcMain.handle('get-pending-remote-wipes', async () => {
  if (!masterSessionActive) return [];
  return listPendingRemoteWipes();
});

ipcMain.handle('cancel-pending-remote-wipe', async (event, targetIp) => {
  if (!masterSessionActive) return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  const ip = String(targetIp || '').trim();
  if (!ip) return { success: false, msg: '대상 IP가 없습니다.' };
  await removePendingRemoteWipe(ip);
  broadcastToOnlinePeers({ type: 'WIPE_QUEUE_CLEAR', targetIp: ip, fromIp: MY_IP });
  return { success: true };
});

// 6시간 단위로 백업 파일이 4배 늘었으니(하루 4개), 보관 일수를 줄여 전체 용량은
// 비슷하게 유지하면서 최근 구간의 복구 지점만 촘촘하게 가져간다.
const AUTO_BACKUP_RETENTION_DAYS = 2;
const PRE_UPDATE_BACKUP_RETENTION_DAYS = 7;

/** 업데이트할 때마다 pre_update_backup_<timestamp> 폴더가 새로 생기는데 지금까지
 * 이를 지우는 코드가 없어 업데이트를 반복할수록 userData 용량이 무한정 쌓였다.
 * 오래된 것부터 정리한다. */
async function cleanupOldPreUpdateBackups() {
  try {
    const base = app.getPath('userData');
    const cutoff = Date.now() - PRE_UPDATE_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const names = await fs.promises.readdir(base);
    for (const name of names) {
      if (!name.startsWith('pre_update_backup_')) continue;
      const dirPath = path.join(base, name);
      try {
        const stat = await fs.promises.stat(dirPath);
        if (!stat.isDirectory()) continue;
        if (stat.mtimeMs < cutoff) {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
        }
      } catch (e) { /* ignore individual failures */ }
    }
  } catch (e) {
    console.error('pre_update_backup 정리 오류:', e.message);
  }
}

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
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // 예전엔 하루에 한 번만 백업해서, 만약 백업 복구가 발동하면 최대 24시간치
    // 대화·공지·일정이 통째로 날아갈 수 있었다(오늘 실제로 겪은 chat_pins 사고와
    // 같은 성격의 위험). 6시간 단위로 나눠 그 위험 구간을 최대 6시간으로 좁힌다.
    const bucket = String(Math.floor(now.getUTCHours() / 6) * 6).padStart(2, '0');
    const todayFile = path.join(dir, `auto_backup_${todayStr}_${bucket}.db`);
    let alreadyExists = true;
    try { await fs.promises.access(todayFile); } catch (e) { alreadyExists = false; }
    if (!alreadyExists) {
      // ⚠️ 실사고: quick_check는 chat_pins류의 스키마 카탈로그 손상을 못 잡아서, 이미 깨진
      // DB가 "정상"으로 백업된 적이 있었다(나중에 복구 시점에야 그 백업도 깨진 걸 발견).
      // 원본·백업 둘 다 부팅 시 검사와 동일한 (더 엄격한) integrity_check로 통일한다.
      const healthy = await new Promise((resolve) => {
        db.get('PRAGMA integrity_check', (err, row) => {
          resolve(!err && sqliteCheckRowOk(row));
        });
      });
      if (!healthy) {
        console.error('[DB] skip auto backup — current DB failed integrity_check');
        scheduleDbCorruptRecovery('backup-integrity-check');
        return;
      }
      await checkpointWal();
      await fs.promises.copyFile(dbPath, todayFile);
      // 복사 자체가 손상을 일으킬 수 있으므로(OneDrive 등) 백업 파일도 별도로 검증 —
      // 손상된 백업이 "정상 백업"인 척 쌓이는 걸 막는다.
      const backupHealthy = await probeSqliteFileHealthy(todayFile);
      if (!backupHealthy) {
        console.error(`[DB] 백업 파일 무결성 실패 — 삭제: ${todayFile}`);
        await fs.promises.unlink(todayFile).catch(() => {});
      }
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
  cleanupOldChatLogFiles();
  cleanupOldPreUpdateBackups();
  setInterval(performAutoBackupIfNeeded, 6 * 60 * 60 * 1000);
  setInterval(cleanupOldLogFiles, 6 * 60 * 60 * 1000);
  setInterval(cleanupOldChatLogFiles, 6 * 60 * 60 * 1000);
  setInterval(cleanupOldPreUpdateBackups, 6 * 60 * 60 * 1000);
  // 방금 보낸 메시지가 -wal 파일에만 있다가, 앱이 비정상 종료되거나 DB 손상 복구
  // 절차가 WAL을 통째로 지우는 경로를 타면서 사라지는 사고가 있었다(실제 발생).
  // 2분마다 체크포인트해 본 파일에 합쳐두면, 데이터가 노출되는 구간을 최대 2분
  // 정도로 좁혀 이런 사고를 사실상 막을 수 있다. PASSIVE라 다른 작업을 막지 않는다
  // (TRUNCATE는 디스크가 느린 PC에서 몇 초~몇십 초씩 이벤트 루프를 막을 수 있었음).
  setInterval(() => { checkpointWalPassive().catch(() => {}); }, 2 * 60 * 1000);
}

ipcMain.handle('get-network-status', async () => ({
  myIp: MY_IP, udpStatus, tcpStatus, onlineCount: countOnlinePeopleForStatus()
}));

ipcMain.handle('get-peer-traffic-stats', async () => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.', rows: [], windowSec: 60 };
  }
  return {
    success: true,
    rows: listPeerTrafficStats(),
    windowSec: Math.round(PEER_TRAFFIC_WINDOW_MS / 1000),
    tcpActiveConnections,
    tcpMaxConnections: TCP_MAX_CONNECTIONS,
    collectedAt: Date.now()
  };
});

ipcMain.handle('reset-peer-traffic-stats', async () => {
  if (!masterSessionActive) return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  peerTrafficByIp.clear();
  return { success: true };
});

ipcMain.handle('run-load-sim', async (_event, payload) => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.' };
  }
  try {
    return runLoadTestCommand(payload || {});
  } catch (e) {
    return { success: false, msg: (e && e.message) || String(e) };
  }
});

ipcMain.handle('get-load-sim-status', async () => {
  if (!masterSessionActive) {
    return { success: false, msg: '마스터 관리자 로그인이 필요합니다.', onlineLoadTest: 0 };
  }
  return {
    success: true,
    onlineLoadTest: countLoadTestPeers(),
    sustain: !!loadTestSustainTimer,
    lastReport: loadTestLastReport,
    tcpActiveConnections,
    tcpMaxConnections: TCP_MAX_CONNECTIONS,
    udpStormActive: Date.now() < udpStormUntil
  };
});

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
  const sendAtMs = Date.parse(sendAt);
  if (!targetIP || !message || !Number.isFinite(sendAtMs)) {
    return { success: false, error: '예약 정보가 올바르지 않습니다.' };
  }
  // 항상 UTC ISO로 저장해 SQL/JS 비교가 어긋나지 않게 한다.
  const normalizedSendAt = new Date(sendAtMs).toISOString();
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO scheduled_messages (target_ip, is_broadcast, message, send_at, sent) VALUES (?, ?, ?, ?, 0)`,
      [targetIP, isBroadcast ? 1 : 0, message, normalizedSendAt],
      function (err) {
        if (err) logDbErr(err);
        resolve({ success: !err, id: err ? null : this.lastID, sendAt: normalizedSendAt });
        // 과거/직전 시각으로 등록된 경우 바로 전송 시도
        if (!err && sendAtMs <= Date.now() + 500) {
          setTimeout(() => checkAndSendDueScheduledMessages(), 50);
        }
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

/** 렌더러가 예약 시각이 지났는데 배너가 남아 있을 때 즉시 밀어내기 */
ipcMain.handle('flush-due-scheduled-messages', async () => {
  const n = await checkAndSendDueScheduledMessages();
  return { success: true, dispatched: n || 0 };
});

let scheduledMessageCheckInFlight = false;

function startScheduledMessageChecker() {
  checkAndSendDueScheduledMessages();
  // 15초는 체감 지연이 커서 5초 간격으로  denser 체크
  setInterval(checkAndSendDueScheduledMessages, 5000);
}

function parseScheduledSendAtMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return NaN;
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;
  // SQLite CURRENT_TIMESTAMP 스타일 "YYYY-MM-DD HH:MM:SS" → UTC로 간주
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return Date.parse(`${m[1]}T${m[2]}${m[2].length === 5 ? ':00' : ''}Z`);
  return NaN;
}

function checkAndSendDueScheduledMessages() {
  if (scheduledMessageCheckInFlight) return Promise.resolve(0);
  scheduledMessageCheckInFlight = true;
  const nowMs = Date.now();
  return new Promise((resolve) => {
    db.all(`SELECT * FROM scheduled_messages WHERE sent = 0 ORDER BY send_at ASC`, [], (err, rows) => {
      if (err) {
        logDbErr(err);
        scheduledMessageCheckInFlight = false;
        resolve(0);
        return;
      }
      const due = (rows || []).filter((row) => {
        const at = parseScheduledSendAtMs(row.send_at);
        return Number.isFinite(at) && at <= nowMs;
      });
      if (due.length === 0) {
        scheduledMessageCheckInFlight = false;
        resolve(0);
        return;
      }
      logToRendererConsole('info', `예약 메시지 전송 시도 ${due.length}건 (now=${new Date(nowMs).toISOString()})`);
      let remaining = due.length;
      due.forEach((row) => {
        dispatchScheduledMessage(row, () => {
          remaining -= 1;
          if (remaining <= 0) {
            scheduledMessageCheckInFlight = false;
            resolve(due.length);
          }
        });
      });
    });
  });
}

function notifyScheduledMessageSent(row, extra) {
  safeWebContentsSend('scheduled-message-sent', {
    targetIP: row.is_broadcast ? 'BROADCAST' : row.target_ip,
    message: row.message,
    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    id: row.id,
    ...(extra || {})
  });
}

function claimScheduledMessage(rowId, cb) {
  db.run(
    `UPDATE scheduled_messages SET sent = 1 WHERE id = ? AND sent = 0`,
    [rowId],
    function (err) {
      if (err) {
        logDbErr(err);
        cb(false);
        return;
      }
      cb(this.changes > 0);
    }
  );
}

function dispatchScheduledMessage(row, done) {
  const finish = () => { if (typeof done === 'function') done(); };
  claimScheduledMessage(row.id, (claimed) => {
    if (!claimed) {
      finish();
      return;
    }

    // UI 배너는 전송 시도 시점에 바로 내려 체감 지연을 없앤다.
    notifyScheduledMessageSent(row);

    if (row.is_broadcast) {
      const msgUid = generateMsgUid();
      const wire = { type: 'BROADCAST', sender: myProfile.username, message: row.message, msgUid };
      broadcastToOnlinePeers(wire);
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, 'BROADCAST', ?, 'SENT', ?)`,
        [senderLabelForMe(), MY_IP, row.message, msgUid],
        (err) => {
          logDbErr(err);
          appendChatLog('BROADCAST', '전체공지', myProfile.username, row.message);
          finish();
        }
      );
      return;
    }

    const targetIP = String(row.target_ip || '').trim();
    if (!targetIP || isSyntheticReceiverKey(targetIP) || !looksLikeIpv4(targetIP)) {
      logToRendererConsole('error', `예약 메시지 대상 IP 불가: ${targetIP}`);
      finish();
      return;
    }

    const msgUid = generateMsgUid();
    const partnerName = (allKnownUsers.get(targetIP) || {}).username || targetIP;
    const chatPayload = {
      type: 'CHAT',
      sender: myProfile.username,
      message: row.message,
      uid: msgUid
    };

    const insertOutbound = (status) => {
      db.run(
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, ?, ?, ?, ?, ?)`,
        [senderLabelForMe(), MY_IP, targetIP, row.message, status, msgUid],
        (err) => {
          logDbErr(err);
          appendChatLog(`DM_${targetIP}`, partnerName, myProfile.username, row.message);
          if (status === 'PENDING') {
            // 오프라인/실패 시 일반 PENDING 재전송 루프에 맡긴다.
            enqueuePendingPeerMessage(targetIP, row.message, msgUid);
          }
          finish();
        }
      );
    };

    if (isChatWireTooLarge(chatPayload)) {
      logToRendererConsole('error', '예약 메시지가 전송 한도를 초과해 PENDING으로 저장합니다.');
      insertOutbound('PENDING');
      return;
    }

    const client = new net.Socket();
    let isConnected = false;
    let settled = false;
    client.setTimeout(2000);

    const settle = (status) => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch (e) { /* ignore */ }
      insertOutbound(status);
    };

    client.connect(TCP_PORT, targetIP, () => {
      isConnected = true;
      try {
        client.write(JSON.stringify(chatPayload) + '\n');
        client.end();
        armDmReadReceiptNotify(targetIP);
        settle('SENT');
      } catch (writeErr) {
        console.error('예약 DM write 오류:', writeErr.message);
        settle('PENDING');
      }
    });

    const handleFailure = () => {
      if (isConnected || settled) return;
      settle('PENDING');
    };
    client.on('timeout', handleFailure);
    client.on('error', handleFailure);
  });
}