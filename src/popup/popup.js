/**
 * GrammarPal Popup Script
 * Loads analysis status from the background worker and renders stats.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const scoreValue = document.getElementById('scoreValue');
  const scoreRingFill = document.getElementById('scoreRingFill');
  const grammarCount = document.getElementById('grammarCount');
  const spellingCount = document.getElementById('spellingCount');
  const clarityCount = document.getElementById('clarityCount');
  const toneValue = document.getElementById('toneValue');
  const statusText = document.querySelector('.status-text');
  const statusDot = document.querySelector('.status-dot');
  const enableToggle = document.getElementById('enableToggle');
  const settingsBtn = document.getElementById('settingsBtn');

  // Add SVG gradient definition for the score ring
  const svgEl = document.querySelector('.score-ring');
  if (svgEl) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gradient.setAttribute('id', 'scoreGradient');
    gradient.setAttribute('x1', '0%');
    gradient.setAttribute('y1', '0%');
    gradient.setAttribute('x2', '100%');
    gradient.setAttribute('y2', '100%');

    const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', '#667eea');
    const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', '#764ba2');

    gradient.appendChild(stop1);
    gradient.appendChild(stop2);
    defs.appendChild(gradient);
    svgEl.insertBefore(defs, svgEl.firstChild);
  }

  // Get current tab
  let currentTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;

    // Check if enabled for this site
    const hostname = tab?.url ? new URL(tab.url).hostname : '';
    const stored = await chrome.storage.sync.get({ disabledSites: [] });
    const isDisabled = stored.disabledSites.some(site =>
      hostname === site || hostname.endsWith('.' + site)
    );
    enableToggle.checked = !isDisabled;
  } catch {
    // Ignore errors
  }

  // Load status from background
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'GRAMMARPAL_GET_STATUS',
      tabId: currentTabId
    });

    if (result && result.corrections) {
      updateUI(result);
    } else {
      setIdleState();
    }
  } catch {
    setIdleState();
  }

  // Enable/disable toggle
  enableToggle.addEventListener('change', async () => {
    const enabled = enableToggle.checked;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;

      const hostname = new URL(tab.url).hostname;
      const stored = await chrome.storage.sync.get({ disabledSites: [] });
      let sites = stored.disabledSites;

      if (enabled) {
        sites = sites.filter(s => s !== hostname);
      } else {
        if (!sites.includes(hostname)) sites.push(hostname);
      }

      await chrome.storage.sync.set({ disabledSites: sites });

      // Notify content script
      chrome.tabs.sendMessage(tab.id, {
        type: 'GRAMMARPAL_TOGGLE',
        enabled
      });

      statusText.textContent = enabled ? 'Enabled for this site' : 'Disabled for this site';
      statusDot.style.background = enabled ? '#52b788' : '#e63946';
    } catch {
      // Ignore
    }
  });

  // Settings button
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── Update UI ──────────────────────────────────────────

  function updateUI(data) {
    const corrections = data.corrections || [];
    const grammar = corrections.filter(c => c.type === 'grammar').length;
    const spelling = corrections.filter(c => c.type === 'spelling').length;
    const clarity = corrections.filter(c => c.type === 'clarity' || c.type === 'punctuation').length;

    grammarCount.textContent = grammar;
    spellingCount.textContent = spelling;
    clarityCount.textContent = clarity;

    // Tone
    const tone = data.tone || 'neutral';
    toneValue.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);

    // Score
    const score = data.overall_score || 0;
    scoreValue.textContent = score;
    animateScoreRing(score);

    // Status
    const totalIssues = corrections.length;
    if (totalIssues === 0) {
      statusText.textContent = '✓ Your writing looks great!';
      statusDot.style.background = '#52b788';
    } else {
      statusText.textContent = `${totalIssues} suggestion${totalIssues > 1 ? 's' : ''} found`;
      statusDot.style.background = '#e63946';
    }

    // Color-code stat cards
    if (grammar > 0) grammarCount.style.color = '#ff6b6b';
    if (spelling > 0) spellingCount.style.color = '#4cc9f0';
    if (clarity > 0) clarityCount.style.color = '#c084fc';
  }

  function setIdleState() {
    scoreValue.textContent = '—';
    statusText.textContent = 'Ready — start typing in any text field';
    statusDot.style.background = '#52b788';
  }

  function animateScoreRing(score) {
    const circumference = 2 * Math.PI * 52; // r=52
    const offset = circumference - (score / 100) * circumference;

    // Set color based on score
    let color1 = '#e63946', color2 = '#ff6b6b'; // red
    if (score >= 80) { color1 = '#52b788'; color2 = '#40916c'; } // green
    else if (score >= 60) { color1 = '#667eea'; color2 = '#764ba2'; } // purple
    else if (score >= 40) { color1 = '#f4a261'; color2 = '#e76f51'; } // amber

    // Update gradient colors
    const stops = document.querySelectorAll('#scoreGradient stop');
    if (stops.length >= 2) {
      stops[0].setAttribute('stop-color', color1);
      stops[1].setAttribute('stop-color', color2);
    }

    // Animate
    requestAnimationFrame(() => {
      scoreRingFill.style.strokeDashoffset = offset;
    });
  }
});
