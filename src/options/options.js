/**
 * GrammarPal Options Page Script
 * Manages provider config, API keys, writing style, and disabled sites.
 */

const PROVIDER_INFO = {
  digitalocean: {
    endpoint: 'https://inference.do-ai.run/v1/chat/completions',
    model: 'openai-gpt-oss-120b',
    hint: 'Leave blank to use the default embedded key.'
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    hint: 'Enter your OpenAI API key (starts with sk-).'
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-latest',
    hint: 'Enter your Anthropic API key (starts with sk-ant-).'
  },
  custom: {
    endpoint: '',
    model: '',
    hint: 'Enter a valid API key for your custom endpoint.'
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const apiKeyHint = document.getElementById('apiKeyHint');
  const toggleKeyBtn = document.getElementById('toggleKey');
  const customEndpointGroup = document.getElementById('customEndpointGroup');
  const customModelGroup = document.getElementById('customModelGroup');
  const customEndpointInput = document.getElementById('customEndpoint');
  const customModelInput = document.getElementById('customModel');
  const infoEndpoint = document.getElementById('infoEndpoint');
  const infoModel = document.getElementById('infoModel');
  const writingStyleSelect = document.getElementById('writingStyle');
  const newSiteInput = document.getElementById('newSite');
  const addSiteBtn = document.getElementById('addSiteBtn');
  const sitesList = document.getElementById('disabledSitesList');
  const noSitesMsg = document.getElementById('noSitesMsg');
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');
  const toast = document.getElementById('toast');

  let disabledSites = [];

  // ── Load saved settings ──────────────────────────────

  chrome.storage.sync.get({
    provider: 'digitalocean',
    apiKey: '',
    customEndpoint: '',
    customModel: '',
    writingStyle: 'neutral',
    disabledSites: []
  }, (data) => {
    providerSelect.value = data.provider;
    apiKeyInput.value = data.apiKey;
    customEndpointInput.value = data.customEndpoint;
    customModelInput.value = data.customModel;
    writingStyleSelect.value = data.writingStyle;
    disabledSites = data.disabledSites;

    updateProviderUI(data.provider);
    renderSites();
  });

  // ── Provider change ─────────────────────────────────

  providerSelect.addEventListener('change', () => {
    updateProviderUI(providerSelect.value);
  });

  function updateProviderUI(provider) {
    const info = PROVIDER_INFO[provider];

    // Show/hide custom fields
    customEndpointGroup.classList.toggle('hidden', provider !== 'custom');
    customModelGroup.classList.toggle('hidden', provider !== 'custom');

    // Update info display
    if (provider === 'custom') {
      infoEndpoint.textContent = customEndpointInput.value || '(not set)';
      infoModel.textContent = customModelInput.value || '(not set)';
    } else {
      infoEndpoint.textContent = info.endpoint;
      infoModel.textContent = info.model;
    }

    apiKeyHint.textContent = info.hint;
  }

  // Custom endpoint/model input updates
  customEndpointInput.addEventListener('input', () => {
    infoEndpoint.textContent = customEndpointInput.value || '(not set)';
  });
  customModelInput.addEventListener('input', () => {
    infoModel.textContent = customModelInput.value || '(not set)';
  });

  // ── Toggle key visibility ──────────────────────────

  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleKeyBtn.textContent = isPassword ? '🙈' : '👁️';
  });

  // ── Disabled sites ────────────────────────────────

  addSiteBtn.addEventListener('click', addSite);
  newSiteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSite();
  });

  function addSite() {
    let site = newSiteInput.value.trim().toLowerCase();
    if (!site) return;

    // Normalize — remove protocol and trailing slash
    site = site.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    if (!disabledSites.includes(site)) {
      disabledSites.push(site);
      renderSites();
    }

    newSiteInput.value = '';
  }

  function removeSite(site) {
    disabledSites = disabledSites.filter(s => s !== site);
    renderSites();
  }

  function renderSites() {
    sitesList.innerHTML = '';
    noSitesMsg.style.display = disabledSites.length === 0 ? 'block' : 'none';

    disabledSites.forEach(site => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${site}</span>
        <button class="remove-site" title="Remove">✕</button>
      `;
      li.querySelector('.remove-site').addEventListener('click', () => removeSite(site));
      sitesList.appendChild(li);
    });
  }

  // ── Save ─────────────────────────────────────────────

  saveBtn.addEventListener('click', () => {
    chrome.storage.sync.set({
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      customEndpoint: customEndpointInput.value,
      customModel: customModelInput.value,
      writingStyle: writingStyleSelect.value,
      disabledSites
    }, () => {
      showToast('Settings saved successfully!');
    });
  });

  // ── Reset ────────────────────────────────────────────

  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset all settings to defaults?')) return;

    providerSelect.value = 'digitalocean';
    apiKeyInput.value = '';
    customEndpointInput.value = '';
    customModelInput.value = '';
    writingStyleSelect.value = 'neutral';
    disabledSites = [];

    updateProviderUI('digitalocean');
    renderSites();

    chrome.storage.sync.set({
      provider: 'digitalocean',
      apiKey: '',
      customEndpoint: '',
      customModel: '',
      writingStyle: 'neutral',
      disabledSites: []
    }, () => {
      showToast('Settings reset to defaults.');
    });
  });

  // ── Toast ────────────────────────────────────────────

  function showToast(message) {
    toast.querySelector('.toast-text').textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }
});
