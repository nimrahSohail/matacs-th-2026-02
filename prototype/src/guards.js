// Rule-based safety checks that run around the AI step. Each returns flags in
// the same { code, message } shape the scorer uses.

// Phrases that try to steer an automated reviewer. This runs on the raw text
// before the AI sees it, so it still works if the model is fooled.
const INJECTION_PATTERNS = [
  /\b(note|message|instruction)s?\s+to\s+(the\s+)?(automated|ai|llm|review)\b/i,
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above|other)\b/i,
  /\brank\s+(it|this|us|this proposal)\s+(first|highest|#?1)\b/i,
  /\b(assign|give)\s+(it\s+|us\s+)?full\s+marks\b/i,
  /\bpre-?approved\b/i,
  /\b(system|developer)\s+prompt\b/i,
];

export function scanForInjection(text) {
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

export function injectionFlags(rawText, extraction) {
  const ruleHits = rawText ? scanForInjection(rawText) : [];
  const aiHits = extraction.embedded_instructions || [];
  if (!ruleHits.length && !aiHits.length) return [];
  const where = aiHits.map((h) => h.location).filter(Boolean).join(', ');
  return [{
    code: 'POSSIBLE_MANIPULATION',
    message: `contains text addressed to automated reviewers${where ? ` (${where})` : ''}, ignored for scoring`,
  }];
}

// --- Evidence checks (live mode only: needs the source text) ------------------

const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// Spellings a number can take in a quote: 238000, 238,000, 5M, 5 million, five.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function numberForms(n) {
  const forms = [String(n), n.toLocaleString('en-CA')];
  if (n >= 1e6 && n % 1e5 === 0) {
    const m = n / 1e6;
    forms.push(`${m}m`, `${m} million`, `$${m}m`);
  }
  if (Number.isInteger(n) && n < WORDS.length) forms.push(WORDS[n]);
  return forms.map((f) => f.toLowerCase());
}

export function verifyEvidence(extraction, sourceText, config) {
  const flags = [];
  const src = norm(sourceText);
  const types = Object.fromEntries(config.facts.map((f) => [f.id, f.type]));
  const derived = new Set(config.facts.filter((f) => f.derived).map((f) => f.id));

  for (const [id, f] of Object.entries(extraction.facts)) {
    if (f.value === null) continue;
    if (!f.quote) {
      flags.push({ code: 'UNVERIFIED', message: `${id}: value given without a supporting quote` });
      f.value = null; // never score an unsupported value
      continue;
    }
    if (!src.includes(norm(f.quote))) {
      flags.push({ code: 'UNVERIFIED', message: `${id}: quote not found in the document` });
      f.value = null;
      continue;
    }
    if ((types[id] === 'number' || types[id] === 'integer') && typeof f.value === 'number') {
      const q = norm(f.quote);
      if (!numberForms(f.value).some((form) => q.includes(form)) && !derived.has(id)) {
        flags.push({ code: 'UNVERIFIED', message: `${id}: value ${f.value} does not appear in its quote` });
        f.value = null;
      }
    }
  }
  return flags;
}

// Two independent extractions should agree. Disagreement means the text is
// ambiguous, so a person should look rather than the tool picking one.
export function compareRuns(a, b) {
  const flags = [];
  for (const id of Object.keys(a.facts)) {
    const va = a.facts[id]?.value ?? null;
    const vb = b.facts[id]?.value ?? null;
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      flags.push({ code: 'EXTRACTION_DISAGREES', message: `${id}: run 1 said ${JSON.stringify(va)}, run 2 said ${JSON.stringify(vb)}` });
    }
  }
  return flags;
}
