/**
 * 가벼운 그림판(draw-editor.html)용 번들 진입점.
 * tldraw와 같은 필기감을 내는 perfect-freehand(MIT, tldraw 제작자 작성)만 담는다.
 * 결과물: lib/draw-app.js — 인터넷 없는 내부망에서도 쓰도록 저장소에 커밋한다.
 */
import getStroke from 'perfect-freehand';
window.getStroke = getStroke;
