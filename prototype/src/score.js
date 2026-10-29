// Deterministic scoring. No AI here: every number comes from the admin's
// criteria config applied to extracted facts, so the same facts always give
// the same result.

const round1 = (n) => Math.round(n * 10) / 10;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString('en-CA') : String(n));

function factValue(extraction, id) {
  const f = extraction.facts[id];
  return f ? f.value : null;
}

// --- Mandatory gates: pass / fail / unclear ---------------------------------

function checkGate(gate, extraction) {
  const problems = [];
  let result = 'pass';
  for (const c of gate.checks) {
    const v = factValue(extraction, c.fact);
    if (v === null || v === undefined) {
      result = result === 'fail' ? 'fail' : 'unclear';
      problems.push(`${c.fact} not stated`);
      continue;
    }
    const ok = c.op === 'is_true' ? v === true : c.op === 'gte' ? v >= c.value : false;
    if (!ok) {
      result = 'fail';
      problems.push(c.fail_message);
    }
  }
  return { id: gate.id, label: gate.label, result, problems };
}

// --- Weighted criteria: each rule returns a 0-100 score or null if missing ---

function linear(rule, extraction) {
  const v = factValue(extraction, rule.fact);
  if (v === null || v === undefined) return { score: null, missing: [rule.fact] };
  const s = clamp01((v - rule.zero_at) / (rule.full_at - rule.zero_at)) * 100;
  const shown = rule.unit === 'CAD' ? `$${fmt(v)}` : `${fmt(v)} ${rule.unit}`;
  const out = { score: s, missing: [], explanation: shown };
  if (rule.hard_limit && rule.hard_limit.max !== undefined && v > rule.hard_limit.max) {
    out.breach = rule.hard_limit.message;
  }
  return out;
}

function average(rule, extraction) {
  const parts = rule.parts.map((p) => applyRule(p, extraction));
  const missing = parts.flatMap((p) => p.missing);
  if (missing.length) return { score: null, missing };
  const score = parts.reduce((a, p) => a + p.score, 0) / parts.length;
  return { score, missing: [], explanation: parts.map((p) => p.explanation).join(' + ') };
}

function checklist(rule, extraction) {
  // An unstated checklist item counts as absent, not missing: the admin asked
  // for these to be in the proposal, so silence means the bidder did not offer it.
  const have = rule.items.filter((i) => factValue(extraction, i.fact) === true);
  const lacking = rule.items.filter((i) => factValue(extraction, i.fact) !== true);
  return {
    score: (have.length / rule.items.length) * 100,
    missing: [],
    explanation:
      `${have.length}/${rule.items.length} items` +
      (lacking.length ? `, no ${lacking.map((i) => i.label).join(', no ')}` : ''),
  };
}

function applyRule(rule, extraction) {
  switch (rule.type) {
    case 'linear': return linear(rule, extraction);
    case 'average': return average(rule, extraction);
    case 'checklist': return checklist(rule, extraction);
    default: throw new Error(`Unknown rule type: ${rule.type}`);
  }
}

// --- One proposal ------------------------------------------------------------

export function evaluateProposal(config, extraction, ctx) {
  const flags = [...(ctx.guardFlags || [])];
  const gates = config.mandatory.map((g) => checkGate(g, extraction));
  const breaches = [];
  const raw = []; // unrounded criterion scores, so totals are not affected by display rounding

  const criteria = config.weighted.map((c) => {
    const r = applyRule(c.rule, extraction);
    if (r.breach) breaches.push(r.breach);
    if (r.score === null) {
      const notes = r.missing.map((id) => extraction.facts[id]?.note).filter(Boolean);
      flags.push({
        code: 'MISSING_FACT',
        message: `no ${c.label.toLowerCase()} value to score` + (notes.length ? ` (${notes.join(' ').replace(/\.$/, '')})` : ''),
      });
    }
    raw.push(r.score);
    return {
      id: c.id, label: c.label, weight: c.weight,
      score: r.score === null ? null : round1(r.score),
      points: r.score === null ? null : round1((r.score * c.weight) / 100),
      explanation: r.explanation || 'not stated',
    };
  });

  for (const fr of config.flag_rules || []) {
    if (fr.type === 'year_window') {
      const v = factValue(extraction, fr.fact);
      if (v !== null && v !== undefined && v < ctx.evaluationYear - fr.years) {
        flags.push({ code: 'CHECK_EVIDENCE', message: fr.message });
      }
    }
  }
  for (const g of gates.filter((g) => g.result === 'unclear')) {
    flags.push({ code: 'MANDATORY_UNCLEAR', message: `${g.label}: ${g.problems.join('; ')}` });
  }

  const failed = gates.filter((g) => g.result === 'fail');
  const complete = criteria.every((c) => c.score !== null);
  const total = complete ? round1(criteria.reduce((a, c, i) => a + (raw[i] * c.weight) / 100, 0)) : null;

  // Range a flagged proposal could reach once the missing facts are known.
  const known = criteria.reduce((a, c, i) => a + (raw[i] === null ? 0 : (raw[i] * c.weight) / 100), 0);
  const unknownWeight = criteria.filter((c) => c.score === null).reduce((a, c) => a + c.weight, 0);
  const range = complete ? null : { min: round1(known), max: round1(known + unknownWeight) };

  let status = 'ranked';
  if (failed.length || breaches.length) status = 'ineligible';
  else if (flags.length) status = 'flagged';

  return {
    proposal: extraction.proposal_id,
    status,
    score: status === 'ineligible' ? null : total,
    possible_range: status === 'ineligible' ? null : range,
    mandatory: gates,
    criteria,
    breaches,
    flags,
  };
}

// --- Whole set: sort, assign ranks, write one-line reasons --------------------

function strengthsAndGaps(e) {
  const scored = e.criteria.filter((c) => c.score !== null);
  const byScore = [...scored].sort((a, b) => b.score - a.score || b.weight - a.weight);
  const top = byScore.filter((c) => c.score === 100).slice(0, 2);
  const best = top.length ? top : byScore.slice(0, 1);
  const weakest = byScore[byScore.length - 1];
  const s = (c) => `${c.label.toLowerCase()} ${Math.round(c.score)} (${c.explanation})`;
  return `strongest: ${best.map(s).join(', ')}; weakest: ${s(weakest)}`;
}

function reasonFor(e, rank, next) {
  if (e.status === 'ineligible') {
    const why = [
      ...e.mandatory.filter((g) => g.result === 'fail').map((g) => `fails mandatory '${g.label}': ${g.problems.join('; ')}`),
      ...e.breaches,
    ];
    return `Ineligible, ${why.join('; ')}. Not scored; reviewer confirms before the bidder is excluded.`;
  }
  if (e.status === 'flagged') {
    const msgs = e.flags.map((f) => f.message).join('; ');
    const sc = e.score !== null
      ? `Scores ${e.score} on the stated facts, held out of the ranking until a reviewer clears it`
      : `Would score ${e.possible_range.min}-${e.possible_range.max} depending on the missing fact; needs bidder clarification before ranking`;
    return `Flagged for review: ${msgs}. ${sc}.`;
  }
  const lead = next ? `, ${round1(e.score - next.score)} pts ahead of next` : '';
  return `Rank ${rank} at ${e.score}/100${lead}; passes both mandatory checks; ${strengthsAndGaps(e)}.`;
}

export function rankAll(evaluations) {
  // Tie-break is deterministic: score, then score on the highest-weight
  // criterion, then proposal letter.
  const ranked = evaluations
    .filter((e) => e.status === 'ranked')
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const wa = [...a.criteria].sort((x, y) => y.weight - x.weight)[0];
      const wb = [...b.criteria].sort((x, y) => y.weight - x.weight)[0];
      if (wb.score !== wa.score) return wb.score - wa.score;
      return a.proposal.localeCompare(b.proposal);
    });
  const order = { flagged: 1, ineligible: 2 };
  const rest = evaluations
    .filter((e) => e.status !== 'ranked')
    .sort((a, b) => order[a.status] - order[b.status] || a.proposal.localeCompare(b.proposal));

  return [
    ...ranked.map((e, i) => ({ ...e, rank: i + 1, reason: reasonFor(e, i + 1, ranked[i + 1]) })),
    ...rest.map((e) => ({ ...e, rank: null, reason: reasonFor(e, null) })),
  ];
}

export function toRankingJson(results) {
  return results.map((r) => ({
    proposal: r.proposal,
    rank: r.rank,
    status: r.status,
    score: r.score,
    reason: r.reason,
  }));
}
