#!/usr/bin/env node
// Runs the triage pipeline on proposals A-E and prints the ranked list.
//
//   node run.js                     offline: uses fixtures/ (no API key needed)
//   node run.js --live              calls Claude on samples/*.txt
//   node run.js --live --double-check   extracts twice and flags disagreements
//   node run.js --write-ranking     also writes ../ranking.json

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateProposal, rankAll, toRankingJson } from './src/score.js';
import { injectionFlags, verifyEvidence, compareRuns } from './src/guards.js';
import { extractFacts, cacheKey, PROMPT_VERSION, MODEL } from './src/extract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const live = flag('--live');
const doubleCheck = flag('--double-check');
const configPath = path.resolve(HERE, opt('--config', 'config/commercial-solar.v1.json'));
const evaluationYear = Number(opt('--eval-year', '2026'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const weightSum = config.weighted.reduce((a, c) => a + c.weight, 0);
if (weightSum !== 100) throw new Error(`Criteria weights add to ${weightSum}, not 100`);

function emptyExtraction(id) {
  return { proposal_id: id, facts: Object.fromEntries(config.facts.map((f) => [f.id, { value: null, quote: null }])), embedded_instructions: [] };
}

async function liveExtraction(id, text, client) {
  mkdirSync(path.join(HERE, 'cache'), { recursive: true });
  const key = cacheKey(text, config);
  const cacheFile = path.join(HERE, 'cache', `${key}.json`);
  if (existsSync(cacheFile) && !flag('--no-cache')) {
    return { ...JSON.parse(readFileSync(cacheFile, 'utf8')), from_cache: true };
  }
  const first = await extractFacts({ client, config, proposalId: id, text, evaluationYear });
  const out = { cache_key: key, runs: [first] };
  if (doubleCheck && !first.failed) out.runs.push(await extractFacts({ client, config, proposalId: id, text, evaluationYear }));
  writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const records = [];
  let client = null;

  if (live) {
    try { process.loadEnvFile(path.join(HERE, '..', '.env')); } catch { /* .env is optional */ }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }

  for (const id of ids) {
    let extraction, rawText = null, guardFlags = [], audit = {};

    if (live) {
      const file = path.join(HERE, 'samples', `${id}.txt`);
      if (!existsSync(file)) throw new Error(`Missing ${file}. See prototype/README.md.`);
      rawText = readFileSync(file, 'utf8');
      const res = await liveExtraction(id, rawText, client);
      audit = { input_sha256: sha(rawText), cache_key: res.cache_key, from_cache: !!res.from_cache, usage: res.runs.map((r) => r.usage) };
      if (res.runs[0].failed) {
        extraction = emptyExtraction(id);
        guardFlags.push({ code: 'EXTRACTION_FAILED', message: res.runs[0].reason });
      } else {
        extraction = structuredClone(res.runs[0].extraction);
        extraction.proposal_id = id;
        if (res.runs[1] && !res.runs[1].failed) guardFlags.push(...compareRuns(res.runs[0].extraction, res.runs[1].extraction));
        guardFlags.push(...verifyEvidence(extraction, rawText, config));
      }
    } else {
      const fixture = readFileSync(path.join(HERE, 'fixtures', `${id}.json`), 'utf8');
      extraction = JSON.parse(fixture);
      audit = { input_sha256: sha(fixture), source: `fixtures/${id}.json` };
    }

    guardFlags.push(...injectionFlags(rawText, extraction));
    const evaluation = evaluateProposal(config, extraction, { evaluationYear, guardFlags });
    records.push({ extraction, evaluation, audit });
  }

  const results = rankAll(records.map((r) => r.evaluation));
  const ranking = toRankingJson(results);

  // Audit record: everything needed to explain or reproduce this run.
  const report = {
    run_id: randomUUID(),
    generated_at: new Date().toISOString(),
    mode: live ? 'live' : 'fixtures',
    category: { id: config.category_id, criteria_version: config.version, criteria_sha256: sha(JSON.stringify(config)) },
    prompt_version: live ? PROMPT_VERSION : null,
    model: live ? MODEL : null,
    evaluation_year: evaluationYear,
    status_note: 'Machine recommendation only. A reviewer must confirm, override or resolve each item before award.',
    ranking,
    proposals: Object.fromEntries(records.map((r) => [r.evaluation.proposal, {
      audit: r.audit,
      extracted_facts: r.extraction.facts,
      embedded_instructions: r.extraction.embedded_instructions,
      evaluation: results.find((x) => x.proposal === r.evaluation.proposal),
    }])),
    reviewer_actions: [],
  };

  mkdirSync(path.join(HERE, 'output'), { recursive: true });
  const outFile = path.join(HERE, 'output', live ? 'run-report.live.json' : 'run-report.json');
  writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  if (flag('--write-ranking')) writeFileSync(path.join(HERE, '..', 'ranking.json'), JSON.stringify(ranking, null, 2) + '\n');

  console.log(`\n${config.category_name} (criteria v${config.version}), ${report.mode} mode\n`);
  for (const r of results) {
    const rank = r.rank ? `#${r.rank}` : '--';
    const score = r.score === null ? '  -  ' : r.score.toFixed(1).padStart(5);
    console.log(`${rank.padEnd(3)} ${r.proposal}  ${r.status.padEnd(10)} ${score}  ${r.reason}`);
  }
  console.log(`\nFull audit record: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
