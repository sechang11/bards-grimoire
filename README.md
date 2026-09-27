# The Bard's Grimoire

Music and ambience for tabletop RPGs, sorted by scene. It has about 420 themes in 18 groups, from Combat, Taverns and Dungeons to Goblin Warrens, Barovia, Call of Cthulhu, Taiko drums and Skyrim, plus thousands of YouTube videos, all confirmed to be embeddable, and 500+ hashtags. A **Most Popular** chart at the top ranks the 30 most‑viewed TTRPG tracks on YouTube.

It's a plain static site with no build step: `index.html`, `css/`, `js/`.

## Run it

YouTube videos only play when the page is served over http(s). They don't play from `file://`.

```bash
python serve.py
```

It prints two addresses: one for this PC (`http://localhost:8080`) and one for your TV or phone on the same Wi‑Fi. Use `serve.py` rather than `python -m http.server`: it tells browsers to always load the newest version of the site, so a TV never keeps running an old copy after an update.

## Play modes

Use the switch in the header to choose where tracks play. The site remembers your choice.

- **Play here** (default): tracks play in the site's own player at the bottom of the screen, so you can preview and switch music without leaving the site.
- **YouTube**: tracks open on YouTube in a new tab. Each pick opens another tab, and YouTube doesn't let the site close or reuse the old one, so close the previous tab yourself or it keeps playing. **Play all** and **Shuffle** open the whole theme as a temporary YouTube playlist (up to 50 videos).

## Your own themes and tracks

Anyone using the site can add music:

- **Add YouTube links:** paste video or playlist links, one per line. Use **Add tracks** on a theme page, or the **Add YouTube links** card under **My Themes** on the home page. A playlist link imports every video in it, up to 200. Videos whose owners block playing on other sites are skipped, and the site tells you how many.
- **New theme:** your own scene or playlist (for example "Curse of Strahd – Session 12"), with a name, short description, icon and colour. Rename it, restyle it or delete it from **Edit list**.
- Added tracks get hashtags automatically, plus `#added`, so they show up in search.

**Where it's saved:** when the site runs from `python serve.py`, everything goes into `data/user-library.json` on your PC. Every device on your Wi‑Fi (PC, phone, TV) sees the same themes, and open pages pick up changes within about 20 seconds. On static hosting such as GitHub Pages, additions are saved in each browser instead. Single videos still work there, but playlist links need `serve.py`. `data/` is in `.gitignore`, so your additions stay private.

## Safety: no logins, but nothing gets lost

There are no accounts and no database. The shared file is protected like this:

- **Undo:** every removal shows *Removed · Undo* for a few seconds. Deleting a theme or restoring a list first asks "Are you sure?", with **Cancel** selected, so a stray press of OK on a remote does nothing.
- **Recently deleted:** removed tracks and deleted themes wait there for **30 days**, and anyone can restore them. Items can be restored but never deleted early, and the server enforces this too.
- **Your themes are yours:** a theme belongs to the device that made it. The device keeps a random key in its browser, and the file only stores a scrambled version (a hash) of that key. Everyone can play and queue it, but only that device can add, remove, reorder, rename or delete. Tick **Open to everyone** to let the group edit the tracks; renaming and deleting stay with the owner. Other devices see it marked 🔒.
- **The host PC can edit everything:** the PC running `serve.py` can change or delete any theme, and can restore themes whose owner cleared their browser or lost their phone. To take that power away (for example on a shared family PC), run `python serve.py --strict`.
- **No accidental overwrites:** every save carries the file's revision number. If another device saved in the meantime, the change is refused, the page reloads the latest version, and it asks you to try again.
- **Backups:** before every change, the old file is copied to `data/backups/`. The last 50 changes are kept, plus one copy per day for 30 days.

```bash
python serve.py --backups
python serve.py --restore 20260927-093552-r2.json
```

The first command lists the backups; the second rolls back to one (the current version is backed up first, and open pages update by themselves).

Built‑in themes are shared by everyone. Anyone can reorder them or hide tracks, and hidden tracks go to Recently deleted, while **Restore original list** resets them. None of this is meant to stop a determined person on your own Wi‑Fi. It stops accidents, kids, guests, and anyone quietly erasing someone else's playlist.

## Share & move: take your music anywhere

Your themes live on the computer running `serve.py`, or in your browser on static hosting, so they aren't automatically at a friend's house or on a new phone. Three ways to bring them along, all on the **Share & move** page (under My Themes, and in the footer):

**1. Share link: one theme, to a friend's house or to a friend**
1. Open a theme (or Favorites) and press **Share**.
2. Press **Copy link**, or scan the QR code with your phone, and send it to yourself or a friend.
3. At the friend's, open *their* copy of the site → **Share & move** → paste the link into **Import at a friend's house** → **Import** → **Add to My Themes**.

If you both use the same website address (for example the same GitHub Pages link), simply opening the link works too. The link only holds the theme's name, look and YouTube video IDs, about 1.5 KB for 100 tracks, and titles are looked up again on import. Pasting a whole message that contains the link is fine.

**2. Backup file: everything, to a new phone, a new browser, or just to keep a copy**
1. **Share & move** → **Download backup file**. It holds your themes, favorites, tracks you added to built‑in themes, and settings such as play mode, timer, volume, shuffle and repeat.
2. Move the file to the new device (email, USB stick, cloud storage…).
3. On the new device: **Share & move** → **Import a backup file**. Nothing is ever deleted: new things are added, themes you already have get only their missing tracks, and importing the same file twice adds nothing.

**3. Owner key: keep editing your themes from a new browser.** Tick **Include my owner key** when downloading the backup, or copy the key from **Share & move → Owner key → Show my key** and type it into **Add a key from your other browser**. The new browser can then edit and delete the themes you made; it keeps its own key as well. Anyone who has your key can change your themes, so keep a backup file that includes the key private.

**On a TV,** do importing on a phone or laptop instead: typing with a remote is slow. With `serve.py`, whatever you import shows up on the TV by itself.

## Reordering (drag and drop)

- **Themes, your themes and Favorites:** grab the ⠿ handle on a card and drop it anywhere in the list. The new order is saved.
- **Edit list** also shows ✕ buttons for removing tracks. Every removal can be undone, and the track waits in **Recently deleted** for 30 days. On built‑in themes, **Restore original list** brings back the original tracks and order, and keeps anything you added.
- On phones and tablets, tap **Edit list** first to show the handles.
- The Most Popular chart can't be reordered, because it's a ranking.

Drag and drop uses [SortableJS](https://github.com/SortableJS/Sortable), loaded from jsDelivr. Everything else works without it.

## Queue

- Add a track with its ➕ button (or `Q` on a focused track), or a whole theme, favorites list or search result with **Queue all**. Queue a playlist by importing it into a theme first, then pressing **Queue all**.
- Queued tracks play **before** the list you're playing continues, in the order you set. The ⏱ timer also plays queued tracks first.
- The queue button in the player bar opens **Up Next**. Drag to reorder, ✕ to remove, click a track to play it now, **Clear**, or **Save as theme** to keep the queue as a playlist.
- The queue is per device, so the TV's queue is separate from your phone's. The queue is for the built‑in player; in YouTube mode, tracks open on YouTube instead.

## Fades

- **Songs you pick start instantly, at full volume.** That covers clicking a track, Next or Previous, a queued track, Play all and rolls. You hear right away whether it's the one you want, a bit like a preview.
- **When the music moves on by itself, it fades.** When a track ends, the ⏱ timer switches, or repeat restarts a song, the old one fades out over 3 seconds and the next fades in over 3.5 seconds, starting only once it's actually playing.
- To change the lengths, edit `FADE_OUT_MS` and `FADE_IN_MS` in `js/app.js`.

## Magic & atmosphere

- **Scene effects (✨ in the header):** a light animated layer that matches what's playing, or the theme page you're on while the music is paused. Examples: candlelight for crypts, vampires and Barovia (the page goes dark around a flickering pool of light that follows your cursor, or the highlighted item on a TV); rain, thunderstorms, neon rain for cyberpunk, snow, falling ash, bubbles underwater, blowing sand, cherry blossoms, autumn leaves, fireflies, magic sparkles, stars with shooting stars, confetti, fog, embers and dust motes. The ✨ button turns them off. They use fewer particles in TV mode and are off by default for people whose device asks for reduced motion. The rules that pick an effect are `FX_RULES` in `js/app.js`; the effects themselves are in `js/effects.js`.
- **Hover sounds (🔊 in the header):** soft magical sounds made on the fly in the browser (no sound files). A sparkle for themes, a lute pluck for tracks, a small bell for buttons. They also play as a TV remote moves between items. Toggle them per browser.
- **Critical hits and fumbles:** every Roll button rolls a d20. A natural 20 bursts golden stars and dice with a fanfare; a natural 1 makes the page shudder and the button fumble, with a sad trombone.
- **Page turns:** moving between pages turns the old one away like a page in a spellbook. Skipped on TVs and for reduced motion.

## Rename the site

Hover over the name in the top‑left corner and press **✎**, or use **Rename this site** in the footer (on phones), to give the site your own name, for example your campaign. It changes the header and the browser tab **in this browser only**; everyone else keeps their own name. **Use the original name** puts it back. The name also travels in backup files.

## Most Popular chart

The **Charts → Most Popular** theme ranks the 30 most‑viewed TTRPG tracks. They come from YouTube searches sorted by view count, plus everything already in the library. Only titles that are clearly TTRPG count (D&D, TTRPG, RPG, tabletop and so on), so huge generic "relaxing music" videos don't take over. Chart tracks show their rank and are also tagged `#popular`. The chart is rebuilt on every library build. To refresh only the chart:

```bash
python tools/build_library.py --popular
```

## Auto-change timer

The **⏱ button** in the player bar switches to a new random track from the current list (a theme, search results or favorites) every few minutes. Each press cycles the interval: **Off → 5 → 10 → 15 → 20 → 30 → 45 → 60 min**.

- The button shows a countdown. It only counts down while music is playing, so pausing pauses the timer.
- It won't repeat a track until every track on the list has played.
- Picking a track yourself restarts the countdown. Your chosen interval is remembered.

## Search & hashtags

Every track has hashtags, such as `#ruins #desert #night`. Each theme's tracks also get that theme's tag, so `#tavern` finds every tavern track. Use the big search box at the top of the home page:

- **Words or tags:** `ruins`, `#ruins` and even `abandoned` all find the ruins tracks, because each tag has a list of related words.
- **Combine words** to narrow the results. `rain tavern` finds only tracks that match both.
- **Tag chips** under the box search with one tap, which is the easiest way on a TV remote. Results also suggest **related** tags to explore.
- On other pages, the small search box in the header does the same thing.

To add a tag or more words for one, edit `TAGS` in `tools/build_library.py`, then re-tag the existing library without searching YouTube again:

```bash
python tools/build_library.py --retag
```

## Controls

| Action | Keyboard / TV remote |
| --- | --- |
| Move | Arrow keys / D‑pad |
| Open / play | Enter / OK |
| Back, close theater | Esc / Back |
| Play / pause | Media ⏯, `K`, Space |
| Next / previous | Media ⏭ ⏮, `N` / `P`, Channel ▲▼ |
| Theater view | `F` |
| Volume | `+` / `-` |
| Search | `/` |
| Queue the focused track · open the queue | `Q` (or the green button on many remotes) |

**TV mode** makes text bigger, adds overscan‑safe margins and turns off heavy effects. It switches on by itself for most smart‑TV browsers. You can also force it with `?tv=1` or use the header button.

## Host it online (Railway + Cloudflare)

The repo is ready for [Railway](https://railway.com). It builds from the `Dockerfile` (Python standard library only) using `railway.json`. When it runs on Railway, `serve.py` switches to **public mode**:

- It listens on Railway's `PORT`.
- It only serves the site's own files: never the data, the tools or itself.
- Pages and the library are gzip-compressed.
- Saves and link look‑ups are rate‑limited per visitor.
- There is no "host PC". Instead, an **admin key** gives its holder host powers: editing or restoring anyone's themes.

**1. Deploy**
1. Railway → **New Project → Deploy from GitHub repo** → pick this repo. It builds and starts automatically.
2. **Add a volume** so the shared library survives redeploys: right‑click the project canvas (or ⌘K / Ctrl+K) → **Volume** → attach it to the service with mount path **`/data`**. `serve.py` finds it through `RAILWAY_VOLUME_MOUNT_PATH`. Without a volume, everything people add is wiped on every deploy.
3. **Set the admin key:** service → **Variables** → `GRIMOIRE_ADMIN_KEY` = 32 characters of 0‑9/a‑f. Make one with `python -c "import secrets; print(secrets.token_hex(16))"`. To use it, open the site → **Share & move → Owner key → Add a key from your other browser**, paste it, and that browser becomes an admin.
4. Service → **Settings → Networking → Generate Domain** to test it on a `*.up.railway.app` address first.

**2. Custom domain (buddys‑grimoire.com on Cloudflare)**
1. Railway: service → **Settings → Networking → + Custom Domain** → `buddys-grimoire.com`, and again for `www.buddys-grimoire.com` if you want both. Railway shows **two records per domain: a CNAME and a TXT. Both are required**; without the TXT, the domain returns 404.
2. Cloudflare → your domain → **DNS → Records**:
   - **CNAME**, name `@`, target the `….up.railway.app` value Railway showed, **Proxied (orange cloud)**. Cloudflare flattens a CNAME on the root domain automatically.
   - **TXT**, with the name and value exactly as Railway shows them.
   - The same pair for `www` if you added it.
3. Cloudflare → **SSL/TLS → Overview** → set encryption mode to **Full**. *Not* "Full (strict)": Railway's docs say strict won't work. Also check that **SSL/TLS → Edge Certificates → Universal SSL** is on.
4. Wait for Railway's green check next to the domain. It usually takes minutes, and at most a few hours.

**Things to know about hosting it publicly**
- Anyone who has the address can add themes and tracks to the shared library. Ownership (🔒), the 30‑day **Recently deleted**, rate limits and backups (on the volume, in `/data/backups`) keep it safe from accidents and casual mischief. It's still a public site with no logins, so keep the admin key private.
- To roll back from a backup, open a shell on the service (Railway → service → ⋮ → **Shell**, or the Railway CLI's `railway ssh`) and run `python serve.py --backups`, then `python serve.py --restore <file>`.
- Updating the site: push to GitHub and Railway redeploys automatically. Grow the library locally with `tools/build_library.py`, commit `js/library.js`, and push.

## Show it on a TCL TV

First check which kind of TCL you have (**Settings → System → About**):

### TCL Google TV / Android TV (most TCL models since 2021)
1. Put the site online so the TV can reach it. Either:
   - **GitHub Pages (recommended, always on):** push this folder to a GitHub repo, then go to **Settings → Pages → Deploy from branch → main / root**. You get a URL like `https://<you>.github.io/<repo>/`.
   - **Your PC on home Wi‑Fi:** run `python serve.py` and open the TV/phone address it prints (for example `http://10.0.0.251:8080`). The PC has to stay on, and you may need to allow Python through Windows Firewall.
2. On the TV, install a browser from the Play Store. **TV Bro** is built for D‑pad remotes. Puffin TV also works. Chrome isn't offered for TVs.
3. Open the URL and bookmark it. If the browser shows a mouse pointer you move with the D‑pad, switch it to key/D‑pad navigation so the site gets the arrow keys.

### TCL Roku TV
Roku has no web browser. Your options:
- **Screen mirroring:** on your Windows PC press `Win + K` and pick the TV. You control the site from the PC.
- Plug in a laptop over **HDMI** and use a wireless keyboard or air‑mouse remote. The site works fully from a keyboard.

### Quickest option with no setup (any Google TV)
Open the site in Chrome on your computer, then **⋮ → Cast… → Sources → Cast tab**. You control it from the computer, not the TV remote.

## Refresh or grow the library

```bash
pip install requests
python tools/build_library.py --add            # keep everything, fill new themes, top each theme up to 22
python tools/build_library.py --add --per 40   # grow every theme to 40
python tools/build_library.py --popular        # just refresh the charts (Most Popular, Marathon Mixes)
python tools/build_library.py --retag          # just refresh hashtags / apply the blocklist
```

- **Where themes and hashtags come from:** the original themes are defined in `tools/build_library.py`. The big catalogue (creatures, places, scenes, moods, weather, cultures, classes, settings, game systems, instruments and game soundtracks) is in **`tools/catalog.py`**. To add a theme, add one line there, `(id, name, tagline, icon, search phrase[, extra hashtag words])`, then run `--add`. Each theme automatically becomes a hashtag, and `EXTRA_TAGS` holds hashtags that aren't themes.
- **How tracks are picked:** each theme runs a few YouTube searches, two pages each (`--pages`). Titles that mention the theme ("goblin", "mind flayer"…) go first; others only count if YouTube ranked them near the top. Every video is checked to be embeddable, and with `--add` it needs at least 2,000 views. Each video lands in only one theme.
- **Big runs are resumable:** searches and embed checks are cached in `tools/.cache/`, and the library is saved every 25 themes. If a run stops (or YouTube slows it down), run the same command again and it continues. Use `--workers 1` if YouTube starts refusing searches.
- **Remove a video for good:** put its ID in `tools/blocklist.txt`, then run `--retag`.

## Credits

All music belongs to its creators on YouTube. Subscribe to the channels you use. Theme icons are from [game-icons.net](https://game-icons.net) (CC BY 3.0).

<details>
<summary>Secrets (spoilers)</summary>

There's a hidden **Bag of Tricks**: fantasy cursors (a d20, a sword, a magic wand, a quill, a torch), each with its own trail, plus a way to force any scene effect. Find it by rolling a natural 20, clicking the d20 logo five times quickly, typing `nat20`, or pressing ▲ ▲ ▼ ▼ ◀ ▶ ◀ ▶ then OK on a TV remote. After that, it's linked in the footer.
</details>
