/* The Bard's Grimoire — app logic (no build step; SortableJS from a CDN for drag & drop) */
(() => {
  "use strict";

  const BASE = window.GRIMOIRE || { groups: [], categories: [], tags: [] };
  // the library stores each icon once (many themes share one); themes refer to it by name
  for (const c of BASE.categories) c.icon = (BASE.icons || {})[c.icon] || c.icon;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const app = $("#app");

  // ---------- persisted state ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("grimoire." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("grimoire." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // This browser's identity: a random key, never shown. The server stores only a
  // hash of it on the themes this device creates, and lets only this device (or
  // the host PC) change or delete them. No accounts, no passwords.
  const deviceKey = (() => {
    let k = store.get("deviceKey", null);
    if (!k) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes); // works on plain http too, unlike crypto.subtle / randomUUID
      k = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
      store.set("deviceKey", k);
    }
    return k;
  })();
  // Owner keys brought over from other browsers (backup file or typed in), so themes
  // made there stay editable here. This browser's own key always goes first.
  let extraKeys = store.get("ownerKeys", []);
  const keyHeader = () => [deviceKey, ...extraKeys].join(",");

  // ---------- the library = built-in themes + what people added ----------
  // user = { categories: [{id,name,tagline,hue,icon,videos:[…],owner,open,yours}],  // their own themes
  //          added:  {themeId: [video…]},   // tracks added to built-in themes
  //          order:  {themeId: [videoId…]}, // drag-and-drop order of built-in themes
  //          hidden: {themeId: [videoId…]}, // built-in tracks removed from a theme
  //          trash:  [{id,kind,deletedAt,…}] } // "Recently deleted", kept 30 days
  let user = { categories: [], added: {}, order: {}, hidden: {}, trash: [] };
  const TRASH_DAYS = 30;
  const LIB = {
    ...BASE,
    groups: [{ id: "mine", name: "My Themes", tagline: "Your own scenes and playlists" }, ...BASE.groups],
    categories: [],
  };
  let catById = new Map(), videoById = new Map(), TOTAL = 0;
  const TAG_WORDS = [...(BASE.tags || []), ["added", []]]; // [[tag, [words that earn the tag]], ...]
  const TAG_RES = TAG_WORDS.filter(([, w]) => w.length).map(([t, words]) =>
    [t, new RegExp("(?:^|\\W)(?:" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")s?(?!\\w)", "i")]);

  // Same hashtag rules as tools/build_library.py, so added tracks are searchable too.
  function autoTag(v) {
    const title = v.title.replace(/’/g, "'").replace(/dungeons? ?(?:&|and|n') ?dragons/gi, " ");
    return ["added", ...TAG_RES.filter(([, rx]) => rx.test(title)).map(([t]) => t)];
  }
  const iconSvg = key => (BASE.categories.find(c => c.id === key) || BASE.categories[0] || { icon: "" }).icon;
  function applyOrder(vids, order) {
    if (!order || !order.length) return vids;
    const pos = new Map(order.map((id, i) => [id, i]));
    return vids.map((v, i) => [pos.has(v.id) ? pos.get(v.id) : order.length + i, v]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  }

  function rebuildLibrary() {
    const base = BASE.categories.map(c => {
      const hidden = new Set(user.hidden[c.id] || []);
      const vids = c.videos.filter(v => !hidden.has(v.id)).concat(user.added[c.id] || []);
      return { ...c, videos: applyOrder(vids, user.order[c.id]) };
    });
    const mine = user.categories.map(u => ({
      id: u.id, name: u.name, tagline: u.tagline || "", group: "mine", hue: u.hue, icon: iconSvg(u.icon),
      custom: true, videos: u.videos, yours: u.yours !== false, open: !!u.open,
    }));
    for (const u of [...user.categories.flatMap(c => c.videos), ...Object.values(user.added).flat()]) {
      u.mine = true;
      u.tags = autoTag(u);
    }
    LIB.categories = [...base, ...mine];
    catById = new Map(LIB.categories.map(c => [c.id, c]));
    videoById = new Map();
    for (const c of LIB.categories) for (const v of c.videos) {
      // a chart (Most Popular) can list a track that also lives in its own theme; keep the theme copy
      if (!videoById.has(v.id)) { v.cat = c.id; videoById.set(v.id, v); }
    }
    TOTAL = videoById.size;
    // favorites brought from another copy of the site may be tracks this library doesn't have
    for (const v of Object.values(store.get("extraVideos", {}))) {
      if (!videoById.has(v.id)) { v.cat = null; v.tags = autoTag(v); videoById.set(v.id, v); }
    }
    TAG_COUNT.clear();
    for (const v of videoById.values()) for (const t of v.tags || []) TAG_COUNT.set(t, (TAG_COUNT.get(t) || 0) + 1);
    FEATURED_TAGS = FEATURED.filter(t => TAG_COUNT.has(t));
  }

  // ---------- saving what people add: shared file via serve.py, else this browser ----------
  // server: saved in serve.py's shared file · host: this is the PC running serve.py (may edit anything)
  // rev: the file's revision this page last saw — saves based on an older one are refused, not merged
  const sync = { server: false, host: false, public: false, rev: 0, dirty: false, inflight: false, saving: false };
  const everyone = () => (sync.public ? "everyone who uses this site" : "every device on your Wi-Fi");
  function normalizeUser(d) {
    d = d && typeof d === "object" ? d : {};
    const obj = x => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
    return {
      categories: Array.isArray(d.categories) ? d.categories.filter(c => c && c.id && Array.isArray(c.videos)) : [],
      added: obj(d.added), order: obj(d.order), hidden: obj(d.hidden),
      trash: Array.isArray(d.trash) ? d.trash.filter(e => e && e.id && e.kind) : [],
    };
  }
  const cleanVideo = v => ({ id: v.id, title: v.title, channel: v.channel || "", length: v.length || 0, views: v.views || 0 });
  const cleanTheme = c => ({ id: c.id, name: c.name, tagline: c.tagline || "", hue: c.hue, icon: c.icon,
    owner: c.owner || null, open: !!c.open, videos: c.videos.map(cleanVideo) });
  function userJSON() {
    return JSON.stringify({
      version: 2,
      categories: user.categories.map(cleanTheme),
      added: Object.fromEntries(Object.entries(user.added).filter(([, l]) => l.length).map(([k, l]) => [k, l.map(cleanVideo)])),
      order: user.order, hidden: user.hidden, trash: user.trash,
    });
  }
  async function fetchUserData() {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch("api/user-data", { cache: "no-store", signal: ctrl.signal, headers: { "X-Device-Key": keyHeader() } });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) return { server: true, data: await r.json() };
    } catch { /* static hosting, or serve.py isn't running */ }
    return { server: false, data: store.get("userData", null) };
  }
  function adoptServer(data) {
    user = normalizeUser(data);
    sync.rev = data.rev || 0;
    sync.host = !!data.host;
    sync.public = !!data.public; // hosted on the internet (e.g. Railway) rather than on a home PC
  }
  async function loadUserData() {
    const { server, data } = await fetchUserData();
    sync.server = server;
    if (server) adoptServer(data);
    else { user = normalizeUser(data); purgeLocalTrash(); }
  }
  function purgeLocalTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    user.trash = user.trash.filter(e => e.deletedAt >= cutoff);
  }

  let saveTimer;
  function saveUser() {
    if (!sync.server) { purgeLocalTrash(); store.set("userData", JSON.parse(userJSON())); return; }
    sync.dirty = sync.saving = true; // a background pull must not overwrite this before it lands
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 250);
  }
  // One save at a time, each based on the revision the previous one produced.
  async function flushSave() {
    if (sync.inflight || !sync.dirty) return;
    sync.inflight = true;
    sync.dirty = false;
    let res = null, body = {};
    try {
      res = await fetch("api/user-data", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Device-Key": keyHeader() },
        body: JSON.stringify({ rev: sync.rev, data: JSON.parse(userJSON()) }),
      });
      body = await res.json().catch(() => ({}));
    } catch { /* network */ }
    sync.inflight = false;
    if (res && res.ok) {
      sync.rev = body.rev;
      sync.host = !!body.data.host;
      // the server fills in who owns brand-new themes
      for (const c of body.data.categories) {
        const u = user.categories.find(x => x.id === c.id);
        if (u) { u.owner = c.owner; u.yours = c.yours; u.open = !!c.open; }
      }
    } else if (res && (res.status === 409 || res.status === 403) && body.data) {
      // refused: show what's really saved, and say why
      sync.dirty = false;
      adoptServer(body.data);
      rebuildLibrary();
      refreshView();
      toast(res.status === 409
        ? "⚠ Another device changed the library at the same moment, so your last change wasn't saved. Please try it again."
        : "🔒 " + body.error, { ms: 6500 });
    } else {
      toast("⚠ Couldn't save to the shared library — " + (body.error || "is serve.py still running?"), { ms: 6500 });
    }
    if (sync.dirty) return flushSave();
    sync.saving = false;
  }
  function commitUser() { saveUser(); rebuildLibrary(); }

  // Who may do what. Built-in themes are shared by everyone (and fully recoverable);
  // a theme someone made belongs to their device unless they opened it to everyone.
  const canEdit = c => !c.custom || !sync.server || sync.host || c.yours || c.open;
  const canDelete = c => !c.custom || !sync.server || sync.host || c.yours;

  let favorites = store.get("favorites", []);
  let recent = store.get("recent", []);

  const state = {
    query: "",
    queue: [],         // the list playback continues through (a theme, search results…)
    index: -1,
    now: null,         // the track loaded in the player (may come from Up Next, not `queue`)
    upNext: store.get("upNext", []), // ids the user queued; they play before the list continues
    editing: null,     // list being edited (shows remove buttons)
    shuffle: store.get("shuffle", false),
    loop: store.get("loop", false),
    autoMins: store.get("autoMins", 0), // change to a random track every N minutes (0 = off)
    volume: store.get("playerVolume", 100),
    playing: false,
    theater: false,
    mode: store.get("mode", "here"), // "here" = built-in player, "yt" = open on YouTube
  };

  // ---------- helpers ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = secs => {
    secs = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  const fmtViews = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);
  const sigil = (c, extra = "") =>
    `<span class="sigil ${extra}" style="--h:${c.hue}"><svg viewBox="0 0 512 512" aria-hidden="true">${c.icon}</svg></span>`;
  const icons = {
    play: `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>`,
    ext: `<svg class="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
    shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h4l10 12h4M3 18h4l3-3.6M14 9.6 17 6h4M18 3l3 3-3 3M18 15l3 3-3 3"/></svg>`,
    back: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
    d20: `<svg viewBox="0 0 512 512">${$(".brand-die").innerHTML.replace(/<path/g, '<path fill="currentColor"')}</svg>`,
    grip: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`,
    queueAdd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h11M4 12h11M4 18h7M18 14v6M15 17h6"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
    grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>`,
    share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`,
  };
  const rollButton = key => `<button class="btn" type="button" data-roll="${key}">${icons.d20}Roll a track</button>`;

  // ---------- the site's name: anyone can rename it, for their own browser only ----------
  const DEFAULT_TITLE = "The Bard's Grimoire";
  let siteTitle = store.get("siteTitle", "") || DEFAULT_TITLE;
  function applySiteTitle() {
    // the last word gets the decorative gold style, like "The Bard's *Grimoire*"
    const words = siteTitle.trim().split(/\s+/), last = words.pop();
    $(".brand-text").innerHTML = (words.length ? esc(words.join(" ")) + " " : "") + `<em>${esc(last)}</em>`;
    $(".brand").setAttribute("aria-label", `${siteTitle} — home`);
    document.title = state.now ? `${state.now.title} · ${siteTitle}` : siteTitle;
  }
  function openRenameSite() {
    openModal(`
      <h2>Rename this site</h2>
      <p class="muted">Give it your own name — for example your campaign or your group. Only this browser sees the change; everyone else keeps their own name.</p>
      <label class="field"><span>Site name</span>
        <input id="fSiteTitle" maxlength="40" value="${esc(siteTitle)}" placeholder="${esc(DEFAULT_TITLE)}" autofocus></label>
      <div class="modal-actions">
        ${siteTitle !== DEFAULT_TITLE ? `<button class="btn" type="button" id="fSiteReset">Use the original name</button>` : ""}
        <button class="btn" type="button" data-close-modal>Cancel</button>
        <button class="btn btn-gold" type="button" id="fSubmit">Save</button>
      </div>`, () => {
      const t = $("#fSiteTitle").value.trim().replace(/\s+/g, " ");
      siteTitle = t || DEFAULT_TITLE;
      store.set("siteTitle", siteTitle === DEFAULT_TITLE ? "" : siteTitle);
      applySiteTitle();
      closeModal();
      toast(`This browser now calls the site “${siteTitle}”`);
    });
    const input = $("#fSiteTitle");
    input.setSelectionRange(input.value.length, input.value.length);
    if ($("#fSiteReset")) $("#fSiteReset").onclick = () => { input.value = DEFAULT_TITLE; modalSubmit(); };
  }

  // A short message; with { undo } it gets an Undo button and stays up longer.
  let toastTimer;
  function toast(msg, { undo, ms } = {}) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="toast-btn" type="button">Undo</button>` : ""}`;
    t.classList.toggle("has-action", !!undo);
    if (undo) $(".toast-btn", t).onclick = () => { t.classList.remove("show"); undo(); };
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms || (undo ? 9000 : 2600));
  }

  // ---------- rendering ----------
  function themeCard(c) {
    return `<a class="theme-card" href="#/t/${c.id}" style="--h:${c.hue}" data-key="t-${c.id}">
      ${sigil(c)}
      <span><h3>${esc(c.name)}</h3><p>${esc(c.tagline)}</p><div class="count">${c.videos.length} tracks${
        !c.custom || !sync.server ? "" : c.yours ? "" : c.open ? " · open to all" : " · 🔒 another device's"}</div></span>
    </a>`;
  }

  // A track card. The tool buttons (drag, queue, remove) sit beside the card
  // button, not inside it, and are skipped by remote navigation (tabindex -1):
  // on a TV, OK plays and the Q / green key queues the focused card instead.
  function videoCard(v, listKey, i, showTheme = false, { sortable = false, removable = false } = {}) {
    const c = catById.get(v.cat) || { name: "" };
    const playing = current() && current().id === v.id ? " is-playing" : "";
    return `<div class="vc" data-vid="${v.id}">
      <button class="video-card${playing}" type="button" data-vid="${v.id}" data-list="${listKey}" data-i="${i}" data-key="v-${listKey}-${v.id}">
        <div class="thumb">
          <img loading="lazy" src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="">
          ${v.length ? `<span class="badge">${fmtTime(v.length)}</span>` : ""}
          ${listKey === "t-popular" ? `<span class="rank">${i + 1}</span>` : ""}
          <span class="play-hint"><span>${icons.play.replace("<svg", '<svg class="i-play"')}${icons.ext}</span></span>
          <span class="eq"><i></i><i></i><i></i><i></i></span>
        </div>
        <h3>${esc(v.title)}</h3>
        <div class="meta">${showTheme && c.name ? `<span class="tag">${esc(c.name)}</span> · ` : ""}${esc(v.channel)}${v.views ? " · " + fmtViews(v.views) + " views" : ""}</div>
        ${v.tags && v.tags.length ? `<div class="card-tags">${v.tags.slice(0, 4).map(t => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
      </button>
      <div class="card-tools">
        ${sortable ? `<button class="tool drag-handle" type="button" tabindex="-1" aria-label="Drag to reorder" title="Drag to reorder">${icons.grip}</button>` : ""}
        <button class="tool tool-queue" type="button" tabindex="-1" data-queue-one="${v.id}" aria-label="Add to queue" title="Add to queue">${icons.queueAdd}</button>
        ${removable ? `<button class="tool tool-remove" type="button" tabindex="-1" data-remove="${v.id}" aria-label="Remove from this list" title="Remove from this list">✕</button>` : ""}
      </div>
    </div>`;
  }

  // Cards that open the "Add music" dialog, shown in the My Themes group.
  const addCards = () => `
    <button class="theme-card add-card" type="button" data-open-add="__new" data-key="add-theme">
      <span class="sigil" style="--h:38">${icons.plus}</span>
      <span><h3>New theme</h3><p>Your own scene or playlist</p></span>
    </button>
    <button class="theme-card add-card" type="button" data-open-add="" data-key="add-links">
      <span class="sigil" style="--h:0">${icons.link}</span>
      <span><h3>Add YouTube links</h3><p>Videos or whole playlists</p></span>
    </button>`;

  // ---------- search: words, #hashtags and their synonyms ----------
  const TAG_COUNT = new Map();
  // Tags offered as one-tap chips (typing on a TV remote is painful); only those that exist are shown.
  let FEATURED_TAGS = [];
  const FEATURED = ["added", "popular", "ruins", "dragon", "rain", "storm", "fire", "night", "undead", "vampire", "ghost", "demon",
    "witch", "wizard", "fairy", "elven", "dwarven", "pirate", "sea", "underwater", "sky", "desert", "jungle", "winter",
    "mountain", "forest", "swamp", "volcano", "cave", "dungeon", "tomb", "castle", "royal", "church", "city", "village",
    "tavern", "market", "potion", "library", "boss", "battle", "chase", "stealth", "thieves", "mystery", "puzzle",
    "planning", "travel", "rest", "celebration", "epic", "horror", "dark", "tense", "sad", "calm", "whimsical", "space",
    "cyberpunk", "cthulhu", "western", "norse", "eastern", "steampunk", "choir", "celtic", "no-music", "no-ai", "long",
  ];

  const tagChip = (t, extra = "") =>
    `<button class="tag-chip" type="button" data-tag="${esc(t)}" data-key="tag-${esc(t)}">#${esc(t)}${extra}</button>`;

  // Which tags does one query word refer to? "#ruins" -> ruins only; "abandoned" -> ruins; "rui" -> ruins.
  function tagsForToken(tok, exactOnly) {
    const out = new Set();
    for (const [tag, words] of TAG_WORDS) {
      if (tag === tok) { out.add(tag); continue; }
      if (exactOnly) continue;
      if (tok.length >= 4 && tag.startsWith(tok)) { out.add(tag); continue; }
      if (words.some(w => w === tok || (tok.length >= 4 && w.startsWith(tok)) ||
          (w.length >= 3 && tok.startsWith(w) && /^(s|es|ed|ing|er|y)$/.test(tok.slice(w.length))))) out.add(tag); // rains, ruined — not sky+rim
    }
    return out;
  }

  function parseQuery(q) {
    q = q.trim().toLowerCase().replace(/\s+/g, " ");
    if (!q) return [];
    // multi-word tag phrases ("no music", "long rest", "wild west") stay together
    const phrase = q.replace(/^#/, "");
    // each word's title pattern is built once per search, not once per track (there are thousands)
    const withRx = t => ({ ...t, rx: new RegExp("(^|\\W)" + t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
    if (phrase.includes(" ") && TAG_WORDS.some(([, words]) => words.includes(phrase)))
      return [withRx({ text: phrase, tags: tagsForToken(phrase), hash: false })];
    return q.split(" ").map(raw => {
      const hash = raw.startsWith("#"), text = raw.replace(/^#+/, "");
      return withRx({ text, hash, tags: tagsForToken(text, hash) });
    }).filter(t => t.text);
  }

  function scoreVideo(v, tok) {
    const c = catById.get(v.cat) || { name: "" }; // favorites brought from elsewhere have no theme here
    let s = 0;
    if ((v.tags || []).some(t => tok.tags.has(t))) s += (v.tags.includes(tok.text) ? 6 : 4);
    if (tok.hash && !s) return 0; // #tag searches only match tagged videos
    if (tok.rx.test(v.title)) s += 3; // also ranks "#ruins" hits that say "ruins" in the title first
    if (!tok.hash) {
      if (c.name.toLowerCase().includes(tok.text)) s += 2;
      if (v.channel.toLowerCase().includes(tok.text)) s += 1;
    }
    return s;
  }

  function runSearch(q) {
    const toks = parseQuery(q);
    if (!toks.length) return { toks, vids: [], themes: [], related: [] };
    const scored = [];
    for (const v of videoById.values()) {
      let total = 0, all = true;
      for (const tok of toks) { const s = scoreVideo(v, tok); if (!s) { all = false; break; } total += s; }
      if (all) scored.push([total, v]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1].views - a[1].views);
    const vids = scored.map(x => x[1]);
    const hits = new Set(vids.map(v => v.id));
    // A theme matches by name, or when most of its tracks match.
    const byName = c => toks.every(t => (c.name + " " + c.tagline + " " + c.id).toLowerCase().includes(t.text));
    const themes = LIB.categories.filter(c => byName(c) ||
      c.videos.filter(v => hits.has(v.id)).length >= Math.max(3, c.videos.length / 2))
      .sort((a, b) => byName(b) - byName(a)); // themes named after the search come first
    // Related tags: most common among the results, excluding what was searched.
    const searched = new Set(toks.flatMap(t => [...t.tags]));
    const counts = new Map();
    for (const v of vids) for (const t of v.tags || []) if (!searched.has(t)) counts.set(t, (counts.get(t) || 0) + 1);
    const related = [...counts].filter(([t]) => !["ambience", "long", "medieval"].includes(t))
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);
    return { toks, vids, themes, related };
  }

  // Lists referenced by video cards so a click knows which queue to play.
  const lists = new Map();
  function registerList(key, videos) { lists.set(key, videos); return videos; }

  function arcaneCircle() {
    const runes = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ".repeat(2);
    return `<svg class="hero-circle" viewBox="0 0 400 400" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="200" cy="200" r="196" stroke-width="1"/><circle cx="200" cy="200" r="184" stroke-width="2"/>
      <circle cx="200" cy="200" r="150" stroke-width="1"/><circle cx="200" cy="200" r="90" stroke-width="1"/>
      <path id="rp" d="M200 33a167 167 0 1 1 0 334a167 167 0 1 1 0-334" stroke="none"/>
      <text font-size="17" fill="currentColor" stroke="none" letter-spacing="7"><textPath href="#rp">${runes}</textPath></text>
      <path d="M200 50 330 275H70zM200 350 70 125h260z" stroke-width="1.2"/>
      <path d="M200 10v380M10 200h380" stroke-width=".6" stroke-dasharray="2 6"/>
    </svg>`;
  }

  // The home page = hero (with the big search + tag chips) + a body that is
  // either the theme index or search results. Typing only re-renders the body,
  // so the search box keeps focus.
  function renderHome() {
    document.documentElement.style.setProperty("--theme-hue", 38);
    app.innerHTML = `<section class="hero" id="hero">
      ${arcaneCircle()}
      <p class="eyebrow">Music &amp; ambience for your table</p>
      <h1>Set the Scene</h1>
      <p class="lede">${LIB.categories.length} themes and ${TOTAL} tracks for every moment of your campaign — from the first tavern brawl to the final boss.</p>
      <div class="hero-search">
        <label class="big-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="heroSearch" type="search" autocomplete="off" spellcheck="false" data-key="hero-search"
            placeholder="Search ${TOTAL} tracks — try ruins, rain, dragon or #tavern" value="${esc(state.query)}">
          <button class="clear-search" id="clearSearch" type="button" aria-label="Clear search">✕</button>
        </label>
        <div class="tag-cloud" id="tagCloud"></div>
      </div>
      <div class="hero-actions">
        <button class="btn btn-gold" id="rollBtn" type="button">${icons.d20}Roll for a scene</button>
        ${favorites.length ? `<a class="btn" href="#/favorites">Your favorites (${favorites.length})</a>` : ""}
      </div>
    </section>
    <div id="homeBody"></div>`;
    renderHomeBody();
  }

  // Featured tags: a row or two of favourites, plus a link to the page with every hashtag.
  const TAGS_COLLAPSED = 16;
  function renderTagCloud() {
    const cloud = $("#tagCloud");
    if (!cloud) return;
    const active = new Set(parseQuery(state.query).filter(t => t.tags.size === 1).flatMap(t => [...t.tags]));
    const shown = FEATURED_TAGS.filter((t, i) => i < TAGS_COLLAPSED || active.has(t));
    cloud.innerHTML = shown.map(t => tagChip(t)).join("") +
      `<a class="tag-chip more" href="#/tags" data-key="more-tags">All ${TAG_COUNT.size} hashtags →</a>`;
    $$(".tag-chip", cloud).forEach(ch => ch.dataset.tag && ch.setAttribute("aria-pressed", active.has(ch.dataset.tag)));
  }

  function renderHomeBody() {
    const body = $("#homeBody");
    if (!body) return;
    const q = state.query.trim();
    $("#hero").classList.toggle("searching", !!q);
    $("#clearSearch").hidden = !q;
    renderTagCloud();
    let html = "";

    if (q) {
      const { vids, themes, related } = runSearch(q);
      const shown = registerList("search", vids.slice(0, 120));
      html += `<section class="section results"><div class="section-head"><h2>Results for “${esc(q)}”</h2><p>${vids.length} track${vids.length === 1 ? "" : "s"}</p></div>`;
      if (shown.length) html += `<div class="hero-actions results-actions">
        <button class="btn btn-gold" type="button" data-playall="search">${icons.play}Play all</button>
        ${rollButton("search")}</div>`;
      if (related.length) html += `<div class="related"><span>Related:</span>${related.map(t => tagChip(t)).join("")}</div>`;
      if (!themes.length && !vids.length) html += `<div class="empty"><h2>The oracle is silent</h2><p>Nothing matched. Try one of the tags above — like #ruins, #rain or #tavern.</p></div>`;
      if (themes.length) html += `<div class="theme-grid">${themes.slice(0, 16).map(themeCard).join("")}</div>`;
      if (shown.length) html += `<div class="section"><div class="video-grid">${shown.map((v, i) => videoCard(v, "search", i, true)).join("")}</div></div>`;
      html += `</section>`;
      body.innerHTML = html;
      return;
    }

    if (recent.length) {
      const vids = registerList("recent", recent.map(id => videoById.get(id)));
      html += `<section class="section"><div class="section-head"><h2>Recently played</h2></div>
        <div class="shelf">${vids.map((v, i) => videoCard(v, "recent", i, true)).join("")}</div></section>`;
    }

    // quick jump to any group — with ~400 themes, the home page only previews each group
    const groups = LIB.groups.filter(g => g.id !== "mine" && LIB.categories.some(c => c.group === g.id));
    html += `<section class="section"><div class="section-head"><h2>Browse</h2><p>${LIB.categories.length} themes in ${groups.length} groups</p></div>
      <div class="browse-chips">${groups.map(g => `<a class="tag-chip" href="#/g/${g.id}" data-key="browse-${g.id}">${esc(g.name)}
        <span class="chip-count">${LIB.categories.filter(c => c.group === g.id).length}</span></a>`).join("")}
        <a class="tag-chip" href="#/tags" data-key="browse-tags">All hashtags</a></div></section>`;

    for (const g of LIB.groups) {
      const cats = LIB.categories.filter(c => c.group === g.id);
      const mine = g.id === "mine";
      if (!cats.length && !mine) continue;
      const where = !mine ? "" : !sync.server ? " · saved in this browser"
        : ` · shared with ${everyone()}` + (sync.host ? (sync.public ? " · you hold the admin key, so you can edit every theme" : " · this is the host PC, so you can edit every theme") : "");
      const links = !mine ? "" : `<span class="section-links">
        <a class="section-link" href="#/transfer" data-key="transfer-link">Share &amp; move</a>
        ${user.trash.length ? `<a class="section-link" href="#/trash" data-key="trash-link">Recently deleted (${user.trash.length})</a>` : ""}</span>`;
      const limit = mine || g.id === "charts" ? Infinity : HOME_PREVIEW;
      const more = cats.length > limit
        ? `<a class="theme-card see-all" href="#/g/${g.id}" data-key="see-${g.id}"><span class="sigil" style="--h:38">${icons.grid}</span>
            <span><h3>See all ${cats.length}</h3><p>Every theme in ${esc(g.name)}</p></span></a>` : "";
      html += `<section class="section" id="g-${g.id}"><div class="section-head"><h2>${esc(g.name)}</h2><p>${esc(g.tagline)}${where}</p>${links}</div>
        <div class="theme-grid">${cats.slice(0, limit).map(themeCard).join("")}${more}${mine ? addCards() : ""}</div></section>`;
    }
    body.innerHTML = html;
  }
  const HOME_PREVIEW = 7; // themes shown per group on the home page (+ a "See all" card)

  // One group, every theme in it.
  function renderGroup(id) {
    const g = LIB.groups.find(x => x.id === id);
    const cats = LIB.categories.filter(c => c.group === id);
    if (!g || !cats.length) return renderNotFound();
    document.documentElement.style.setProperty("--theme-hue", 38);
    const tracks = cats.reduce((n, c) => n + c.videos.length, 0);
    app.innerHTML = `
      <section class="theme-hero" style="--h:38">
        <span class="sigil" style="--h:38">${icons.grid}</span>
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <h1>${esc(g.name)}</h1>
          <p class="tagline">${esc(g.tagline)} · ${cats.length} themes · ${tracks} tracks</p>
        </div>
      </section>
      <div class="theme-grid">${cats.map(themeCard).join("")}</div>`;
  }

  // Every hashtag, sorted by kind (creatures, places, moods…) and then by how many tracks have it.
  function renderTags() {
    document.documentElement.style.setProperty("--theme-hue", 38);
    const facetOf = new Map(TAG_WORDS.map(([t, , f]) => [t, f || "More"]));
    const byFacet = new Map((BASE.facets || ["More"]).map(f => [f, []]));
    for (const [t, n] of TAG_COUNT) {
      const f = facetOf.get(t) || "More";
      if (!byFacet.has(f)) byFacet.set(f, []);
      byFacet.get(f).push([t, n]);
    }
    app.innerHTML = `
      <section class="theme-hero" style="--h:38">
        <span class="sigil" style="--h:38"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 9h14M4 15h14M10 4 8 20M16 4l-2 16"/></svg></span>
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <h1>All hashtags</h1>
          <p class="tagline">${TAG_COUNT.size} hashtags across ${TOTAL} tracks. Pick one to see every track that has it.</p>
        </div>
      </section>
      ${[...byFacet].filter(([, list]) => list.length).map(([f, list]) => `
        <section class="section"><div class="section-head"><h2>${esc(f)}</h2><p>${list.length}</p></div>
          <div class="tag-wall">${list.sort((a, b) => b[1] - a[1]).map(([t, n]) =>
            tagChip(t, `<span class="chip-count">${n}</span>`)).join("")}</div></section>`).join("")}`;
  }

  function renderTheme(id) {
    const c = catById.get(id);
    if (!c) return renderNotFound();
    document.documentElement.style.setProperty("--theme-hue", c.hue);
    const key = "t-" + c.id, chart = c.group === "charts"; // charts are rankings: no reordering
    registerList(key, c.videos);
    const editable = !chart && canEdit(c), deletable = canDelete(c);
    const editing = editable && state.editing === key;
    const customized = !c.custom && (user.order[c.id] || (user.hidden[c.id] || []).length);
    const note = !c.custom || !sync.server || c.yours ? ""
      : !editable ? `<p class="lock-note">🔒 Made on another device. You can play and queue it — only that device (or ${sync.public ? "an admin" : "the PC running the site"}) can change it.</p>`
      : c.open ? `<p class="lock-note">Made on another device and open to everyone: anyone can add, remove and reorder tracks.</p>` : "";
    app.innerHTML = `
      <section class="theme-hero" style="--h:${c.hue}">
        ${sigil(c)}
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <h1>${esc(c.name)}</h1>
          <p class="tagline">${esc(c.tagline)}</p>
          <div class="hero-actions">
            ${c.videos.length ? `<button class="btn btn-gold" type="button" data-playall="${key}">${icons.play}Play all</button>
            <button class="btn" type="button" data-shuffleall="${key}">${icons.shuffle}Shuffle</button>
            ${rollButton(key)}
            <button class="btn btn-queue" type="button" data-queueall="${key}">${icons.queueAdd}Queue all</button>
            <button class="btn" type="button" data-share="${key}">${icons.share}Share</button>` : ""}
            ${editable ? `<button class="btn" type="button" data-open-add="${c.id}">${icons.plus}Add tracks</button>` : ""}
            ${!editable || (!c.videos.length && !c.custom) ? "" : `<button class="btn" type="button" data-edit="${key}" aria-pressed="${editing}">${icons.edit}${editing ? "Done" : "Edit list"}</button>`}
          </div>
          ${note}
          ${editing ? `<div class="edit-bar">
            <span>Drag ${icons.grip} to reorder · ✕ removes a track (you can undo, or restore it from <a href="#/trash">Recently deleted</a>)</span>
            ${c.custom ? `${deletable ? `<button class="link-btn" type="button" data-theme-settings="${c.id}">Rename &amp; style</button>
              <button class="link-btn danger" type="button" data-delete-theme="${c.id}">Delete theme</button>` : ""}`
              : customized ? `<button class="link-btn" type="button" data-reset-theme="${c.id}">Restore original list</button>` : ""}
          </div>` : ""}
        </div>
      </section>
      ${c.videos.length
        ? `<div class="video-grid${editing ? " editing" : ""}" id="trackGrid">${c.videos.map((v, i) =>
            videoCard(v, key, i, false, { sortable: editable, removable: editing })).join("")}</div>`
        : `<div class="empty"><h2>This theme is empty</h2><p>${editable ? "Use <b>Add tracks</b> to paste YouTube videos or playlists." : "Its owner hasn't added any tracks yet."}</p></div>`}`;
    if (editable) makeSortable($("#trackGrid"), ids => reorderTheme(c.id, ids));
  }

  function renderFavorites() {
    document.documentElement.style.setProperty("--theme-hue", 12);
    const vids = registerList("favorites", favorites.map(id => videoById.get(id)).filter(Boolean));
    const editing = state.editing === "favorites";
    app.innerHTML = `
      <section class="theme-hero" style="--h:12">
        <span class="sigil" style="--h:12"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.3A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.6c0 5.7-7.5 10.3-7.5 10.3z"/></svg></span>
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <h1>Favorites</h1>
          <p class="tagline">Your personal spellbook of go-to tracks</p>
          ${vids.length ? `<div class="hero-actions">
            <button class="btn btn-gold" type="button" data-playall="favorites">${icons.play}Play all</button>
            <button class="btn" type="button" data-shuffleall="favorites">${icons.shuffle}Shuffle</button>
            <button class="btn btn-queue" type="button" data-queueall="favorites">${icons.queueAdd}Queue all</button>
            <button class="btn" type="button" data-share="favorites">${icons.share}Share</button>
            <button class="btn" type="button" data-edit="favorites" aria-pressed="${editing}">${icons.edit}${editing ? "Done" : "Edit list"}</button></div>` : ""}
          ${editing ? `<div class="edit-bar"><span>Drag ${icons.grip} to reorder · ✕ removes a favorite</span></div>` : ""}
        </div>
      </section>
      ${vids.length ? `<div class="video-grid${editing ? " editing" : ""}" id="trackGrid">${vids.map((v, i) =>
          videoCard(v, "favorites", i, true, { sortable: true, removable: editing })).join("")}</div>`
        : `<div class="empty"><h2>No favorites yet</h2><p>Play a track and press the ♥ button in the player to save it here.</p></div>`}`;
    makeSortable($("#trackGrid"), ids => { favorites = ids; store.set("favorites", favorites); registerList("favorites", ids.map(id => videoById.get(id))); renumber(); });
  }

  const ago = ms => {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  // Can this device put a trash entry back? (a track goes back into a theme it's allowed to edit)
  function restoreBlocker(e) {
    if (e.kind !== "track") return "";
    const c = catById.get(e.from);
    if (!c) return "Its theme was deleted — restore the theme first";
    return canEdit(c) ? "" : "Only the device that owns this theme can restore it";
  }

  function renderTrash() {
    document.documentElement.style.setProperty("--theme-hue", 0);
    const items = user.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
    const row = e => {
      const blocker = restoreBlocker(e);
      const left = Math.max(1, TRASH_DAYS - Math.floor((Date.now() - e.deletedAt) / 86400000));
      const art = e.kind === "theme"
        ? sigil({ hue: e.theme.hue, icon: iconSvg(e.theme.icon) })
        : `<img src="https://i.ytimg.com/vi/${e.video.id}/mqdefault.jpg" alt="" loading="lazy">`;
      const what = e.kind === "theme"
        ? `<b>Theme “${esc(e.theme.name)}”</b><small>${e.theme.videos.length} tracks`
        : `<b>${esc(e.video.title)}</b><small>from ${esc(e.fromName || e.from)}`;
      return `<div class="trash-row">
        <span class="trash-art">${art}</span>
        <span class="trash-text">${what} · deleted ${ago(e.deletedAt)} · gone in ${left} day${left === 1 ? "" : "s"}</small></span>
        <button class="btn" type="button" data-restore="${e.id}" data-key="restore-${e.id}" ${blocker ? `disabled title="${esc(blocker)}"` : ""}>Restore</button>
      </div>`;
    };
    app.innerHTML = `
      <section class="theme-hero" style="--h:0">
        <span class="sigil" style="--h:0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></span>
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <h1>Recently deleted</h1>
          <p class="tagline">Removed tracks and deleted themes stay here for ${TRASH_DAYS} days${sync.server ? " on every device" : ""}, so nothing is lost by accident. Anyone can restore them.</p>
        </div>
      </section>
      ${items.length ? `<div class="trash-list">${items.map(row).join("")}</div>`
        : `<div class="empty"><h2>Nothing here</h2><p>When someone removes a track or deletes a theme, it waits here for ${TRASH_DAYS} days.</p></div>`}`;
  }

  function renderNotFound() {
    app.innerHTML = `<div class="empty"><h2>You have wandered off the map</h2><p><a href="#/">Return to the index</a></p></div>`;
  }

  // ---------- router ----------
  const focusMemory = new Map(); // route -> { key, scroll }
  let currentRoute = null;

  function renderRoute() {
    const [, kind, arg] = (currentRoute || "/").split("/");
    if (kind === "t") renderTheme(decodeURIComponent(arg || ""));
    else if (kind === "favorites") renderFavorites();
    else if (kind === "trash") renderTrash();
    else if (kind === "transfer") renderTransfer();
    else if (kind === "import") renderImport(arg || "");
    else if (kind === "g") renderGroup(decodeURIComponent(arg || ""));
    else if (kind === "tags") renderTags();
    else renderHome();
    $("#favLink").classList.toggle("active", kind === "favorites");
    document.body.classList.toggle("on-home", !["t", "favorites", "trash", "transfer", "import", "g", "tags"].includes(kind));
  }

  // Redraw the current page in place (after an edit, or another device changed the library).
  function refreshView() {
    const y = scrollY, key = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    renderRoute();
    scrollTo(0, y);
    if (key) $(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }

  function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    if (currentRoute) {
      const a = document.activeElement;
      focusMemory.set(currentRoute, { key: a && a.dataset ? a.dataset.key : null, scroll: scrollY });
    }
    if (hash !== currentRoute) {
      state.editing = null;
      if (currentRoute) pageTurn(hash === "/"); // going home turns the page back the other way
    }
    currentRoute = hash;
    renderRoute();
    updateFx();

    app.classList.remove("enter"); void app.offsetWidth; app.classList.add("enter");
    const mem = focusMemory.get(hash);
    scrollTo(0, mem ? mem.scroll : 0);
    if (focusHeroAfterRoute) {
      // typed into the header box on another page: keep typing in the big box
      focusHeroAfterRoute = false;
      const hero = $("#heroSearch");
      hero.focus(); hero.setSelectionRange(hero.value.length, hero.value.length);
    } else if (keyMode()) {
      const el = (mem && mem.key && $(`[data-key="${CSS.escape(mem.key)}"]`)) || $("#app .theme-card, #app .btn, #app .video-card");
      if (el) el.focus({ preventScroll: !!mem });
    }
  }

  // ---------- player ----------
  // ytReady: the IFrame API script has loaded. playerReady: our player has fired
  // onReady (its methods don't exist before that). Until then the latest pick
  // waits in pendingPlay, so a second pick during startup isn't lost.
  let yt = null, ytReady = false, playerReady = false, createdWith = null, pendingPlay = null, fadeTimer = null;
  let pendingAuto = false, nowAuto = false; // was the pending / current track started automatically?

  window.onYouTubeIframeAPIReady = () => { ytReady = true; if (pendingPlay) loadVideo(pendingPlay, pendingAuto); };

  function current() { return state.now; }

  function createPlayer(videoId) {
    createdWith = videoId;
    yt = new YT.Player("yt", {
      videoId,
      host: "https://www.youtube-nocookie.com",
      playerVars: { autoplay: 1, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, modestbranding: 1, origin: location.origin },
      events: {
        onReady: e => {
          const f = e.target.getIframe();
          f.setAttribute("tabindex", "-1");
          f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
          playerReady = true;
          e.target.unMute();
          // picked by hand: full volume right away; started automatically: fade in
          applyVolume(pendingAuto ? 0 : state.volume);
          fadeInPending = pendingAuto ? FADE_IN_MS : 0;
          const want = pendingPlay; pendingPlay = null;
          if (want && want.id !== createdWith) e.target.loadVideoById(want.id);
          else e.target.playVideo();
        },
        onStateChange: e => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) {
            setPlaying(true);
            if (fadeInPending) {
              // start the fade-in only now that sound is actually coming out
              const ms = fadeInPending; fadeInPending = 0;
              yt.unMute(); fadeTo(null, ms);
            } else if (!fadeTimer) {
              // safety net: if no fade is running, make sure the player is at the user's volume
              yt.unMute(); applyVolume(state.volume);
            }
          }
          else if (e.data === S.PAUSED) setPlaying(false);
          else if (e.data === S.ENDED) {
            // normally the pre-end fade (see the progress tick) has already moved on
            if (fadingOut) return; // already fading into the next track
            if (state.loop) { applyVolume(0); fadeInPending = FADE_IN_MS; yt.seekTo(0, true); yt.playVideo(); } else next(true);
          }
        },
        onError: e => {
          toast(e.data === 100 ? "That track was removed — skipping" : "That track can't be embedded — skipping");
          const auto = nowAuto;
          setTimeout(() => next(auto), 800);
        },
      },
    });
  }

  // Fades toward `target`. A target of null means "the user's volume", read on
  // every step so a volume change mid-fade is honoured instead of overwritten.
  // We track the volume we last applied ourselves: while a new video is loading
  // the player's getVolume() returns undefined, which used to leave fades stuck at 0.
  // Fades only happen when the music moves on by itself (a track ends, the ⏱ timer, repeat).
  // Anything picked by hand starts instantly at full volume — handy for previewing.
  const FADE_OUT_MS = 3000;   // fade the old track out when changing songs
  const FADE_IN_MS = 3500;    // fade the new track in once it starts playing
  let fadingOut = false, applied = 0, fadeInPending = 0;
  function applyVolume(v) {
    applied = v;
    if (yt && yt.setVolume) yt.setVolume(v);
  }
  function fadeTo(target, ms, done) {
    clearInterval(fadeTimer);
    fadingOut = target === 0;
    if (!yt || !yt.setVolume) { fadingOut = false; done && done(); return; }
    const start = applied, steps = Math.max(1, Math.round(ms / 40));
    let n = 0;
    fadeTimer = setInterval(() => {
      n++;
      const end = target == null ? state.volume : target;
      const p = n / steps, eased = p * p * (3 - 2 * p); // smoothstep: gentle start and finish
      applyVolume(Math.round(start + (end - start) * eased));
      if (n >= steps) { clearInterval(fadeTimer); fadeTimer = null; fadingOut = false; done && done(); }
    }, 40);
  }

  function loadVideo(v, auto = false) {
    if (!playerReady) {
      pendingPlay = v;
      pendingAuto = auto;
      if (ytReady && !yt) createPlayer(v.id);
      return;
    }
    if (!auto) {
      // picked by hand: cut straight to it at full volume, so you hear right away if it's the one
      clearInterval(fadeTimer);
      fadeTimer = null;
      fadingOut = false;
      fadeInPending = 0;
      yt.unMute();
      applyVolume(state.volume);
      yt.loadVideoById(v.id);
      return;
    }
    // moving on by itself: fade the old track out, swap, and fade the new one in once it plays
    const swap = () => { applyVolume(0); fadeInPending = FADE_IN_MS; yt.loadVideoById(v.id); };
    state.playing && applied > 0 ? fadeTo(0, FADE_OUT_MS, swap) : swap();
  }

  // Fade out during the last seconds of a track so natural endings also transition smoothly.
  let preEndFor = null;
  function checkPreEndFade(t, d) {
    const v = current();
    if (!v || !state.playing || fadingOut || d < 60 || d - t > FADE_OUT_MS / 1000 + 0.5 || preEndFor === v.id) return;
    preEndFor = v.id;
    if (state.loop) {
      // seeking while playing may not fire a new PLAYING event, so fade straight back in
      fadeTo(0, FADE_OUT_MS, () => { yt.seekTo(0, true); yt.playVideo(); fadeTo(null, FADE_IN_MS); preEndFor = null; });
    } else next(true);
  }

  function playList(key, i = 0, { shuffle } = {}) {
    const list = lists.get(key);
    if (!list || !list.length) return;
    if (shuffle != null) { state.shuffle = shuffle; store.set("shuffle", shuffle); }
    state.queue = list.slice();
    state.queueName = listName(key);
    played = new Set();
    state.index = shuffle ? Math.floor(Math.random() * list.length) : i;
    startCurrent();
  }

  function listName(key) {
    if (key.startsWith("t-")) return (catById.get(key.slice(2)) || {}).name || "this theme";
    return { search: `search “${state.query.trim()}”`, favorites: "Favorites", recent: "Recently played" }[key] || "this list";
  }

  function startCurrent(auto = false) { beginPlayback(state.queue[state.index], auto); }

  function beginPlayback(v, auto = false) {
    if (!v) return;
    state.now = v;
    nowAuto = auto;
    document.body.classList.add("has-dock");
    $("#dock").hidden = false;
    loadVideo(v, auto);
    preEndFor = null;
    played.add(v.id);
    resetAutoTimer();
    recent = [v.id, ...recent.filter(id => id !== v.id)].slice(0, 16);
    store.set("recent", recent);
    updateDock();
    renderQueuePanel();
    updateFx();
  }

  // Shuffle bag: random picks don't repeat a track until the whole list has played.
  let played = new Set();
  function randomIndex() {
    const q = state.queue, others = i => i !== state.index;
    if (q.length < 2) return state.index;
    let pool = q.map((_, i) => i).filter(i => others(i) && !played.has(q[i].id));
    if (!pool.length) { played = new Set([q[state.index].id]); pool = q.map((_, i) => i).filter(others); }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // auto = true when the music moves on by itself (fades); false when someone pressed Next (instant)
  function next(auto = false) {
    // Up Next first, in the order the user arranged; then the list carries on.
    while (state.upNext.length) {
      const v = videoById.get(state.upNext.shift());
      saveQueue();
      if (v) return beginPlayback(v, auto);
    }
    if (!state.queue.length) return;
    state.index = state.shuffle ? randomIndex() : (state.index + 1) % state.queue.length;
    startCurrent(auto);
  }

  // ---------- auto-change timer: switch to a random track every N minutes ----------
  const AUTO_STEPS = [0, 5, 10, 15, 20, 30, 45, 60];
  let autoLeft = 0, autoTick = Date.now();
  function resetAutoTimer() { autoLeft = state.autoMins * 60000; autoTick = Date.now(); updateAutoButton(); }
  function updateAutoButton() {
    const b = $("#btnTimer");
    b.setAttribute("aria-pressed", state.autoMins > 0);
    $("#timerLabel").textContent = state.autoMins ? fmtTime(Math.ceil(autoLeft / 1000)) : "";
    b.title = state.autoMins
      ? `Changing to a random track every ${state.autoMins} min — next change in ${fmtTime(Math.ceil(autoLeft / 1000))}`
      : "Auto-change track: off";
  }
  $("#btnTimer").onclick = () => {
    state.autoMins = AUTO_STEPS[(AUTO_STEPS.indexOf(state.autoMins) + 1) % AUTO_STEPS.length];
    store.set("autoMins", state.autoMins);
    resetAutoTimer();
    toast(state.autoMins ? `⏱ New random track every ${state.autoMins} minutes` : "⏱ Auto-change off");
  };
  // Counts real elapsed time (so throttled timers can't drift), and only while music plays.
  setInterval(() => {
    const now = Date.now(), dt = now - autoTick;
    autoTick = now;
    if (!state.autoMins || !state.playing || (state.queue.length < 2 && !state.upNext.length)) return;
    autoLeft -= dt;
    if (autoLeft <= 0) {
      if (state.upNext.length) next(true); // queued tracks go first
      else { state.index = randomIndex(); startCurrent(true); }
      toast(`⏱ Time's up — now playing ${current().title.slice(0, 44)}${current().title.length > 44 ? "…" : ""}`);
    } else updateAutoButton();
  }, 1000);
  function prev() {
    if (!state.queue.length) return;
    if (yt && yt.getCurrentTime && yt.getCurrentTime() > 5) { yt.seekTo(0, true); return; }
    state.index = (state.index - 1 + state.queue.length) % state.queue.length;
    startCurrent();
  }
  function togglePlay() {
    if (!yt || !yt.getPlayerState) return;
    if (yt.getPlayerState() === YT.PlayerState.PLAYING) fadeTo(0, 350, () => { yt.pauseVideo(); applyVolume(state.volume); });
    else { yt.unMute(); applyVolume(0); fadeInPending = 800; yt.playVideo(); }
  }
  function setVolume(v, save = true) {
    state.volume = Math.max(0, Math.min(100, Math.round(v)));
    if (save) store.set("playerVolume", state.volume);
    $("#volFill").style.width = state.volume + "%";
    // While fading out (track switch / pause) let the fade finish; the fade-in
    // afterwards picks up the new volume. Otherwise apply it right away.
    if (fadingOut) return;
    clearInterval(fadeTimer); fadeTimer = null;
    if (yt && yt.setVolume) { yt.unMute(); applyVolume(state.volume); }
  }

  function setPlaying(p) {
    state.playing = p;
    document.body.classList.toggle("playing", p);
    document.body.classList.toggle("paused", !p);
    updateFx();
  }

  function updateDock() {
    const v = current();
    if (!v) return;
    const c = catById.get(v.cat) || { hue: 38, icon: iconSvg() }; // its theme may have been deleted
    $("#dockTitle").textContent = v.title;
    $("#dockChannel").textContent = v.channel;
    $("#dockSigil").innerHTML = sigil(c);
    $("#btnShuffle").setAttribute("aria-pressed", state.shuffle);
    $("#btnLoop").setAttribute("aria-pressed", state.loop);
    $("#btnFav").setAttribute("aria-pressed", favorites.includes(v.id));
    $$(".video-card.is-playing").forEach(el => el.classList.remove("is-playing"));
    $$(`.video-card[data-vid="${v.id}"]`).forEach(el => el.classList.add("is-playing"));
    document.title = `${v.title} · ${siteTitle}`;
  }

  setInterval(() => {
    if (!yt || !yt.getDuration) return;
    const d = yt.getDuration() || 0, t = yt.getCurrentTime() || 0;
    $("#progressFill").style.width = d ? (t / d * 100) + "%" : "0";
    $("#dockTime").textContent = d ? `${fmtTime(t)} / ${fmtTime(d)}` : "…";
    if (d) checkPreEndFade(t, d);
    // tracks added without a known length (no serve.py) learn it the first time they play
    const v = current();
    if (v && v.mine && !v.length && d > 0) { v.length = Math.round(d); saveUser(); }
  }, 1000);

  function setTheater(on) {
    state.theater = on;
    document.body.classList.toggle("theater", on);
    $("#btnTheater").setAttribute("aria-pressed", on);
    app.inert = on; $("#topbar").inert = on; $("#footer").inert = on;
    if (on) { wake(); if (keyMode()) $("#btnPlay").focus(); }
  }

  // hide theater controls when idle
  let idleTimer;
  function wake() {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    if (state.theater) idleTimer = setTimeout(() => document.body.classList.add("idle"), 3500);
  }
  ["mousemove", "keydown", "pointerdown"].forEach(ev => addEventListener(ev, wake, { passive: true }));

  function toggleFav() {
    const v = current(); if (!v) return;
    const had = favorites.includes(v.id);
    favorites = had ? favorites.filter(id => id !== v.id) : [v.id, ...favorites];
    store.set("favorites", favorites);
    $("#btnFav").setAttribute("aria-pressed", !had);
    toast(had ? "Removed from favorites" : "Added to favorites ♥");
    if (currentRoute === "/favorites") { const key = document.activeElement?.dataset?.key; renderFavorites(); key && $(`[data-key="${CSS.escape(key)}"]`)?.focus(); }
  }

  function spinDie(btn) { btn.classList.remove("rolling"); void btn.offsetWidth; btn.classList.add("rolling"); }

  // Roll a d20 and play a random track from this page's list (theme or search results).
  function rollTrack(btn, key) {
    const list = lists.get(key);
    if (!list || !list.length) return;
    const roll = 1 + Math.floor(Math.random() * 20);
    const i = Math.floor(Math.random() * list.length);
    const t = list[i].title;
    const msg = `🎲 You rolled a ${roll} — ${t.length > 48 ? t.slice(0, 46) + "…" : t}`;
    spinDie(btn);
    rollFlourish(btn, roll);
    if (roll === 20 && !tricks.unlocked) setTimeout(() => unlockTricks("Natural 20!"), 1600);
    // A new tab has to open inside the click itself or the browser blocks it.
    if (state.mode === "yt") { toast(msg); return openOnYouTube(key, { index: i, single: true }); }
    setTimeout(() => { toast(msg); playList(key, i); }, 650);
  }

  function rollScene(btn) {
    const roll = 1 + Math.floor(Math.random() * 20);
    const cats = LIB.categories.filter(c => c.videos.length);
    const c = cats[Math.floor(Math.random() * cats.length)];
    registerList("t-" + c.id, c.videos);
    spinDie(btn);
    rollFlourish(btn, roll);
    if (roll === 20 && !tricks.unlocked) setTimeout(() => unlockTricks("Natural 20!"), 1600);
    // A new tab has to open inside the click itself or the browser blocks it.
    if (state.mode === "yt") { toast(`🎲 You rolled a ${roll} — ${c.name}!`); return openOnYouTube("t-" + c.id, { shuffle: true }); }
    setTimeout(() => {
      toast(`🎲 You rolled a ${roll} — ${c.name}!`);
      playList("t-" + c.id, 0, { shuffle: true });
    }, 650);
  }

  // ---------- play mode: integrated player or YouTube in a new tab ----------
  function setMode(mode) {
    state.mode = mode;
    store.set("mode", mode);
    document.body.classList.toggle("mode-yt", mode === "yt");
    $("#modeHere").setAttribute("aria-pressed", mode === "here");
    $("#modeYT").setAttribute("aria-pressed", mode === "yt");
  }
  $("#modeHere").onclick = () => { setMode("here"); toast("Tracks play in the built-in player"); };
  $("#modeYT").onclick = () => { setMode("yt"); toast("Tracks open on YouTube in a new tab"); };

  // Opens one track, or a whole list as a temporary YouTube playlist (max 50 videos).
  function openOnYouTube(key, { index = 0, single = false, shuffle = false } = {}) {
    let vids = (lists.get(key) || []).slice();
    if (!vids.length) return;
    if (shuffle) vids.sort(() => Math.random() - 0.5);
    if (single) vids = [vids[index]];
    const url = vids.length === 1
      ? `https://www.youtube.com/watch?v=${vids[0].id}`
      : `https://www.youtube.com/watch_videos?video_ids=${vids.slice(0, 50).map(v => v.id).join(",")}`;
    if (state.playing) togglePlay(); // don't play two tracks at once
    window.open(url, "_blank", "noopener");
    recent = [vids[0].id, ...recent.filter(id => id !== vids[0].id)].slice(0, 16);
    store.set("recent", recent);
  }

  // ---------- Up Next queue ----------
  function saveQueue() {
    store.set("upNext", state.upNext);
    const n = state.upNext.length;
    $("#queueCount").textContent = n || "";
    $("#btnQueue").title = n ? `Queue — ${n} up next` : "Queue";
    renderQueuePanel();
  }
  // Adds tracks to the end of Up Next; if nothing is playing yet, starts the first one.
  function queueIds(ids) {
    const before = state.upNext.length;
    for (const id of ids) {
      if (videoById.has(id) && !state.upNext.includes(id) && !(state.now && state.now.id === id)) state.upNext.push(id);
    }
    const added = state.upNext.length - before;
    saveQueue();
    if (!state.now && state.upNext.length) next();
    return added;
  }
  function queueOne(id) {
    const wasIdle = !state.now;
    if (!wasIdle && state.now.id === id) return toast("That track is playing now");
    const n = queueIds([id]);
    toast(wasIdle ? "▶ Playing now — queue more with ➕ or Q"
      : n ? `➕ Added to queue · ${state.upNext.length} up next` : "Already in the queue");
  }
  function queueAll(key) {
    const wasIdle = !state.now;
    const n = queueIds((lists.get(key) || []).map(v => v.id));
    toast(wasIdle && n ? `▶ Playing the first · ${state.upNext.length} more queued`
      : n ? `➕ Queued ${n} track${n === 1 ? "" : "s"} · ${state.upNext.length} up next` : "Those tracks are already queued");
  }

  const qRow = (v, attrs, { handle = false, remove = false } = {}) => `
    <div class="q-row" data-vid="${v.id}">
      <button class="q-play" type="button" ${attrs} data-key="q-${v.id}">
        <img src="https://i.ytimg.com/vi/${v.id}/default.jpg" alt="" loading="lazy">
        <span class="q-text"><b>${esc(v.title)}</b><small>${esc(v.channel)}${v.length ? " · " + fmtTime(v.length) : ""}</small></span>
      </button>
      ${handle ? `<button class="tool drag-handle" type="button" tabindex="-1" aria-label="Drag to reorder">${icons.grip}</button>` : ""}
      ${remove ? `<button class="tool tool-remove" type="button" data-qremove="${v.id}" aria-label="Remove from queue">✕</button>` : ""}
    </div>`;

  function renderQueuePanel() {
    const body = $("#queueBody");
    if (!body || !document.body.classList.contains("queue-open")) return;
    const up = state.upNext.map(id => videoById.get(id)).filter(Boolean);
    let html = "";
    if (state.now) html += `<h3>Now playing</h3>${qRow(state.now, "disabled")}`;
    html += `<h3>Up next <span>${up.length || ""}</span></h3>`;
    html += up.length
      ? `<div class="q-list" id="upNextList">${up.map(v => qRow(v, `data-qplay="${v.id}"`, { handle: true, remove: true })).join("")}</div>`
      : `<p class="q-empty">Nothing queued. Use ${icons.queueAdd} on any track, <b>Queue all</b> on a theme, or press <kbd>Q</kbd> on a focused track.</p>`;
    if (state.queue.length && state.index >= 0) {
      if (state.shuffle) {
        html += `<h3>Then</h3><p class="q-empty">Shuffling ${esc(state.queueName || "the list")}.</p>`;
      } else {
        const rest = [];
        for (let k = 1; k <= Math.min(5, state.queue.length - 1); k++) rest.push((state.index + k) % state.queue.length);
        html += `<h3>Then from ${esc(state.queueName || "the list")}</h3>` +
          rest.map(i => qRow(state.queue[i], `data-qjump="${i}"`)).join("");
      }
    }
    body.innerHTML = html;
    $("#queueClear").hidden = !up.length;
    $("#queueSave").hidden = !up.length && !state.now;
    makeSortable($("#upNextList"), ids => { state.upNext = ids; saveQueue(); });
  }

  function toggleQueue(on = !document.body.classList.contains("queue-open")) {
    document.body.classList.toggle("queue-open", on);
    $("#queuePanel").setAttribute("aria-hidden", !on);
    $("#btnQueue").setAttribute("aria-pressed", on);
    if (on) {
      if (state.theater) setTheater(false);
      renderQueuePanel();
      if (keyMode()) ($("#queueBody [data-qplay]") || $("#queueClose")).focus();
    } else if (keyMode()) $("#btnQueue").focus();
  }

  // ---------- drag & drop reordering (SortableJS) ----------
  let dragging = false;
  function makeSortable(el, onSort) {
    if (!el || !window.Sortable) return; // no drag & drop if the CDN is unreachable; everything else works
    window.Sortable.create(el, {
      handle: ".drag-handle", draggable: ".vc, .q-row", animation: 180,
      forceFallback: true, fallbackTolerance: 4,      // same behaviour for mouse and touch
      ghostClass: "drag-ghost", chosenClass: "drag-chosen", dragClass: "drag-active",
      scrollSensitivity: 90, scrollSpeed: 16, bubbleScroll: true,
      onStart: () => { dragging = true; document.body.classList.add("dragging"); },
      onEnd: e => {
        dragging = false;
        document.body.classList.remove("dragging");
        if (e.oldIndex !== e.newIndex) onSort([...el.children].map(x => x.dataset.vid).filter(Boolean));
      },
    });
  }
  // after a drop the DOM order is the truth; keep each card's list index in step
  function renumber() { $$("#trackGrid .video-card").forEach((b, i) => { b.dataset.i = i; }); }

  function reorderTheme(catId, ids) {
    const u = user.categories.find(c => c.id === catId);
    if (u) {
      const byId = new Map(u.videos.map(v => [v.id, v]));
      u.videos = ids.map(id => byId.get(id)).filter(Boolean);
    } else user.order[catId] = ids;
    commitUser();
    registerList("t-" + catId, catById.get(catId).videos);
    renumber();
  }

  // ---------- deleting safely: everything goes to "Recently deleted" and can be undone ----------
  function trashPush(entry) {
    const e = { id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), deletedAt: Date.now(), ...entry };
    user.trash.unshift(e);
    return e;
  }
  const short = t => (t.length > 40 ? t.slice(0, 38) + "…" : t);

  function removeFromList(vid) {
    const key = state.editing;
    if (key === "favorites") {
      // favorites live on this device only: a plain undo is enough
      const i = favorites.indexOf(vid), before = favorites.slice();
      favorites = favorites.filter(id => id !== vid);
      store.set("favorites", favorites);
      refreshView();
      if (i >= 0) toast("Removed from favorites", { undo: () => { favorites = before; store.set("favorites", favorites); refreshView(); } });
      return;
    }
    if (!key || !key.startsWith("t-")) return;
    const catId = key.slice(2), c = catById.get(catId), u = user.categories.find(x => x.id === catId);
    const v = c.videos.find(x => x.id === vid);
    if (!v) return;
    let entry;
    if (u) {                                                        // a theme someone made
      const i = u.videos.findIndex(x => x.id === vid);
      u.videos.splice(i, 1);
      entry = trashPush({ kind: "track", from: catId, fromName: u.name, index: i, video: cleanVideo(v) });
    } else if ((user.added[catId] || []).some(x => x.id === vid)) {  // a track added to a built-in theme
      const i = user.added[catId].findIndex(x => x.id === vid);
      user.added[catId].splice(i, 1);
      entry = trashPush({ kind: "track", from: catId, fromName: c.name, index: i, video: cleanVideo(v) });
    } else {                                                        // a built-in track: hidden, not destroyed
      user.hidden[catId] = [...(user.hidden[catId] || []), vid];
      entry = trashPush({ kind: "hide", from: catId, fromName: c.name, video: cleanVideo(v) });
    }
    commitUser();
    refreshView();
    toast(`Removed “${short(v.title)}”`, { undo: () => restoreTrash(entry.id) });
  }

  async function deleteTheme(catId) {
    const u = user.categories.find(x => x.id === catId);
    if (!u) return;
    const ok = await confirmDialog(`Delete “${u.name}”?`,
      `Its ${u.videos.length} track${u.videos.length === 1 ? "" : "s"} go to <b>Recently deleted</b> for ${TRASH_DAYS} days, so it can be restored.`,
      "Delete theme");
    if (!ok) return;
    user.categories = user.categories.filter(x => x !== u);
    const entry = trashPush({ kind: "theme", theme: cleanTheme(u) });
    commitUser();
    location.hash = "#/";
    toast(`Deleted “${short(u.name)}”`, { undo: () => restoreTrash(entry.id) });
  }

  async function resetTheme(catId) {
    const ok = await confirmDialog("Restore the original list?",
      "Puts back any built-in tracks that were removed and resets the order. Tracks people added stay.", "Restore");
    if (!ok) return;
    const before = { order: user.order[catId], hidden: user.hidden[catId] };
    delete user.order[catId];
    delete user.hidden[catId];
    user.trash = user.trash.filter(e => !(e.kind === "hide" && e.from === catId)); // they're back, nothing to restore
    commitUser();
    refreshView();
    toast("Original list restored", { undo: () => {
      if (before.order) user.order[catId] = before.order;
      if (before.hidden) user.hidden[catId] = before.hidden;
      commitUser();
      refreshView();
    } });
  }

  function restoreTrash(id) {
    const e = user.trash.find(x => x.id === id);
    if (!e) return;
    const blocker = restoreBlocker(e);
    if (blocker) return toast(blocker);
    if (e.kind === "theme") {
      if (!user.categories.some(c => c.id === e.theme.id)) user.categories.push({ ...e.theme, yours: undefined });
    } else if (e.kind === "hide") {
      user.hidden[e.from] = (user.hidden[e.from] || []).filter(x => x !== e.video.id);
    } else {
      const u = user.categories.find(c => c.id === e.from);
      const list = u ? u.videos : (user.added[e.from] = user.added[e.from] || []);
      if (!list.some(v => v.id === e.video.id)) list.splice(Math.min(e.index != null ? e.index : list.length, list.length), 0, e.video);
    }
    user.trash = user.trash.filter(x => x !== e);
    commitUser();
    refreshView();
    toast(e.kind === "theme" ? `Restored “${short(e.theme.name)}”` : `Restored “${short(e.video.title)}”`);
  }

  // ---------- dialogs ----------
  let modalSubmit = null, modalReturn = null, modalOnClose = null;
  function openModal(html, onSubmit, onClose = null) {
    modalReturn = document.activeElement;
    modalSubmit = onSubmit;
    modalOnClose = onClose;
    $("#modalCard").innerHTML = html;
    $("#modal").hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => ($("#modal [autofocus]") || $("#modal input, #modal button"))?.focus(), 30);
  }
  function closeModal() {
    const cb = modalOnClose;
    modalOnClose = null;
    $("#modal").hidden = true;
    document.body.classList.remove("modal-open");
    modalSubmit = null;
    modalReturn && document.contains(modalReturn) && modalReturn.focus({ preventScroll: true });
    if (cb) cb();
  }
  // "Are you sure?" that works with a remote. Cancel has focus, so a stray OK does nothing harmful.
  function confirmDialog(title, text, okLabel) {
    return new Promise(resolve => {
      openModal(`<h2>${esc(title)}</h2><p class="muted confirm-text">${text}</p>
        <div class="modal-actions">
          <button class="btn" type="button" data-close-modal autofocus>Cancel</button>
          <button class="btn btn-danger" type="button" id="fSubmit">${esc(okLabel)}</button>
        </div>`, () => { modalOnClose = null; closeModal(); resolve(true); }, () => resolve(false));
    });
  }

  // themes share icons, so offer each icon once
  const pickableIcons = () => {
    const seen = new Set();
    return BASE.categories.filter(c => c.group !== "charts" && !seen.has(c.icon) && seen.add(c.icon));
  };
  const HUES = [0, 20, 38, 55, 95, 150, 185, 210, 255, 285, 320];
  function themeFields(t = {}) {
    const icon = t.icon || "tavern", hue = t.hue != null ? t.hue : 38;
    return `<div class="theme-fields">
      <label class="field"><span>Theme name</span>
        <input id="fName" maxlength="40" value="${esc(t.name || "")}" placeholder="e.g. Curse of Strahd, Session 12, The Lich Queen"></label>
      <label class="field"><span>Short description <em>(optional)</em></span>
        <input id="fTagline" maxlength="80" value="${esc(t.tagline || "")}" placeholder="e.g. Music for the siege of Vallaki"></label>
      <div class="field"><span>Icon</span><div class="icon-pick" style="--h:${hue}">
        ${pickableIcons().map(c =>
          `<button type="button" class="pick-icon" data-pick-icon="${c.id}" aria-pressed="${c.id === icon}" title="${esc(c.name)}"><svg viewBox="0 0 512 512">${c.icon}</svg></button>`).join("")}
      </div></div>
      <div class="field"><span>Colour</span><div class="hue-pick">
        ${HUES.map(h => `<button type="button" class="pick-hue" data-pick-hue="${h}" aria-pressed="${h === hue}" style="--h:${h}" aria-label="Colour ${h}"></button>`).join("")}
      </div></div>
      ${sync.server ? `<label class="check"><input type="checkbox" id="fOpen" ${t.open ? "checked" : ""}>
        <span><b>Open to everyone</b> — ${sync.public ? "anyone using this site" : "anyone on the Wi-Fi"} can add, remove and reorder its tracks.
        <small>Otherwise only this device can change it; others can still play and queue it. Only this device can rename or delete it either way.</small></span></label>` : ""}
    </div>`;
  }
  const readThemeFields = () => ({
    name: $("#fName").value.trim(),
    tagline: $("#fTagline").value.trim(),
    icon: $(".pick-icon[aria-pressed=true]")?.dataset.pickIcon || "tavern",
    hue: +($(".pick-hue[aria-pressed=true]")?.dataset.pickHue || 38),
    open: !!$("#fOpen")?.checked,
  });

  // "Add music": paste links, pick (or create) a theme. Also used to save the queue as a theme.
  function openAddDialog(target = "", { fromQueue = false } = {}) {
    const mine = LIB.categories.filter(c => c.custom && canEdit(c));   // only themes this device may change
    const builtIn = LIB.categories.filter(c => !c.custom && c.group !== "charts");
    if (!target) target = mine.length ? mine[0].id : "__new";
    const isNew = target === "__new" || fromQueue;
    const opt = c => `<option value="${c.id}" ${c.id === target ? "selected" : ""}>${esc(c.name)}</option>`;
    const queued = [state.now, ...state.upNext.map(id => videoById.get(id))].filter(Boolean);
    openModal(`
      <h2>${fromQueue ? "Save queue as a theme" : "Add music"}</h2>
      ${fromQueue ? `<p class="muted">Creates a new theme with the ${queued.length} track${queued.length === 1 ? "" : "s"} playing and queued.</p>` : `
      <label class="field"><span>YouTube links</span>
        <textarea id="fLinks" rows="4" autofocus placeholder="Paste video or playlist links — one per line"></textarea>
        <small>${sync.server ? "Playlist links import every video in the playlist (up to 200)."
          : "Single videos work anywhere. Playlist links need the site running from serve.py."}</small></label>
      <label class="field"><span>Add to</span><select id="fTarget">
        <option value="__new" ${isNew ? "selected" : ""}>＋ New theme…</option>
        ${mine.length ? `<optgroup label="My Themes">${mine.map(opt).join("")}</optgroup>` : ""}
        ${LIB.groups.filter(g => g.id !== "mine").map(g => { const cs = builtIn.filter(c => c.group === g.id);
          return cs.length ? `<optgroup label="${esc(g.name)}">${cs.map(opt).join("")}</optgroup>` : ""; }).join("")}
      </select></label>`}
      <div id="newThemeFields" ${isNew ? "" : "hidden"}>${themeFields()}</div>
      <p class="form-status" id="fStatus" role="status"></p>
      <div class="modal-actions">
        <button class="btn" type="button" data-close-modal>Cancel</button>
        <button class="btn btn-gold" type="button" id="fSubmit">${fromQueue ? "Save theme" : "Add"}</button>
      </div>`, () => submitAdd(fromQueue, queued));
    $("#fTarget")?.addEventListener("change", e => { $("#newThemeFields").hidden = e.target.value !== "__new"; });
    if (fromQueue) setTimeout(() => $("#fName").focus(), 40);
  }

  async function submitAdd(fromQueue, queued) {
    const status = $("#fStatus"), btn = $("#fSubmit");
    const target = fromQueue ? "__new" : $("#fTarget").value;
    const links = fromQueue ? [] : $("#fLinks").value.split(/[\n,]+|\s+(?=https?:|www\.|youtu)/).map(s => s.trim()).filter(Boolean);
    const fields = target === "__new" ? readThemeFields() : null;
    if (fields && !fields.name) { status.textContent = "Give your theme a name."; $("#fName").focus(); return; }
    if (!fromQueue && !links.length && !fields) { status.textContent = "Paste at least one YouTube link."; $("#fLinks").focus(); return; }

    btn.disabled = true;
    const found = [], problems = [];
    for (const [n, link] of links.entries()) {
      status.textContent = `Looking up link ${n + 1} of ${links.length}…`;
      try {
        const r = await resolveLink(link);
        found.push(...r.items);
        if (r.skipped) problems.push(`${r.skipped} video${r.skipped === 1 ? "" : "s"} in “${r.title}” can't play on other sites`);
      } catch (err) { problems.push(`${link.length > 45 ? link.slice(0, 44) + "…" : link} — ${err.message}`); }
    }
    btn.disabled = false;
    if (links.length && !found.length) { status.textContent = "Nothing added. " + problems.join(" · "); return; }

    let catId = target;
    if (fields) {
      catId = "u-" + Date.now().toString(36);
      user.categories.push({ id: catId, ...fields, videos: [], yours: true }); // the server records this device as owner
    }
    const added = addVideosTo(catId, (fromQueue ? queued : found).map(cleanVideo));
    commitUser();
    closeModal();
    const name = catById.get(catId).name;
    toast(fields && !added ? `Created “${name}”` : `Added ${added} track${added === 1 ? "" : "s"} to ${name}`);
    if (problems.length) setTimeout(() => toast("Skipped: " + problems[0]), 2800);
    if (currentRoute === "/t/" + catId) refreshView(); else location.hash = "#/t/" + catId;
  }

  function addVideosTo(catId, vids) {
    const u = user.categories.find(c => c.id === catId);
    const base = BASE.categories.find(c => c.id === catId);
    const list = u ? u.videos : (user.added[catId] = user.added[catId] || []);
    const have = new Set(list.map(v => v.id).concat(base ? base.videos.map(v => v.id) : []));
    let n = 0;
    for (const v of vids) {
      if (base && (user.hidden[catId] || []).includes(v.id)) {       // re-adding a removed built-in track: just unhide it
        user.hidden[catId] = user.hidden[catId].filter(id => id !== v.id); n++;
      } else if (!have.has(v.id)) { list.push(v); have.add(v.id); n++; }
    }
    return n;
  }

  function openThemeSettings(catId) {
    const u = user.categories.find(c => c.id === catId);
    if (!u) return;
    openModal(`<h2>Rename &amp; style</h2>${themeFields(u)}
      <p class="form-status" id="fStatus" role="status"></p>
      <div class="modal-actions">
        <button class="btn" type="button" data-close-modal>Cancel</button>
        <button class="btn btn-gold" type="button" id="fSubmit">Save</button>
      </div>`, () => {
      const f = readThemeFields();
      if (!f.name) { $("#fStatus").textContent = "Give your theme a name."; return; }
      Object.assign(u, f);
      commitUser();
      closeModal();
      refreshView();
    });
  }

  // ======================================================================
  // Share & move: share links, backup files and owner keys — no accounts.
  // ======================================================================

  // A share link carries a theme's name, look and YouTube IDs (+ lengths) in the
  // part after "#", which never leaves the browser. Titles are looked up again
  // on import, which keeps links short enough to text (≈1.5 KB for 100 tracks).
  const b64url = {
    enc(str) {
      let bin = "";
      new TextEncoder().encode(str).forEach(b => { bin += String.fromCharCode(b); });
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(s) {
      s = s.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      return new TextDecoder().decode(Uint8Array.from(atob(s), ch => ch.charCodeAt(0)));
    },
  };
  function shareSource(key) {
    if (key === "favorites") return { name: "Favorites", tagline: "", icon: "victory", hue: 12,
      videos: favorites.map(id => videoById.get(id)).filter(Boolean) };
    const c = catById.get(key.slice(2));
    if (!c) return null;
    const u = user.categories.find(x => x.id === c.id);
    return { name: c.name, tagline: c.tagline, icon: u ? u.icon : c.id, hue: c.hue, videos: c.videos };
  }
  function encodeShare(src) {
    return b64url.enc(JSON.stringify({
      f: 1, n: src.name, d: src.tagline || "", i: src.icon, h: src.hue,
      v: src.videos.map(v => v.id).join(""),
      l: src.videos.map(v => (v.length || 0).toString(36)).join("."),
    }));
  }
  function decodeShare(code) {
    try {
      const p = JSON.parse(b64url.dec(code));
      const ids = (p.v || "").match(/.{11}/g) || [];
      const lens = (p.l || "").split(".");
      if (p.f !== 1 || !p.n || !ids.length || ids.some(id => !/^[\w-]{11}$/.test(id))) return null;
      return { name: String(p.n).slice(0, 40), tagline: String(p.d || "").slice(0, 80), icon: String(p.i || "tavern"),
        hue: Number.isFinite(p.h) ? p.h : 38, items: ids.slice(0, 500).map((id, k) => ({ id, length: parseInt(lens[k], 36) || 0 })) };
    } catch { return null; }
  }
  const shareUrl = code => location.origin + location.pathname + "#/import/" + code;
  // Accepts a full share link (from any copy of the site) or just the code.
  const extractCode = text => { const m = text.trim().match(/#\/import\/([\w-]+)/); return m ? m[1] : text.trim().replace(/\s+/g, ""); };

  function loadScript(src) {
    return new Promise((ok, fail) => {
      if ([...document.scripts].some(s => s.src === src)) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* only on https/localhost — fall back */ }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* not allowed */ }
    ta.remove();
    return ok;
  }

  function openShareDialog(key) {
    const src = shareSource(key);
    if (!src || !src.videos.length) return toast("Add some tracks before sharing");
    const link = shareUrl(encodeShare(src));
    openModal(`
      <h2>Share “${esc(src.name)}”</h2>
      <p class="muted">Anyone with this link can add a copy of this theme (${src.videos.length} track${src.videos.length === 1 ? "" : "s"}) to their own site.
        The link holds only the list of YouTube videos — nothing private.</p>
      <div class="copy-row"><input id="shareLink" readonly value="${esc(link)}" aria-label="Share link">
        <button class="btn btn-gold" type="button" id="copyLink" autofocus>Copy link</button></div>
      <div class="share-grid">
        <div class="qr-box"><div id="shareQr" class="qr">Making QR code…</div><small>Scan with a phone to open it there</small></div>
        <div class="steps"><b>Taking it to a friend's house?</b>
          <ol><li>Send yourself this link — text, email or chat.</li>
            <li>At your friend's, open their copy of the site and choose <b>Share &amp; move → Import</b>.</li>
            <li>Paste the link and press <b>Import</b>.</li></ol>
          <small>If you both use the same website address, simply opening the link works too.</small></div>
      </div>
      <div class="modal-actions">
        ${navigator.share ? `<button class="btn" type="button" id="nativeShare">Share via…</button>` : ""}
        <button class="btn" type="button" data-close-modal>Done</button>
      </div>`, null);
    $("#copyLink").onclick = async () => toast(await copyText(link) ? "Link copied — paste it anywhere" : "Select the link above and copy it");
    if ($("#nativeShare")) $("#nativeShare").onclick = () => navigator.share({ title: src.name, url: link }).catch(() => {});
    const qrBox = $("#shareQr");
    loadScript("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js").then(() => {
      try {
        const qr = window.qrcode(0, "L");
        qr.addData(link);
        qr.make();
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 3, scalable: true });
      } catch {
        qrBox.textContent = "Too many tracks for a QR code — copy the link instead"; // the link still works
      }
    }, () => { qrBox.textContent = "QR code unavailable — copy the link instead"; });
  }

  // Titles and channels for a list of YouTube IDs (6 at a time), reusing what the library already knows.
  async function lookupTitles(items, onProgress) {
    const out = new Array(items.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < items.length) {
        const k = next++, it = items[k], known = videoById.get(it.id);
        if (known) out[k] = cleanVideo({ ...known, length: known.length || it.length });
        else {
          try {
            const r = await fetch("https://www.youtube.com/oembed?format=json&url=" +
              encodeURIComponent("https://www.youtube.com/watch?v=" + it.id));
            if (r.ok) { const j = await r.json(); out[k] = { id: it.id, title: j.title, channel: j.author_name || "", length: it.length || 0, views: 0 }; }
          } catch { /* unavailable: skipped */ }
        }
        onProgress && onProgress(++done, items.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    const found = out.filter(Boolean);
    return { found, skipped: items.length - found.length };
  }
  const uniqueName = name => {
    const names = new Set(LIB.categories.map(c => c.name.toLowerCase()));
    if (!names.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!names.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  };
  const whereItGoes = () => sync.server
    ? `It goes into this site's shared library, as your theme — ${everyone()} will see it.`
    : "It's saved in this browser.";

  function renderImport(code) {
    document.documentElement.style.setProperty("--theme-hue", 38);
    const s = decodeShare(code);
    if (!s) {
      app.innerHTML = `<div class="empty"><h2>This share link doesn't work</h2>
        <p>It may have been cut off when it was sent. Ask for it again, or paste it on the <a href="#/transfer">Share &amp; move</a> page.</p></div>`;
      return;
    }
    const total = s.items.reduce((a, it) => a + it.length, 0);
    app.innerHTML = `
      <section class="theme-hero" style="--h:${s.hue}">
        ${sigil({ hue: s.hue, icon: iconSvg(s.icon) })}
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <p class="eyebrow import-eyebrow">Shared with you</p>
          <h1>${esc(s.name)}</h1>
          <p class="tagline">${s.tagline ? esc(s.tagline) + " · " : ""}${s.items.length} track${s.items.length === 1 ? "" : "s"}${total ? " · " + fmtTime(total) + " of music" : ""}</p>
          <div class="hero-actions">
            <button class="btn btn-gold" type="button" id="doImport" data-key="do-import">${icons.plus}Add to My Themes</button>
            <a class="btn" href="#/">Not now</a>
          </div>
          <p class="lock-note" id="importStatus">${whereItGoes()}</p>
        </div>
      </section>
      <div class="import-strip">${s.items.slice(0, 12).map(it =>
        `<img src="https://i.ytimg.com/vi/${it.id}/mqdefault.jpg" alt="" loading="lazy">`).join("")}</div>`;
    $("#doImport").onclick = async () => {
      const btn = $("#doImport"), status = $("#importStatus");
      btn.disabled = true;
      const { found, skipped } = await lookupTitles(s.items, (d, n) => { status.textContent = `Looking up tracks… ${d} of ${n}`; });
      if (!found.length) { btn.disabled = false; status.textContent = "None of these videos can be played any more."; return; }
      const id = "u-" + Date.now().toString(36);
      user.categories.push({ id, name: uniqueName(s.name), tagline: s.tagline, icon: s.icon, hue: s.hue, open: false, yours: true, videos: found });
      commitUser();
      location.replace("#/t/" + id); // so Back doesn't return to the import page
      toast(`Added “${s.name}” with ${found.length} track${found.length === 1 ? "" : "s"}` +
        (skipped ? ` · ${skipped} no longer available` : ""), { ms: 4500 });
    };
  }

  // ---------- backup file: everything this browser has, in one small file ----------
  function buildBackup({ allThemes, withKey }) {
    const themes = user.categories.filter(c => allThemes || !sync.server || c.yours !== false);
    return {
      format: "bards-grimoire-backup", version: 1, exportedAt: new Date().toISOString(), from: location.origin,
      themes: themes.map(c => ({ ...cleanTheme(c), owner: undefined })),
      added: Object.fromEntries(Object.entries(user.added).filter(([, l]) => l.length).map(([k, l]) => [k, l.map(cleanVideo)])),
      favorites: favorites.map(id => videoById.get(id)).filter(Boolean).map(cleanVideo),
      prefs: { mode: state.mode, autoMins: state.autoMins, volume: state.volume, shuffle: state.shuffle, loop: state.loop, sfx: sfx.on, tricks,
        ...(siteTitle !== DEFAULT_TITLE ? { siteTitle } : {}) },
      ...(withKey ? { ownerKeys: [deviceKey, ...extraKeys] } : {}),
    };
  }
  function downloadBackup() {
    const b = buildBackup({ allThemes: !!$("#bkAll")?.checked, withKey: !!$("#bkKey")?.checked });
    const blob = new Blob([JSON.stringify(b, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bards-grimoire-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Backup saved: ${b.themes.length} theme${b.themes.length === 1 ? "" : "s"}, ${b.favorites.length} favorite${b.favorites.length === 1 ? "" : "s"}` +
      (b.ownerKeys ? " + your owner key — keep this file private" : ""), { ms: 5000 });
  }

  function readBackupFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let b;
      try { b = JSON.parse(reader.result); } catch { b = null; }
      if (!b || b.format !== "bards-grimoire-backup") return toast("That isn't a Bard's Grimoire backup file");
      const tracks = (b.themes || []).reduce((n, t) => n + (t.videos || []).length, 0);
      const addedN = Object.values(b.added || {}).reduce((n, l) => n + l.length, 0);
      const lines = [
        b.themes?.length && `${b.themes.length} theme${b.themes.length === 1 ? "" : "s"} (${tracks} tracks)`,
        b.favorites?.length && `${b.favorites.length} favorite${b.favorites.length === 1 ? "" : "s"}`,
        addedN && `${addedN} track${addedN === 1 ? "" : "s"} added to built-in themes`,
        b.prefs && `your settings (play mode, timer, volume, shuffle, repeat, hover sounds${b.prefs.siteTitle ? `, site name “${b.prefs.siteTitle}”` : ""})`,
        b.ownerKeys?.length && "an owner key — this browser will be able to edit the themes made with it",
      ].filter(Boolean);
      openModal(`<h2>Import this backup?</h2>
        <p class="muted">Made ${b.exportedAt ? new Date(b.exportedAt).toLocaleString() : "earlier"}. It contains:</p>
        <ul class="import-list">${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
        <p class="muted">Nothing here gets deleted — new things are added and duplicates are skipped. ${whereItGoes()}</p>
        <div class="modal-actions"><button class="btn" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-gold" type="button" id="fSubmit" autofocus>Import</button></div>`,
        () => { closeModal(); applyBackup(b); });
    };
    reader.readAsText(file);
  }

  async function applyBackup(b) {
    let keysAdded = 0;
    for (const k of b.ownerKeys || []) {
      if (/^[0-9a-f]{32}$/.test(k) && k !== deviceKey && !extraKeys.includes(k)) { extraKeys.push(k); keysAdded++; }
    }
    if (keysAdded) {
      store.set("ownerKeys", extraKeys);
      if (sync.server) { await loadUserData(); rebuildLibrary(); } // learn which themes are ours now
    }
    let themesNew = 0, tracksMerged = 0;
    for (const t of b.themes || []) {
      if (!t || !t.name || !Array.isArray(t.videos)) continue;
      const vids = t.videos.filter(v => v && /^[\w-]{11}$/.test(v.id)).map(cleanVideo);
      const editable = c => canEdit(catById.get(c.id));
      // the same theme may already be here — imported before, or from a share link (new id, same name)
      const same = user.categories.find(c => c.id === t.id) ||
        user.categories.find(c => c.name.toLowerCase() === String(t.name).toLowerCase() && editable(c));
      if (same && editable(same)) {                              // already here: add what's missing
        const have = new Set(same.videos.map(v => v.id));
        for (const v of vids) if (!have.has(v.id)) { same.videos.push(v); tracksMerged++; }
      } else {
        user.categories.push({ id: same ? "u-" + Date.now().toString(36) + themesNew : t.id,
          name: same ? uniqueName(t.name) : t.name, tagline: t.tagline || "", icon: t.icon || "tavern",
          hue: Number.isFinite(t.hue) ? t.hue : 38, open: !!t.open, yours: true, videos: vids });
        themesNew++;
      }
    }
    for (const [catId, list] of Object.entries(b.added || {})) {
      if (BASE.categories.some(c => c.id === catId)) tracksMerged += addVideosTo(catId, list.map(cleanVideo));
    }
    const extras = store.get("extraVideos", {});
    let favsNew = 0;
    for (const v of b.favorites || []) {
      if (!v || !/^[\w-]{11}$/.test(v.id)) continue;
      if (!videoById.has(v.id)) extras[v.id] = cleanVideo(v);
      if (!favorites.includes(v.id)) { favorites.push(v.id); favsNew++; }
    }
    store.set("extraVideos", extras);
    store.set("favorites", favorites);
    const p = b.prefs || {};
    if (p.mode === "here" || p.mode === "yt") setMode(p.mode);
    if (AUTO_STEPS.includes(p.autoMins)) { state.autoMins = p.autoMins; store.set("autoMins", p.autoMins); resetAutoTimer(); }
    if (Number.isFinite(p.volume)) setVolume(p.volume);
    if (typeof p.shuffle === "boolean") { state.shuffle = p.shuffle; store.set("shuffle", p.shuffle); }
    if (typeof p.loop === "boolean") { state.loop = p.loop; store.set("loop", p.loop); }
    if (typeof p.sfx === "boolean") setSfx(p.sfx);
    if (p.tricks && CURSORS.hasOwnProperty(p.tricks.cursor)) { Object.assign(tricks, p.tricks); saveTricks(); }
    if (typeof p.siteTitle === "string" && p.siteTitle.trim()) {
      siteTitle = p.siteTitle.trim().slice(0, 40);
      store.set("siteTitle", siteTitle);
      applySiteTitle();
    }
    commitUser();
    refreshView();
    const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
    const parts = [themesNew && n(themesNew, "new theme"), tracksMerged && n(tracksMerged, "track") + " added to themes you had",
      favsNew && n(favsNew, "favorite"), keysAdded && "owner key"].filter(Boolean);
    toast(parts.length ? "Imported: " + parts.join(", ") : "Everything in that backup is already here — nothing to add", { ms: 5000 });
  }

  async function addOwnerKey(raw) {
    const k = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (k.length !== 32) return toast("An owner key is 32 letters and numbers (0-9, a-f)");
    if (k === deviceKey || extraKeys.includes(k)) return toast("This browser already has that key");
    const before = LIB.categories.filter(c => c.custom && c.yours).length;
    extraKeys.push(k);
    store.set("ownerKeys", extraKeys);
    if (sync.server) { await loadUserData(); rebuildLibrary(); }
    refreshView();
    const gained = LIB.categories.filter(c => c.custom && c.yours).length - before;
    toast(sync.server ? `Key added — you can now edit ${gained} more theme${gained === 1 ? "" : "s"} here` : "Key added", { ms: 4500 });
  }

  // ---------- the "Share & move" page: how to take your music anywhere ----------
  function renderTransfer() {
    document.documentElement.style.setProperty("--theme-hue", 200);
    const mine = LIB.categories.filter(c => c.custom && c.yours !== false && c.videos.length);
    const others = user.categories.length - user.categories.filter(c => c.yours !== false).length;
    const keyShown = state.showKey;
    app.innerHTML = `
      <section class="theme-hero" style="--h:200">
        <span class="sigil" style="--h:200">${icons.share}</span>
        <div>
          <a class="crumb" href="#/" data-back>${icons.back} All themes</a>
          <h1>Share &amp; move</h1>
          <p class="tagline">Take your themes to a friend's house, a new phone, or a new browser — no account needed.</p>
        </div>
      </section>

      <div class="transfer">
        <section class="t-card t-wide">
          <h2>Where your music is saved</h2>
          <p>${sync.server
            ? (sync.public
            ? "Themes and tracks people add are saved on this website, so they're here wherever you open it — any device, anywhere. To give a theme to a friend who runs their own copy of the site, send a <b>share link</b>; to keep your own copy, download a <b>backup file</b>."
            : "Themes and tracks people add are saved on the computer running this site, and every device on this Wi-Fi sees them. Somewhere else — like a friend's house — they won't be there, so bring them along with a <b>share link</b> or a <b>backup file</b>.")
            : "Your themes, tracks and favorites are saved in <b>this browser only</b>. To use them in another browser or on another device, bring them along with a <b>share link</b> or a <b>backup file</b>."}</p>
        </section>

        <section class="t-card">
          <h2><span class="t-num">1</span> Share one theme</h2>
          <p>Makes a link you can text or email. Whoever opens it — you at a friend's, or a friend at home — can add a copy of the theme.</p>
          <ol class="t-steps"><li>Open a theme and press <b>Share</b>, or use a button below.</li><li>Press <b>Copy link</b> (or scan the QR code with your phone).</li><li>Send it — text, email or chat.</li></ol>
          <div class="t-buttons">
            ${mine.map(c => `<button class="btn" type="button" data-share="t-${c.id}">${icons.share}${esc(c.name)}</button>`).join("")}
            ${favorites.length ? `<button class="btn" type="button" data-share="favorites">${icons.share}Favorites</button>` : ""}
            ${!mine.length && !favorites.length ? `<p class="t-note">You haven't made any themes yet. Any theme page has a <b>Share</b> button too.</p>` : ""}
          </div>
        </section>

        <section class="t-card">
          <h2><span class="t-num">2</span> Import at a friend's house</h2>
          <p>Open <b>their</b> copy of the site, come to this page, and paste the link you sent yourself.</p>
          <label class="field"><span>Share link or code</span>
            <textarea id="importCode" rows="3" placeholder="Paste a share link here"></textarea></label>
          <div class="t-buttons"><button class="btn btn-gold" type="button" id="importCodeBtn">Import</button></div>
          <p class="t-note">Tip: on a TV, do this on a phone or laptop instead — typing with a remote is slow${sync.server ? ", and anything imported here shows up on the TV by itself" : ""}.</p>
        </section>

        <section class="t-card">
          <h2><span class="t-num">3</span> Move everything with a backup file</h2>
          <p>One small file with your themes, favorites, tracks you added and your settings. Use it for a new phone, a new browser, or just to keep a copy.</p>
          <ol class="t-steps"><li>Press <b>Download backup file</b> here.</li><li>Move the file to the new device (email it to yourself, a USB stick, cloud storage…).</li><li>On the new device, open this page and press <b>Import a backup file</b>.</li></ol>
          <label class="check"><input type="checkbox" id="bkKey">
            <span><b>Include my owner key</b> — so the new browser can edit and delete my themes too.
            <small>Anyone holding the file could then change your themes. Keep it private; don't send it to others.</small></span></label>
          ${others && (sync.host || !sync.server) ? `<label class="check"><input type="checkbox" id="bkAll">
            <span><b>Include everyone's themes</b> (${user.categories.length} in total) — a full copy of this site's library.</span></label>` : ""}
          <div class="t-buttons">
            <button class="btn btn-gold" type="button" id="bkDownload">Download backup file</button>
            <button class="btn" type="button" id="bkImport">Import a backup file</button>
            <input type="file" id="bkFile" accept=".json,application/json" hidden>
          </div>
          <p class="t-note">Importing never deletes anything — it adds what's new and skips what's already there.</p>
        </section>

        <section class="t-card">
          <h2><span class="t-num">4</span> Owner key <em>(advanced)</em></h2>
          <p>${sync.server ? "Each browser has a secret key. Themes you make belong to it: other people can play them, but only a browser with your key can change or delete them." : "Each browser has a secret key. If you later use a shared copy of the site (with serve.py), themes you bring belong to it."}
            If you move to a new browser, give it your key — through the backup file above, or by typing it here.</p>
          <div class="key-row">
            <code id="myKey">${keyShown ? deviceKey.match(/.{4}/g).join("-") : "••••-••••-••••-••••-••••-••••-••••-••••"}</code>
            <button class="btn" type="button" id="keyShow">${keyShown ? "Hide" : "Show my key"}</button>
            ${keyShown ? `<button class="btn" type="button" id="keyCopy">Copy</button>` : ""}
          </div>
          <label class="field"><span>Add a key from your other browser</span>
            <input id="keyInput" placeholder="e.g. 1a2b-3c4d-…" autocomplete="off" spellcheck="false"></label>
          <div class="t-buttons"><button class="btn" type="button" id="keyAdd">Add key</button></div>
          <p class="t-note">${extraKeys.length ? `This browser also holds ${extraKeys.length} key${extraKeys.length === 1 ? "" : "s"} from other browsers. ` : ""}Adding a key never removes this browser's own.</p>
        </section>
      </div>`;
    $("#importCodeBtn").onclick = () => {
      const code = extractCode($("#importCode").value);
      if (!code) return toast("Paste a share link first");
      if (!decodeShare(code)) return toast("That link doesn't look complete — was it cut off when it was sent?");
      location.hash = "#/import/" + code;
    };
    $("#bkDownload").onclick = downloadBackup;
    $("#bkImport").onclick = () => $("#bkFile").click();
    $("#bkFile").onchange = e => { if (e.target.files[0]) readBackupFile(e.target.files[0]); e.target.value = ""; };
    $("#keyShow").onclick = () => { state.showKey = !keyShown; refreshView(); };
    if ($("#keyCopy")) $("#keyCopy").onclick = async () => toast(await copyText(deviceKey) ? "Key copied" : "Select the key and copy it");
    $("#keyAdd").onclick = () => addOwnerKey($("#keyInput").value);
  }

  // ---------- YouTube links ----------
  function parseLink(text) {
    text = text.trim();
    if (/^[\w-]{11}$/.test(text)) return { kind: "video", id: text };
    let u;
    try { u = new URL(/^https?:\/\//i.test(text) ? text : "https://" + text); } catch { return null; }
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(u.hostname)) return null;
    const list = u.searchParams.get("list");
    let vid = u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (!vid && parts.length) {
      if (/youtu\.be$/i.test(u.hostname)) vid = parts[0];
      else if (["shorts", "embed", "live", "v"].includes(parts[0])) vid = parts[1];
    }
    // RD… lists are YouTube's endless auto-mixes: treat those links as the single video
    if (list && !/^(RD|UL|LL|WL)/.test(list)) return { kind: "playlist", id: list };
    if (vid && /^[\w-]{11}$/.test(vid)) return { kind: "video", id: vid };
    return null;
  }

  async function resolveLink(link) {
    const p = parseLink(link);
    if (!p) throw new Error("not a YouTube link");
    if (sync.server) {
      const r = await fetch("api/resolve?url=" + encodeURIComponent(link));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "lookup failed");
      return j;
    }
    if (p.kind === "playlist") throw new Error("playlists need the site running from serve.py");
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + p.id)).catch(() => null);
    if (!r || !r.ok) throw new Error("private, removed, or can't play on other sites");
    const j = await r.json();
    return { kind: "video", title: j.title, skipped: 0,
      items: [{ id: p.id, title: j.title, channel: j.author_name || "", length: 0, views: 0 }] };
  }

  // ---------- keep devices in step (PC adds tracks → the TV picks them up) ----------
  async function pullUserData() {
    if (!sync.server || sync.saving || dragging || !$("#modal").hidden || document.visibilityState !== "visible") return;
    const { server, data } = await fetchUserData();
    if (!server || sync.saving || (data.rev || 0) === sync.rev) return;
    adoptServer(data);
    rebuildLibrary();
    refreshView();
  }
  document.addEventListener("visibilitychange", pullUserData);
  setInterval(pullUserData, 20000);

  // ---------- click handling ----------
  document.addEventListener("click", e => {
    const t = e.target;
    // dialogs
    if (t === $("#modal") || t.closest("[data-close-modal]")) return closeModal();
    if (t.closest("#fSubmit")) return modalSubmit && modalSubmit();
    const pickIcon = t.closest("[data-pick-icon]"), pickHue = t.closest("[data-pick-hue]");
    if (pickIcon || pickHue) {
      const b = pickIcon || pickHue;
      $$(pickIcon ? ".pick-icon" : ".pick-hue").forEach(x => x.setAttribute("aria-pressed", x === b));
      if (pickHue) $(".icon-pick").style.setProperty("--h", b.dataset.pickHue);
      return;
    }
    const openAdd = t.closest("[data-open-add]");
    if (openAdd) return openAddDialog(openAdd.dataset.openAdd);
    // queue
    const q1 = t.closest("[data-queue-one]");
    if (q1) return queueOne(q1.dataset.queueOne);
    const qa = t.closest("[data-queueall]");
    if (qa) return queueAll(qa.dataset.queueall);
    const qp = t.closest("[data-qplay]");
    if (qp) {
      const id = qp.dataset.qplay;
      state.upNext = state.upNext.filter(x => x !== id);
      saveQueue();
      return beginPlayback(videoById.get(id));
    }
    const qj = t.closest("[data-qjump]");
    if (qj) { state.index = +qj.dataset.qjump; return startCurrent(); }
    const qr = t.closest("[data-qremove]");
    if (qr) { state.upNext = state.upNext.filter(x => x !== qr.dataset.qremove); return saveQueue(); }
    // editing lists
    const ed = t.closest("[data-edit]");
    if (ed) { state.editing = state.editing === ed.dataset.edit ? null : ed.dataset.edit; return refreshView(); }
    const rm = t.closest("[data-remove]");
    if (rm) return removeFromList(rm.dataset.remove);
    const rs = t.closest("[data-reset-theme]");
    if (rs) return resetTheme(rs.dataset.resetTheme);
    const st = t.closest("[data-theme-settings]");
    if (st) return openThemeSettings(st.dataset.themeSettings);
    const del = t.closest("[data-delete-theme]");
    if (del) return deleteTheme(del.dataset.deleteTheme);
    const restore = t.closest("[data-restore]");
    if (restore) return restoreTrash(restore.dataset.restore);
    const share = t.closest("[data-share]");
    if (share) return openShareDialog(share.dataset.share);
    if (t.closest("#renameSite, [data-rename-site]")) { e.preventDefault(); return openRenameSite(); }
    if (t.closest("[data-open-tricks]")) { e.preventDefault(); return openTricks(); }
    const trick = t.closest("[data-cursor]");
    if (trick) {
      tricks.cursor = trick.dataset.cursor;
      saveTricks();
      $$(".trick").forEach(b => b.setAttribute("aria-pressed", b === trick));
      return;
    }

    const yt = state.mode === "yt";
    const card = t.closest(".video-card");
    if (card) return yt ? openOnYouTube(card.dataset.list, { index: +card.dataset.i, single: true }) : playList(card.dataset.list, +card.dataset.i);
    const pa = e.target.closest("[data-playall]");
    if (pa) return yt ? openOnYouTube(pa.dataset.playall) : playList(pa.dataset.playall, 0, { shuffle: false });
    const sa = e.target.closest("[data-shuffleall]");
    if (sa) return yt ? openOnYouTube(sa.dataset.shuffleall, { shuffle: true }) : playList(sa.dataset.shuffleall, 0, { shuffle: true });
    const chip = e.target.closest(".tag-chip[data-tag]");
    if (chip) {
      const q = "#" + chip.dataset.tag;
      setQuery(state.query.trim().toLowerCase() === q ? "" : q); // tapping the active tag clears it
      if (state.query) showResults();
      return;
    }
    if (e.target.closest("#clearSearch")) { setQuery(""); $("#heroSearch").focus(); return; }
    const back = e.target.closest("[data-back]");
    if (back && history.length > 1 && focusMemory.has("/")) { e.preventDefault(); history.back(); return; }
    if (e.target.closest("#rollBtn")) return rollScene(e.target.closest("#rollBtn"));
    const roll = e.target.closest("[data-roll]");
    if (roll) return rollTrack(roll, roll.dataset.roll);
  });

  $("#btnPlay").onclick = togglePlay;
  $("#btnNext").onclick = () => next();
  $("#btnPrev").onclick = prev;
  $("#btnShuffle").onclick = () => { state.shuffle = !state.shuffle; store.set("shuffle", state.shuffle); updateDock(); toast(state.shuffle ? "Shuffle on" : "Shuffle off"); };
  $("#btnLoop").onclick = () => { state.loop = !state.loop; store.set("loop", state.loop); updateDock(); toast(state.loop ? "Repeating this track" : "Repeat off"); };
  $("#btnVolDown").onclick = () => { setVolume(state.volume - 10); toast(`Volume ${state.volume}%`); };
  $("#btnVolUp").onclick = () => { setVolume(state.volume + 10); toast(`Volume ${state.volume}%`); };
  $("#btnFav").onclick = toggleFav;
  $("#btnQueue").onclick = () => toggleQueue();
  $("#queueClose").onclick = () => toggleQueue(false);
  $("#queueClear").onclick = () => {
    const before = state.upNext.slice();
    state.upNext = [];
    saveQueue();
    toast(`Cleared ${before.length} queued track${before.length === 1 ? "" : "s"}`, { undo: () => { state.upNext = before; saveQueue(); } });
  };
  $("#queueSave").onclick = () => openAddDialog("__new", { fromQueue: true });
  $("#btnTheater").onclick = () => setTheater(!state.theater);
  $("#stageExpand").onclick = () => setTheater(true);
  $("#volBar").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); setVolume((e.clientX - r.left) / r.width * 100); };
  $("#progress").onclick = e => {
    if (!yt || !yt.getDuration) return;
    const r = e.currentTarget.getBoundingClientRect();
    yt.seekTo(yt.getDuration() * (e.clientX - r.left) / r.width, true);
  };

  // ---------- search ----------
  // The header box (inner pages) and the big home box share one query.
  const search = $("#search");
  let focusHeroAfterRoute = false;
  function setQuery(q, from) {
    state.query = q;
    if (from !== search) search.value = q;
    const hero = $("#heroSearch");
    if (hero && from !== hero) hero.value = q;
    if (currentRoute !== "/") { focusHeroAfterRoute = from === search; location.hash = "#/"; }
    else renderHomeBody();
  }
  search.addEventListener("input", () => setQuery(search.value, search));
  app.addEventListener("input", e => { if (e.target.id === "heroSearch") setQuery(e.target.value, e.target); });

  function showResults() {
    const body = $("#homeBody");
    if (!body) return;
    const top = body.getBoundingClientRect().top + scrollY - $("#topbar").offsetHeight - 12;
    scrollTo({ top, behavior: "smooth" });
    // remote users: jump straight to the first result instead of wading back through the chips
    if (keyMode()) ($("#homeBody .theme-card") || $("#homeBody .video-card") || $("#homeBody .tag-chip"))?.focus({ preventScroll: true });
  }

  // ---------- TV mode ----------
  const tvUA = /\b(SmartTV|SMART-TV|Tizen|Web0S|webOS|NetCast|BRAVIA|GoogleTV|Android TV|AFT[A-Z]|CrKey|Roku|HbbTV|TCL|Hisense|VIDAA)\b/i.test(navigator.userAgent);
  const params = new URLSearchParams(location.search);
  let tv = params.has("tv") ? params.get("tv") !== "0" : store.get("tv", tvUA);
  function setTV(on) {
    tv = on;
    store.set("tv", on);
    document.body.classList.toggle("tv", on);
    document.documentElement.classList.toggle("tv", on);
    $("#tvToggle").setAttribute("aria-pressed", on);
    if (window.GrimoireFX) window.GrimoireFX.setLite(on); // fewer particles for TV browsers
    initEmbers();
  }
  $("#tvToggle").onclick = () => { setTV(!tv); toast(tv ? "TV mode on — use arrow keys / remote" : "TV mode off"); };

  // ---------- keyboard / TV remote spatial navigation ----------
  let usingKeys = false;
  const keyMode = () => usingKeys || tv;
  addEventListener("mousemove", () => { if (usingKeys) { usingKeys = false; document.body.classList.remove("keys"); } }, { passive: true });

  function focusables() {
    const body = document.body.classList;
    const scope = body.contains("modal-open") ? $("#modal") : body.contains("queue-open") ? $("#queuePanel")
      : state.theater ? $("#dock") : document;
    return $$('a[href], button:not([disabled]), input, textarea, select, [tabindex="0"]', scope).filter(el => {
      if (el.tabIndex < 0 || el.closest("[inert]") || el.closest("[hidden]")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
  }

  function moveFocus(dir) {
    const items = focusables();
    const cur = document.activeElement;
    if (!cur || cur === document.body || cur === app || !items.includes(cur)) {
      const firstVisible = items.find(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && el.closest("#app"); });
      (firstVisible || items[0])?.focus({ preventScroll: true });
      ensureVisible(document.activeElement);
      return;
    }
    const a = cur.getBoundingClientRect();
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      let main, cross;
      if (dir === "right") { if (b.left + b.width / 2 <= a.left + a.width / 2) continue; main = Math.max(0, b.left - a.right); cross = gap(a.top, a.bottom, b.top, b.bottom); }
      if (dir === "left") { if (b.left + b.width / 2 >= a.left + a.width / 2) continue; main = Math.max(0, a.left - b.right); cross = gap(a.top, a.bottom, b.top, b.bottom); }
      if (dir === "down") { if (b.top + b.height / 2 <= a.top + a.height / 2 + 1) continue; main = Math.max(0, b.top - a.bottom); cross = gap(a.left, a.right, b.left, b.right); }
      if (dir === "up") { if (b.top + b.height / 2 >= a.top + a.height / 2 - 1) continue; main = Math.max(0, a.top - b.bottom); cross = gap(a.left, a.right, b.left, b.right); }
      const centerOff = dir === "left" || dir === "right"
        ? Math.abs((b.top + b.height / 2) - (a.top + a.height / 2))
        : Math.abs((b.left + b.width / 2) - (a.left + a.width / 2));
      const score = main + cross * 4 + centerOff * 0.05;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { best.focus({ preventScroll: true }); ensureVisible(best); }
    else if (dir === "down" && !state.theater && !$("#dock").hidden && !cur.closest("#dock")) $("#btnPlay").focus();
  }
  const gap = (a1, a2, b1, b2) => Math.max(0, Math.max(a1, b1) - Math.min(a2, b2));

  function ensureVisible(el) {
    if (!el || el.closest("#dock") || el.closest("#topbar")) return;
    const r = el.getBoundingClientRect();
    const top = $("#topbar").offsetHeight + 24;
    let bottom = innerHeight - ($("#dock").hidden ? 0 : $("#dock").offsetHeight) - 24;
    // don't leave the focused card hidden behind the floating mini player
    const s = $("#stage").getBoundingClientRect();
    if (!$("#dock").hidden && r.right > s.left && r.left < s.right) bottom = Math.min(bottom, s.top - 16);
    if (r.top < top) scrollBy({ top: r.top - top - 40, behavior: "smooth" });
    else if (r.bottom > bottom) scrollBy({ top: Math.min(r.bottom - bottom + 40, r.top - top), behavior: "smooth" });
    // horizontal shelves
    const shelf = el.closest(".shelf");
    if (shelf) { const s = shelf.getBoundingClientRect(); if (r.left < s.left || r.right > s.right) shelf.scrollBy({ left: r.left - s.left - 12, behavior: "smooth" }); }
  }

  const BACK_KEYS = new Set(["Escape", "GoBack", "BrowserBack", "Back"]);
  const BACK_CODES = new Set([461, 10009, 8]); // LG webOS, Samsung Tizen, Backspace

  function goBack() {
    if (!$("#modal").hidden) return closeModal();
    if (document.body.classList.contains("queue-open")) return toggleQueue(false);
    if (state.theater) return setTheater(false);
    if (state.editing) { state.editing = null; return refreshView(); }
    if (document.activeElement.matches("input") && document.activeElement.value) { setQuery(""); return; }
    if (currentRoute !== "/") { focusMemory.has("/") ? history.back() : (location.hash = "#/"); return; }
    if (state.query) { setQuery(""); scrollTo({ top: 0, behavior: "smooth" }); }
  }

  document.addEventListener("keydown", e => {
    const el = e.target instanceof Element ? e.target : document.body;
    const inInput = el.matches("input, textarea, select");
    const dirs = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (dragging) return;

    if (e.key in dirs) {
      const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (el.matches("textarea")) {
        // arrows move the caret, but ▲ at the very start / ▼ at the very end leave the box (a remote would be stuck otherwise)
        const atStart = el.selectionStart === 0, atEnd = el.selectionEnd === el.value.length;
        if (horizontal || (e.key === "ArrowUp" && !atStart) || (e.key === "ArrowDown" && !atEnd)) return;
      } else if (inInput && horizontal && !el.matches("select")) return; // move caret
      // on a <select>, ▲▼ move between fields like everywhere else; OK opens its list
      e.preventDefault();
      usingKeys = true; document.body.classList.add("keys");
      moveFocus(dirs[e.key]);
      return;
    }
    if (el.matches("input") && e.key === "Enter") {
      e.preventDefault(); usingKeys = true; document.body.classList.add("keys");
      if (!$("#modal").hidden) moveFocus("down");
      else if (state.query && $("#homeBody")) showResults();
      else moveFocus("down");
      if (document.activeElement === e.target) e.target.blur();
      return;
    }

    if (BACK_KEYS.has(e.key) || (BACK_CODES.has(e.keyCode) && !(inInput && e.keyCode === 8))) {
      if (e.keyCode === 8 && inInput) return;
      e.preventDefault();
      goBack();
      return;
    }
    if (inInput) return;

    switch (e.key) {
      case "MediaPlayPause": case "MediaPlay": case "MediaPause": case "k": case "K":
        e.preventDefault(); togglePlay(); break;
      case " ":
        if (!el.matches("button, a")) { e.preventDefault(); togglePlay(); } break;
      case "MediaTrackNext": case "MediaFastForward": case "n": case "N": case "ChannelUp": next(); break;
      case "MediaTrackPrevious": case "MediaRewind": case "p": case "P": case "ChannelDown": prev(); break;
      case "f": case "F": case "ColorF0Red": if (!$("#dock").hidden) setTheater(!state.theater); break;
      // Hardware volume keys are left to the OS/TV so they don't also lower the player.
      case "+": case "=": if (!$("#dock").hidden) { setVolume(state.volume + 10); toast(`Volume ${state.volume}%`); } break;
      case "-": if (!$("#dock").hidden) { setVolume(state.volume - 10); toast(`Volume ${state.volume}%`); } break;
      case "/": e.preventDefault(); ($("#heroSearch") || search).focus(); break;
      // queue the focused track (Q on a keyboard, the green / menu button on many TV remotes)
      case "q": case "Q": case "ColorF1Green": case "ContextMenu": {
        const card = document.activeElement && document.activeElement.closest(".video-card");
        if (card && state.mode !== "yt") { e.preventDefault(); queueOne(card.dataset.vid); }
        else if (e.key.toLowerCase() === "q" && !$("#dock").hidden) toggleQueue();
        break;
      }
      case "Enter":
        // anchors & buttons already activate on Enter; make other focusables work too
        if (document.activeElement && document.activeElement.matches('[tabindex="0"]')) document.activeElement.click();
        break;
    }
  });

  // Keep the remote working after the user clicks into the YouTube iframe.
  addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement && document.activeElement.tagName === "IFRAME") {
      document.activeElement.blur();
      if (keyMode()) $("#btnPlay").focus();
    }
  }, 0));

  // ---------- magical hover sounds (made on the fly with Web Audio — no sound files) ----------
  // A sparkle on themes, a lute-like pluck on tracks, a small bell on buttons. They also play
  // when the TV remote moves focus, since a TV has no mouse to hover with.
  const sfx = {
    on: store.get("sfx", true),
    ctx: null, out: null, last: 0, lastEl: null,
    // A-minor pentatonic, high and bright
    notes: [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760],
  };
  function sfxContext() {
    if (!sfx.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      sfx.ctx = new AC();
      // quiet master level + a short echo, which is what makes it sound "magical"
      const master = sfx.ctx.createGain(), delay = sfx.ctx.createDelay(), fb = sfx.ctx.createGain(), wet = sfx.ctx.createGain();
      master.gain.value = 0.9;
      delay.delayTime.value = 0.13; fb.gain.value = 0.32; wet.gain.value = 0.35;
      delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
      master.connect(sfx.ctx.destination);
      sfx.out = { dry: master, wet: delay };
    }
    if (sfx.ctx.state === "suspended") sfx.ctx.resume().catch(() => {});
    return sfx.ctx;
  }
  function tone(freq, start, { type = "sine", dur = 0.35, gain = 0.035, attack = 0.005 } = {}) {
    const ctx = sfx.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = (Math.random() - 0.5) * 12;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(sfx.out.dry); g.connect(sfx.out.wet);
    o.start(start); o.stop(start + dur + 0.05);
  }
  const pick = (from, to) => sfx.notes[from + Math.floor(Math.random() * (to - from))];
  const SOUNDS = {
    // rising shimmer of three or four high notes
    sparkle(t) { const n = 3 + Math.floor(Math.random() * 2), base = Math.floor(Math.random() * 4) + 5;
      for (let i = 0; i < n; i++) tone(sfx.notes[Math.min(base + i, sfx.notes.length - 1)], t + i * 0.045, { dur: 0.45, gain: 0.022 }); },
    // a plucked string: bright triangle, quick decay
    pluck(t) { const f = pick(0, 5); tone(f, t, { type: "triangle", dur: 0.28, gain: 0.05, attack: 0.002 }); tone(f * 2, t, { dur: 0.12, gain: 0.012, attack: 0.002 }); },
    // a tiny bell: a fundamental plus an out-of-tune overtone
    bell(t) { const f = pick(4, 9); tone(f, t, { dur: 0.6, gain: 0.02 }); tone(f * 2.76, t, { dur: 0.25, gain: 0.008 }); },
  };
  function playSfx(el) {
    if (!sfx.on || !el || el === sfx.lastEl) return;
    const now = performance.now();
    if (now - sfx.last < 60) return; // sweeping across a grid shouldn't machine-gun
    sfx.last = now;
    sfx.lastEl = el;
    const ctx = sfxContext();
    if (!ctx || ctx.state !== "running") return; // browsers allow audio only after the first click or key press
    const kind = el.matches(".theme-card, .tag-chip") ? "sparkle" : el.matches(".video-card, .q-play") ? "pluck" : "bell";
    SOUNDS[kind](ctx.currentTime + 0.01);
  }
  const SFX_TARGETS = ".theme-card, .video-card, .tag-chip, .btn, .ctl, .chip, .q-play, .pick-icon, .pick-hue, .segmented button";
  document.addEventListener("pointerover", e => {
    if (e.pointerType !== "mouse") return; // on touch screens a "hover" is really a tap
    const el = e.target.closest(SFX_TARGETS);
    if (el && !el.contains(e.relatedTarget)) playSfx(el);
  });
  document.addEventListener("pointerout", e => { if (sfx.lastEl && !sfx.lastEl.contains(e.relatedTarget)) sfx.lastEl = null; });
  document.addEventListener("focusin", e => { if (usingKeys || tv) playSfx(e.target.closest(SFX_TARGETS)); });
  // unlock audio on the first interaction, so the very first hover afterwards can play
  ["pointerdown", "keydown"].forEach(ev => addEventListener(ev, () => { if (sfx.on) sfxContext(); }, { once: true, passive: true }));
  function setSfx(on) {
    sfx.on = on;
    store.set("sfx", on);
    const b = $("#sfxToggle");
    b.setAttribute("aria-pressed", on);
    b.title = `Magical hover sounds: ${on ? "on" : "off"}`;
  }
  $("#sfxToggle").onclick = () => {
    setSfx(!sfx.on);
    if (sfx.on) { sfx.lastEl = null; sfxContext(); setTimeout(() => SOUNDS.sparkle(sfx.ctx.currentTime + 0.02), 30); }
    toast(sfx.on ? "✨ Hover sounds on" : "Hover sounds off");
  };

  // ---------- easter egg: the Bag of Tricks (fantasy cursors with magical trails) ----------
  // Found by rolling a natural 20, clicking the d20 logo five times, typing "nat20",
  // or ▲▲▼▼◀▶◀▶ + OK on a remote. After that it's in the footer.
  const tricks = Object.assign({ unlocked: false, cursor: "default", trail: true, fx: "auto" }, store.get("tricks", {}));
  // 32×32 cursors; [svg, hotspot x, y, trail kind]. The hotspot is the pointy end.
  const CURSORS = {
    default: null,
    d20: [`<path d="M16 2 28 9v14l-12 7-12-7V9z" fill="#d9a441" stroke="#1b1206" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M16 2v7M28 9l-4 13M4 9l4 13M16 9l8 13H8zM16 30v-8M8 22l-4 1M24 22l4 1" fill="none" stroke="#1b1206" stroke-width="1.1"/>
      <text x="16" y="19.5" font-size="7" font-weight="700" text-anchor="middle" fill="#1b1206" font-family="sans-serif">20</text>`, 16, 2, "pips"],
    sword: [`<path d="M2 2 6 3 22 19 19 22 3 6z" fill="#eef0f6" stroke="#1d1b24" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M4 4 20.5 20.5" stroke="#9aa0b4" stroke-width=".8"/>
      <path d="M16.5 24.5 24.5 16.5" stroke="#1d1b24" stroke-width="4.4" stroke-linecap="round"/>
      <path d="M16.5 24.5 24.5 16.5" stroke="#d9a441" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M21.5 21.5 27 27" stroke="#1d1b24" stroke-width="4" stroke-linecap="round"/>
      <path d="M21.5 21.5 27 27" stroke="#7a4a26" stroke-width="2" stroke-linecap="round"/>
      <circle cx="28.3" cy="28.3" r="2.4" fill="#d9a441" stroke="#1d1b24" stroke-width="1.1"/>`, 2, 2, "glint"],
    wand: [`<path d="M9 9 29 29" stroke="#1b1206" stroke-width="4.2" stroke-linecap="round"/>
      <path d="M9 9 29 29" stroke="#8a5a34" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M22 22 27 27" stroke="#f3cf7a" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M6 0.8 7.6 4.4 11.4 4.8 8.5 7.3 9.4 11.1 6 9.1 2.6 11.1 3.5 7.3 0.6 4.8 4.4 4.4z" fill="#ffe39c" stroke="#1b1206" stroke-width="1" stroke-linejoin="round"/>`, 6, 6, "sparkle"],
    quill: [`<path d="M29.5 1.5C19 2.5 10 9 7.5 21.5 15 22 25.5 14 29.5 1.5z" fill="#f1e6cf" stroke="#1b1206" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M27.5 4 5 27M22 6.5l-2.5 3M18 10l-3 2.5M14 14.5l-3 1.5" stroke="#1b1206" stroke-width="1"/>
      <path d="M6 24 2.5 30 4 30.5 9 23z" fill="#2a3a6a" stroke="#1b1206" stroke-width="1"/>`, 2, 30, "ink"],
    torch: [`<path d="M11 13 28 30" stroke="#1b1206" stroke-width="4.6" stroke-linecap="round"/>
      <path d="M11 13 28 30" stroke="#7a4a26" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M9 9l6 6" stroke="#5a5a64" stroke-width="5" stroke-linecap="round"/>
      <path d="M7 1C3 6 2 9 4.5 12.5 7 15 11 13.5 11.5 10.5 12 7.5 9 6 9.5 3 8 5 7 6 7 7.5 6 6 6.5 3 7 1z" fill="#ff9d2e" stroke="#1b1206" stroke-width="1" stroke-linejoin="round"/>
      <path d="M7 7c-1.5 2-1.5 4 .5 5 1.8.6 2.8-1 2.3-2.6C9.3 8 8 8.4 7 7z" fill="#ffe39c"/>`, 7, 1, "ember"],
  };
  const CURSOR_NAMES = { default: "Normal", d20: "D20", sword: "Sword", wand: "Magic wand", quill: "Quill", torch: "Torch" };
  const cursorUrl = (svg, glow) => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${
      glow ? `<filter id="g"><feDropShadow dx="0" dy="0" stdDeviation="1.2" flood-color="#ffd76a"/></filter><g filter="url(#g)">${svg}</g>` : svg}</svg>`);

  function applyCursor() {
    const c = CURSORS[tricks.cursor];
    let css = "";
    if (c) {
      const [svg, x, y] = c;
      // over things you can click, the same cursor with a golden glow instead of the pointing hand
      css = `html, body { cursor: url("${cursorUrl(svg)}") ${x} ${y}, auto; }
        a, button, label, select, summary, .theme-card, .video-card, .vol, .dock-progress, [data-tag] {
          cursor: url("${cursorUrl(svg, true)}") ${x} ${y}, pointer; }
        input, textarea { cursor: text; }`;
    }
    let tag = $("#cursorStyle");
    if (!tag) { tag = document.createElement("style"); tag.id = "cursorStyle"; document.head.appendChild(tag); }
    tag.textContent = css;
    $("#tricksLink").hidden = !tricks.unlocked;
  }

  // the trail: small particles that drift away from the cursor
  let lastTrail = 0;
  document.addEventListener("pointermove", e => {
    const c = CURSORS[tricks.cursor];
    if (!c || !tricks.trail || e.pointerType !== "mouse" || tv) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const now = performance.now();
    if (now - lastTrail < 28) return;
    lastTrail = now;
    const host = $("#trail");
    if (host.childElementCount > 45) return;
    const p = document.createElement("i");
    p.className = "trail-p trail-" + c[3];
    p.style.left = e.clientX + (Math.random() * 10 - 5) + "px";
    p.style.top = e.clientY + (Math.random() * 10 - 5) + "px";
    p.style.setProperty("--dx", (Math.random() * 30 - 15) + "px");
    p.style.setProperty("--dy", (Math.random() * 16 + (c[3] === "ember" ? -34 : c[3] === "ink" ? 22 : -10)) + "px");
    if (c[3] === "pips") p.textContent = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][Math.floor(Math.random() * 6)];
    host.appendChild(p);
    p.addEventListener("animationend", () => p.remove());
  }, { passive: true });

  function saveTricks() { store.set("tricks", tricks); applyCursor(); }

  function unlockTricks(how) {
    const first = !tricks.unlocked;
    tricks.unlocked = true;
    saveTricks();
    toast(first ? `🎲 ${how} You found a secret: the Bag of Tricks!` : "🎲 The Bag of Tricks", { ms: 4000 });
    setTimeout(openTricks, first ? 700 : 0);
  }

  function openTricks() {
    const preview = key => CURSORS[key]
      ? `<img src="${cursorUrl(CURSORS[key][0])}" alt="" width="32" height="32">` : `<span class="trick-arrow">➤</span>`;
    openModal(`
      <h2>🎲 Bag of Tricks</h2>
      <p class="muted">A secret, just for this browser. Pick a cursor — each one leaves its own magical trail.</p>
      <div class="trick-grid">${Object.keys(CURSORS).map(k => `
        <button type="button" class="trick" data-cursor="${k}" aria-pressed="${tricks.cursor === k}">${preview(k)}<span>${CURSOR_NAMES[k]}</span></button>`).join("")}
      </div>
      <label class="check"><input type="checkbox" id="trickTrail" ${tricks.trail ? "checked" : ""}>
        <span><b>Magical trail</b> — sparkles, embers, ink or dice follow the cursor.</span></label>
      <label class="field"><span>Scene effect</span><select id="trickFx">
        <option value="auto" ${tricks.fx === "auto" ? "selected" : ""}>Match the music (normal)</option>
        ${Object.entries(FX_NAMES).map(([k, n]) => `<option value="${k}" ${tricks.fx === k ? "selected" : ""}>Always: ${n}</option>`).join("")}
      </select></label>
      <div class="modal-actions"><button class="btn btn-gold" type="button" data-close-modal autofocus>Done</button></div>`, null);
    $("#trickTrail").onchange = e => { tricks.trail = e.target.checked; saveTricks(); };
    $("#trickFx").onchange = e => { tricks.fx = e.target.value; saveTricks(); if (!fxState.on) setFx(true); else updateFx(); };
  }

  // secret 1: five quick clicks on the d20 logo
  let dieClicks = [];
  $(".brand").addEventListener("click", () => {
    const now = Date.now();
    dieClicks = [...dieClicks.filter(t => now - t < 2500), now];
    spinDie($(".brand"));
    if (dieClicks.length >= 5) { dieClicks = []; unlockTricks("Five taps on the die…"); }
  });
  // secret 2: type "nat20"; secret 3 (for remotes): ▲▲▼▼◀▶◀▶ then OK
  const CHEAT = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "Enter"];
  let typed = "", keys = [];
  document.addEventListener("keydown", e => {
    if (e.target instanceof Element && e.target.matches("input, textarea")) return;
    keys = [...keys, e.key].slice(-CHEAT.length);
    if (keys.join() === CHEAT.join()) { keys = []; e.preventDefault(); unlockTricks("A secret code!"); return; }
    if (e.key.length === 1) {
      typed = (typed + e.key.toLowerCase()).slice(-5);
      if (typed === "nat20") { typed = ""; unlockTricks("Natural 20!"); }
    }
  });

  // ---------- scene effects: a light animated layer that matches the music (js/effects.js) ----------
  // The first rule whose hashtags match what's playing (or the theme page you're on) wins,
  // so specific moods (candlelight for crypts) beat general ones (embers for any battle).
  const FX_RULES = [
    ["candle", ["horror", "tomb", "crypt", "vampire", "vampire-court", "undead", "ghost", "ghosts", "cthulhu", "coc", "haunted-manor",
      "catacombs", "asylum", "dark-ritual", "cultists", "graveyard-night", "necromancer", "lich", "ravenloft", "barovia", "delta-green",
      "darkest-dungeon", "bloodborne", "eerie", "sinister", "whispers", "dark-carnival", "dungeon", "candle", "vtm"]],
    ["storm", ["storm", "windstorm", "naval-battle"]],
    ["neon", ["cyberpunk", "cyberpunk-red", "shadowrun"]],
    ["snow", ["winter", "blizzard", "snowfall", "tundra", "glacier", "icewind-dale", "ice-cave", "arctic", "white-dragon", "skyrim", "norse", "mountain"]],
    ["ash", ["volcano", "nine-hells", "demon", "devil", "avernus", "abyss", "red-dragon", "mork-borg", "hades"]],
    ["bubbles", ["underwater", "kraken", "siren"]],
    ["sand", ["desert", "sandstorm", "egypt", "pyramid", "oasis", "dark-sun", "heatwave"]],
    ["rain", ["rain", "heavy-rain", "rainy-day", "swamp", "black-dragon"]],
    ["petals", ["eastern", "japan", "china", "korea", "spring", "romance", "wedding", "samurai", "l5r", "genshin"]],
    ["leaves", ["autumn", "druid", "treant", "countryside", "farmstead", "festival"]],
    ["confetti", ["celebration", "carnival", "dance", "drinking-songs", "tavern-brawl", "level-up", "triumphant", "coronation", "tournament"]],
    ["sparkles", ["fairy", "fey-lords", "witchlight", "wizard", "mystical", "celestial", "heaven", "unicorn", "magic-school", "strixhaven",
      "dream-realm", "sorcerer", "warlock", "music-box", "wonder", "dreamy", "gold-dragon", "potion", "alchemy-lab", "arcane"]],
    ["stars", ["space", "astral", "starry-night", "stargazing", "void", "observatory", "sky", "aurora", "starfinder", "spelljammer",
      "traveller", "star-wars", "mothership", "alien-rpg", "coriolis", "twilight", "midnight"]],
    ["fireflies", ["forest", "night", "rest", "lakeside", "summer", "jungle", "mushroom-forest", "elven", "ranger", "lullaby", "peaceful"]],
    ["fog", ["fog", "sea", "sailing", "pirate", "pirate-crew", "docks", "lighthouse", "below-deck", "beach", "mystery", "shadowfell", "limbo", "mysterious", "ominous", "tension", "afterlife", "mirror-realm", "stealth",
      "thieves", "moors", "werewolf", "hag", "witch", "sewers", "bandits"]],
    ["embers", ["fire", "battle", "boss", "dragon", "forge", "fireplace", "barbarian", "war-drums", "siege-battle", "epic", "phoenix",
      "dwarven", "orc", "giant", "campfire", "rage", "last-stand", "war-camp"]],
    ["dust", ["tavern", "library", "great-library", "castle", "church", "city", "village", "market", "royal", "planning", "candlekeep",
      "guildhall", "throne-room", "calm", "cozy", "shop", "inn", "medieval", "bard", "lute"]],
  ];
  const FX_NAMES = { candle: "Candlelight", storm: "Thunderstorm", neon: "Neon rain", snow: "Snow", ash: "Falling ash",
    bubbles: "Bubbles", sand: "Blowing sand", rain: "Rain", petals: "Cherry blossoms", leaves: "Autumn leaves",
    confetti: "Confetti", sparkles: "Magic sparkles", stars: "Stars", fireflies: "Fireflies", fog: "Fog", embers: "Embers", dust: "Dust motes" };
  const fxState = { on: store.get("fx", !matchMedia("(prefers-reduced-motion: reduce)").matches) };

  function fxFor(tags) {
    const have = new Set(tags);
    for (const [kind, list] of FX_RULES) if (list.some(t => have.has(t))) return kind;
    return null;
  }
  // a theme's own identity wins ("forest" → fireflies) over tags its tracks happen to share ("magical")
  const fxForTheme = (id, tags) => fxFor([id]) || fxFor(tags);
  // Hashtags that describe a whole theme: its id plus those most of its tracks share.
  function themeTags(c) {
    const counts = new Map();
    for (const v of c.videos) for (const t of v.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [c.id, ...[...counts].filter(([, n]) => n >= c.videos.length * 0.4).map(([t]) => t)];
  }
  function updateFx() {
    if (!window.GrimoireFX) return;
    let kind = null;
    if (fxState.on) {
      if (tricks.fx && tricks.fx !== "auto") kind = tricks.fx;       // forced from the Bag of Tricks
      else if (state.now && state.playing) kind = fxForTheme(state.now.cat, state.now.tags || []); // paused: follow the page
      else {
        const m = (currentRoute || "").match(/^\/t\/(.+)$/);
        const c = m && catById.get(decodeURIComponent(m[1]));
        if (c) kind = fxForTheme(c.id, themeTags(c));
      }
    }
    window.GrimoireFX.show(kind);
  }
  function setFx(on) {
    fxState.on = on;
    store.set("fx", on);
    const b = $("#fxToggle");
    b.setAttribute("aria-pressed", on);
    b.title = `Scene effects that match the music: ${on ? "on" : "off"}`;
    updateFx();
  }
  $("#fxToggle").onclick = () => { setFx(!fxState.on); toast(fxState.on ? "✨ Scene effects on — they match what's playing" : "Scene effects off"); };

  // Critical hits and fumbles on every d20 roll.
  function rollFlourish(btn, roll) {
    if (roll === 20) {
      if (!tv) window.GrimoireFX.burst(btn);
      if (sfx.on && sfxContext() && sfx.ctx.state === "running") {
        const t = sfx.ctx.currentTime + 0.02; // a rising fanfare
        [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98].forEach((f, i) => tone(f, t + i * 0.07, { dur: 0.7, gain: 0.03 }));
      }
    } else if (roll === 1) {
      window.GrimoireFX.fumble(btn, app);
      if (sfx.on && sfxContext() && sfx.ctx.state === "running") {
        const t = sfx.ctx.currentTime + 0.02; // wah-wah-wah-waaah
        [392, 369.99, 349.23, 329.63].forEach((f, i) => tone(f, t + i * 0.28, { type: "triangle", dur: i === 3 ? 0.9 : 0.3, gain: 0.045 }));
      }
    }
  }

  // Page turns: the old page swings away like a page in a spellbook while the new one appears beneath.
  function pageTurn(back) {
    if (tv || matchMedia("(prefers-reduced-motion: reduce)").matches || !app.firstElementChild) return;
    const r = app.getBoundingClientRect(), top = Math.max(r.top, 0);
    const page = app.cloneNode(true);
    page.removeAttribute("id");
    page.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
    page.classList.remove("enter");
    page.style.marginTop = Math.min(0, r.top - top) + "px"; // keep what was scrolled into view
    const sheet = document.createElement("div");
    sheet.className = "page-turn " + (back ? "turn-back" : "turn-fwd");
    sheet.setAttribute("aria-hidden", "true");
    sheet.style.cssText = `top:${top}px;left:${r.left}px;width:${r.width}px;height:${innerHeight - top}px`;
    sheet.appendChild(page);
    document.body.appendChild(sheet);
    sheet.addEventListener("animationend", () => sheet.remove());
    setTimeout(() => sheet.remove(), 1200);
  }

  // ---------- ambience: floating embers ----------
  function initEmbers() {
    const host = $(".bg-embers");
    host.innerHTML = "";
    if (tv || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (let i = 0; i < 18; i++) {
      const s = document.createElement("i");
      s.style.left = Math.random() * 100 + "%";
      s.style.animationDuration = 12 + Math.random() * 16 + "s";
      s.style.animationDelay = -Math.random() * 25 + "s";
      s.style.setProperty("--drift", (Math.random() * 160 - 80) + "px");
      s.style.transform = `scale(${0.5 + Math.random()})`;
      host.appendChild(s);
    }
  }

  // ---------- boot ----------
  try { localStorage.removeItem("grimoire.volume"); } catch { /* old 70% default, no longer used */ }
  setVolume(state.volume, false);
  resetAutoTimer();
  setTV(tv);
  setMode(state.mode);
  applySiteTitle();
  setSfx(sfx.on);
  applyCursor();

  (async () => {
    await loadUserData(); // themes & tracks people added (shared via serve.py, or this browser)
    rebuildLibrary();
    favorites = favorites.filter(id => videoById.has(id));
    recent = recent.filter(id => videoById.has(id));
    state.upNext = state.upNext.filter(id => videoById.has(id));
    saveQueue();
    if (BASE.generated) $("#builtOn").textContent = `Library of ${TOTAL} tracks compiled ${BASE.generated}.`;
    addEventListener("hashchange", route);
    route();
    setFx(fxState.on);
    if (location.protocol === "file:") toast("Open via a web server (see README) — YouTube won't play from file://");
  })();
})();
