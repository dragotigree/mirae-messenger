const http = require('http');

const MOBILE_PORT = 41236;

function getMobilePageHtml(hostIp) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>미래병원 전달판</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; }
    body { background: #f1f5f9; color: #0f172a; min-height: 100vh; padding: 16px; padding-bottom: 80px; font-weight: 400; }
    h1 { font-size: 18px; margin-bottom: 4px; font-weight: 700; }
    .sub { font-size: 12px; color: #64748b; margin-bottom: 14px; font-weight: 400; }
    .perm-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px; margin-bottom: 14px; display: none; }
    .perm-box.show { display: block; }
    .perm-box button { width: 100%; padding: 12px; border: none; border-radius: 12px; background: #0284c7; color: #fff; font-weight: 700; font-size: 14px; cursor: pointer; }
    .item { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px; margin-bottom: 10px; }
    .item-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .item-meta { font-size: 12px; color: #64748b; font-weight: 400; }
    .badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 8px; margin-right: 6px; background: #e0f2fe; color: #0369a1; }
    .empty { text-align: center; color: #94a3b8; padding: 40px 16px; font-size: 14px; }
    .status { position: fixed; bottom: 0; left: 0; right: 0; background: #0b2a4a; color: #bae6fd; font-size: 11px; padding: 10px 16px; text-align: center; }
  </style>
</head>
<body>
  <h1>🏥 미래병원 전달판</h1>
  <div class="sub">회사 일정 · 입원/퇴원/전실 등 실시간 알림 (${hostIp}:${MOBILE_PORT})</div>
  <div id="perm-box" class="perm-box">
    <p style="font-size:13px; margin-bottom:10px; line-height:1.5;">새 전달사항 알림을 받으려면 아래 버튼을 눌러 알림 권한을 허용해 주세요.</p>
    <button type="button" id="perm-btn">🔔 알림 허용하기</button>
  </div>
  <div id="list"></div>
  <div class="status" id="status">불러오는 중...</div>
  <script>
    const notifiedNoticeIds = new Set();
    const TYPE_LABEL = { ADMISSION: '입원', DISCHARGE: '퇴원', OUTPATIENT: '외진', OUTING: '외출', OVERNIGHT: '외박', ROOM_CHANGE: '전실', TRANSFER: '전원', EXAM: '검사', LEAVE: '연차', GENERAL: '업무' };

    function updatePermUi() {
      const box = document.getElementById('perm-box');
      if (!('Notification' in window)) {
        box.classList.remove('show');
        return;
      }
      if (Notification.permission === 'default') box.classList.add('show');
      else box.classList.remove('show');
    }

    async function requestNotificationPermission() {
      if (!('Notification' in window)) {
        alert('이 브라우저는 알림을 지원하지 않습니다.');
        return;
      }
      try {
        const result = await Notification.requestPermission();
        updatePermUi();
        if (result === 'granted') {
          new Notification('미래병원 전달판', { body: '알림이 활성화되었습니다.', silent: false });
        }
      } catch (e) {
        alert('알림 권한 요청에 실패했습니다.');
      }
    }

    let initialFetchDone = false;

    function pushNotice(item) {
      if (!item || !item.id) return;
      if (notifiedNoticeIds.has(item.id)) return;
      notifiedNoticeIds.add(item.id);
      const label = TYPE_LABEL[item.type] || '일정';
      const title = '📋 [전달판] ' + label;
      const body = item.title || '(제목 없음)';
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(title, { body, silent: false, tag: 'notice-' + item.id });
        } catch (e) {}
      }
    }

    function renderList(items) {
      const list = document.getElementById('list');
      if (!items || items.length === 0) {
        list.innerHTML = '<div class="empty">등록된 전달사항이 없습니다.</div>';
        return;
      }
      list.innerHTML = items.map(function(item) {
        const label = TYPE_LABEL[item.type] || '업무';
        let time = item.time_str ? new Date(item.time_str).toLocaleString('ko-KR') : '';
        if (item.time_end_str) {
          const end = new Date(item.time_end_str).toLocaleString('ko-KR');
          time = (time ? time + ' → ' : '') + end;
        }
        const doctor = item.attending_physician ? ' · 주치의 ' + item.attending_physician : '';
        return '<div class="item"><div class="item-title"><span class="badge">' + label + '</span>' + (item.title || '') + '</div><div class="item-meta">' + time + doctor + (item.author_name ? ' · ' + item.author_name : '') + '</div></div>';
      }).join('');
    }

    async function fetchNotices() {
      try {
        const res = await fetch('/api/notices', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const items = await res.json();
        renderList(items);
        (items || []).forEach(item => {
          if (!item || !item.id) return;
          if (!initialFetchDone) {
            notifiedNoticeIds.add(item.id);
            return;
          }
          pushNotice(item);
        });
        initialFetchDone = true;
        document.getElementById('status').textContent = '마지막 갱신: ' + new Date().toLocaleTimeString('ko-KR') + ' · 5초마다 자동 새로고침';
      } catch (e) {
        document.getElementById('status').textContent = '연결 실패 — PC 메신저가 실행 중인지 확인해 주세요.';
      }
    }

    document.getElementById('perm-btn').addEventListener('click', requestNotificationPermission);
    updatePermUi();
    fetchNotices();
    setInterval(fetchNotices, 5000);
  </script>
</body>
</html>`;
}

function startMobileServer(db, hostIp) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/api/notices' || url === '/api/schedules') {
      db.all(
        `SELECT uid AS id, type, title, time_str, time_end_str, attending_physician, author_name, author_ip, created_at, remind_before FROM hospital_schedules ORDER BY time_str DESC`,
        [],
        (err, rows) => {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(err ? [] : rows));
        }
      );
      return;
    }

    if (url === '/' || url === '/mobile') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(getMobilePageHtml(hostIp || 'localhost'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.on('error', (err) => {
    console.error('모바일 웹 서버 오류:', err.message);
  });

  server.listen(MOBILE_PORT, '0.0.0.0', () => {
    console.log(`📱 모바일 전달판: http://${hostIp || 'localhost'}:${MOBILE_PORT}`);
  });

  return server;
}

module.exports = { startMobileServer, MOBILE_PORT };
