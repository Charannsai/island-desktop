'use strict';
const CAPTURE = new URLSearchParams(location.search).has('capture');
let captureTime = 0;
const clock = () => CAPTURE ? captureTime * 1000 : performance.now();
/* Island desktop frontend: spring physics + live Windows state via Tauri.
   Falls back to a scripted mock when __TAURI__ is absent (preview/recording). */

/* ---------------- bridge ---------------- */
const mock = (() => {
  const t0 = Date.now();
  const S = {
    battery_pct: 72, charging: false, volume: 0.65, muted: false, brightness: 60,
    media: { title: 'Night Drive', artist: 'Aurora', playing: true,
             duration_ms: 252000, position_ms: 41000, art: null },
  };
  return {
    active: false, S,
    tick() {
      const t = (Date.now() - t0) / 1000;
      S.charging = t > 9 && t < 14;
      if (S.media && S.media.playing) S.media.position_ms += 250;
      return S;
    },
  };
})();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hasTauri = typeof window.__TAURI__ !== 'undefined';
let cmdCount = 0;

async function invoke(name, args) {
  if (hasTauri) return window.__TAURI__.core.invoke(name, args);
  // mock
  if (name === 'get_state') return mock.tick();
  if (name === 'media_cmd') {
    if (args.cmd === 'play') mock.S.media.playing = !mock.S.media.playing;
  }
  if (name === 'media_seek_ms') mock.S.media.position_ms = args.ms;
  if (name === 'volume_set') mock.S.volume = args.v;
  if (name === 'brightness_set') mock.S.brightness = args.v;
  if (name === 'set_island_rect') return;
  if (name === 'quit_app') document.title = 'quit';
  return null;
}

/* ---------------- svg glyphs ---------------- */
const I = {
  play: '<svg width="26" height="30" viewBox="0 0 26 32" fill="#fff"><path d="M4 2.6c0-1.8 2-2.9 3.5-1.9l16.5 12.4c1.5 1.1 1.5 3.4 0 4.5L7.5 30c-1.6 1-3.5-.1-3.5-1.9V2.6z"/></svg>',
  pause: '<svg width="22" height="26" viewBox="0 0 22 28" fill="#fff"><rect x="2" y="2" width="6.5" height="24" rx="2"/><rect x="13.5" y="2" width="6.5" height="24" rx="2"/></svg>',
  prev: '<svg width="30" height="20" viewBox="0 0 30 20" fill="#fff"><path d="M9.5 10 22 2.2c1.2-.75 2.7.1 2.7 1.5v12.6c0 1.4-1.5 2.25-2.7 1.5L9.5 10z"/><rect x="3.5" y="2.5" width="3.2" height="15" rx="1.3"/></svg>',
  next: '<svg width="30" height="20" viewBox="0 0 30 20" fill="#fff"><path d="M20.5 10 8 2.2C6.8 1.45 5.3 2.3 5.3 3.7v12.6c0 1.4 1.5 2.25 2.7 1.5L20.5 10z"/><rect x="23.3" y="2.5" width="3.2" height="15" rx="1.3"/></svg>',
  note: '<svg width="12" height="12" viewBox="0 0 12 12" fill="rgba(255,255,255,.75)"><path d="M4.5 1.5v6.1a2.2 2.2 0 1 0 1.2 2V4h3.9V1.5H4.5z" transform="scale(.9)"/></svg>',
  vol: '<svg width="15" height="15" viewBox="0 0 16 16" fill="rgba(255,255,255,.85)"><path d="M8.5 2.2 5 5.5H2.5A.5.5 0 0 0 2 6v4c0 .3.2.5.5.5H5l3.5 3.3c.4.3 1 0 1-.5V2.7c0-.6-.6-.9-1-.5zM11 5.4a3.6 3.6 0 0 1 0 5.2l.8.8a4.7 4.7 0 0 0 0-6.8l-.8.8z"/></svg>',
  sun: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1.4"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.2v1.8M8 13v1.8M1.2 8H3M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" stroke-linecap="round"/></svg>',
  bolt: '<svg width="12" height="14" viewBox="0 0 20 26" fill="#30d158"><path d="M11.5 0 1 14.5h6.6L6.2 26 19 10.5h-6.9L11.5 0z" transform="scale(.92)"/></svg>',
  boltBig: '<svg width="18" height="22" viewBox="0 0 20 26" fill="#30d158"><path d="M11.5 0 1 14.5h6.6L6.2 26 19 10.5h-6.9L11.5 0z" transform="scale(.92)"/></svg>',
};

function battSvg(pct, charging) {
  const w = Math.max(0, Math.min(18.6, 18.6 * pct / 100));
  const col = charging ? '#30d158' : '#fff';
  return `<svg width="24" height="11" viewBox="0 0 27 12" fill="none">
    <rect x="0.5" y="0.5" width="22" height="11" rx="3.5" stroke="rgba(255,255,255,.45)"/>
    <rect x="2.2" y="2.2" width="${w.toFixed(1)}" height="7.6" rx="1.8" fill="${col}"/>
    <path d="M24.8 4v4c1.2-.3 2-1 2-2s-.8-1.7-2-2z" fill="rgba(255,255,255,.45)"/></svg>`;
}

/* ---------------- spring engine ---------------- */
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const ease = x => 1 - (1 - clamp01(x)) * (1 - clamp01(x));

class Spr {
  constructor(x0) { this.x = x0; this.v = 0; this.t = x0; this.k = 150; this.c = 17; }
  to(t, k, c) { this.t = t; this.k = k; this.c = c; }
  step(dt) { const f = -this.k * (this.x - this.t) - this.c * this.v; this.v += f * dt; this.x += this.v * dt; }
  settled() { return Math.abs(this.x - this.t) < 0.4 && Math.abs(this.v) < 2; }
}
const K_OUT = [150, 17], K_IN = [220, 26], K_FI = [200, 24], K_FO = [320, 36];

/* ---------------- state ---------------- */
const island = document.getElementById('island');
const ST = { IDLE: 0, MIN: 1, MAX: 2, CHARGE: 3 };
let state = ST.IDLE;
let layers = [];
let S = null;                 // latest system state
let chargeUntil = 0, prevCharging = false;

const gw = new Spr(300), gh = new Spr(40), gr = new Spr(20);
const fadeIn = new Spr(0), fadeOut = new Spr(1);
fadeIn.k = K_FI[0]; fadeIn.c = K_FI[1]; fadeIn.t = 1;
fadeOut.k = K_FO[0]; fadeOut.c = K_FO[1]; fadeOut.t = 0;

function geo(s) {
  switch (s) {
    case ST.MIN: return [372, 56, 28];
    case ST.MAX: return [520, 282, 42];
    case ST.CHARGE: return [430, 92, 38];
    default: return [300, 40, 20];
  }
}

function setState(ns) {
  if (ns === state) return;
  for (const L of layers) if (L.dir === 'in') { L.dir = 'out'; }
  const [w, h, r] = geo(ns);
  const grow = w * h >= gw.t * gh.t;
  const [k, c] = grow ? K_OUT : K_IN;
  gw.to(w, k, c); gh.to(h, k, c); gr.to(r, k, c);
  fadeIn.x = 0; fadeIn.v = 0;
  fadeOut.x = 1; fadeOut.v = 0;
  const root = buildView(ns);
  island.appendChild(root);
  layers.push({ root, dir: 'in', born: clock() / 1000 });
  state = ns;
  if (ns === ST.MAX) setTimeout(bindMaxControls, 0);
}

/* rebuild current view's DOM in place (content changed, geometry stays) */
function refreshView() {
  if (state === ST.CHARGE || dragging) return;
  for (const L of layers) L.root.remove();
  const root = buildView(state);
  island.appendChild(root);
  layers = [{ root, dir: 'in', born: clock() / 1000 - 1 }];
  if (state === ST.MAX) setTimeout(bindMaxControls, 0);
}

/* ---------------- views ---------------- */
function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const clockStr = () => {
  const d = new Date();
  let h = d.getHours() % 12; if (h === 0) h = 12;
  return h + ':' + String(d.getMinutes()).padStart(2, '0');
};

function artHtml(size, rad) {
  const m = S && S.media;
  if (m && m.art) return `<div class="art" style="width:${size}px;height:${size}px;border-radius:${rad}px;background-image:url('${m.art}')"></div>`;
  return `<div class="art" style="width:${size}px;height:${size}px;border-radius:${rad}px">${I.note}</div>`;
}

function buildView(s) {
  if (s === ST.IDLE) {
    const batt = S && S.battery_pct >= 0
      ? `<div class="meta">${battSvg(S.battery_pct, S.charging)}<span>${S.battery_pct}%</span></div>` : '';
    const music = S && S.media
      ? `<div class="dot"></div><div class="mnote">${I.note}<span>${esc(S.media.title)}</span></div>` : '';
    return el(`<div class="view idle"><span class="clock">${clockStr()}</span>${batt}${music}</div>`);
  }
  if (s === ST.MIN) {
    const m = S && S.media ? S.media : { title: 'Nothing playing', artist: '' };
    return el(`<div class="view mini">
      ${artHtml(30, 8)}
      <div class="titles" data-stag><span class="t1">${esc(m.title)}</span><span class="t2">${esc(m.artist)}</span></div>
      <div class="spacer"></div><div class="wave" data-stag>${'<i></i>'.repeat(5)}</div></div>`);
  }
  if (s === ST.CHARGE) {
    const pct = S && S.battery_pct >= 0 ? S.battery_pct : '';
    return el(`<div class="view charge">
      <div class="boltwrap" data-stag>${I.boltBig}</div>
      <div class="titles" data-stag><span class="t1" style="font-size:15px">Charging</span><span class="t2">Battery</span></div>
      <span class="pct" data-stag>${pct}%</span></div>`);
  }
  // MAX
  const m = S && S.media ? S.media : null;
  const vol = S && S.volume >= 0 ? Math.round(S.volume * 100) : 0;
  const bri = S && S.brightness >= 0 ? S.brightness : -1;
  const batt = S && S.battery_pct >= 0
    ? `<div class="batt" data-stag>${battSvg(S.battery_pct, S.charging)}<span>${S.battery_pct}%${S.charging ? ' charging' : ''}</span></div>` : '';
  return el(`<div class="view max">
    <div class="mm-top" data-stag>
      ${artHtml(52, 12)}
      <div class="titles"><span class="t1">${m ? esc(m.title) : 'Nothing playing'}</span><span class="t2">${m ? esc(m.artist) : 'Play music to see it here'}</span></div>
      <div class="wave">${'<i></i>'.repeat(5)}</div>
    </div>
    <div class="prog" data-stag>
      <div class="track" id="track"><div class="fill" id="fill"></div><div class="knob" id="knob"></div></div>
      <div class="times"><span id="tcur">0:00</span><span id="trem">-0:00</span></div>
    </div>
    <div class="controls" data-stag>
      <div class="cbtn" id="cPrev">${I.prev}</div>
      <div class="cbtn" id="cPlay">${m && m.playing ? I.pause : I.play}</div>
      <div class="cbtn" id="cNext">${I.next}</div>
    </div>
    <div class="divider" data-stag></div>
    <div class="sliders" data-stag>
      <div class="srow"><span class="sic">${I.vol}</span>
        <div class="strack" id="volT"><div class="sfill" id="volF" style="width:${vol}%"></div></div>
        <span class="sval" id="volV">${vol}</span></div>
      ${bri >= 0 ? `<div class="srow"><span class="sic">${I.sun}</span>
        <div class="strack" id="briT"><div class="sfill" id="briF" style="width:${bri}%"></div></div>
        <span class="sval" id="briV">${bri}</span></div>` : ''}
    </div>
    <div class="foot" data-stag>
      <span class="brand">Island</span>
      ${batt}
      <span class="quit" id="quit">Quit</span>
    </div>
  </div>`);
}

/* ---------------- interactions ---------------- */
let dragging = null;

island.addEventListener('click', e => {
  if (dragging) return;
  const t = e.target;
  if (t.closest('#cPlay')) { invoke('media_cmd', { cmd: 'play' }).then(poll); return; }
  if (t.closest('#cNext')) { invoke('media_cmd', { cmd: 'next' }).then(() => setTimeout(poll, 250)); return; }
  if (t.closest('#cPrev')) { invoke('media_cmd', { cmd: 'prev' }).then(() => setTimeout(poll, 250)); return; }
  if (t.closest('#quit')) { invoke('quit_app'); return; }
  if (t.closest('#track')) {
    const r = t.closest('#track').getBoundingClientRect();
    const f = clamp01((e.clientX - r.left) / r.width);
    if (S && S.media) invoke('media_seek_ms', { ms: Math.round(f * S.media.duration_ms) }).then(poll);
    return;
  }
  if (t.closest('.strack')) return; // sliders handle their own
  if (state === ST.IDLE) { if (S && S.media) setState(ST.MIN); else setState(ST.MAX); return; }
  if (state === ST.MIN) { setState(ST.MAX); return; }
  if (state === ST.MAX) { setState(S && S.media ? ST.MIN : ST.IDLE); return; }
});

island.addEventListener('contextmenu', e => { e.preventDefault(); });

function sliderDrag(id, fillId, valId, cb) {
  const tr = document.getElementById(id);
  if (!tr) return;
  tr.addEventListener('pointerdown', e => {
    dragging = id;
    tr.setPointerCapture(e.pointerId);
    const move = ev => {
      const r = tr.getBoundingClientRect();
      const f = clamp01((ev.clientX - r.left) / r.width);
      document.getElementById(fillId).style.width = (f * 100) + '%';
      document.getElementById(valId).textContent = Math.round(f * 100);
      cb(f);
    };
    move(e);
    const up = () => {
      dragging = null;
      tr.removeEventListener('pointermove', move);
      tr.removeEventListener('pointerup', up);
    };
    tr.addEventListener('pointermove', move);
    tr.addEventListener('pointerup', up);
  });
}

let volTimer = 0, briTimer = 0;
let pollBusy = false;
function bindMaxControls() {
  sliderDrag('volT', 'volF', 'volV', f => {
    clearTimeout(volTimer);
    volTimer = setTimeout(() => invoke('volume_set', { v: f }), 40);
  });
  sliderDrag('briT', 'briF', 'briV', f => {
    clearTimeout(briTimer);
    briTimer = setTimeout(() => invoke('brightness_set', { v: Math.round(f * 100) }), 40);
  });
}

/* ---------------- data loop ---------------- */
async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try { S = await invoke('get_state'); } catch (e) { return; } finally { pollBusy = false; }
  render.polledAt = clock() / 1000;
  const titleChanged = lastTitle !== (S.media && S.media.title);
  lastTitle = S.media && S.media.title;
  // charging bloom
  if (S.charging && !prevCharging && S.battery_pct >= 0 && S.battery_pct < 100) {
    chargeUntil = clock() / 1000 + 3;
    setState(ST.CHARGE);
  }
  prevCharging = !!S.charging;
  // auto min when music starts
  if (S.media && state === ST.IDLE && S.media.playing) setState(ST.MIN);
  if (!S.media && (state === ST.MIN)) setState(ST.IDLE);
  if (titleChanged) refreshView();
}

if (!CAPTURE) { setInterval(poll, 700); poll(); }

/* ---------------- render loop ---------------- */
let lastRect = '';
let lastPlay = null, lastTitle = null;

function render() {
  const now = clock() / 1000;
  if (state === ST.CHARGE && now > chargeUntil) setState(S && S.media ? ST.MIN : ST.IDLE);

  const dt = Math.min(0.05, render.dt || 1 / 60);
  gw.step(dt); gh.step(dt); gr.step(dt); fadeIn.step(dt); fadeOut.step(dt);

  island.style.width = gw.x.toFixed(1) + 'px';
  island.style.height = gh.x.toFixed(1) + 'px';
  island.style.borderRadius = gr.x.toFixed(1) + 'px';

  layers = layers.filter(L => {
    if (L.dir === 'out' && fadeOut.settled()) { L.root.remove(); return false; }
    return true;
  });
  for (const L of layers) {
    if (L.dir === 'out') {
      L.root.style.opacity = clamp01(fadeOut.x).toFixed(3);
    } else {
      const fi = ease(fadeIn.x);
      L.root.style.opacity = fi.toFixed(3);
      const age = now - L.born;
      const items = L.root.querySelectorAll('[data-stag]');
      items.forEach((n, i) => {
        const s = ease(clamp01((age - i * 0.05) * 3.2) * fi);
        n.style.opacity = s.toFixed(3);
        n.style.transform = `translateY(${((1 - s) * 12).toFixed(1)}px)`;
      });
    }
  }

  // live updates inside MAX
  if (S) {
    const m = S.media;
    const fill = document.getElementById('fill');
    if (fill && m) {
      const pos = m.playing ? m.position_ms + (now - (render.polledAt || now)) * 1000 : m.position_ms;
      const f = clamp01(pos / Math.max(1, m.duration_ms));
      fill.style.width = (f * 100).toFixed(2) + '%';
      const knob = document.getElementById('knob');
      if (knob) knob.style.left = (f * 100).toFixed(2) + '%';
      const tc = document.getElementById('tcur'), trm = document.getElementById('trem');
      if (tc) tc.textContent = fmt(pos);
      if (trm) trm.textContent = '-' + fmt(Math.max(0, m.duration_ms - pos));
    }
    // play/pause glyph + title refresh without rebuilding springs
    if (m) {
      if (m.playing !== lastPlay) {
        lastPlay = m.playing;
        const cp = document.getElementById('cPlay');
        if (cp) cp.innerHTML = m.playing ? I.pause : I.play;
      }
    }
  }

  if (S && !dragging && !CAPTURE) {
    const vf = document.getElementById('volF'), vv = document.getElementById('volV');
    if (vf && S.volume >= 0) vf.style.width = S.volume * 100 + '%';
    if (vv && S.volume >= 0) vv.textContent = Math.round(S.volume * 100);
    const bf = document.getElementById('briF'), bv = document.getElementById('briV');
    if (bf && S.brightness >= 0) bf.style.width = S.brightness + '%';
    if (bv && S.brightness >= 0) bv.textContent = S.brightness;
  }

  // waveform bars
  const playing = S && S.media && S.media.playing;
  document.querySelectorAll('.wave').forEach(wv => {
    const bars = wv.children;
    for (let i = 0; i < bars.length; i++) {
      const a = playing
        ? 0.45 + 0.55 * Math.abs(Math.sin(now * 3.1 + i * 1.35) + 0.5 * Math.sin(now * 5.3 + i))
        : 0.22;
      bars[i].style.height = (5 + 8 * a).toFixed(1) + 'px';
    }
  });

  // idle clock refresh once a minute-ish
  if (state === ST.IDLE && Math.floor(now) % 20 === 0 && render.clockAt !== Math.floor(now / 20)) {
    render.clockAt = Math.floor(now / 20);
    const c = island.querySelector('.clock');
    if (c) c.textContent = clockStr();
  }

  // report island rect for click-through
  const rect = `${Math.round(gw.x)}x${Math.round(gh.y || gh.x)}`;
  if (rect !== lastRect) {
    lastRect = rect;
    const x = (window.innerWidth - gw.x) / 2, y = 10;
    invoke('set_island_rect', { x, y, w: gw.x, h: gh.x });
  }
}
render.dt = 0;

let prevT = clock();
if (!CAPTURE) (function loop() {
  const now = clock();
  render.dt = Math.min(0.05, (now - prevT) / 1000);
  prevT = now;
  render();
  requestAnimationFrame(loop);
})();

// initial view
island.appendChild(buildView(ST.IDLE));
layers = [{ root: island.firstElementChild, dir: 'in', born: 0 }];
fadeIn.x = 1;

// Explicitly labelled UI-preview capture. It never stands in for Windows testing.
if (CAPTURE) {
  document.body.style.background = 'radial-gradient(ellipse at 40% 0%, #2b1b28, #0d1019 75%)';
  const caption = document.createElement('div');
  caption.textContent = 'UI PREVIEW  /  SAMPLE DATA  /  WINDOWS CONTROLS NOT TESTED';
  caption.style.cssText = 'position:absolute;bottom:28px;width:100%;text-align:center;color:#9a9ba6;font-size:11px;letter-spacing:.13em;pointer-events:none';
  document.body.appendChild(caption);
  let stage = -1;
  window.__duration = 22;
  window.__seek = t => {
    while (captureTime < t - .00001) {
      captureTime += 1 / 240;
      const n = captureTime < 1.5 ? 0 : captureTime < 4 ? 1 : captureTime < 8 ? 2 : captureTime < 10 ? 3 : captureTime < 13 ? 4 : captureTime < 18 ? 5 : 6;
      if (n !== stage) {
        stage = n;
        S = structuredClone(mock.S);
        S.charging = n >= 4;
        if(n === 0) { S.media = null; refreshView(); }
        if(n === 1) setState(ST.MIN);
        if(n === 2 || n === 5) setState(ST.MAX);
        if(n === 3 || n === 6) setState(ST.MIN);
        if(n === 4) {chargeUntil = 13; setState(ST.CHARGE);}
      }
      if (S && S.media) S.media.position_ms = 41000 + captureTime * 1000;
      if (stage === 5) {
        const f = .65 - .35 * clamp01((captureTime - 14) / 2);
        const vf = document.getElementById('volF'), vv = document.getElementById('volV');
        if(vf) vf.style.width = f * 100 + '%';
        if(vv) vv.textContent = Math.round(f * 100);
      }
      render.dt = 1 / 240;
      render.polledAt = captureTime;
      render();
    }
  };
}

if (!hasTauri && !CAPTURE) {
 const badge=document.createElement('div');badge.textContent='BROWSER PREVIEW / SAMPLE DATA';badge.style.cssText='position:absolute;bottom:20px;width:100%;text-align:center;color:#888;font-size:11px';document.body.appendChild(badge);
}
