/**
 * GrammarPal Content Script
 * Detects text inputs, sends text for analysis, and shows a single
 * corrected paragraph with one-click replace (Grammarly-style).
 */

(function () {
  'use strict';

  if (window.__grammarPalLoaded) return;
  window.__grammarPalLoaded = true;

  let isEnabled = true;
  let activeElement = null;
  let debounceTimer = null;
  let currentAnalysis = null;

  const DEBOUNCE_MS = 1500;
  const MIN_TEXT_LENGTH = 10;

  // ─── Initialization ─────────────────────────────────────────
  init();

  async function init() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GRAMMARPAL_CHECK_ENABLED' });
      isEnabled = response?.enabled !== false;
    } catch {
      isEnabled = true;
    }
    if (!isEnabled) return;

    attachListeners();
    observeDOM();
    if (document.body) injectIndicator();
    else document.addEventListener('DOMContentLoaded', () => injectIndicator());
  }

  // ─── Text Input Detection ───────────────────────────────────

  function getEditableElement(el) {
    if (!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'email', 'url', ''].includes((el.getAttribute('type') || 'text').toLowerCase()))) return el;
    if (el.isContentEditable || el.contentEditable === 'true') return el;
    if (el.getAttribute?.('role') === 'textbox') return el;
    if (el.closest) {
      const editable = el.closest('[contenteditable="true"]');
      if (editable) return editable;
    }
    return null;
  }

  function getTextFromElement(el) {
    if (!el) return '';
    const tag = el.tagName?.toLowerCase();
    if (tag === 'textarea' || tag === 'input') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function setTextToElement(el, text) {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ─── Event Listeners ───────────────────────────────────────

  function attachListeners() {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('click', onClickAnywhere, true);
  }

  function onClickAnywhere(e) {
    if (!isEnabled) return;
    // If clicking outside the overlay and outside the active element, dismiss
    if (overlayContainer && !overlayContainer.contains(e.target)) {
      const el = getEditableElement(e.target);
      if (!el || el !== activeElement) {
        // Clicked somewhere else entirely — keep overlay for now
      }
      if (el) {
        activeElement = el;
        showIndicator(el);
      }
    } else {
      const el = getEditableElement(e.target);
      if (el) {
        activeElement = el;
        showIndicator(el);
      }
    }
  }

  function onFocusIn(e) {
    if (!isEnabled) return;
    const el = getEditableElement(e.target);
    if (el) {
      activeElement = el;
      showIndicator(el);
    }
  }

  function onInput(e) {
    if (!isEnabled) return;
    const el = getEditableElement(e.target);
    if (!el) return;
    activeElement = el;
    scheduleAnalysis(el);
  }

  function onKeyUp(e) {
    if (!isEnabled) return;
    const el = getEditableElement(e.target);
    if (!el) return;
    if (el.tagName?.toLowerCase() === 'textarea' || el.tagName?.toLowerCase() === 'input') return;
    activeElement = el;
    scheduleAnalysis(el);
  }

  function scheduleAnalysis(el) {
    clearTimeout(debounceTimer);
    const text = getTextFromElement(el);
    if (text.trim().length < MIN_TEXT_LENGTH) {
      clearOverlay();
      updateIndicatorState('idle');
      return;
    }
    updateIndicatorState('waiting');
    debounceTimer = setTimeout(() => analyzeCurrentText(el), DEBOUNCE_MS);
  }

  // ─── AI Analysis ───────────────────────────────────────────

  async function analyzeCurrentText(el) {
    const text = getTextFromElement(el);
    if (text.trim().length < MIN_TEXT_LENGTH) return;

    updateIndicatorState('analyzing');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'GRAMMARPAL_ANALYZE',
        text: text
      });

      if (result?.error) {
        updateIndicatorState('error', result.error);
        return;
      }

      currentAnalysis = result;
      const corrections = result?.corrections || [];

      if (corrections.length > 0) {
        renderCorrectedParagraph(el, text, corrections, result);
        updateIndicatorState('issues', corrections.length);
      } else {
        clearOverlay();
        updateIndicatorState('clean');
      }
    } catch (error) {
      updateIndicatorState('error', error.message);
    }
  }

  // ─── Corrected Paragraph Overlay (Grammarly-style) ─────────

  let overlayContainer = null;

  function ensureOverlayContainer() {
    const targetBody = document.body;
    if (overlayContainer && targetBody.contains(overlayContainer)) return overlayContainer;
    if (overlayContainer) { overlayContainer.remove(); overlayContainer = null; }

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'grammarpal-overlay-container';
    overlayContainer.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483640;pointer-events:none;';

    const shadow = overlayContainer.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = getOverlayStyles();
    shadow.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.id = 'gp-wrapper';
    shadow.appendChild(wrapper);

    targetBody.appendChild(overlayContainer);
    return overlayContainer;
  }

  /**
   * Build the corrected full text and a diff-highlighted HTML version
   */
  function buildCorrectedOutput(originalText, corrections) {
    // Sort corrections by position in text (first occurrence)
    const sorted = corrections
      .map(c => ({
        ...c,
        index: originalText.indexOf(c.original)
      }))
      .filter(c => c.index !== -1)
      .sort((a, b) => a.index - b.index);

    let correctedText = originalText;
    let diffHtml = '';
    let cursor = 0;

    // Deduplicate overlapping corrections
    const used = [];
    for (const c of sorted) {
      const start = originalText.indexOf(c.original, cursor);
      if (start === -1) continue;
      // Check overlap
      if (used.length > 0) {
        const last = used[used.length - 1];
        if (start < last.index + last.original.length) continue;
      }
      used.push({ ...c, index: start });
    }

    // Build diff HTML from used corrections
    cursor = 0;
    for (const c of used) {
      // Text before this correction
      if (c.index > cursor) {
        diffHtml += escapeHtml(originalText.substring(cursor, c.index));
      }
      // The correction itself
      const typeClass = `gp-diff-${c.type || 'grammar'}`;
      diffHtml += `<span class="gp-diff-change ${typeClass}" title="${escapeHtml(c.explanation || '')}">`;
      diffHtml += `<span class="gp-diff-removed">${escapeHtml(c.original)}</span>`;
      diffHtml += `<span class="gp-diff-added">${escapeHtml(c.corrected)}</span>`;
      diffHtml += `</span>`;
      cursor = c.index + c.original.length;
    }
    // Remaining text
    if (cursor < originalText.length) {
      diffHtml += escapeHtml(originalText.substring(cursor));
    }

    // Build plain corrected text
    correctedText = originalText;
    // Apply in reverse order to preserve indices
    for (let i = used.length - 1; i >= 0; i--) {
      const c = used[i];
      correctedText = correctedText.substring(0, c.index) + c.corrected + correctedText.substring(c.index + c.original.length);
    }

    return { diffHtml, correctedText, count: used.length };
  }

  function renderCorrectedParagraph(el, originalText, corrections, analysis) {
    ensureOverlayContainer();
    const wrapper = overlayContainer.shadowRoot.getElementById('gp-wrapper');
    wrapper.innerHTML = '';

    const rect = el.getBoundingClientRect();

    const { diffHtml, correctedText, count } = buildCorrectedOutput(originalText, corrections);

    // Main panel — compact, fixed to viewport, draggable
    const panel = document.createElement('div');
    panel.className = 'gp-panel';

    const panelWidth = 300;
    const panelEstHeight = 220;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const margin = 10;

    // Position: try right side of text field, then left, then below — all viewport-relative
    let panelTop = Math.max(margin, rect.top);
    let panelLeft;
    if (rect.right + panelWidth + margin < viewportW) {
      panelLeft = rect.right + 8;
    } else if (rect.left - panelWidth - margin > 0) {
      panelLeft = rect.left - panelWidth - 8;
    } else {
      panelLeft = Math.max(margin, Math.min(rect.left, viewportW - panelWidth - margin));
      panelTop = Math.min(rect.bottom + 6, viewportH - panelEstHeight - margin);
    }

    // Clamp within viewport
    panelTop = Math.max(margin, Math.min(panelTop, viewportH - panelEstHeight - margin));
    panelLeft = Math.max(margin, Math.min(panelLeft, viewportW - panelWidth - margin));

    panel.style.cssText = `position:fixed;top:${panelTop}px;left:${panelLeft}px;z-index:2147483642;pointer-events:auto;width:${panelWidth}px;`;

    // Determine score color
    const score = analysis.overall_score || 0;
    let scoreClass = 'gp-score-low';
    if (score >= 80) scoreClass = 'gp-score-high';
    else if (score >= 60) scoreClass = 'gp-score-mid';

    // Header
    const grammarN = corrections.filter(c => c.type === 'grammar').length;
    const spellingN = corrections.filter(c => c.type === 'spelling').length;
    const clarityN = corrections.filter(c => c.type === 'clarity' || c.type === 'punctuation').length;

    let statsHtml = '';
    if (grammarN) statsHtml += `<span class="gp-badge gp-badge-grammar">${grammarN} grammar</span>`;
    if (spellingN) statsHtml += `<span class="gp-badge gp-badge-spelling">${spellingN} spelling</span>`;
    if (clarityN) statsHtml += `<span class="gp-badge gp-badge-clarity">${clarityN} clarity</span>`;

    panel.innerHTML = `
      <div class="gp-header">
        <div class="gp-header-left">
          <span class="gp-logo">✏️ GrammarPal</span>
          <div class="gp-badges">${statsHtml}</div>
        </div>
        <div class="gp-header-right">
          <span class="gp-score ${scoreClass}">${score}</span>
          <button class="gp-close-btn" title="Dismiss">✕</button>
        </div>
      </div>
      <div class="gp-body">
        <div class="gp-label">Corrected version <span class="gp-label-hint">(changes highlighted)</span></div>
        <div class="gp-diff-paragraph">${diffHtml}</div>
        ${analysis.tone ? `<div class="gp-tone">Tone: <span class="gp-tone-value">${analysis.tone}</span></div>` : ''}
      </div>
      <div class="gp-footer">
        <button class="gp-replace-btn">✓ Replace All (${count} fix${count !== 1 ? 'es' : ''})</button>
        <button class="gp-dismiss-btn">Dismiss</button>
      </div>
    `;

    // Event handlers
    panel.querySelector('.gp-replace-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setTextToElement(el, correctedText);
      clearOverlay();
      updateIndicatorState('clean');
    });

    panel.querySelector('.gp-dismiss-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      clearOverlay();
      updateIndicatorState('idle');
    });

    panel.querySelector('.gp-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      clearOverlay();
      updateIndicatorState('idle');
    });

    // ── Drag support: grab the header to move the panel ──
    const header = panel.querySelector('.gp-header');
    let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.gp-close-btn')) return; // don't drag on close button
      isDragging = true;
      dragOffsetX = e.clientX - panel.getBoundingClientRect().left;
      dragOffsetY = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });

    const onMouseMove = (e) => {
      if (!isDragging) return;
      let newLeft = e.clientX - dragOffsetX;
      let newTop = e.clientY - dragOffsetY;
      // Clamp within viewport
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - panelWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 50));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onMouseUp = () => { isDragging = false; };

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);

    // Store cleanup refs so we can remove on clear
    panel.__gpDragCleanup = () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };

    wrapper.appendChild(panel);
  }

  function clearOverlay() {
    if (overlayContainer) {
      const wrapper = overlayContainer.shadowRoot?.getElementById('gp-wrapper');
      if (wrapper) {
        // Clean up drag listeners
        const panel = wrapper.querySelector('.gp-panel');
        if (panel?.__gpDragCleanup) panel.__gpDragCleanup();
        wrapper.innerHTML = '';
      }
    }
    currentAnalysis = null;
  }

  // ─── Floating Indicator ────────────────────────────────────

  let indicatorElement = null;

  function injectIndicator() {
    if (indicatorElement || !document.body) return;
    indicatorElement = document.createElement('div');
    indicatorElement.id = 'grammarpal-indicator';

    const shadow = indicatorElement.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { position:fixed!important; z-index:2147483647!important; pointer-events:auto; display:none; }
        .gp-ind { display:flex; align-items:center; gap:5px; padding:4px 10px; border-radius:20px;
          font-family:'Inter','Segoe UI',system-ui,sans-serif; font-size:11px; font-weight:600; color:#fff;
          background:linear-gradient(135deg,#1a1a2e,#16213e); border:1px solid rgba(255,255,255,0.1);
          box-shadow:0 4px 15px rgba(0,0,0,0.3); cursor:default; transition:all .3s; white-space:nowrap; }
        .gp-ind:hover { transform:translateY(-1px); box-shadow:0 6px 20px rgba(0,0,0,0.4); }
        .gp-ind.analyzing { background:linear-gradient(135deg,#0f3460,#533483); }
        .gp-ind.clean { background:linear-gradient(135deg,#1b4332,#2d6a4f); }
        .gp-ind.issues { background:linear-gradient(135deg,#7f2b2b,#e63946); }
        .gp-ind.error { background:linear-gradient(135deg,#5c3a1e,#b8860b); }
        .dot { width:7px; height:7px; border-radius:50%; background:#4cc9f0; }
        .gp-ind.analyzing .dot { animation:p 1s ease-in-out infinite; }
        .gp-ind.clean .dot { background:#52b788; }
        .gp-ind.issues .dot { background:#ff6b6b; }
        .gp-ind.error .dot { background:#f4a261; }
        @keyframes p { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }
      </style>
      <div class="gp-ind"><span class="dot"></span><span class="lbl">GrammarPal</span></div>
    `;
    document.body.appendChild(indicatorElement);
  }

  function showIndicator(el) {
    if (!indicatorElement) { injectIndicator(); if (!indicatorElement) return; }
    const rect = el.getBoundingClientRect();
    indicatorElement.style.display = 'block';
    indicatorElement.style.top = `${Math.max(2, rect.top - 30)}px`;
    indicatorElement.style.left = `${Math.max(2, rect.right - 120)}px`;
    updateIndicatorState('idle');
  }

  function hideIndicator() { if (indicatorElement) indicatorElement.style.display = 'none'; }

  function updateIndicatorState(state, detail) {
    if (!indicatorElement) return;
    const badge = indicatorElement.shadowRoot?.querySelector('.gp-ind');
    const label = indicatorElement.shadowRoot?.querySelector('.lbl');
    if (!badge || !label) return;
    badge.className = `gp-ind ${state}`;
    const map = { idle:'GrammarPal', waiting:'Waiting...', analyzing:'Analyzing...', clean:'✓ All good!',
      issues:`${detail} issue${detail>1?'s':''} found`, error:'Error' };
    label.textContent = map[state] || 'GrammarPal';
  }

  // ─── MutationObserver ──────────────────────────────────────

  function observeDOM() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => observeDOM()); return; }
    new MutationObserver((mutations) => {
      for (const m of mutations) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = getEditableElement(node);
        if (el && document.activeElement === el) { activeElement = el; showIndicator(el); }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] });
  }

  // ─── Messages from background ──────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'GRAMMARPAL_CONTEXT_RESULT' && activeElement) {
      currentAnalysis = message.result;
      const corrections = message.result?.corrections || [];
      if (corrections.length > 0) {
        renderCorrectedParagraph(activeElement, getTextFromElement(activeElement), corrections, message.result);
        updateIndicatorState('issues', corrections.length);
      } else { updateIndicatorState('clean'); }
    }
    if (message.type === 'GRAMMARPAL_ERROR') updateIndicatorState('error', message.error);
    if (message.type === 'GRAMMARPAL_TOGGLE') {
      isEnabled = message.enabled;
      if (!isEnabled) { clearOverlay(); hideIndicator(); }
    }
  });

  // ─── Utilities ─────────────────────────────────────────────

  function escapeHtml(str) {
    const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
  }

  function getOverlayStyles() {
    return `
      * { box-sizing:border-box; margin:0; padding:0; }

      .gp-panel {
        font-family: 'Inter','Segoe UI',system-ui,-apple-system,sans-serif;
        background: linear-gradient(160deg, #12122a 0%, #0e0e20 100%);
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.1);
        overflow: hidden;
        animation: gpFadeIn 0.25s ease;
        backdrop-filter: blur(16px);
        font-size: 12px;
      }

      /* ── Header ── */
      .gp-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px;
        background: linear-gradient(135deg, rgba(99,102,241,0.08), rgba(147,51,234,0.06));
        border-bottom: 1px solid rgba(255,255,255,0.06);
        cursor: grab; user-select: none;
      }
      .gp-header:active { cursor: grabbing; }
      .gp-header-left { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .gp-header-right { display:flex; align-items:center; gap:10px; }
      .gp-logo { font-size:11px; font-weight:800; letter-spacing:-0.3px;
        background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text;
        -webkit-text-fill-color:transparent; background-clip:text; }
      .gp-badges { display:flex; gap:6px; flex-wrap:wrap; }
      .gp-badge { font-size:9px; font-weight:600; padding:1px 6px; border-radius:8px; }
      .gp-badge-grammar { background:rgba(230,57,70,0.15); color:#ff6b6b; }
      .gp-badge-spelling { background:rgba(72,149,239,0.15); color:#4cc9f0; }
      .gp-badge-clarity { background:rgba(147,51,234,0.15); color:#c084fc; }
      .gp-score { font-size:13px; font-weight:800; min-width:26px; text-align:center;
        padding:1px 6px; border-radius:6px; }
      .gp-score-high { color:#52b788; background:rgba(82,183,136,0.12); }
      .gp-score-mid { color:#667eea; background:rgba(99,102,241,0.12); }
      .gp-score-low { color:#ff6b6b; background:rgba(230,57,70,0.12); }
      .gp-close-btn { background:none; border:none; color:#555; cursor:pointer; font-size:13px;
        padding:2px 4px; border-radius:4px; transition:all .2s; line-height:1; }
      .gp-close-btn:hover { background:rgba(255,255,255,0.1); color:#fff; }

      /* ── Body ── */
      .gp-body { padding:8px 12px; }
      .gp-label { font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:0.6px;
        color:#6868a0; margin-bottom:5px; }
      .gp-label-hint { font-weight:400; text-transform:none; letter-spacing:0; font-size:9px; }

      .gp-diff-paragraph {
        font-size: 12px; line-height: 1.6; color: #c8c8e0;
        padding: 8px 10px;
        background: rgba(255,255,255,0.03);
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.05);
        max-height: 150px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* Inline diff highlights */
      .gp-diff-change {
        position: relative;
        border-radius: 3px;
        cursor: help;
      }
      .gp-diff-removed {
        text-decoration: line-through;
        color: #ff6b6b;
        opacity: 0.7;
        font-size: 11px;
        margin-right: 1px;
      }
      .gp-diff-added {
        color: #52b788;
        font-weight: 600;
        background: rgba(82,183,136,0.1);
        padding: 1px 4px;
        border-radius: 3px;
        margin-left: 1px;
      }
      .gp-diff-grammar .gp-diff-added { border-bottom: 2px solid rgba(230,57,70,0.5); }
      .gp-diff-spelling .gp-diff-added { border-bottom: 2px solid rgba(72,149,239,0.5); }
      .gp-diff-clarity .gp-diff-added { border-bottom: 2px solid rgba(147,51,234,0.5); }
      .gp-diff-punctuation .gp-diff-added { border-bottom: 2px solid rgba(244,162,97,0.5); }

      .gp-diff-change:hover::after {
        content: attr(title);
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: #1a1a36;
        color: #c8c8e0;
        font-size: 11px;
        font-weight: 500;
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        white-space: nowrap;
        z-index: 10;
        pointer-events: none;
      }

      .gp-tone { margin-top:6px; font-size:10px; color:#6868a0; }
      .gp-tone-value { color:#c084fc; font-weight:600; text-transform:capitalize; }

      /* ── Footer ── */
      .gp-footer {
        display: flex; gap: 6px; padding: 7px 12px;
        border-top: 1px solid rgba(255,255,255,0.06);
        background: rgba(0,0,0,0.15);
      }
      .gp-replace-btn {
        flex: 1;
        background: linear-gradient(135deg, #52b788, #40916c);
        border: none; color: #fff; font-size: 11px; font-weight: 700;
        padding: 6px 12px; border-radius: 7px; cursor: pointer;
        transition: all 0.2s; font-family: inherit;
        box-shadow: 0 3px 10px rgba(82,183,136,0.25);
      }
      .gp-replace-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(82,183,136,0.4);
      }
      .gp-dismiss-btn {
        background: transparent; border: 1px solid rgba(255,255,255,0.08);
        color: #6868a0; font-size: 11px; font-weight: 600;
        padding: 6px 10px; border-radius: 7px; cursor: pointer;
        transition: all 0.2s; font-family: inherit;
      }
      .gp-dismiss-btn:hover { background:rgba(255,255,255,0.05); color:#9898b8; }

      @keyframes gpFadeIn {
        from { opacity:0; transform:translateY(8px); }
        to { opacity:1; transform:translateY(0); }
      }

      /* Scrollbar */
      .gp-diff-paragraph::-webkit-scrollbar { width:5px; }
      .gp-diff-paragraph::-webkit-scrollbar-track { background:transparent; }
      .gp-diff-paragraph::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:4px; }
    `;
  }

})();
