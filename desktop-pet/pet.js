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
  const open = document.querySelector('#open');
  open.textContent = state.mode === 'native' ? state.accountPhase === 'signed_out' ? '登录 Muse' : '重新连接 ↻' : '打开 Muse ↗';
  open.disabled = !!state.accountPhase && state.accountPhase !== 'signed_out';
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
const portrait = document.querySelector('#portrait'), orbit = document.querySelector('#orbit');
let orbitOpen = false, orbitPending = false;
function renderOrbit(expanded) {
  orbitOpen = expanded; document.body.dataset.orbit = String(expanded); orbit.hidden = !expanded;
  portrait.setAttribute('aria-expanded', String(expanded));
  portrait.setAttribute('aria-label', expanded ? '收起气泡菜单' : '展开气泡菜单');
}
async function toggleOrbit() {
  if (orbitPending) return; orbitPending = true;
  try { renderOrbit(await window.pet.setOrbit(!orbitOpen)); } finally { orbitPending = false; }
}
portrait.addEventListener('click', () => void toggleOrbit());
document.querySelector('#orbit-account').addEventListener('click', () => window.pet.accountMenu());
document.addEventListener('keydown', event => { if (event.key === 'Escape' && orbitOpen) void window.pet.setOrbit(false); });
document.addEventListener('click', event => {
  if (orbitOpen && !event.target.closest('button,.handle')) void window.pet.setOrbit(false);
});
window.pet.onOrbit(renderOrbit);
window.pet.onState(render);
window.pet.onUnread(count => { const badge=document.querySelector('#unread'); badge.hidden=!count; badge.textContent=count>9?'9+':String(count); });
void window.pet.getState().then(render);
