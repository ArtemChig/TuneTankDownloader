# TuneTank Downloader

A small Manifest V3 Chrome extension that adds a one-click download button to
every track on [tunetank.com](https://tunetank.com). Built as a learning
project, so the interesting part is the write-up below as much as the code.

## What the site actually does

Tunetank is a Next.js (App Router) site. When it renders a page server-side, the
track objects it embeds look like this:

```json
{
  "image": "https://d2mpxqr2vyojy5.cloudfront.net/artworks/1701935884240.jpg",
  "new": false,
  "preview": "https://d1s1y0ui543e5o.cloudfront.net/tracks/3688/preview/2674.mp3",
  "waveform": "https://d1s1y0ui543e5o.cloudfront.net/tracks/3688/waveform/2674.json"
}
```

Three things follow from that, and they're what the whole extension is built on:

1. **The audio is a plain public object.** `GET`ting that CloudFront URL returns
   `200 audio/mpeg` with no signature, no cookie, and no token. There is no
   "unlock" step to reverse-engineer — the player just streams the file, and so
   can anything else.
2. **The preview *is* the track.** For track 3688 the file is 1,403,924 bytes and
   87.7 s long, matching the 1:27 shown in the UI, at roughly 128 kbps. It isn't
   a 30-second clip or a watermarked teaser; it's the whole song at streaming
   quality. The paid product is the licence plus the higher-quality
   MP3/WAV/stems, not access to the audio.
3. **The URL has to be scraped, not constructed.** The `2674` in the path is an
   opaque per-track hash — you can't derive it from the track id `3688`. So the
   extension has to read the URL out of the page.

### Where the URL is readable

Next.js streams page data into the document as `self.__next_f.push([1, "..."])`
script tags, and the preview URLs sit in there verbatim. Scanning
`document.scripts` with one regex yields every track on the page for free — 14
unique tracks on the homepage, with zero extra network requests.

That covers the server-rendered pages (homepage, `/track/...`, artist pages,
discover pages, playlists). Tracks that arrive later — client-side navigation,
lazy loading — were never in *this* document's payload, so there's a fallback:
fetch `/track/<id>-<slug>/` same-origin and run the same regex over the HTML.
Results are cached in a `Map`, and concurrent lookups for the same id share one
in-flight promise.

### The CORS wrinkle

The CloudFront responses carry **no** `Access-Control-Allow-Origin` header. A
`fetch()` from the content script would be blocked, so you can't grab the bytes
and make a blob URL from the page. The fix is to hand the URL to
`chrome.downloads.download` in the service worker instead — that runs in the
browser's network stack and isn't subject to the page's origin rules. This is
the single design decision that shapes the rest of the extension.

## How the extension is put together

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `downloads`, `storage`; host: `tunetank.com`. |
| `src/content.js` | Scrapes preview URLs, injects buttons, answers the popup. |
| `src/content.css` | Self-contained button styling. |
| `src/background.js` | Service worker; the only place `chrome.downloads` is called. |
| `src/popup.html/js` | Track count, "download all on this page", folder toggle. |

A few choices worth pointing at:

- **No dependence on their CSS classes.** Tunetank is Tailwind, and utility
  classes churn between builds. Everything anchors on `a[href*="/track/"]` and
  the numeric id in the href, which is stable. The button brings its own styles
  (`all: unset` plus explicit rules) so it can't inherit surprises.
- **Placement keys off the icon library, not the layout.** Tunetank draws icons
  with Lucide, which stamps a stable `lucide-<name>` class on every `<svg>`. So
  the button finds its home by looking for `svg.lucide-download` — the row's own
  download icon — and inserting itself right after it. One rule covers both
  cases: in a list row it lands in the action cluster on the right, and on a
  track page it lands under the big yellow Download button. If a layout has no
  download control, it falls back to sitting beside the title.
- **One button per row, not per link.** Each row has several links to the same
  track (artwork, overlay, title). Only the one carrying text gets a button.
- **A `MutationObserver`** (debounced 150 ms) re-runs the scan, so infinite
  scroll and SPA navigation are handled without polling.
- **Dedup is positional, not identity-based.** This one took two attempts. The
  button sits *inside* Tunetank's React-rendered action cluster, so re-renders
  churn the DOM around it. Marking the anchor "done" fails, and so does a
  `WeakMap` from anchor to button: when the waveforms load, React replaces the
  **anchor** but keeps the **cluster**, so the new anchor looks unvisited while
  the old button is still on screen — and hovering a row gave it two buttons.
  Since the button always goes directly after the slot, the exact question is
  "is our button already this slot's next sibling?", which is true regardless of
  how many times the anchor has been swapped.
- **The player bar is a row that changes track.** The fixed bottom bar has a
  track link and a download icon, so it picks up a button like any row — which
  is genuinely useful, since it downloads whatever is playing. But it is *one
  container that represents a different track over time*, and that broke the
  first dedup: keyed on (container, track id), the previous song's button looked
  like a legitimate different track rather than a stale one, so it stayed and a
  new one appeared beside it. Auto-advancing through a playlist left a row of
  them along the bar. Two rules fix it: a neighbouring button with the *wrong*
  id is stale and gets replaced, and `pruneButtons()` collects any button no
  longer sitting directly on a slot.
- **The worker re-validates its input.** A message listener is reachable from
  any extension page, so `background.js` checks the sender origin *and* pattern-
  matches the URL before passing it to `chrome.downloads`, rather than trusting
  whatever it's handed.
- **Filenames** come out as `Artist - Title.mp3`, with characters Windows and
  macOS reject stripped, saved into a `TuneTank/` subfolder by default.

## Install

Works in Chrome, Edge, Brave, or any other Chromium browser.

1. **Download** `TuneTankDownloader.zip` from the
   [latest release](https://github.com/ArtemChig/TuneTankDownloader/releases/latest),
   and unzip it somewhere you'll keep it — Chrome loads the extension from that
   folder every launch, so deleting it uninstalls the extension.
   Cloning the repo works just as well.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** — the toggle in the top right. **Load unpacked**
   only appears once it's on.
4. Click **Load unpacked** and select the unzipped folder (the one holding
   `manifest.json`, not the file itself).
5. Open [tunetank.com](https://tunetank.com). Every track row gets a yellow
   download icon at the right end of its action cluster, just after Tunetank's
   own; track pages get a "Download MP3" button under the big yellow Download;
   the player bar gets one for whatever is currently playing.

Files land in `Downloads/TuneTank/` as `Artist - Title.mp3`. The toolbar icon
opens a popup with a count of the tracks on the page, a "download all on this
page" button, and a toggle for that subfolder.

### If nothing appears

- **No buttons** — reload the Tunetank tab. Content scripts don't inject into
  tabs that were already open when the extension loaded.
- **A button errors** — hover it for the reason; full detail is in the page
  console (F12).
- **Nothing saves** — click **service worker** on the extension card to open the
  background console, which is where download errors surface.

When developing: after editing any file, hit reload on the extension card, then
reload the Tunetank tab.

## Worth knowing before you use it

The files are served publicly, but "reachable" and "licensed" are different
things. Tunetank sells a licence for these tracks, and free downloads normally
come with an attribution requirement. Downloading the preview gets you the
audio, not the licence — so this is fine as a thing you built and learned from,
and not a substitute for their download flow if you're publishing anything.

Also: it reads the URL the page already handed the browser, and issues at most
one extra request per track. Keep it that way. Pointing it at the whole catalog
in a loop turns a learning project into a scraper.

## Things to try next

- **Tag the files.** The download is a bare MP3; the page knows title, artist,
  BPM and artwork. Writing ID3v2 frames yourself is a genuinely good exercise in
  binary formats.
- **Handle `/music/`.** The catalog page loads its list from `api.tunetank.com`
  rather than server-rendering it, so the payload scan finds nothing there and
  every track falls through to the per-track fetch. Watching that API response
  instead would be faster.
- **A progress UI** for bulk downloads, using `chrome.downloads.onChanged`.
- **Port it to Firefox.** Mostly a matter of the `browser.*` namespace and a
  `background.scripts` shim.
