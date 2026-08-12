/**
 * 공지사항 서식 편집기(Tiptap) 진입점 — esbuild로 번들되어 lib/tiptap-editor.js 가 된다.
 * 렌더러(index.html)는 window.MiraeEditor 만 사용한다.
 *
 * ⚠️ 보안: 공지는 LAN으로 다른 PC에서 넘어온다. 예전에는 본문이 순수 텍스트라
 * textContent로 찍으면 끝이었지만, 서식(HTML)을 쓰는 순간 <img onerror=...> 같은 것이
 * 실행될 수 있다. 그래서 "저장할 때"와 "보여줄 때" 양쪽 모두 DOMPurify로 걸러낸다.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import DOMPurify from 'dompurify';

/** 공지 본문에서 허용할 태그·속성 — 화이트리스트 방식(허용한 것만 통과) */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
    'h1', 'h2', 'h3', 'h4',
    'ul', 'ol', 'li',
    'blockquote', 'code', 'pre', 'hr',
    'span', 'mark',
    'table', 'thead', 'tbody', 'tr', 'th', 'td'
  ],
  ALLOWED_ATTR: ['style', 'colspan', 'rowspan', 'colwidth', 'data-color', 'class'],
  // 링크/이미지/스크립트/이벤트핸들러는 아예 허용하지 않는다(사진은 기존 첨부 기능을 쓴다).
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'img', 'a', 'svg'],
  ALLOW_DATA_ATTR: false
};

/** style 속성으로 들어올 수 있는 위험한 값(url(), expression() 등)까지 한 번 더 막는다. */
function scrubInlineStyles(root) {
  root.querySelectorAll('[style]').forEach((el) => {
    const raw = String(el.getAttribute('style') || '');
    const safe = raw
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => {
        if (!decl) return false;
        const [prop, ...rest] = decl.split(':');
        const name = String(prop || '').trim().toLowerCase();
        const value = rest.join(':').trim().toLowerCase();
        if (!name || !value) return false;
        // 글자색·형광펜·정렬 정도만 허용
        if (!['color', 'background-color', 'background', 'text-align', 'font-weight'].includes(name)) return false;
        if (/url\s*\(|expression\s*\(|javascript:|@import/.test(value)) return false;
        return true;
      })
      .join('; ');
    if (safe) el.setAttribute('style', safe);
    else el.removeAttribute('style');
  });
}

function sanitizeHtml(html) {
  const input = String(html == null ? '' : html);
  if (!input) return '';
  const clean = DOMPurify.sanitize(input, { ...SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: false });
  const holder = document.createElement('div');
  holder.innerHTML = clean;
  scrubInlineStyles(holder);
  return holder.innerHTML;
}

/** 목록 미리보기·검색·알림에 쓸 순수 텍스트로 변환 */
function htmlToPlainText(html) {
  const holder = document.createElement('div');
  holder.innerHTML = sanitizeHtml(html);
  // 블록 요소 경계는 줄바꿈으로 바꿔야 "제목내용"처럼 붙어버리지 않는다.
  holder.querySelectorAll('br').forEach((el) => el.replaceWith(document.createTextNode('\n')));
  // 표는 칸끼리도 붙으면 "셀A셀B"가 되므로 칸 사이는 공백으로 띄운다.
  holder.querySelectorAll('td, th').forEach((el) => el.appendChild(document.createTextNode(' ')));
  holder.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, blockquote, pre').forEach((el) => {
    el.appendChild(document.createTextNode('\n'));
  });
  return (holder.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 저장된 값이 서식(HTML)인지, 옛 순수 텍스트인지 판별 */
function looksLikeHtml(value) {
  return /<\/?(p|br|strong|em|u|s|h[1-4]|ul|ol|li|mark|span|table|blockquote|pre|code|hr)\b[^>]*>/i.test(
    String(value || '')
  );
}

/** 옛 순수 텍스트 공지를 안전하게 HTML로 감싼다(줄바꿈 유지). */
function plainTextToHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text == null ? '' : text);
  return div.innerHTML.replace(/\n/g, '<br>');
}

/** 화면에 표시할 최종 HTML — 옛 글/새 글 모두 이 함수 하나로 처리한다. */
function toDisplayHtml(content) {
  const s = String(content == null ? '' : content);
  if (!s.trim()) return '';
  return looksLikeHtml(s) ? sanitizeHtml(s) : plainTextToHtml(s);
}

function createEditor(element, options) {
  const o = options || {};
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: false }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TableKit.configure({ table: { resizable: true } })
    ],
    content: toDisplayHtml(o.content || ''),
    autofocus: false,
    onUpdate: () => { if (typeof o.onUpdate === 'function') o.onUpdate(); }
  });
  return editor;
}

window.MiraeEditor = {
  create: createEditor,
  sanitize: sanitizeHtml,
  toDisplayHtml,
  htmlToPlainText,
  looksLikeHtml
};
