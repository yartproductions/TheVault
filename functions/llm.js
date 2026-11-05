// Listing generator providers: Anthropic (Claude) or OpenAI. Pure helpers, tested in llm.test.js.
// Both get the same rulebook prompt and must return the same <listing_json> output, so
// everything after the model call (checks, HTML, metafields) is shared.

const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.4' };

// USD per million tokens; search is per lookup. Unknown OpenAI models fall back to the
// default model's prices and the cost is marked as an estimate.
const OPENAI_PRICES = {
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 }
};
const OPENAI_SEARCH = 0.01;

// A key is usable only if it looks like a real key for that provider (a placeholder such as
// "none" lets the functions deploy before the key exists).
const keyLooksReal = (provider, key) => {
  const k = String(key || '').trim();
  if (provider === 'anthropic') return /^sk-ant-/.test(k);
  if (provider === 'openai') return /^sk-/.test(k) && !/^sk-ant-/.test(k);
  return false;
};

// Settings choice: 'anthropic', 'openai' or 'auto' (Claude if its key is set, else OpenAI).
function pickProvider(choice, keys) {
  const has = p => keyLooksReal(p, keys[p]);
  if (choice === 'anthropic' || choice === 'openai') {
    if (has(choice)) return choice;
    const name = choice === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(`The listing generator is set to ${choice === 'anthropic' ? 'Claude' : 'OpenAI'}, but ${name} isn't set. Add it with: npx firebase-tools functions:secrets:set ${name} — or switch the provider in Settings.`);
  }
  if (has('anthropic')) return 'anthropic';
  if (has('openai')) return 'openai';
  throw new Error('No listing generator key is set. Add one with: npx firebase-tools functions:secrets:set OPENAI_API_KEY (or ANTHROPIC_API_KEY), then deploy functions.');
}

const modelFor = (provider, override) => String(override || '').trim() || DEFAULT_MODELS[provider];

// OpenAI Responses API request. The rulebook goes first and is identical every time, so
// OpenAI's automatic prompt caching applies to it; prompt_cache_key keeps listings on one cache.
function openaiBody({ system, user }, model, opts = {}) {
  const body = { model, instructions: system, input: user, max_output_tokens: 6000 };
  if (opts.search !== false) { body.tools = [{ type: 'web_search' }]; body.max_tool_calls = 4; }
  if (opts.cacheKey !== false) body.prompt_cache_key = 'syg-listing-rulebook';
  return body;
}

// Which optional part of the request a 400 complains about, so it can be dropped and retried.
function openaiRejected(message) {
  const m = String(message || '');
  if (/prompt_cache_key/i.test(m)) return 'cacheKey';
  if (/max_tool_calls|web_search|tool/i.test(m)) return 'search';
  return null;
}

// Text, lookups and token usage from a Responses API reply.
function parseOpenai(reply) {
  const out = (reply && reply.output) || [];
  let text = typeof reply.output_text === 'string' ? reply.output_text : '';
  if (!text) text = out.filter(o => o.type === 'message').flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
  const searches = out.filter(o => o.type === 'web_search_call').length;
  const u = reply.usage || {};
  const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  const usage = { input_tokens: Math.max(0, (u.input_tokens || 0) - cached), output_tokens: u.output_tokens || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached };
  const incomplete = reply.status === 'incomplete' ? ((reply.incomplete_details && reply.incomplete_details.reason) || 'incomplete') : '';
  return { text, searches, usage, incomplete };
}

function openaiCost(usage, searches, model) {
  const known = OPENAI_PRICES[model];
  const p = known || OPENAI_PRICES[DEFAULT_MODELS.openai];
  const u = usage || {};
  const usd = ((u.input_tokens || 0) * p.input + (u.cache_read_input_tokens || 0) * p.cached + (u.output_tokens || 0) * p.output) / 1e6 + (searches || 0) * OPENAI_SEARCH;
  return { cost: +usd.toFixed(4), estimate: !known };
}

module.exports = { DEFAULT_MODELS, OPENAI_PRICES, keyLooksReal, pickProvider, modelFor, openaiBody, openaiRejected, parseOpenai, openaiCost };
