// The one AI step: turn a proposal's text into facts with supporting quotes.
// Prompts are read from PROMPTS.md so the documented prompt is the sent prompt.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROMPT_VERSION = 'extract-v1';
export const MODEL = 'claude-opus-5-5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadPrompts() {
  const md = readFileSync(path.join(ROOT, 'PROMPTS.md'), 'utf8');
  const block = (name) => {
    const m = md.match(new RegExp(`<!-- PROMPT:${name} -->\\s*\`\`\`text\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\s*<!-- /PROMPT:${name} -->`));
    if (!m) throw new Error(`Prompt block '${name}' not found in PROMPTS.md`);
    return m[1];
  };
  return { system: block('system'), user: block('user') };
}

export function renderFactList(config) {
  return config.facts.map((f) => `- ${f.id} (${f.type}): ${f.question}`).join('\n');
}

export function renderUserMessage(template, config, proposalId, text, evaluationYear) {
  const values = {
    CATEGORY_NAME: config.category_name,
    PROJECT_CONTEXT: config.project_context,
    EVALUATION_YEAR: String(evaluationYear),
    FACT_LIST: renderFactList(config),
    PROPOSAL_ID: proposalId,
    PROPOSAL_TEXT: text,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k]);
}

// Cache key: same document + same prompt + same criteria + same model gives
// the stored extraction instead of a new call. This is what makes a re-run
// return the identical result.
export function cacheKey(text, config) {
  return createHash('sha256')
    .update([PROMPT_VERSION, MODEL, config.category_id, config.version, text].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

async function buildSchema(config) {
  const { z } = await import('zod');
  const valueType = { boolean: () => z.boolean(), number: () => z.number(), integer: () => z.number().int(), string: () => z.string() };
  const facts = {};
  for (const f of config.facts) {
    facts[f.id] = z.object({
      value: valueType[f.type]().nullable(),
      quote: z.string().nullable(),
      note: z.string().nullable(),
    });
  }
  return z.object({
    proposal_id: z.string(),
    facts: z.object(facts),
    embedded_instructions: z.array(z.object({ quote: z.string(), location: z.string().nullable() })),
  });
}

export async function extractFacts({ client, config, proposalId, text, evaluationYear }) {
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const prompts = loadPrompts();
  const schema = await buildSchema(config);

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(schema) },
    system: prompts.system,
    messages: [{ role: 'user', content: renderUserMessage(prompts.user, config, proposalId, text, evaluationYear) }],
  });

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' || !response.parsed_output) {
    // Never guess: an extraction that did not complete sends the proposal to a person.
    return { failed: true, reason: `extraction did not complete (stop_reason: ${response.stop_reason})`, usage: response.usage };
  }
  return { failed: false, extraction: response.parsed_output, usage: response.usage };
}
