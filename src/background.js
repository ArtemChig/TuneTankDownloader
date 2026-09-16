/*
 * TuneTank Downloader - service worker
 *
 * The content script cannot do the saving itself, for two reasons:
 *   - chrome.downloads is not exposed to content scripts.
 *   - The CloudFront MP3s reply without an Access-Control-Allow-Origin header,
 *     so fetching them from a page context is blocked by CORS. chrome.downloads
 *     goes through the browser's own network stack and sidesteps that entirely.
 */

const DEFAULTS = { subfolder: true };

// Only ever hand chrome.downloads a URL that looks like a Tunetank preview.
// The content script builds these, but a message listener is reachable from any
// extension page, so the worker re-checks rather than trusting its input.
const ALLOWED_URL =
  /^https:\/\/[a-z0-9]+\.cloudfront\.net\/tracks\/\d+\/preview\/[a-z0-9]+\.mp3$/;

async function targetPath(name) {
  const { subfolder } = await chrome.storage.sync.get(DEFAULTS);
  return subfolder ? `TuneTank/${name}` : name;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'ttd:download') return false;

  (async () => {
    try {
      const from = sender.origin || sender.url || '';
      if (!from.startsWith('https://tunetank.com')) {
        throw new Error('unexpected sender');
      }
      if (!ALLOWED_URL.test(msg.url || '')) {
        throw new Error('URL is not a Tunetank preview');
      }

      const id = await chrome.downloads.download({
        url: msg.url,
        filename: await targetPath(msg.filename || 'tunetank.mp3'),
        conflictAction: 'uniquify',
        saveAs: false,
      });
      sendResponse({ ok: true, id });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // reply happens asynchronously
});
