// Judge of an AI eval run with TypeSafe Jev: yes/no questions about the WORDS of the AI replies that a
// rule cannot settle (does it ask back, in which language, is the closing line only a closing). Exact
// facts (status, 👍, message counts) stay with the eval script's rule checks.
// Usage: node e2e/eval-judge-jev.mjs <eval result.json> [--dry-run] [--baseline <judged.json>] [--out <f>]
// Reads the `conversations` that e2e/devbuild-resolution-eval.mjs --out saved; calls Jev through the
// user-level skill caller (key: Windows user variable TYPESAFE_API_KEY, never printed). --dry-run checks
// the requests without a key or network. A yes probability between LOW and HIGH is "unclear": the
// check then falls back to the eval's rule result and is listed, so a judge's doubt is visible.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [file] = args;
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!file) throw new Error('Usage: node e2e/eval-judge-jev.mjs <eval result.json> [--dry-run]');
const dryRun = args.includes('--dry-run');
const CALLER = join(homedir(), '.claude', 'skills', 'jev-decision', 'scripts', 'call_jev.py');
const LOW = 0.3;
const HIGH = 0.7;
const LANGUAGE = { en: 'English', ms: 'Malay', zh: 'Chinese' };

const run = JSON.parse(readFileSync(file, 'utf8'));
if (!run.conversations?.length) throw new Error('no conversations: re-run the eval with --out');
const ruleOk = new Map(run.rows.map((r) => [r.key, r.ok]));

/** The Jev questions for one conversation and the answer each needs to pass (true = yes). */
function questionsFor(c) {
  const lang = LANGUAGE[c.case.id.split('-')[0]] ?? 'the customer’s';
  const q = {
    asks_back: {
      want: c.switchOn,
      rule: `${c.key}/${c.switchOn ? 'answer asks back whether it answered' : 'answer has no check-in'}`,
      type: 'noul',
      instructions:
        'Does ai_answer end by asking the customer whether it answered their question or whether it helped (in any words or language)? A question about something else does not count.',
    },
    language: {
      want: true,
      type: 'noul',
      instructions: `Is ai_answer written in ${lang}, the language of customer_question?`,
    },
  };
  if (c.case.closes && c.switchOn)
    q.closing_only = {
      want: true,
      rule: `${c.key}/closes with one short closing line in words`,
      type: 'noul',
      instructions: `Is ai_after_closing exactly one short, polite closing line in ${lang} (for example glad it helped, you are welcome), with no question, no new offer and no new facts?`,
    };
  return q;
}

function stateFor(c) {
  return {
    business: 'A coffee shop answering customers on WhatsApp through an AI agent.',
    customer_question: c.case.question,
    ai_answer: c.answer,
    customer_closing: c.case.closing,
    ai_after_closing: c.after.length ? c.after : '(no text message)',
  };
}

function callJev(request) {
  const res = spawnSync('python', [CALLER, '--request', '-', ...(dryRun ? ['--dry-run'] : [])], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`Jev call failed: ${(res.stderr || res.stdout).trim()}`);
  return JSON.parse(res.stdout);
}

const rows = [];
let unclear = 0;
for (const c of run.conversations) {
  const questions = questionsFor(c);
  const request = {
    state: stateFor(c),
    model: process.env.TYPESAFE_MODEL ?? 'jev-latest',
    questions: Object.fromEntries(
      Object.entries(questions).map(([id, { type, instructions }]) => [id, { type, instructions }]),
    ),
  };
  const response = callJev(request);
  if (dryRun) {
    console.log(`DRY  ${c.key}: ${Object.keys(request.questions).join(', ')}`);
    continue;
  }
  for (const [id, spec] of Object.entries(questions)) {
    const yes = response.answers?.[id]?.noul;
    const key = `${c.key}/judge:${id}`;
    if (typeof yes !== 'number' || (yes > LOW && yes < HIGH)) {
      unclear++;
      const fallback = spec.rule ? ruleOk.get(spec.rule) : undefined;
      rows.push({
        key,
        ok: fallback ?? false,
        detail: `unclear p(yes)=${yes ?? '?'}; rule fallback`,
      });
      continue;
    }
    rows.push({ key, ok: yes >= HIGH === spec.want, detail: `p(yes)=${yes.toFixed(2)}` });
  }
}
if (dryRun) process.exit(0);

const all = [...run.rows, ...rows];
const passed = all.filter((r) => r.ok).length;
const score = Math.round((passed / all.length) * 100);
const baseline = flag('--baseline') ? JSON.parse(readFileSync(flag('--baseline'), 'utf8')) : null;
const was = new Map((baseline?.rows ?? []).map((r) => [r.key, r.ok]));
for (const r of rows) {
  const diff =
    !was.has(r.key) || was.get(r.key) === r.ok ? '' : r.ok ? '  ▲ fixed' : '  ▼ REGRESSED';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.key}  (${r.detail})${diff}`);
}
console.log(
  `Judged AI eval score: ${score}/100 (${passed}/${all.length}: ${run.rows.length} rule + ${rows.length} Jev checks, ${unclear} unclear)` +
    (baseline ? `; baseline ${baseline.score}/100` : ''),
);
if (flag('--out'))
  writeFileSync(flag('--out'), JSON.stringify({ score, judge: 'jev', rows: all }, null, 2));
