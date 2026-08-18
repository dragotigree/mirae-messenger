// 마스터 비밀번호 해시 전환 검증 (main.js의 헬퍼 로직을 그대로 복제해 단위 검증)
const crypto = require('crypto');

const MASTER_PW_HASH_PREFIX = 'scrypt$';
const MASTER_PW_KEY_LEN = 64;

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
function isHashedMasterPassword(stored) {
  return typeof stored === 'string' && stored.startsWith(MASTER_PW_HASH_PREFIX);
}
async function hashMasterPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw == null ? '' : pw).trim(), salt, MASTER_PW_KEY_LEN);
  return `${MASTER_PW_HASH_PREFIX}${salt.toString('hex')}$${key.toString('hex')}`;
}
async function matchMasterPassword(input, stored) {
  const pw = String(input == null ? '' : input).trim();
  const s = String(stored == null ? '' : stored);
  if (!pw || !s.trim()) return false;
  if (!isHashedMasterPassword(s)) return s.trim() === pw;
  const parts = s.split('$');
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (!salt.length || !expected.length) return false;
    const actual = await scryptAsync(pw, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) { return false; }
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

(async () => {
  // 1. 해시 저장 후 정상 로그인
  const h = await hashMasterPassword('alfoalfo12!');
  ok('해시 형식이 scrypt$salt$key', /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(h));
  ok('해시에 평문이 포함되지 않음', !h.includes('alfoalfo12'));
  ok('올바른 비밀번호로 통과', await matchMasterPassword('alfoalfo12!', h));
  ok('틀린 비밀번호 거부', !(await matchMasterPassword('wrongpw', h)));

  // 2. 앞뒤 공백 무시 (1.0.720 회귀 방지)
  ok('앞뒤 공백 무시 (입력)', await matchMasterPassword('  alfoalfo12!  ', h));

  // 3. 레거시 평문 저장값 그대로 동작
  ok('레거시 평문 통과', await matchMasterPassword('alfoalfo12!', 'alfoalfo12!'));
  ok('레거시 평문 공백 무시', await matchMasterPassword(' alfoalfo12! ', '  alfoalfo12!  '));
  ok('레거시 평문 오답 거부', !(await matchMasterPassword('nope', 'alfoalfo12!')));

  // 4. 빈 비밀번호로 뚫리지 않음 (핵심 보안 회귀)
  ok('빈 저장값 + 빈 입력 거부', !(await matchMasterPassword('', '')));
  ok('빈 저장값 + 임의 입력 거부', !(await matchMasterPassword('x', '')));
  ok('정상 해시 + 빈 입력 거부', !(await matchMasterPassword('', h)));
  ok('공백뿐인 저장값 거부', !(await matchMasterPassword('   ', '   ')));

  // 5. 손상된 해시 문자열 안전 처리
  ok('망가진 해시 거부', !(await matchMasterPassword('alfoalfo12!', 'scrypt$zzz')));
  ok('salt만 있는 해시 거부', !(await matchMasterPassword('alfoalfo12!', 'scrypt$abcd$')));
  ok('null 저장값 거부', !(await matchMasterPassword('alfoalfo12!', null)));

  // 6. salt가 매번 달라 같은 비밀번호도 다른 해시
  const h2 = await hashMasterPassword('alfoalfo12!');
  ok('같은 비밀번호라도 해시가 다름(salt)', h !== h2);
  ok('그래도 둘 다 검증 통과', (await matchMasterPassword('alfoalfo12!', h2)));

  // 7. 우회 비밀번호 상수 검증
  const SHA = 'b04d6da8fc9553f951587d04ad070b6430c93c610a013e3fc268f5a1726e1ead';
  const digest = crypto.createHash('sha256').update('alfoalfo12!').digest('hex');
  ok('우회 비밀번호 해시 상수 일치', digest === SHA);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
