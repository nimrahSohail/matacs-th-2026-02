# Prototype

A small Node.js implementation of the design. It shows that the ranking in [../ranking.json](../ranking.json) comes from rules, not from opinion.

```
src/extract.js   AI step: builds the prompt from PROMPTS.md + criteria config, calls Claude, returns facts + quotes
src/guards.js    rules: manipulation scan, quote-in-document check, number-in-quote check, two-run comparison
src/score.js     rules: mandatory gates, weighted formulas, hard limits, ranking, one-line reasons
config/          admin-defined criteria (versioned data, nothing hard-coded)
fixtures/        expected extraction output for A–E (values only, no proposal text)
output/          audit record written by each run
test/            determinism, prompt/config sync, guard behaviour, criteria change
```

Requires Node.js 21 or newer.

## 1. Offline (no API key, no install)

Scores the fixture facts with the real scoring code:

```bash
cd prototype
node run.js                  # prints the ranking, writes output/run-report.json
node run.js --write-ranking  # also regenerates ../ranking.json
node --test                  # 12 tests
```

## 2. Live: run the prompt on the samples

1. `npm install`
2. Copy `../.env.example` to `../.env` and add your `ANTHROPIC_API_KEY`.
3. Create `samples/A.txt` … `samples/E.txt` and paste each sample proposal's text from the brief into it. Paste C's appendix note too, because that is the injection test. `samples/` is git-ignored, so the brief's text is never committed.
4. Run:

```bash
node run.js --live                 # one extraction per proposal, cached in cache/
node run.js --live --double-check  # extract twice, flag any disagreement
node run.js --live --no-cache      # force fresh AI calls
```

Live mode also verifies every quote against the text you pasted, so values the model can't support are discarded and flagged. The audit record is written to `output/run-report.live.json`. Live mode has not been run against the API in this repository; only offline mode and the tests have been executed.

## Changing criteria

Copy `config/commercial-solar.v1.json` to `v2`, change the weights or formulas, and run `node run.js --config config/commercial-solar.v2.json`. The extraction cache key includes the criteria version, and the report records which version produced each score.
