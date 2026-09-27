"""
Local server for The Bard's Grimoire.

Serves the site like `python -m http.server`, plus:
  * Cache-Control: no-cache, so TVs and phones never keep running an old copy.
  * /api/user-data  GET/PUT: themes, tracks and custom order people add on the
    site, saved to data/user-library.json so every device on the Wi-Fi (PC,
    phone, TV) sees the same thing. With no logins, it guards that file by:
      - a revision number, so a page with stale data can't overwrite newer changes;
      - device ownership: a theme belongs to the device that made it (a random
        key kept in that browser). Others can play and queue it, but only that
        device (or this PC, the host) can change or delete it — unless its
        owner marks it "open";
      - a 30-day "Recently deleted" trash that can be restored but not emptied;
      - a backup of the previous file before every save (data/backups/).
  * /api/resolve?url=...  turns a pasted YouTube link (video or playlist) into
    track info, skipping videos whose owners don't allow embedding.

    python serve.py                      # port 8080
    python serve.py 9000                 # another port
    python serve.py --backups            # list backups
    python serve.py --restore FILE       # roll the shared library back to a backup
"""
import argparse
import gzip
import hashlib
import html
import http.server
import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
# Where the shared library lives. On Railway, attach a volume and this follows it automatically.
DATA_DIR = (os.environ.get("GRIMOIRE_DATA_DIR") or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
            or os.path.join(ROOT, "data"))
DATA_FILE = os.path.join(DATA_DIR, "user-library.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
# Hosted on the internet (Railway) rather than at home: there is no "host PC", and people
# anywhere can reach it. An admin key (a Railway variable) gives its holder host powers instead.
PUBLIC = bool(os.environ.get("RAILWAY_PROJECT_ID") or os.environ.get("GRIMOIRE_PUBLIC"))
ADMIN_KEY = (os.environ.get("GRIMOIRE_ADMIN_KEY") or "").strip().lower()
# Only the site's own files are served — never the data folder, the tools, or this script.
PUBLIC_FILES = re.compile(r"^/(|index\.html|css/[\w.-]+\.css|js/[\w.-]+\.js)$")
GZIP_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
              ".js": "text/javascript; charset=utf-8"}
_gzip_cache = {}
# Rate limits per visitor, per minute (the site is on the open internet when hosted).
LIMITS = {"save": 40, "resolve": 30, "read": 240}
_hits, _hits_lock = {}, threading.Lock()
MAX_BYTES = 2_000_000       # refuse absurdly large saves
MAX_PLAYLIST = 200
TRASH_DAYS = 30
KEEP_RECENT_BACKUPS = 50    # plus the first backup of each day for TRASH_DAYS days
WRITE_LOCK = threading.Lock()
HOST_ADDRS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}  # + this PC's LAN address, added at startup

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


# ---------------------------------------------------------------- YouTube lookups
def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


def parse_link(text):
    """Returns ("video", id), ("playlist", id) or None for a pasted link/ID."""
    text = text.strip()
    if VIDEO_ID.match(text):
        return ("video", text)
    u = urllib.parse.urlparse(text if "://" in text else "https://" + text)
    q = urllib.parse.parse_qs(u.query)
    lst, vid = q.get("list", [None])[0], q.get("v", [None])[0]
    parts = [p for p in u.path.split("/") if p]
    if not vid and parts:
        if "youtu.be" in u.netloc:
            vid = parts[0]
        elif parts[0] in ("shorts", "embed", "live", "v") and len(parts) > 1:
            vid = parts[1]
    # RD… lists are YouTube's endless auto-mixes; treat those links as the single video
    if lst and not lst.startswith(("RD", "UL", "LL", "WL")):
        return ("playlist", lst)
    if vid and VIDEO_ID.match(vid):
        return ("video", vid)
    return None


def oembed(vid):
    status, body = fetch("https://www.youtube.com/oembed?format=json&url=" +
                         urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}"))
    return json.loads(body) if status == 200 else None


def video_info(vid):
    meta = oembed(vid)
    if not meta:
        return None  # removed, private, or embedding disabled
    info = {"id": vid, "title": meta.get("title", vid), "channel": meta.get("author_name", ""),
            "length": 0, "views": 0}
    status, page = fetch(f"https://www.youtube.com/watch?v={vid}")
    if status == 200:
        m = re.search(r'"lengthSeconds":"(\d+)"', page)
        n = re.search(r'"viewCount":"(\d+)"', page)
        info["length"] = int(m.group(1)) if m else 0
        info["views"] = int(n.group(1)) if n else 0
    return info


def _walk(o, key):
    if isinstance(o, dict):
        if key in o:
            yield o[key]
        for v in o.values():
            yield from _walk(v, key)
    elif isinstance(o, list):
        for x in o:
            yield from _walk(x, key)


def _secs(text):
    total = 0
    for part in text.split(":"):
        total = total * 60 + int(part)
    return total


def _views(label):
    m = re.search(r"([\d.,]+)\s*(thousand|million|billion|K|M|B)?", label or "", re.I)
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    mult = {"thousand": 1e3, "k": 1e3, "million": 1e6, "m": 1e6, "billion": 1e9, "b": 1e9}
    return int(n * mult.get((m.group(2) or "").lower(), 1))


def playlist_info(pid):
    status, page = fetch(f"https://www.youtube.com/playlist?list={pid}")
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", page)
    if status != 200 or not m:
        return None
    data = json.loads(m.group(1))
    t = re.search(r'<meta property="og:title" content="([^"]*)"', page)
    title = html.unescape(t.group(1)) if t else "YouTube playlist"
    items = []
    # current layout
    for lv in _walk(data, "lockupViewModel"):
        if lv.get("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO":
            continue
        md = lv.get("metadata", {}).get("lockupMetadataViewModel", {})
        rows = md.get("metadata", {}).get("contentMetadataViewModel", {}).get("metadataRows", [])
        parts = [p for r in rows for p in r.get("metadataParts", [])]
        blob = json.dumps(lv.get("contentImage", {}))
        dur = re.search(r'"text":\s*"(\d{1,2}(?::\d{2}){1,2})"', blob)
        items.append({
            "id": lv.get("contentId"),
            "title": md.get("title", {}).get("content", ""),
            "channel": parts[0]["text"]["content"] if parts else "",
            "length": _secs(dur.group(1)) if dur else 0,
            "views": next((_views(p.get("accessibilityLabel")) for p in parts
                           if "view" in (p.get("accessibilityLabel") or "")), 0),
        })
    # older layout
    for r in _walk(data, "playlistVideoRenderer"):
        if not r.get("isPlayable", True):
            continue
        items.append({
            "id": r.get("videoId"),
            "title": "".join(x.get("text", "") for x in r.get("title", {}).get("runs", [])),
            "channel": (r.get("shortBylineText", {}).get("runs") or [{}])[0].get("text", ""),
            "length": int(r.get("lengthSeconds") or 0), "views": 0,
        })
    seen, unique = set(), []
    for it in items:
        if it["id"] and VIDEO_ID.match(it["id"]) and it["id"] not in seen:
            seen.add(it["id"])
            unique.append(it)
    unique = unique[:MAX_PLAYLIST]
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(lambda it: oembed(it["id"]) is not None, unique))
    good = [it for it, fine in zip(unique, ok) if fine]
    return {"kind": "playlist", "title": title, "items": good, "skipped": len(unique) - len(good)}


def resolve(url):
    link = parse_link(url)
    if not link:
        return 400, {"error": "That doesn't look like a YouTube video or playlist link."}
    kind, ident = link
    if kind == "playlist":
        info = playlist_info(ident)
        if not info:
            return 404, {"error": "Couldn't open that playlist. Is it public or unlisted?"}
        return 200, info
    info = video_info(ident)
    if not info:
        return 404, {"error": "That video is private, removed, or doesn't allow playing on other sites."}
    return 200, {"kind": "video", "title": info["title"], "items": [info], "skipped": 0}


# ---------------------------------------------------------------- the shared library file
def load_doc():
    doc = {}
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf8") as f:
            doc = json.load(f)
    doc.setdefault("rev", 0)
    for key, empty in (("categories", []), ("trash", []), ("added", {}), ("order", {}), ("hidden", {})):
        if not isinstance(doc.get(key), type(empty)):
            doc[key] = empty
    return doc


def write_doc(doc):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA_FILE)  # atomic: a crash never leaves a half-written file


def backup_current():
    """Copy the current file into data/backups/ before it's replaced."""
    if not os.path.exists(DATA_FILE):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    rev = load_doc().get("rev", 0)
    shutil.copy2(DATA_FILE, os.path.join(BACKUP_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}-r{rev}.json"))
    files = sorted(f for f in os.listdir(BACKUP_DIR) if f.endswith(".json"))
    keep = set(files[-KEEP_RECENT_BACKUPS:])
    first_of_day = {}
    for f in files:
        first_of_day.setdefault(f[:8], f)
    cutoff = time.strftime("%Y%m%d", time.localtime(time.time() - TRASH_DAYS * 86400))
    keep |= {f for day, f in first_of_day.items() if day >= cutoff}
    for f in files:
        if f not in keep:
            os.remove(os.path.join(BACKUP_DIR, f))


def key_hash(key):
    """Themes store a hash of their device's key, never the key itself."""
    if not key or not (16 <= len(key) <= 128):
        return None
    return hashlib.sha256(("grimoire:" + key).encode()).hexdigest()[:32]


def key_hashes(header):
    """A browser sends its own key first, then any owner keys it was given (from a backup file)."""
    hashes = [key_hash(k.strip()) for k in (header or "").split(",")[:20]]
    return [h for h in hashes if h]


def view(doc, khs, host):
    """The library as one device sees it: which themes are its own, and whether it's the host."""
    out = json.loads(json.dumps(doc))
    for c in out["categories"]:
        c["yours"] = bool(c.get("owner") and c.get("owner") in khs)
    out["host"] = host
    out["public"] = PUBLIC
    return out


def purge_trash(doc):
    cutoff = (time.time() - TRASH_DAYS * 86400) * 1000
    doc["trash"] = [e for e in doc["trash"] if isinstance(e, dict) and e.get("deletedAt", 0) >= cutoff]


def was_restored(entry, new):
    """A trash entry may only leave the trash by being restored."""
    kind, frm = entry.get("kind"), entry.get("from")
    vid = (entry.get("video") or {}).get("id")
    if kind == "theme":
        return any(c.get("id") == (entry.get("theme") or {}).get("id") for c in new["categories"])
    if kind == "hide":
        return vid not in new["hidden"].get(frm, [])
    if kind == "track":
        lists = [c.get("videos", []) for c in new["categories"] if c.get("id") == frm] + [new["added"].get(frm, [])]
        return any(v.get("id") == vid for lst in lists for v in lst)
    return False


def check_write(old, new, khs, host):
    """Returns an error message if this save breaks the rules, else None. Also assigns owners to new themes."""
    kh = khs[0] if khs else None  # new themes belong to the browser's own key
    old_t = {c.get("id"): c for c in old["categories"]}
    new_t = {c.get("id"): c for c in new["categories"]}
    trashed = {e["theme"].get("id"): e["theme"] for e in old["trash"]
               if e.get("kind") == "theme" and isinstance(e.get("theme"), dict)}
    for c in new["categories"]:
        c.pop("yours", None)
    for tid, o in old_t.items():
        owner = o.get("owner")
        if host or not owner or owner in khs:
            continue
        n = new_t.get(tid)
        if n is None:
            return "That theme belongs to another device, so only that device can delete it."
        # open themes: anyone may edit the tracks and name, but not delete it or change who owns it
        protected = ("owner", "open") if o.get("open") else ("owner", "open", "name", "tagline", "hue", "icon", "videos")
        if any(o.get(k) != n.get(k) for k in protected):
            return "That theme belongs to another device, so only that device can change it."
    for tid, n in new_t.items():
        if tid in old_t:
            continue
        restored = trashed.get(tid)
        if restored is not None and n.get("owner") == restored.get("owner"):
            continue  # restored from Recently deleted: keeps its original owner
        n["owner"] = kh
        n["open"] = bool(n.get("open"))
    if not host:
        new_ids = {e.get("id") for e in new["trash"]}
        for e in old["trash"]:
            if e.get("id") not in new_ids and not was_restored(e, new):
                return "Items in Recently deleted can be restored, but not deleted."
    return None


# ---------------------------------------------------------------- HTTP handler
class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        # behind Railway's proxy the visitor's address is the first one in X-Forwarded-For
        fwd = self.headers.get("X-Forwarded-For") if PUBLIC else None
        return (fwd.split(",")[0].strip() if fwd else self.client_address[0])

    def over_limit(self, kind):
        now, ip = time.time(), self.client_ip()
        with _hits_lock:
            recent = [t for t in _hits.get((kind, ip), []) if now - t < 60]
            recent.append(now)
            _hits[(kind, ip)] = recent
            if len(_hits) > 5000:  # forget idle visitors
                for k in [k for k, v in _hits.items() if now - v[-1] > 60]:
                    del _hits[k]
        if len(recent) > LIMITS[kind]:
            self.send_json(429, {"error": "Too many requests — please wait a minute and try again."})
            return True
        return False

    def who(self):
        """(hashes of this browser's owner keys, may it act as the host?)
        At home, the host is the PC running this server. When hosted publicly there is no
        such PC, so the admin key (set as a Railway variable) grants the same powers."""
        header = self.headers.get("X-Device-Key") or ""
        admin = bool(ADMIN_KEY) and ADMIN_KEY in [k.strip().lower() for k in header.split(",")]
        return key_hashes(header), admin or self.client_address[0] in HOST_ADDRS

    def serve_file(self, path):
        """The site's own files, gzip-compressed when the browser accepts it (the library is several MB)."""
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.join(ROOT, *rel.split("/"))
        ext = os.path.splitext(full)[1]
        if ext not in GZIP_TYPES or "gzip" not in (self.headers.get("Accept-Encoding") or "") or not os.path.isfile(full):
            return super().do_GET()
        mtime = os.path.getmtime(full)
        cached = _gzip_cache.get(full)
        if not cached or cached[0] != mtime:
            with open(full, "rb") as f:
                cached = (mtime, gzip.compress(f.read(), 6))
            _gzip_cache[full] = cached
        self.send_response(200)
        self.send_header("Content-Type", GZIP_TYPES[ext])
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(cached[1])))
        self.end_headers()
        self.wfile.write(cached[1])

    def do_GET(self):
        path = urllib.parse.urlparse(self.path)
        if path.path == "/api/user-data":
            if self.over_limit("read"):
                return
            khs, host = self.who()
            with WRITE_LOCK:
                doc = load_doc()
            return self.send_json(200, view(doc, khs, host))
        if path.path == "/api/resolve":
            if self.over_limit("resolve"):
                return
            url = urllib.parse.parse_qs(path.query).get("url", [""])[0]
            try:
                return self.send_json(*resolve(url))
            except Exception as e:  # network trouble etc.
                return self.send_json(502, {"error": f"Couldn't reach YouTube ({e.__class__.__name__})."})
        if not PUBLIC_FILES.match(path.path):
            return self.send_error(404)
        return self.serve_file(path.path)

    def do_HEAD(self):
        if not PUBLIC_FILES.match(urllib.parse.urlparse(self.path).path):
            return self.send_error(404)
        return super().do_HEAD()

    def do_PUT(self):
        if urllib.parse.urlparse(self.path).path != "/api/user-data":
            return self.send_json(404, {"error": "not found"})
        if self.over_limit("save"):
            return
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_BYTES:
            return self.send_json(413, {"error": "That's too much to save at once."})
        try:
            body = json.loads(self.rfile.read(size).decode("utf8"))
            if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
                raise ValueError
        except ValueError:
            return self.send_json(400, {"error": "This page is out of date — please reload it."})
        khs, host = self.who()
        with WRITE_LOCK:
            old = load_doc()
            if body.get("rev") != old["rev"]:
                # someone else saved since this page last loaded: don't overwrite their change
                return self.send_json(409, {"error": "conflict", "rev": old["rev"], "data": view(old, khs, host)})
            new = body["data"]
            for key, empty in (("categories", []), ("trash", []), ("added", {}), ("order", {}), ("hidden", {})):
                if not isinstance(new.get(key), type(empty)):
                    new[key] = empty
            new["categories"] = [c for c in new["categories"] if isinstance(c, dict) and c.get("id")]
            purge_trash(old)
            purge_trash(new)
            err = check_write(old, new, khs, host)
            if err:
                return self.send_json(403, {"error": err, "rev": old["rev"], "data": view(load_doc(), khs, host)})
            new["version"] = 2
            new["rev"] = old["rev"] + 1
            new.pop("host", None)
            backup_current()
            write_doc(new)
        return self.send_json(200, {"ok": True, "rev": new["rev"], "data": view(new, khs, host)})


def lan_ip():
    # Opening a UDP socket sends nothing; it just asks the OS which interface
    # would be used to reach the internet, i.e. this PC's Wi-Fi/LAN address.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except OSError:
            return "your-pc-ip"


def list_backups():
    files = sorted(f for f in os.listdir(BACKUP_DIR) if f.endswith(".json")) if os.path.isdir(BACKUP_DIR) else []
    if not files:
        print("No backups yet — one is made before every change to the shared library.")
        return
    print(f"Backups in {os.path.relpath(BACKUP_DIR, ROOT)} (oldest first):")
    for f in files:
        with open(os.path.join(BACKUP_DIR, f), encoding="utf8") as fh:
            d = json.load(fh)
        themes = d.get("categories", [])
        print(f"  {f}   {len(themes)} themes, {sum(len(c.get('videos', [])) for c in themes)} tracks, "
              f"{len(d.get('trash', []))} in Recently deleted")
    print("\nRoll back with:  python serve.py --restore <file name>")


def restore_backup(name):
    src = os.path.join(BACKUP_DIR, os.path.basename(name))
    if not os.path.exists(src):
        raise SystemExit(f"No backup called {name}. See: python serve.py --backups")
    with open(src, encoding="utf8") as f:
        doc = json.load(f)
    backup_current()                             # so the rollback itself can be undone
    doc["rev"] = load_doc().get("rev", 0) + 1    # a newer revision, so open pages pick it up
    write_doc(doc)
    print(f"Restored {os.path.basename(src)}. Open pages update within about 20 seconds.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Serve The Bard's Grimoire on your Wi-Fi, or on a host like Railway.")
    ap.add_argument("port", nargs="?", type=int, default=int(os.environ.get("PORT", 8080)))  # Railway sets PORT
    ap.add_argument("--backups", action="store_true", help="list backups of the shared library")
    ap.add_argument("--restore", metavar="FILE", help="roll the shared library back to a backup")
    ap.add_argument("--strict", action="store_true",
                    help="give this PC no special powers: it can only change its own themes, like any other device")
    args = ap.parse_args()
    os.chdir(ROOT)
    if args.backups:
        list_backups()
    elif args.restore:
        restore_backup(args.restore)
    else:
        if PUBLIC:
            HOST_ADDRS.clear()  # hosted: nobody is "the host PC"; the admin key grants those powers
            has_volume = bool(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH") or os.environ.get("GRIMOIRE_DATA_DIR"))
            print(f"The Bard's Grimoire is running on port {args.port} (public mode).", flush=True)
            print(f"Shared library: {DATA_FILE}" +
                  ("" if has_volume else "  ! no volume attached: it will be wiped on every deploy"), flush=True)
            if not ADMIN_KEY:
                print("Admin key: not set, so nobody can edit or restore other people's themes.", flush=True)
            elif not re.fullmatch(r"[0-9a-f]{32}", ADMIN_KEY):
                print("! GRIMOIRE_ADMIN_KEY should be 32 characters of 0-9 and a-f, "
                      "so it can be typed into the site as an owner key.", flush=True)
            else:
                print("Admin key: set.", flush=True)
        else:
            ip = lan_ip()
            if args.strict:
                HOST_ADDRS.clear()
            else:
                HOST_ADDRS.add(ip)  # this PC's own browser counts as the host, however it connects
            print("The Bard's Grimoire is running:", flush=True)
            print(f"  this PC:        http://localhost:{args.port}", flush=True)
            print(f"  TV/phone/other: http://{ip}:{args.port}", flush=True)
            print(f"Themes and tracks people add are saved to {os.path.relpath(DATA_FILE, ROOT)}", flush=True)
            print(f"(backups in {os.path.relpath(BACKUP_DIR, ROOT)} — see: python serve.py --backups)", flush=True)
            print("Press Ctrl+C to stop.", flush=True)
        http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
