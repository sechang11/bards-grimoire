/* The Bard's Grimoire — scene effects: a light animated layer that matches the music.
   One canvas, one animation loop, ~17 effects (rain, snow, embers, fireflies, candlelight…).
   app.js decides which effect fits what's playing and calls GrimoireFX.show(kind).
   Also: bursts for critical hits / fumbles. No dependencies. */
(() => {
  "use strict";

  const rand = (a, b) => a + Math.random() * (b - a);
  const TAU = Math.PI * 2;
  const cv = document.getElementById("fx");
  const ctx = cv.getContext("2d");
  const state = { kind: null, want: null, parts: [], raf: 0, last: 0, t: 0, w: 0, h: 0, flash: 0,
    light: { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2 }, lite: false };

  function resize() {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1); // a sharper canvas isn't worth the frame time
    state.w = innerWidth;
    state.h = innerHeight;
    cv.width = Math.round(state.w * dpr);
    cv.height = Math.round(state.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener("resize", () => { resize(); if (state.kind) seed(); });
  resize();

  // A soft glowing dot, drawn once per color and reused (shadowBlur every frame is slow on TVs).
  const sprites = {};
  function glow(color, size = 24) {
    const key = color + size;
    if (sprites[key]) return sprites[key];
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d"), grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, color);
    grd.addColorStop(0.35, color.replace(/[\d.]+\)$/, "0.5)"));
    grd.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return (sprites[key] = c);
  }

  // Each effect: how many particles (per 1280×720), how to make one, move it, draw it.
  // `init` = true when filling the screen at start (spread everywhere) rather than respawning at an edge.
  const EFFECTS = {
    rain: {
      n: 150,
      make(w, h, init) { return { x: rand(-80, w + 40), y: init ? rand(0, h) : rand(-60, -10), l: rand(12, 24), s: rand(10, 16), a: rand(0.12, 0.3) }; },
      step(p, dt, w, h) { p.x += p.s * 0.22 * dt; p.y += p.s * dt; return p.y < h + 30; },
      draw(p) { ctx.strokeStyle = `rgba(175,195,235,${p.a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l * 0.22, p.y - p.l); ctx.stroke(); },
    },
    neon: {
      n: 130,
      make(w, h, init) { return { ...EFFECTS.rain.make(w, h, init), hue: Math.random() < 0.5 ? 320 : 185 }; },
      step(p, dt, w, h) { return EFFECTS.rain.step(p, dt, w, h); },
      draw(p) { ctx.strokeStyle = `hsla(${p.hue},100%,70%,${p.a + 0.1})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l * 0.22, p.y - p.l); ctx.stroke(); },
    },
    storm: {
      n: 190,
      make(w, h, init) { const p = EFFECTS.rain.make(w, h, init); p.s *= 1.3; p.a += 0.05; return p; },
      step(p, dt, w, h) { p.x += p.s * 0.4 * dt; p.y += p.s * dt; return p.y < h + 30; },
      draw: p => EFFECTS.rain.draw(p),
      frame(dt) { if (Math.random() < 0.0025 * dt) state.flash = rand(0.6, 1); }, // lightning
    },
    snow: {
      n: 110,
      make(w, h, init) { return { x: rand(0, w), y: init ? rand(0, h) : -10, r: rand(1, 3.2), s: rand(0.4, 1.2), ph: rand(0, TAU), a: rand(0.4, 0.85) }; },
      step(p, dt) { p.y += p.s * dt; p.x += Math.sin(state.t / 900 + p.ph) * 0.35 * dt; return p.y < state.h + 10; },
      draw(p) { ctx.fillStyle = `rgba(240,245,255,${p.a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); },
    },
    ash: {
      n: 80,
      make(w, h, init) { return { x: rand(0, w), y: init ? rand(0, h) : -10, r: rand(0.8, 2.2), s: rand(0.3, 0.8), ph: rand(0, TAU), a: rand(0.25, 0.55), hot: Math.random() < 0.18 }; },
      step(p, dt) { p.y += p.s * dt; p.x += Math.sin(state.t / 700 + p.ph) * 0.5 * dt; return p.y < state.h + 10; },
      draw(p) {
        if (p.hot) ctx.drawImage(glow("rgba(255,120,40,0.9)", 12), p.x - 6, p.y - 6);
        else { ctx.fillStyle = `rgba(150,140,135,${p.a})`; ctx.fillRect(p.x, p.y, p.r * 1.6, p.r); }
      },
    },
    embers: {
      n: 60,
      make(w, h, init) { return { x: rand(0, w), y: init ? rand(0, h) : h + 10, s: rand(0.4, 1.2), ph: rand(0, TAU), size: rand(8, 16), life: rand(0.6, 1) }; },
      step(p, dt) { p.y -= p.s * dt; p.x += Math.sin(state.t / 500 + p.ph) * 0.6 * dt; p.life -= 0.0012 * dt; return p.y > -20 && p.life > 0; },
      draw(p) { ctx.globalAlpha = Math.max(0, p.life); ctx.drawImage(glow("rgba(255,150,50,0.95)", 24), p.x - p.size / 2, p.y - p.size / 2, p.size, p.size); ctx.globalAlpha = 1; },
    },
    fireflies: {
      n: 38,
      make(w, h) { return { x: rand(0, w), y: rand(h * 0.2, h), vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), ph: rand(0, TAU), sp: rand(0.8, 1.6), size: rand(10, 18) }; },
      step(p, dt, w, h) {
        p.vx += rand(-0.03, 0.03) * dt; p.vy += rand(-0.03, 0.03) * dt;
        p.vx = Math.max(-0.5, Math.min(0.5, p.vx)); p.vy = Math.max(-0.5, Math.min(0.5, p.vy));
        p.x = (p.x + p.vx * dt + w) % w; p.y = Math.max(0, Math.min(h, p.y + p.vy * dt));
        return true;
      },
      draw(p) {
        const a = Math.max(0, Math.sin(state.t / 600 * p.sp + p.ph));
        ctx.globalAlpha = a * a;
        ctx.drawImage(glow("rgba(210,255,120,0.95)", 24), p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.globalAlpha = 1;
      },
    },
    sparkles: {
      n: 45,
      make(w, h) { return { x: rand(0, w), y: rand(0, h), life: 0, max: rand(60, 140), size: rand(3, 7), hue: Math.random() < 0.6 ? 45 : 280 }; },
      step(p, dt) { p.life += dt; p.y -= 0.15 * dt; return p.life < p.max; },
      draw(p) {
        const k = Math.sin(Math.PI * p.life / p.max), s = p.size * k;
        ctx.fillStyle = `hsla(${p.hue},100%,80%,${0.9 * k})`;
        ctx.beginPath(); // a four-pointed star
        ctx.moveTo(p.x, p.y - s * 2); ctx.lineTo(p.x + s * 0.4, p.y - s * 0.4); ctx.lineTo(p.x + s * 2, p.y);
        ctx.lineTo(p.x + s * 0.4, p.y + s * 0.4); ctx.lineTo(p.x, p.y + s * 2); ctx.lineTo(p.x - s * 0.4, p.y + s * 0.4);
        ctx.lineTo(p.x - s * 2, p.y); ctx.lineTo(p.x - s * 0.4, p.y - s * 0.4); ctx.closePath(); ctx.fill();
      },
    },
    stars: {
      n: 120,
      make(w, h) { return { x: rand(0, w), y: rand(0, h), r: rand(0.5, 1.6), ph: rand(0, TAU), sp: rand(0.5, 2) }; },
      step() { return true; },
      draw(p) { const a = 0.35 + 0.65 * Math.abs(Math.sin(state.t / 1400 * p.sp + p.ph)); ctx.fillStyle = `rgba(235,235,255,${a * 0.8})`; ctx.fillRect(p.x, p.y, p.r, p.r); },
      frame(dt) { // the occasional shooting star
        if (!state.shoot && Math.random() < 0.004 * dt) state.shoot = { x: rand(0, state.w * 0.7), y: rand(0, state.h * 0.4), life: 0 };
        const s = state.shoot;
        if (s) {
          s.life += dt; s.x += 9 * dt; s.y += 4 * dt;
          const g = ctx.createLinearGradient(s.x, s.y, s.x - 90, s.y - 40);
          g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - 90, s.y - 40); ctx.stroke();
          if (s.life > 45) state.shoot = null;
        }
      },
    },
    bubbles: {
      n: 45,
      make(w, h, init) { return { x: rand(0, w), y: init ? rand(0, h) : h + 20, r: rand(2, 7), s: rand(0.4, 1.3), ph: rand(0, TAU) }; },
      step(p, dt) { p.y -= p.s * dt; p.x += Math.sin(state.t / 400 + p.ph) * 0.4 * dt; return p.y > -20; },
      draw(p) { ctx.strokeStyle = "rgba(170,225,255,0.45)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(p.x - p.r * 0.4, p.y - p.r * 0.5, 1.2, 1.2); },
    },
    sand: {
      n: 110,
      make(w, h, init) { return { x: init ? rand(0, w) : -40, y: rand(0, h), l: rand(8, 30), s: rand(5, 11), a: rand(0.1, 0.3) }; },
      step(p, dt) { p.x += p.s * dt; p.y += Math.sin(state.t / 300 + p.l) * 0.3 * dt; return p.x < state.w + 40; },
      draw(p) { ctx.strokeStyle = `rgba(225,190,130,${p.a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l, p.y); ctx.stroke(); },
    },
    leaves: {
      n: 34,
      make(w, h, init) { return { x: rand(0, w), y: init ? rand(0, h) : -20, s: rand(0.5, 1.2), rot: rand(0, TAU), vr: rand(-0.04, 0.04), ph: rand(0, TAU), size: rand(5, 9), hue: rand(10, 45) }; },
      step(p, dt) { p.y += p.s * dt; p.x += Math.sin(state.t / 800 + p.ph) * 0.9 * dt; p.rot += p.vr * dt; return p.y < state.h + 20; },
      draw(p) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = `hsla(${p.hue},75%,45%,0.75)`;
        ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, TAU); ctx.fill(); ctx.restore(); },
    },
    petals: {
      n: 40,
      make(w, h, init) { return { x: init ? rand(0, w) : rand(-w * 0.3, w), y: init ? rand(0, h) : -15, s: rand(0.5, 1.1), rot: rand(0, TAU), vr: rand(-0.05, 0.05), size: rand(3, 6) }; },
      step(p, dt) { p.y += p.s * dt; p.x += 0.5 * dt; p.rot += p.vr * dt; return p.y < state.h + 20 && p.x < state.w + 20; },
      draw(p) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = "rgba(255,190,215,0.75)";
        ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, TAU); ctx.fill(); ctx.restore(); },
    },
    confetti: {
      n: 60,
      make(w, h, init) { return { x: rand(0, w), y: init ? rand(0, h) : -10, s: rand(0.8, 1.8), rot: rand(0, TAU), vr: rand(-0.12, 0.12), hue: [45, 0, 200, 120, 280][Math.floor(rand(0, 5))], size: rand(3, 6) }; },
      step(p, dt) { p.y += p.s * dt; p.rot += p.vr * dt; p.x += Math.sin(p.rot) * 0.4 * dt; return p.y < state.h + 10; },
      draw(p) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = `hsla(${p.hue},85%,62%,0.8)`; ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore(); },
    },
    fog: {
      n: 9,
      make(w, h) { return { x: rand(-w * 0.3, w), y: rand(h * 0.1, h), r: rand(180, 380), s: rand(0.15, 0.4), a: rand(0.05, 0.09) }; },
      step(p, dt, w) { p.x += p.s * dt; if (p.x - p.r > w) p.x = -p.r; return true; },
      draw(p) { const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(200,200,215,${p.a})`); g.addColorStop(1, "rgba(200,200,215,0)");
        ctx.fillStyle = g; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); },
    },
    dust: {
      n: 45,
      make(w, h) { return { x: rand(0, w), y: rand(0, h), vx: rand(-0.12, 0.12), vy: rand(-0.12, 0.05), size: rand(3, 7), ph: rand(0, TAU) }; },
      step(p, dt, w, h) { p.x = (p.x + p.vx * dt + w) % w; p.y = (p.y + p.vy * dt + h) % h; return true; },
      draw(p) { ctx.globalAlpha = 0.35 + 0.35 * Math.sin(state.t / 1200 + p.ph); ctx.drawImage(glow("rgba(255,215,150,0.8)", 16), p.x, p.y, p.size, p.size); ctx.globalAlpha = 1; },
    },
    // Candlelight: the page goes dark except a flickering pool of warm light that follows the
    // cursor (or, with a remote, the highlighted item). Drawn over the page, but never blocks clicks.
    candle: {
      n: 0,
      frame() {
        const L = state.light;
        L.x += (L.tx - L.x) * 0.12; L.y += (L.ty - L.y) * 0.12;
        const flicker = 1 + Math.sin(state.t / 90) * 0.02 + Math.sin(state.t / 37) * 0.015 + rand(-0.012, 0.012);
        const R = Math.min(state.w, state.h) * 0.36 * flicker;
        ctx.fillStyle = "rgba(6,4,2,0.64)";
        ctx.fillRect(0, 0, state.w, state.h);
        ctx.globalCompositeOperation = "destination-out"; // cut the pool of light out of the darkness
        const hole = ctx.createRadialGradient(L.x, L.y, R * 0.15, L.x, L.y, R);
        hole.addColorStop(0, "rgba(0,0,0,1)"); hole.addColorStop(0.55, "rgba(0,0,0,0.85)"); hole.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = hole; ctx.fillRect(0, 0, state.w, state.h);
        ctx.globalCompositeOperation = "lighter"; // and warm it up
        const warm = ctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, R * 0.9);
        warm.addColorStop(0, `rgba(255,160,70,${0.1 * flicker})`); warm.addColorStop(1, "rgba(255,160,70,0)");
        ctx.fillStyle = warm; ctx.fillRect(0, 0, state.w, state.h);
        ctx.globalCompositeOperation = "source-over";
      },
    },
  };

  addEventListener("pointermove", e => { if (e.pointerType === "mouse") { state.light.tx = e.clientX; state.light.ty = e.clientY; } }, { passive: true });
  document.addEventListener("focusin", e => { // with a remote, the light follows the highlighted item
    const r = e.target.getBoundingClientRect && e.target.getBoundingClientRect();
    if (r && r.width) { state.light.tx = r.left + r.width / 2; state.light.ty = r.top + r.height / 2; }
  });

  function seed() {
    const fx = EFFECTS[state.kind];
    const scale = Math.max(0.4, Math.min(1.6, (state.w * state.h) / (1280 * 720))) * (state.lite ? 0.5 : 1);
    state.parts = Array.from({ length: Math.round(fx.n * scale) }, () => fx.make(state.w, state.h, true));
  }

  function loop(now) {
    const fx = EFFECTS[state.kind];
    if (!fx) return;
    const dt = Math.min(3, (now - (state.last || now)) / 16.7); // 1 = one frame at 60 fps
    state.last = now;
    state.t = now;
    ctx.clearRect(0, 0, state.w, state.h);
    for (let i = 0; i < state.parts.length; i++) {
      const p = state.parts[i];
      if (!fx.step(p, dt, state.w, state.h)) state.parts[i] = fx.make(state.w, state.h, false);
      fx.draw(state.parts[i]);
    }
    if (fx.frame) fx.frame(dt);
    if (state.flash > 0.01) { ctx.fillStyle = `rgba(220,230,255,${state.flash * 0.18})`; ctx.fillRect(0, 0, state.w, state.h); state.flash *= Math.pow(0.86, dt); }
    state.raf = requestAnimationFrame(loop);
  }

  function start(kind) {
    cancelAnimationFrame(state.raf);
    state.kind = kind;
    state.last = 0;
    state.flash = 0;
    state.shoot = null;
    ctx.clearRect(0, 0, state.w, state.h);
    if (!kind) return;
    seed();
    state.raf = requestAnimationFrame(loop);
    cv.style.opacity = 1;
  }

  let switchTimer;
  // Fade out the current effect, swap, fade the new one in.
  function show(kind) {
    kind = EFFECTS[kind] ? kind : null;
    if (kind === state.want) return;
    state.want = kind;
    clearTimeout(switchTimer);
    cv.style.opacity = 0;
    cv.classList.toggle("fx-candle", kind === "candle");
    switchTimer = setTimeout(() => start(kind), state.kind ? 500 : 0);
  }
  document.addEventListener("visibilitychange", () => { // don't animate a hidden tab
    if (document.hidden) cancelAnimationFrame(state.raf);
    else if (state.kind) { state.last = 0; state.raf = requestAnimationFrame(loop); }
  });

  // ---------- critical hits and fumbles ----------
  const layer = () => document.getElementById("trail");
  function burst(el) {
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < 28; i++) {
      const p = document.createElement("i");
      const star = i % 3 !== 0;
      p.className = "crit-p " + (star ? "crit-star" : "crit-die");
      if (!star) p.textContent = "⬢";
      const ang = rand(0, TAU), dist = rand(70, 190);
      p.style.left = cx + "px";
      p.style.top = cy + "px";
      p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      p.style.setProperty("--dy", Math.sin(ang) * dist - 40 + "px");
      p.style.setProperty("--rot", rand(-360, 360) + "deg");
      p.style.animationDelay = rand(0, 0.08) + "s";
      layer().appendChild(p);
      p.addEventListener("animationend", () => p.remove());
    }
    banner("NATURAL 20!", "crit-text", cx, cy);
  }
  function banner(text, cls, x, y) {
    const b = document.createElement("div");
    b.className = cls;
    b.textContent = text;
    b.style.left = x + "px";
    b.style.top = y + "px";
    layer().appendChild(b);
    b.addEventListener("animationend", () => b.remove());
  }
  function fumble(el, shakeEl) {
    const r = el.getBoundingClientRect();
    el.classList.remove("fumbling"); void el.offsetWidth; el.classList.add("fumbling");
    shakeEl.classList.remove("shake"); void shakeEl.offsetWidth; shakeEl.classList.add("shake");
    banner("Natural 1…", "fumble-text", r.left + r.width / 2, r.top);
  }

  window.GrimoireFX = {
    show,                                   // show("rain") / show(null)
    current: () => state.want,              // which effect is showing (or null)
    kinds: Object.keys(EFFECTS),
    setLite(on) { state.lite = on; if (state.kind) seed(); }, // fewer particles on TVs
    burst, fumble,
  };
})();
