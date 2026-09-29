'use strict';
const video = document.querySelector('#avatar');
const still = document.querySelector('#still');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sources = Object.freeze({
  default: 'https://muse.ai/avatars/hatch.mp4',
  working: 'https://muse.ai/avatars/hatch_working.mp4',
  making_something: 'https://muse.ai/avatars/hatch_making_something.mp4',
});
let latest = null, currentSrc = null;
function render(state) {
  if (!state) return;
  latest = state;
  document.body.dataset.kind = state.kind;
  document.querySelector('#status').textContent = state.label;
  document.querySelector('#detail').textContent = state.detail;
  document.querySelector('#status').title = state.scope;
  document.querySelector('.eyebrow span').textContent = state.mode === 'native' ? '· 原生' : '· 本机';
  document.querySelector('#open').textContent = state.mode === 'native' ? '重新连接 ↻' : '打开 Muse ↗';
  const src = motion.matches ? null : sources[state.variant] ?? null;
  if (src !== currentSrc) {
    currentSrc = src; video.classList.remove('ready'); video.pause();
    if (src) { video.src = src; video.load(); void video.play().catch(() => {}); }
    else { video.removeAttribute('src'); video.load(); }
  }
}
video.addEventListener('canplay', () => { if (currentSrc) video.classList.add('ready'); });
video.addEventListener('error', () => video.classList.remove('ready'));
still.addEventListener('error', () => { still.hidden = true; });
motion.addEventListener('change', () => render(latest));
document.querySelector('#open').addEventListener('click', () => window.pet.openMuse());
document.querySelector('#hide').addEventListener('click', () => window.pet.hide());
window.pet.onState(render);
void window.pet.getState().then(render);
