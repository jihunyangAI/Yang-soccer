/** The game's name as shown to players. (Saved games keep their older `pitchline.*` storage keys.) */
export const TITLE = 'YangSoccer';

/** Version and build date, filled in by the build (see vite.config.ts). */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/**
 * How to play, shown from the main menu: the controls for this device first, then the others,
 * and what a tester needs to send feedback.
 */
export function helpHtml(touch: boolean): string {
  const keys = `
    <div class="hp-block">
      <div class="card-label">키보드</div>
      <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 이동 · <kbd>Shift</kbd> 달리기 · <kbd>Space</kbd> 선수 전환</div>
      <div><b>공격</b> <kbd>J</kbd> 패스 · <kbd>L</kbd> 스루패스 · <kbd>I</kbd> 로빙 · <kbd>K</kbd> 슛 (길게 누르면 세게)</div>
      <div><b>수비</b> <kbd>J</kbd> 누르고 있기 = 압박 · <kbd>K</kbd> 태클</div>
      <div><kbd>Z</kbd> 카메라 · <kbd>C</kbd> 해설 · <kbd>M</kbd> 소리 · <kbd>H</kbd> 도움말 · <kbd>Esc</kbd> 일시정지</div>
      <div class="hp-dim">2인 대전: P2는 <kbd>방향키</kbd> 이동 · <kbd>,</kbd> 패스 · <kbd>.</kbd> 슛 · <kbd>/</kbd> 스루 · <kbd>;</kbd> 로빙 · <kbd>R-Shift</kbd> 달리기 · <kbd>'</kbd> 전환</div>
    </div>
    <div class="hp-block">
      <div class="card-label">게임패드</div>
      <div>왼쪽 스틱 이동 · <kbd>A</kbd> 패스/압박 · <kbd>B</kbd> 슛/태클 · <kbd>Y</kbd> 스루패스 · <kbd>X</kbd> 로빙 · <kbd>RB</kbd>/<kbd>RT</kbd> 달리기 · <kbd>LB</kbd> 선수 전환</div>
    </div>`;
  const touchHelp = `
    <div class="hp-block">
      <div class="card-label">터치 (휴대폰은 가로로 돌려서)</div>
      <div>화면 왼쪽을 누른 채 움직이면 이동합니다.</div>
      <div>오른쪽 버튼: <b>슛</b>(길게 누르면 세게) · <b>패스</b> · <b>스루</b> · <b>로빙</b> · <b>달리기</b> · <b>전환</b></div>
      <div>수비할 때는 패스 버튼이 <b>압박</b>, 슛 버튼이 <b>태클</b>로 바뀝니다.</div>
    </div>`;
  return `
    <div class="lg-head">
      <div><h2>조작법</h2><span class="menu-sub">${TITLE} ${BUILD}</span></div>
      <button type="button" class="lg-ghost" data-act="help-exit">메인 메뉴</button>
    </div>
    ${touch ? touchHelp + keys : keys + touchHelp}
    <div class="hp-block">
      <div class="card-label">알아두면 좋은 것</div>
      <div>선수를 바꾸면 스틱을 움직이기 전까지 그 선수가 스스로 공을 쫓아갑니다.</div>
      <div><b>조작 보조</b>를 켜면 슛이 골대 구석을 향하고, 짧게 눌러도 거리에 맞는 세기로 찹니다.</div>
      <div>리그·컵·클럽 육성의 진행 상황과 팀 에디터로 바꾼 내용은 이 기기에 자동 저장됩니다.</div>
    </div>
    <div class="hp-block">
      <div class="card-label">해설 음성 확인</div>
      <div>해설 목소리가 들리지 않으면 아래 버튼을 눌러 보세요. 이 기기에서 해설 음성이 재생되는지 바로 알려 드립니다.</div>
      <div class="lg-actions"><button type="button" class="lg-ghost" data-act="help-voice">테스트 음성 듣기</button></div>
      <div class="ed-note" data-id="voice-note" role="status">${talkStatus()}</div>
    </div>
    <div class="hp-block">
      <div class="card-label">테스트해 주시는 분께</div>
      <div>이상한 점을 알려주실 때 아래 버튼으로 복사한 정보를 함께 보내 주시면 원인을 찾기 쉽습니다.</div>
      <div class="lg-actions"><button type="button" class="lg-ghost" data-act="help-copy">기기 정보 복사</button><span class="ed-note" data-id="copy-note" role="status"></span></div>
    </div>`;
}

interface TalkProbe { diagnostics: string; silent: boolean; test(): Promise<string> }
const talk = (): TalkProbe | undefined => (window as unknown as { __talk?: TalkProbe }).__talk;
const talkStatus = (): string => talk()?.diagnostics ?? '';
/** Speak a test line (must be called from a button press) and say what happened. */
export const testVoice = (): Promise<string> => talk()?.test() ?? Promise.resolve('해설 기능을 찾을 수 없습니다.');

/** A few lines about this device and build, for a tester to paste next to their feedback. */
export function deviceReport(touch: boolean): string {
  const has = (k: string) => { try { return localStorage.getItem(k) ? '있음' : '없음'; } catch { return '저장 불가'; } };
  const voice = typeof speechSynthesis === 'undefined' ? '없음'
    : speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ko')).map((v) => v.name).join(', ') || '한국어 음성 없음';
  return [
    `${TITLE} ${BUILD}`,
    `화면 ${window.innerWidth}×${window.innerHeight} (배율 ${window.devicePixelRatio}) · ${touch ? '터치' : '키보드/패드'}`,
    `브라우저 ${navigator.userAgent}`,
    `한국어 음성: ${voice}`,
    `해설: ${talkStatus() || '-'}`,
    `저장: 리그 ${has('pitchline.league.v1')} · 컵 ${has('pitchline.cup.v1')} · 육성 ${has('pitchline.career.v1')} · 에디터 ${has('pitchline.custom.v1')}`,
  ].join('\n');
}

const isApple = (): boolean => /iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * A notice for browsers that cannot speak at all. Links opened inside a messenger (KakaoTalk
 * and the like) run in the app's own small browser, which has no speech synthesis, so the
 * commentary would be captions only. Empty when speech is available.
 */
export function noVoiceNotice(): string {
  // With recorded commentary this only happens if the recordings failed to load as well.
  if (!talk()?.silent) return '';
  return `
    <div class="novoice" role="note">
      <span><b>이 화면에서는 해설 목소리가 나오지 않습니다.</b> 녹음된 해설을 불러오지 못했고, 앱 안에서 연 화면이라 브라우저 음성도 없습니다. ${isApple() ? '사파리' : '크롬'}에서 열면 목소리까지 들립니다. (자막과 효과음은 여기서도 나옵니다)</span>
      <span class="novoice-actions">
        <button type="button" class="lg-ghost" data-act="open-ext">${isApple() ? '사파리' : '크롬'}에서 열기</button>
        <button type="button" class="lg-ghost" data-act="copy-link">주소 복사</button>
      </span>
      <span class="ed-note" data-id="link-note" role="status"></span>
    </div>`;
}

/** Hand this page to the phone's real browser, by the route the app it was opened in provides. */
export function openExternal(): void {
  const url = location.href, ua = navigator.userAgent;
  if (/KAKAOTALK/i.test(ua)) { location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`; return; }
  if (/Line\//i.test(ua)) { location.href = url + (url.includes('?') ? '&' : '?') + 'openExternalBrowser=1'; return; }
  if (isApple()) { location.href = url.replace(/^https?:\/\//, 'x-safari-https://'); return; }
  // Android: ask for Chrome by name; the fallback keeps the page where it is if Chrome is missing.
  location.href = `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

/** Copy text for the player; false if the browser would not allow it. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the older way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/**
 * If the game hits an error it cannot carry on from, say so instead of leaving a frozen
 * picture, and offer to start again. Saved seasons are untouched.
 */
export function showCrash(root: HTMLElement, error: unknown): void {
  if (root.querySelector('.crash')) return;
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(0, 6).join('\n')}` : String(error);
  const el = document.createElement('div');
  el.className = 'crash';
  el.innerHTML = `<div class="pause-card">
    <div class="title">문제가 생겼습니다</div>
    <p>게임을 계속할 수 없는 오류가 발생했습니다. 저장된 리그·컵·육성 기록은 그대로입니다.</p>
    <button type="button" class="primary" data-c="reload">다시 시작</button>
    <button type="button" data-c="copy">오류 내용 복사</button>
    <span class="ed-note" role="status"></span>
  </div>`;
  el.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-c]')?.dataset.c;
    if (act === 'reload') location.reload();
    if (act === 'copy') {
      const ok = await copyText(`${deviceReport(document.body.classList.contains('touch-mode'))}\n\n${detail}`);
      el.querySelector('.ed-note')!.textContent = ok ? '복사했습니다. 그대로 붙여 넣어 보내 주세요.' : detail;
    }
  });
  root.appendChild(el);
}
