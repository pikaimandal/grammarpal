/**
 * GrammarPal Background Service Worker
 * Handles message passing, context menus, and AI analysis coordination.
 */

import { analyzeText, getConfig } from './ai-service.js';

// Simple in-memory cache (cleared when service worker restarts)
const analysisCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 50;

// Throttle tracking
const pendingRequests = new Map();

/**
 * Generate a simple hash for cache keys
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Get cached result or null
 */
function getCached(text) {
  const key = simpleHash(text);
  const cached = analysisCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }
  if (cached) analysisCache.delete(key);
  return null;
}

/**
 * Store result in cache
 */
function setCache(text, result) {
  const key = simpleHash(text);
  if (analysisCache.size >= MAX_CACHE_SIZE) {
    const oldest = analysisCache.keys().next().value;
    analysisCache.delete(oldest);
  }
  analysisCache.set(key, { result, timestamp: Date.now() });
}

// Install context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'grammarpal-check',
    title: 'Check with GrammarPal',
    contexts: ['selection']
  });
  console.log('[GrammarPal BG] Extension installed, context menu created.');
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'grammarpal-check' && info.selectionText) {
    try {
      const result = await analyzeText(info.selectionText);
      chrome.tabs.sendMessage(tab.id, {
        type: 'GRAMMARPAL_CONTEXT_RESULT',
        result,
        selectedText: info.selectionText
      });
    } catch (error) {
      console.error('[GrammarPal BG] Context menu analysis error:', error);
      chrome.tabs.sendMessage(tab.id, {
        type: 'GRAMMARPAL_ERROR',
        error: error.message
      });
    }
  }
});

// Store latest results per tab
const tabResults = new Map();

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GrammarPal BG] Received message:', message.type, 'from tab:', sender.tab?.id);

  if (message.type === 'GRAMMARPAL_ANALYZE') {
    handleAnalyzeRequest(message.text, sender.tab?.id)
      .then(result => {
        console.log('[GrammarPal BG] Analysis complete, sending response');
        sendResponse(result);
      })
      .catch(err => {
        console.error('[GrammarPal BG] Analysis error:', err.message);
        sendResponse({ error: err.message });
      });
    return true; // Keep channel open for async response
  }

  if (message.type === 'GRAMMARPAL_GET_STATUS') {
    const tabId = message.tabId || sender.tab?.id;
    const status = tabId ? (tabResults.get(tabId) || null) : null;
    sendResponse(status);
    return false; // Synchronous response
  }

  if (message.type === 'GRAMMARPAL_CHECK_ENABLED') {
    checkIfEnabled(sender.tab?.url)
      .then(enabled => sendResponse({ enabled }))
      .catch(() => sendResponse({ enabled: true }));
    return true;
  }
});

/**
 * Handle text analysis request with caching and deduplication
 */
async function handleAnalyzeRequest(text, tabId) {
  if (!text || text.trim().length < 5) {
    return { corrections: [], tone: 'neutral', clarity_score: 100, overall_score: 100, summary: '' };
  }

  // Check cache
  const cached = getCached(text);
  if (cached) {
    console.log('[GrammarPal BG] Cache hit');
    if (tabId) tabResults.set(tabId, cached);
    return cached;
  }

  // Deduplicate: if same text is already being analyzed, wait for it
  const requestKey = simpleHash(text);
  if (pendingRequests.has(requestKey)) {
    console.log('[GrammarPal BG] Dedup — waiting for existing request');
    return pendingRequests.get(requestKey);
  }

  console.log('[GrammarPal BG] Making API call...');

  const promise = analyzeText(text)
    .then(result => {
      setCache(text, result);
      if (tabId) tabResults.set(tabId, result);
      pendingRequests.delete(requestKey);
      console.log('[GrammarPal BG] API call successful, corrections:', result.corrections?.length);
      return result;
    })
    .catch(err => {
      pendingRequests.delete(requestKey);
      console.error('[GrammarPal BG] API call failed:', err.message);
      throw err;
    });

  pendingRequests.set(requestKey, promise);
  return promise;
}

/**
 * Check if GrammarPal is enabled for a given URL / domain
 */
async function checkIfEnabled(url) {
  if (!url) return true;
  return new Promise((resolve) => {
    chrome.storage.sync.get({ disabledSites: [] }, (result) => {
      try {
        const hostname = new URL(url).hostname;
        const disabled = result.disabledSites.some(site =>
          hostname === site || hostname.endsWith('.' + site)
        );
        resolve(!disabled);
      } catch {
        resolve(true);
      }
    });
  });
}

// Clean up tab results when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabResults.delete(tabId);
});

console.log('[GrammarPal BG] Service worker loaded.');
