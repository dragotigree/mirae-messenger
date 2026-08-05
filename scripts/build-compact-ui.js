#!/usr/bin/env node
/**
 * 미니모드 UI 빌드: Tailwind CSS + Phosphor Icons 경로 생성
 * 사용: node scripts/build-compact-ui.mjs
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets', 'compact');
const phDir = path.join(root, 'node_modules', '@phosphor-icons', 'core', 'assets', 'regular');

const ICON_MAP = {
  lock: 'lock',
  lockOpen: 'lock-open',
  shieldUser: 'shield-check',
  shieldCheck: 'shield-check',
  logs: 'scroll',
  pin: 'push-pin',
  folder: 'folder',
  refresh: 'arrows-clockwise',
  panelNarrow: 'sidebar-simple',
  monitor: 'monitor',
  chevronLeft: 'caret-left',
  chevronRight: 'caret-right',
  settings: 'gear',
  clearChat: 'trash',
  search: 'magnifying-glass',
  mediaArchive: 'archive',
  back: 'caret-left',
  ipmsg: 'chat-circle-dots',
  notice: 'megaphone',
  users: 'users',
  chatBubble: 'chat-circle',
  moreDots: 'dots-three',
  calendar: 'calendar-blank',
  question: 'question',
  send: 'paper-plane-tilt',
  expand: 'arrows-out',
  compress: 'arrows-in',
  star: 'star',
  funnel: 'funnel',
  userCircle: 'user-circle',
  x: 'x'
};

function extractInner(svgText) {
  const m = svgText.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return (m ? m[1] : '').trim().replace(/\s+/g, ' ');
}

function buildPhosphorPaths() {
  if (!fs.existsSync(phDir)) {
    console.warn('[build-compact-ui] @phosphor-icons/core 없음 — 기존 phosphor-paths.json 유지');
    return;
  }
  const out = {};
  for (const [key, file] of Object.entries(ICON_MAP)) {
    const p = path.join(phDir, `${file}.svg`);
    if (!fs.existsSync(p)) {
      console.warn('[build-compact-ui] missing icon:', file);
      continue;
    }
    out[key] = extractInner(fs.readFileSync(p, 'utf8'));
  }
  fs.writeFileSync(path.join(assetsDir, 'phosphor-paths.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('[build-compact-ui] phosphor-paths.json:', Object.keys(out).length, 'icons');
}

function buildTailwind() {
  const input = path.join(assetsDir, 'src.css');
  const output = path.join(assetsDir, 'compact-overlay.css');
  execSync(
    `npx --yes tailwindcss -i "${input}" -o "${output}" --minify`,
    { cwd: root, stdio: 'inherit' }
  );
  console.log('[build-compact-ui] compact-overlay.css written');
}

fs.mkdirSync(assetsDir, { recursive: true });
buildPhosphorPaths();
buildTailwind();
