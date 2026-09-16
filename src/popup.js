/*
 * Popup: reports what the content script found on the current tab and offers a
 * bulk download. All the real work stays in the content script - the popup just
 * asks it questions over chrome.runtime messaging.
 */

const statusEl = document.getElementById('status');
const allBtn = document.getElementById('all');
const resultEl = document.getElementById('result');
const subfolderEl = document.getElementById('subfolder');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ask(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script in this tab (wrong site, or the tab predates an
    // extension reload and needs a refresh).
    return null;
  }
}

async function init() {
  const { subfolder = true } = await chrome.storage.sync.get({ subfolder: true });
  subfolderEl.checked = subfolder;
  subfolderEl.addEventListener('change', () =>
    chrome.storage.sync.set({ subfolder: subfolderEl.checked })
  );

  const tab = await activeTab();
  if (!tab?.url?.startsWith('https://tunetank.com')) {
    statusEl.textContent = 'Open a page on tunetank.com to use this.';
    return;
  }

  const res = await ask(tab.id, { type: 'ttd:list' });
  if (!res) {
    statusEl.textContent = 'Reload the Tunetank tab, then try again.';
    return;
  }

  const count = res.tracks.length;
  statusEl.textContent = count
    ? `${count} track${count === 1 ? '' : 's'} on this page.`
    : 'No tracks found on this page.';
  allBtn.disabled = count === 0;

  allBtn.addEventListener('click', async () => {
    allBtn.disabled = true;
    allBtn.textContent = 'Downloading...';
    const out = await ask(tab.id, { type: 'ttd:downloadAll' });
    allBtn.textContent = 'Download all on this page';
    allBtn.disabled = false;

    if (!out) {
      resultEl.textContent = 'The page stopped responding - reload and retry.';
      return;
    }
    resultEl.textContent =
      `Saved ${out.ok} of ${out.total}.` +
      (out.failed.length ? `\nFailed:\n- ${out.failed.join('\n- ')}` : '');
  });
}

init();
