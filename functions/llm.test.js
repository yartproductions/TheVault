const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./llm');

test('provider choice follows Settings and the keys that are really set', () => {
  const both = { anthropic: 'sk-ant-abc', openai: 'sk-proj-xyz' };
  const onlyOpenai = { anthropic: 'none', openai: 'sk-proj-xyz' };
  assert.equal(L.pickProvider('auto', both), 'anthropic');
  assert.equal(L.pickProvider('auto', onlyOpenai), 'openai');
  assert.equal(L.pickProvider('openai', both), 'openai');
  assert.equal(L.pickProvider(undefined, onlyOpenai), 'openai');
  assert.throws(() => L.pickProvider('anthropic', onlyOpenai), /ANTHROPIC_API_KEY isn't set/);
  assert.throws(() => L.pickProvider('auto', { anthropic: 'none', openai: 'none' }), /No listing generator key/);
  assert.equal(L.keyLooksReal('openai', 'sk-ant-abc'), false);
});

test('OpenAI request carries the rulebook, search limit and cache key; parts can be dropped', () => {
  const b = L.openaiBody({ system: 'RULES', user: 'ITEM' }, 'gpt-5.4');
  assert.equal(b.instructions, 'RULES');
  assert.equal(b.input, 'ITEM');
  assert.deepEqual(b.tools, [{ type: 'web_search' }]);
  assert.equal(b.max_tool_calls, 4);
  assert.ok(b.prompt_cache_key);
  const bare = L.openaiBody({ system: 'R', user: 'I' }, 'gpt-5.4', { search: false, cacheKey: false });
  assert.equal(bare.tools, undefined);
  assert.equal(bare.prompt_cache_key, undefined);
  assert.equal(L.openaiRejected("Unknown parameter: 'prompt_cache_key'."), 'cacheKey');
  assert.equal(L.openaiRejected("Tool 'web_search' is not supported with this model."), 'search');
  assert.equal(L.openaiRejected('Invalid API key'), null);
});

test('OpenAI reply: text, lookups, cached tokens split out', () => {
  const reply = {
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: '<listing_json>{"a":1}</listing_json>' }] }
    ],
    usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 3000 }, output_tokens: 900 }
  };
  const r = L.parseOpenai(reply);
  assert.equal(r.text, '<listing_json>{"a":1}</listing_json>');
  assert.equal(r.searches, 2);
  assert.deepEqual(r.usage, { input_tokens: 2000, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 });
  assert.equal(r.incomplete, '');
  assert.equal(L.parseOpenai({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }).incomplete, 'max_output_tokens');
});

test('OpenAI cost, with unknown models marked as estimates', () => {
  const usage = { input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: 3000 };
  // 2000×2.5 + 3000×0.25 + 900×15 = 19,250 per million → $0.01925, plus 2 lookups $0.02
  assert.deepEqual(L.openaiCost(usage, 2, 'gpt-5.4'), { cost: 0.0393, estimate: false });
  assert.equal(L.openaiCost(usage, 0, 'some-new-model').estimate, true);
  assert.equal(L.modelFor('openai', ''), 'gpt-5.4');
  assert.equal(L.modelFor('openai', ' gpt-5.4-mini '), 'gpt-5.4-mini');
});
