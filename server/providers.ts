import { apiKey, cloudModels, model as deepInfraModel, ollamaUrl } from './config';

export type ProviderId = 'deepinfra' | 'ollama';
export interface Target { provider: ProviderId; model: string }
/** US dollars per million tokens. */
export interface Price { input: number; output: number }
export interface ModelList {
  deepinfra: { configured: boolean; models: string[]; prices: Record<string, Price> };
  ollama: { available: boolean; url: string; models: string[] };
}

// Prices come from DeepInfra's public catalogue (no key), read once per run so the picker never shows a
// figure typed in by hand that has since changed. A model the catalogue marks deprecated is dropped.
let catalogue: Promise<{ prices: Record<string, Price>; gone: Set<string> }> | null = null;
export function deepInfraCatalogue(fetcher: typeof fetch = fetch) {
  catalogue ??= fetcher('https://api.deepinfra.com/models/list', { signal: AbortSignal.timeout(10_000) })
    .then(response => response.ok ? response.json() : [])
    .then((list: any[]) => {
      const prices: Record<string, Price> = {};
      const gone = new Set<string>();
      for (const entry of Array.isArray(list) ? list : []) {
        const name = String(entry?.model_name || '');
        if (!cloudModels.includes(name)) continue;
        if (entry.deprecated) gone.add(name);
        const input = Number(entry.pricing?.cents_per_input_token), output = Number(entry.pricing?.cents_per_output_token);
        // cents per token → dollars per million tokens
        if (Number.isFinite(input) && Number.isFinite(output)) prices[name] = { input: Math.round(input * 1e6) / 100, output: Math.round(output * 1e6) / 100 };
      }
      return { prices, gone };
    })
    .catch(() => { catalogue = null; return { prices: {}, gone: new Set<string>() }; });
  return catalogue;
}

// DeepInfra switches reasoning differently per family. Qwen3 and DeepSeek reason only when asked here;
// Gemma 4 with reasoning on loops until max_tokens and returns broken JSON, so it is never asked.
export function reasoningSwitch(model: string, think: boolean): Record<string, unknown> {
  if (model.startsWith('Qwen/')) return { chat_template_kwargs: { enable_thinking: think } };
  if (model.startsWith('deepseek-ai/')) return { chat_template_kwargs: { thinking: think } };
  return {};
}

// Local models are read from the machine, not from a fixed list, so a fresh `ollama pull` shows up.
export async function ollamaModels(timeout = 1500): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return [];
    const json: any = await response.json();
    return (json.models || []).map((m: any) => String(m.name)).filter(Boolean);
  } catch { return []; }
}

export async function listModels(): Promise<ModelList> {
  const none = { prices: {}, gone: new Set<string>() };
  // Every request lists models, so the catalogue may not hold one up: past 1.5s it is skipped this time and
  // keeps loading for the next.
  const priced = apiKey ? Promise.race([deepInfraCatalogue(), new Promise<typeof none>(done => setTimeout(done, 1500, none))]) : none;
  const [local, { prices, gone }] = await Promise.all([ollamaModels(), priced]);
  return {
    deepinfra: { configured: Boolean(apiKey), models: apiKey ? cloudModels.filter(m => m === deepInfraModel || !gone.has(m)) : [], prices },
    ollama: { available: local.length > 0, url: ollamaUrl, models: local },
  };
}

export function defaultTarget(models: ModelList): Target {
  if (apiKey) return { provider: 'deepinfra', model: deepInfraModel };
  if (models.ollama.models.length) return { provider: 'ollama', model: models.ollama.models[0] };
  return { provider: 'deepinfra', model: deepInfraModel };
}

export function resolveTarget(requested: any, models: ModelList): Target {
  const provider: ProviderId = requested?.provider === 'ollama' ? 'ollama' : 'deepinfra';
  const wanted = typeof requested?.model === 'string' ? requested.model : '';
  if (provider === 'ollama') {
    if (!models.ollama.available) throw new Error(`Ollama is not answering at ${ollamaUrl}. Start it with "ollama serve", then rescan.`);
    if (wanted && !models.ollama.models.includes(wanted)) throw new Error(`Ollama has no model called ${wanted}. Run "ollama pull ${wanted}" or pick another.`);
    return { provider, model: wanted || models.ollama.models[0] };
  }
  if (!apiKey) throw new Error('Add your DeepInfra key to .env.local, or switch to a local Ollama model.');
  return { provider, model: wanted || deepInfraModel };
}

// Plain text, for anything that is prose rather than structured data.
export async function completeText(target: Target, messages: unknown[], signal: AbortSignal, fetcher: typeof fetch = fetch, options: { temperature?: number } = {}): Promise<string> {
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
  if (target.provider === 'ollama') {
    const response = await fetcher(`${ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model: target.model, stream: false, options: { temperature, num_predict: 400 }, messages }),
    }).catch((error: any) => { throw new Error(`Ollama could not answer (${String(error?.cause?.code || error?.message).slice(0, 60)}).`); });
    if (!response.ok) throw new Error(`The local model could not answer (${response.status}).`);
    const json: any = await response.json();
    const content = json.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('The local model returned nothing.');
    return content.trim();
  }
  const response = await fetcher('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model: target.model, temperature, max_tokens: 400, stream: false, messages }),
  });
  if (!response.ok) throw new Error(deepInfraError(response.status));
  const json: any = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepInfra returned nothing.');
  return content.trim();
}

const deepInfraError = (status: number) => {
  if (status === 401 || status === 403) return 'DeepInfra did not accept the API key. Update .env.local and restart Cue.';
  if (status === 429) return 'DeepInfra is busy or the account has reached its limit. Try again shortly.';
  return `DeepInfra could not answer right now (${status}). Try again.`;
};

export async function completeJson(target: Target, messages: unknown[], schema: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch, options: { temperature?: number; think?: boolean } = {}): Promise<string> {
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
  if (target.provider === 'ollama') {
    let response: Response;
    try {
      response = await fetcher(`${ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model: target.model, stream: false, format: schema, options: { temperature, num_predict: 2000 }, messages }),
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      // A model that fails to load can drop the socket; report the cause instead of blaming the server.
      const cause = error?.cause?.code || error?.cause?.message || error?.message || 'unknown error';
      throw new Error(`Ollama could not answer (${String(cause).slice(0, 80)}). Check "ollama serve" and that ${target.model} runs with "ollama run ${target.model}".`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 404) throw new Error(`Ollama has no model called ${target.model}. Run "ollama pull ${target.model}".`);
      throw new Error(`The local model could not answer (${response.status}). ${detail.slice(0, 120)}`.trim());
    }
    const json: any = await response.json();
    const content = json.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('The local model returned an empty answer. Try a smaller model or a shorter question.');
    return content;
  }
  const response = await fetcher('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model: target.model, temperature, max_tokens: options.think ? 8000 : 2500, stream: false,
      ...reasoningSwitch(target.model, Boolean(options.think)),
      response_format: { type: 'json_schema', json_schema: { name: 'video_answer', strict: true, schema } },
      messages }),
  });
  if (!response.ok) throw new Error(deepInfraError(response.status));
  const json: any = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('DeepInfra returned no answer. Try again.');
  return content;
}
