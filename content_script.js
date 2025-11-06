// content_script.js
(function () {
  'use strict';

  // ---- CONFIG ----
  const INITIAL_WAIT_MS = 7000;      // how long before first reload attempt (keeps your 7s requirement)
  const POLL_INTERVAL_MS = 500;      // poll interval while waiting for button
  const OBSERVER_TIMEOUT_MS = 30000; // how long MutationObserver runs before timing out
  const MAX_RELOADS = 3;             // safety: do not reload more than this per session
  const BACKOFF_FACTOR = 1.8;        // multiplier for additional wait after each unsuccessful reload attempt

  // helpful text / busy indicators (taken from the page JSON strings)
  const BUSY_TEXTS = [
    'Encrypting', 'Encrypting...', 'Uploading', 'Uploading...',
    'Uploaded', 'You can close this page now', 'downloadError', 'downloadError'
  ];

  // regexes / heuristics for detecting a download control
  const DOWNLOAD_TEXT_RE = /\b(download|download file|download all files|download files|get file)\b/i;
  const HREF_FILE_EXT_RE = /\.(zip|pdf|tar|gz|exe|msi|dmg|bin|jpg|jpeg|png|mp4|webm)(\?|$)/i;

  // session storage key to avoid infinite reload loops
  const RELOAD_KEY = 'wormhole_autodl_reloads';

  // ---- UTILITIES ----
  function getReloadCount() {
    try { return parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10); } catch (e) { return 0; }
  }
  function incrementReloadCount() {
    try {
      const v = getReloadCount() + 1;
      sessionStorage.setItem(RELOAD_KEY, String(v));
      return v;
    } catch (e) { return 0; }
  }

  function isBusyUiPresent() {
    // check for visible elements that indicate the app is still working
    const texts = BUSY_TEXTS;
    const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    for (const t of texts) {
      if (bodyText.indexOf(t) !== -1) {
        console.debug('[Wormhole Auto Downloader] Busy indicator found in body text:', t);
        return true;
      }
    }
    // check for elements with aria-busy
    const busyEl = document.querySelector('[aria-busy="true"], [data-loading="true"], .loading, .spinner');
    if (busyEl) {
      console.debug('[Wormhole Auto Downloader] Busy element found:', busyEl);
      return true;
    }
    return false;
  }

  function isVisibleAndInteractable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    // ignore hidden
    try {
      const style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0)) return false;
    } catch (e) { /* ignore */ }

    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;

    // ensure clickable area is inside viewport
    const inViewport = (r.bottom >= 0 && r.top <= (window.innerHeight || document.documentElement.clientHeight));
    if (!inViewport) return false;

    // not aria-hidden
    if (el.closest && el.closest('[aria-hidden="true"]')) return false;

    return true;
  }

  function looksLikeDownload(el) {
    if (!el) return false;
    const text = ((el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || '')) + ' ' + (el.getAttribute && (el.getAttribute('title') || ''))).trim();
    if (DOWNLOAD_TEXT_RE.test(text)) return true;
    const href = el.getAttribute && el.getAttribute('href');
    if (href && HREF_FILE_EXT_RE.test(href)) return true;
    if (el.hasAttribute && el.hasAttribute('download')) return true;
    // some pages may use data attributes or aria-labels
    const aria = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-download'));
    if (aria && /download/i.test(aria)) return true;
    return false;
  }

  function findDownloadControl() {
    // 1) Try specific candidate selectors observed on the page (chakra-button, large CTA, etc.)
    const specificSelectors = [
      'button.chakra-button',              // general Chakra UI buttons
      'a.chakra-link.chakra-button',       // anchor styled as button
      'a[href*="download"]',
      'a[download]',
      'button[aria-label*="Download"]',
      'button[title*="Download"]'
    ];
    for (const s of specificSelectors) {
      try {
        const node = document.querySelector(s);
        if (node && isVisibleAndInteractable(node) && looksLikeDownload(node)) {
          console.debug('[Wormhole Auto Downloader] Found via specific selector:', s, node);
          return node;
        }
      } catch (e) { /* ignore selector errors */ }
    }

    // 2) Scan all clickable elements (buttons, anchors, inputs)
    const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]'));
    for (const c of candidates) {
      if (looksLikeDownload(c) && isVisibleAndInteractable(c)) {
        console.debug('[Wormhole Auto Downloader] Found via scanning candidate:', c);
        return c;
      }
    }

    // 3) Last resort: any element with download attribute or huge file-href
    const downloadAttr = document.querySelector('[download]');
    if (downloadAttr && isVisibleAndInteractable(downloadAttr)) {
      console.debug('[Wormhole Auto Downloader] Found [download] element:', downloadAttr);
      return downloadAttr;
    }

    const fileHref = Array.from(document.querySelectorAll('a[href]')).find(a => HREF_FILE_EXT_RE.test(a.href) && isVisibleAndInteractable(a));
    if (fileHref) {
      console.debug('[Wormhole Auto Downloader] Found link with file extension:', fileHref);
      return fileHref;
    }

    return null;
  }

  function emulateClick(el) {
    try {
      console.info('[Wormhole Auto Downloader] Emulating click on', el);
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      // dispatch low-level events so frameworks pick up the action
      ['pointerdown', 'mousedown', 'click', 'mouseup'].forEach(type => {
        const evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(evt);
      });
      // fallback to el.click()
      if (typeof el.click === 'function') {
        try { el.click(); } catch (e) { /* ignore */ }
      }
      console.info('[Wormhole Auto Downloader] Click dispatched.');
    } catch (err) {
      console.error('[Wormhole Auto Downloader] Click failed:', err);
    }
  }

  // ----- Main routine -----
  function startAutoDl() {
    console.debug('[Wormhole Auto Downloader] startAutoDl() — readyState:', document.readyState);

    // quick check for download control
    const immediate = findDownloadControl();
    if (immediate) {
      emulateClick(immediate);
      return;
    }

    // if busy indicators exist, wait longer and do not reload aggressively
    if (isBusyUiPresent()) {
      console.debug('[Wormhole Auto Downloader] Busy UI present — delaying initial reload/wait.');
    }

    let resolved = false;
    const observer = new MutationObserver((mutations) => {
      if (resolved) return;
      const found = findDownloadControl();
      if (found) {
        resolved = true;
        observer.disconnect();
        console.debug('[Wormhole Auto Downloader] Found download control via MutationObserver.');
        emulateClick(found);
      }
    });

    // observe document for new nodes (some frameworks mount into body later)
    const observeTarget = document.documentElement || document.body;
    try {
      observer.observe(observeTarget, { childList: true, subtree: true, attributes: true });
    } catch (e) {
      console.warn('[Wormhole Auto Downloader] Observer failed to attach:', e);
    }

    // polling fallback
    let elapsed = 0;
    let pollInterval = POLL_INTERVAL_MS;
    const start = Date.now();
    const timer = setInterval(() => {
      if (resolved) { clearInterval(timer); return; }
      const found = findDownloadControl();
      if (found) {
        resolved = true;
        clearInterval(timer);
        observer.disconnect();
        console.debug('[Wormhole Auto Downloader] Found download control via polling after', Date.now() - start, 'ms.');
        emulateClick(found);
        return;
      }
      elapsed += pollInterval;
      // if we've reached the initial wait time, consider reload with backoff, but only if not busy
      if (elapsed >= INITIAL_WAIT_MS) {
        clearInterval(timer);
        observer.disconnect();

        if (isBusyUiPresent()) {
          // if busy, give more time (backoff) instead of immediate reload
          const reloads = getReloadCount();
          console.info('[Wormhole Auto Downloader] Page is busy. Will retry without reloading (retry count:', reloads, ').');
          // schedule a delayed secondary attempt with backoff
          const extraWait = Math.max(2000, Math.floor(INITIAL_WAIT_MS * Math.pow(BACKOFF_FACTOR, reloads)));
          setTimeout(() => startAutoDl(), extraWait);
          return;
        }

        // no busy indicators — consider reload but enforce limits
        const reloads = getReloadCount();
        if (reloads >= MAX_RELOADS) {
          console.warn('[Wormhole Auto Downloader] Max reload attempts reached (' + reloads + '). Giving up.');
          return;
        }

        // increase reload counter and reload
        const newCount = incrementReloadCount();
        console.warn('[Wormhole Auto Downloader] No download control found after', INITIAL_WAIT_MS, 'ms. Reloading (attempt', newCount, 'of', MAX_RELOADS, ').');
        try {
          location.reload();
        } catch (e) {
          console.error('[Wormhole Auto Downloader] Reload failed:', e);
        }
      }
    }, pollInterval);

    // stop observer after a long timeout to avoid leaks
    setTimeout(() => {
      if (!resolved) {
        observer.disconnect();
        try { clearInterval(timer); } catch (e) { /* ignore */ }
        console.debug('[Wormhole Auto Downloader] Observer timeout reached without finding download control.');
      }
    }, OBSERVER_TIMEOUT_MS);
  }

  // start on load or shortly after if already complete
  if (document.readyState === 'complete') {
    setTimeout(startAutoDl, 150);
  } else {
    window.addEventListener('load', () => setTimeout(startAutoDl, 150), { once: true });
  }

})();
