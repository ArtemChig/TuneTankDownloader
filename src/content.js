/*
 * TuneTank Downloader - content script
 *
 * How the site exposes audio
 * --------------------------
 * tunetank.com is a Next.js (App Router) site. Every track object it renders
 * server-side carries a "preview" field pointing at a plain, unauthenticated
 * CloudFront object:
 *
 *   https://<dist>.cloudfront.net/tracks/<trackId>/preview/<hash>.mp3
 *
 * Those objects are ordinary public GETs - no signature, no cookie, no token -
 * and they hold the full-length track (~128 kbps MP3), which is exactly what
 * the on-page player streams.
 *
 * The <hash> segment is not derivable from the track id, so the URL has to be
 * read out of the page rather than constructed. There are two places to get it,
 * cheapest first:
 *
 *   1. The inline RSC payload. Next.js streams page data into the document as
 *      `self.__next_f.push([1, "...json..."])` <script> tags, and the preview
 *      URLs sit in there verbatim. Free - it is already in the DOM.
 *   2. A same-origin fetch of /track/<id>-<slug>/. Needed for tracks that
 *      arrived through client-side navigation or lazy loading, and so were
 *      never part of this document's initial payload.
 *
 * Downloading itself goes through chrome.downloads in the service worker.
 * That matters: the CloudFront responses carry no Access-Control-Allow-Origin
 * header, so a plain fetch() from this content script would be blocked by CORS.
 * chrome.downloads runs in the browser's network stack instead and is not
 * subject to the page's origin rules.
 */

(() => {
  'use strict';

  const CDN_RE =
    /https:\/\/[a-z0-9]+\.cloudfront\.net\/tracks\/(\d+)\/preview\/[a-z0-9]+\.mp3/g;
  const TRACK_PATH_RE = /\/track\/(\d+)-/;

  // Tunetank draws its icons with Lucide, which stamps a stable `lucide-<name>`
  // class onto every <svg>. That is a far better anchor than the Tailwind
  // utility classes around it, which change from build to build.
  const THEIR_DOWNLOAD = 'button svg.lucide-download';

  /** trackId -> preview mp3 URL */
  const previews = new Map();
  /** trackId -> in-flight fallback lookup, so a burst of clicks fetches once */
  const inflight = new Map();

  // --- discovery -----------------------------------------------------------

  function harvest(text) {
    let found = 0;
    CDN_RE.lastIndex = 0;
    for (let m; (m = CDN_RE.exec(text)); ) {
      if (!previews.has(m[1])) {
        previews.set(m[1], m[0]);
        found++;
      }
    }
    return found;
  }

  function harvestDocument() {
    let found = 0;
    for (const script of document.scripts) found += harvest(script.textContent || '');
    return found;
  }

  async function resolvePreview(id, href) {
    if (previews.has(id)) return previews.get(id);

    if (!inflight.has(id)) {
      const lookup = (async () => {
        const res = await fetch(href, { credentials: 'omit' });
        if (!res.ok) throw new Error(`track page responded ${res.status}`);
        harvest(await res.text());
        const url = previews.get(id);
        if (!url) throw new Error(`no preview URL found for track ${id}`);
        return url;
      })();
      // Drop the entry once settled so a failed lookup can be retried.
      inflight.set(id, lookup.finally(() => inflight.delete(id)));
    }
    return inflight.get(id);
  }

  // --- naming --------------------------------------------------------------

  function metaFromRow(anchor) {
    const title = (anchor.textContent || '').trim();
    let artist = '';
    let node = anchor;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const link = node.querySelector?.('a[href*="/music/artist/"]');
      if (link) {
        artist = link.textContent.trim();
        break;
      }
    }
    return { title, artist };
  }

  // Characters Windows, macOS or chrome.downloads reject in a filename.
  const FORBIDDEN = '<>:"/\\|?*';

  function sanitize(part) {
    let out = '';
    for (const ch of part) {
      if (FORBIDDEN.includes(ch)) continue;
      if (ch.codePointAt(0) < 32) continue; // control characters
      out += ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function filenameFor(meta, id) {
    const stem =
      [sanitize(meta.artist || ''), sanitize(meta.title || '')].filter(Boolean).join(' - ') ||
      `tunetank-${id}`;
    return `${stem.slice(0, 120)}.mp3`;
  }

  // --- button --------------------------------------------------------------

  // Lucide-shaped glyphs, so ours sits in their icon row without looking foreign.
  function icon(paths, extraClass = '') {
    return (
      `<svg class="ttd-icon ${extraClass}" viewBox="0 0 24 24" width="16" height="16" ` +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      `stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
    );
  }

  const ICONS = {
    idle: icon(
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
        '<polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'
    ),
    busy: icon('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>', 'ttd-icon--spin'),
    done: icon('<polyline points="20 6 9 17 4 12"/>'),
    error: icon(
      '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/>' +
        '<line x1="12" x2="12.01" y1="16" y2="16"/>'
    ),
  };

  const LABELS = { idle: 'Download MP3', busy: 'Saving', done: 'Saved', error: 'Failed' };

  function setState(btn, state) {
    btn.dataset.state = state;
    // Only the wide track-page variant shows a text label; row buttons are
    // icon-only so they line up with Tunetank's own square controls.
    const labelled = btn.classList.contains('ttd-btn--lg');
    btn.innerHTML = ICONS[state] + (labelled ? `<span>${LABELS[state]}</span>` : '');
  }

  function createButton({ id, href, getMeta, large = false }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = large ? 'ttd-btn ttd-btn--lg' : 'ttd-btn';
    btn.dataset.ttdId = id;
    btn.title = 'Download MP3 (TuneTank Downloader)';
    btn.setAttribute('aria-label', 'Download MP3');
    setState(btn, 'idle');

    btn.addEventListener('click', async (event) => {
      // These sit inside clickable rows; don't trigger the row underneath.
      event.preventDefault();
      event.stopPropagation();
      if (btn.dataset.state === 'busy') return;

      setState(btn, 'busy');
      try {
        const url = await resolvePreview(id, href);
        const res = await chrome.runtime.sendMessage({
          type: 'ttd:download',
          url,
          filename: filenameFor(getMeta(), id),
        });
        if (!res?.ok) throw new Error(res?.error || 'download rejected');
        setState(btn, 'done');
      } catch (err) {
        console.warn('[TuneTank Downloader]', err);
        btn.title = `Download failed: ${err.message}`;
        setState(btn, 'error');
      }
      setTimeout(() => {
        btn.title = 'Download MP3 (TuneTank Downloader)';
        setState(btn, 'idle');
      }, 2500);
    });

    return btn;
  }

  // --- placement -----------------------------------------------------------

  function trackAnchors() {
    return document.querySelectorAll('a[href*="/track/"]');
  }

  function trackIdsIn(node) {
    const ids = new Set();
    for (const a of node.querySelectorAll('a[href*="/track/"]')) {
      const m = (a.getAttribute('href') || '').match(TRACK_PATH_RE);
      if (m) ids.add(m[1]);
    }
    return ids.size;
  }

  /**
   * Walk up from a track's title link looking for that row's own download
   * control, so our button can sit beside it in the action cluster on the
   * right. Bail out once the ancestor covers more than one track - that means
   * we have climbed out of the row and into the list.
   */
  function theirDownloadFor(anchor) {
    let node = anchor.parentElement;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      if (trackIdsIn(node) > 1) return null;
      const svg = node.querySelector(THEIR_DOWNLOAD);
      if (svg) {
        const button = svg.closest('button');
        // Their icon buttons are wrapped in a positioned span for tooltips;
        // insert after the wrapper so we land in the same flex row, not inside it.
        const wrapper = button?.parentElement;
        return wrapper?.classList.contains('relative') ? wrapper : button;
      }
    }
    return null;
  }

  /** The one anchor per row we hang a button off: the one showing the title. */
  function titleAnchorId(anchor) {
    // Artwork and overlay links point at the same track; only decorate the
    // one carrying the title text, so each row gets exactly one button.
    if (!anchor.textContent.trim()) return null;
    return (anchor.getAttribute('href') || '').match(TRACK_PATH_RE)?.[1] || null;
  }

  function isOurButton(node) {
    return !!node && node.classList?.contains('ttd-btn');
  }

  /** A button of ours is only valid directly after the slot it was placed on. */
  function isValidSlot(node) {
    if (!node) return false;
    if (node.matches?.('a[href*="/track/"]')) return true; // fallback placement
    return !!node.querySelector?.('svg.lucide-download'); // their control, or its wrapper
  }

  /**
   * Remove buttons that are no longer sitting on a slot. This is what keeps the
   * player bar honest: it is one container that swaps which track it represents,
   * so anything React leaves stranded there - or any second copy, whose previous
   * sibling is our own button rather than a download control - gets collected
   * here rather than piling up along the bar.
   */
  function pruneButtons() {
    for (const btn of document.querySelectorAll('.ttd-btn:not(.ttd-btn--lg)')) {
      if (!isValidSlot(btn.previousElementSibling)) btn.remove();
    }
  }

  function injectRowButtons() {
    for (const anchor of trackAnchors()) {
      const id = titleAnchorId(anchor);
      if (!id) continue;

      // Preferred home: right after the row's own download icon. If a layout
      // has no such control, fall back to sitting beside the title.
      const slot = theirDownloadFor(anchor) || anchor;

      // Dedup is positional, not identity-based: we always insert directly
      // after the slot, so "is our button already the next sibling?" is the
      // exact question. Keying off the anchor instead would fail whenever
      // React swaps the anchor but keeps the surrounding action cluster - the
      // new anchor looks unvisited while the old button is still on screen,
      // and the row ends up with two.
      const neighbour = slot.nextElementSibling;
      if (isOurButton(neighbour)) {
        if (neighbour.dataset.ttdId === id) continue;
        // Same slot, different track: the player bar moved on to the next song.
        // The button is stale, not a duplicate - replace it.
        neighbour.remove();
      }

      slot.insertAdjacentElement(
        'afterend',
        createButton({ id, href: anchor.href, getMeta: () => metaFromRow(anchor) })
      );
    }
  }

  /**
   * Track detail pages have no self-link, so they are handled separately: the
   * button goes directly under the big yellow Download button, as a secondary
   * action in the same panel.
   */
  function injectTrackPageButton() {
    const id = location.pathname.match(TRACK_PATH_RE)?.[1];
    const existing = document.querySelector('.ttd-btn--lg');

    if (!id) {
      existing?.remove(); // client-side nav away from a track page
      return;
    }
    if (existing) {
      if (existing.dataset.ttdId === id) return;
      existing.remove(); // navigated to a different track
    }

    const h1 = document.querySelector('h1');
    if (!h1) return;
    const panel = h1.parentElement;
    const theirs = panel?.querySelector(THEIR_DOWNLOAD)?.closest('button');

    const btn = createButton({
      id,
      href: location.href,
      large: true,
      getMeta: () => ({
        title: h1.textContent.trim() || document.title,
        artist: document.querySelector('a[href*="/music/artist/"]')?.textContent.trim() || '',
      }),
    });

    if (theirs) theirs.insertAdjacentElement('afterend', btn);
    else h1.insertAdjacentElement('afterend', btn);
  }

  function refresh() {
    harvestDocument();
    pruneButtons(); // clear strays first, so injection sees a clean slot
    injectRowButtons();
    injectTrackPageButton();
  }

  // --- popup API -----------------------------------------------------------

  function listTracks() {
    const seen = new Set();
    const out = [];
    for (const anchor of trackAnchors()) {
      const id = titleAnchorId(anchor);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, href: anchor.href, ...metaFromRow(anchor) });
    }
    return out;
  }

  async function downloadAll() {
    const tracks = listTracks();
    let ok = 0;
    const failed = [];
    for (const track of tracks) {
      try {
        const url = await resolvePreview(track.id, track.href);
        const res = await chrome.runtime.sendMessage({
          type: 'ttd:download',
          url,
          filename: filenameFor(track, track.id),
        });
        if (!res?.ok) throw new Error(res?.error || 'download rejected');
        ok++;
      } catch (err) {
        failed.push(`${track.title || track.id}: ${err.message}`);
      }
      // Space the requests out rather than firing the whole page at once.
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok, total: tracks.length, failed };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ttd:list') {
      refresh();
      sendResponse({ tracks: listTracks() });
      return false;
    }
    if (msg?.type === 'ttd:downloadAll') {
      downloadAll().then(sendResponse);
      return true; // keep the channel open for the async reply
    }
    return false;
  });

  // --- boot ----------------------------------------------------------------

  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  refresh();
})();
