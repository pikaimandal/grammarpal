/**
 * GrammarPal AI Service
 * Unified AI provider supporting DigitalOcean Gradient, OpenAI, and Anthropic.
 */

const DEFAULT_PROVIDER = 'digitalocean';
const DEFAULT_API_KEY = 'YOUR_DIGITALOCEAN_API_KEY_HERE'; // Replace with your DigitalOcean Gradient AI key

const PROVIDERS = {
  digitalocean: {
    name: 'DigitalOcean Gradient AI',
    endpoint: 'https://inference.do-ai.run/v1/chat/completions',
    model: 'openai-gpt-oss-120b',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    buildBody: (model, messages) => ({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 2048
    }),
    parseResponse: (data) => data.choices?.[0]?.message?.content
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    buildBody: (model, messages) => ({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 2048
    }),
    parseResponse: (data) => data.choices?.[0]?.message?.content
  },
  anthropic: {
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-latest',
    authHeader: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    }),
    buildBody: (model, messages) => ({
      model,
      max_tokens: 2048,
      messages: messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role,
        content: m.content
      })),
      system: messages.find(m => m.role === 'system')?.content || ''
    }),
    parseResponse: (data) => data.content?.[0]?.text
  },
  custom: {
    name: 'Custom Provider',
    endpoint: '',
    model: '',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    buildBody: (model, messages) => ({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 2048
    }),
    parseResponse: (data) => data.choices?.[0]?.message?.content
  }
};

const SYSTEM_PROMPT = `You are GrammarPal, an expert writing assistant. Analyze the given text and return a JSON response with corrections and analysis.

IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks, no extra text.

Response format:
{
  "corrections": [
    {
      "original": "exact text with error",
      "corrected": "corrected text",
      "type": "grammar|spelling|punctuation|clarity",
      "explanation": "brief explanation"
    }
  ],
  "tone": "formal|casual|friendly|academic|neutral",
  "clarity_score": 85,
  "overall_score": 78,
  "summary": "Brief overall assessment of the writing"
}

Rules:
- "original" must be an exact substring from the input text
- "type" must be one of: grammar, spelling, punctuation, clarity
- "clarity_score" and "overall_score" are 0-100
- If no errors found, return empty corrections array
- Keep explanations concise (under 15 words)
- Be thorough but avoid false positives`;

/**
 * Get the current AI configuration from storage
 */
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      provider: DEFAULT_PROVIDER,
      apiKey: '',
      customEndpoint: '',
      customModel: '',
      writingStyle: 'neutral'
    }, (result) => {
      resolve(result);
    });
  });
}

/**
 * Analyze text using the configured AI provider
 */
async function analyzeText(text) {
  if (!text || text.trim().length < 5) {
    return { corrections: [], tone: 'neutral', clarity_score: 100, overall_score: 100, summary: 'Too short to analyze.' };
  }

  const config = await getConfig();
  const providerKey = config.provider || DEFAULT_PROVIDER;
  const provider = PROVIDERS[providerKey];

  if (!provider) {
    throw new Error(`Unknown provider: ${providerKey}`);
  }

  const apiKey = config.apiKey || (providerKey === 'digitalocean' ? DEFAULT_API_KEY : '');
  if (!apiKey || apiKey === 'YOUR_DIGITALOCEAN_API_KEY_HERE') {
    throw new Error('API key not configured. Please set your API key in GrammarPal settings.');
  }

  const endpoint = providerKey === 'custom' ? config.customEndpoint : provider.endpoint;
  const model = providerKey === 'custom' ? config.customModel : provider.model;

  if (!endpoint) {
    throw new Error('API endpoint not configured.');
  }

  const styleInstruction = config.writingStyle !== 'neutral'
    ? `\nEvaluate the text assuming the intended writing style is: ${config.writingStyle}.`
    : '';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + styleInstruction },
    { role: 'user', content: `Analyze this text:\n\n${text}` }
  ];

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...provider.authHeader(apiKey)
      },
      body: JSON.stringify(provider.buildBody(model, messages))
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${errorBody || response.statusText}`);
    }

    const data = await response.json();
    const content = provider.parseResponse(data);

    if (!content) {
      throw new Error('Empty response from AI provider.');
    }

    // Parse the JSON response, handling potential markdown code blocks
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(cleaned);

    // Validate and sanitize
    return {
      corrections: Array.isArray(result.corrections) ? result.corrections.map(c => ({
        original: String(c.original || ''),
        corrected: String(c.corrected || ''),
        type: ['grammar', 'spelling', 'punctuation', 'clarity'].includes(c.type) ? c.type : 'grammar',
        explanation: String(c.explanation || '')
      })) : [],
      tone: String(result.tone || 'neutral'),
      clarity_score: Math.min(100, Math.max(0, parseInt(result.clarity_score) || 0)),
      overall_score: Math.min(100, Math.max(0, parseInt(result.overall_score) || 0)),
      summary: String(result.summary || '')
    };

  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Failed to parse AI response. The model returned invalid JSON.');
    }
    throw error;
  }
}

// Export for use in background.js (service worker module)
export { analyzeText, getConfig, PROVIDERS, DEFAULT_PROVIDER };
