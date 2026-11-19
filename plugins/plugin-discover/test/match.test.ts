import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Catalog } from '../src/catalog.ts';
import { advisorCommands, match, score, shellQuote, stem, terms, THRESHOLD } from '../src/match.ts';
import { sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

function m(task: string, t = s): Record<string, any> {
  const { code, stdout, stderr } = t.call(['match', task, '--json']);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('terms drop stop words and generic words, split identifiers and stem', () => {
  assert.deepEqual(terms('Please list_events for the autologger Sessions, logged events'), ['list', 'event', 'session', 'log', 'event']);
  assert.deepEqual(['dashboards', 'studies', 'running', 'logged', 'status', 'access'].map(stem), ['dashboard', 'study', 'run', 'log', 'status', 'access']);
});

test('score: autologger terms weigh more, name terms double, phrases add a bonus', () => {
  assert.deepEqual(score(['pdf'], 'tools', 'merge pdf files'), { score: 1, matched: ['pdf'] });
  assert.deepEqual(score(['session'], 'tools', 'session data'), { score: 2, matched: ['session'] });
  assert.deepEqual(score(['session'], 'session-tools', 'data'), { score: 4, matched: ['session'] });
  assert.deepEqual(score(['dev', 'stack'], 'x', 'a local dev stack'), { score: 6, matched: ['dev', 'stack', '"dev stack"'] });
  assert.deepEqual(score(['stack', 'dev'], 'x', 'a local dev stack'), { score: 4, matched: ['stack', 'dev'] });
});

test('ranking: an installed plugin that fits comes first, with its best skill and the reason', () => {
  const r = m('list the logged events and transcript of yesterday\'s session');
  assert.equal(r.none_applicable, false);
  assert.equal(r.installed[0].name, 'autologger-mcp');
  assert.equal(r.installed[0].id, 'autologger-mcp@autologger-marketplace');
  assert.equal(r.installed[0].skill, 'query-session-data');
  assert.equal(r.installed[0].kind, 'plugin');
  assert.ok(r.installed[0].score >= THRESHOLD);
  assert.deepEqual(r.installed[0].reason.slice(0, 4), ['log', 'event', 'transcript', 'session']);
  for (let i = 1; i < r.installed.length; i++) assert.ok(r.installed[i - 1].score >= r.installed[i].score);
  assert.equal(r.advisor, undefined);
});

test('write tasks pick the write skill', () => {
  assert.equal(m('delete a topic and update a wiki page').installed[0].skill, 'write-session-data');
});

test('available: a fitting marketplace plugin that is not installed comes with its install command', () => {
  const r = m('bring up the local dev stack with https and openbao');
  assert.deepEqual(r.installed.filter((e: { name: string }) => e.name.startsWith('autologger-dev')), []);
  assert.equal(r.available[0].name, 'autologger-dev');
  assert.equal(r.available[0].installCommand, 'claude plugin install autologger-dev@autologger-marketplace');
  assert.deepEqual(r.available[0].reason.slice(0, 6), ['bring', 'local', 'dev', 'stack', 'http', 'openbao']);
  assert.equal(r.none_applicable, false);
});

test('installed and available split: once installed, a plugin moves from available to installed', () => {
  const t = sandbox({ installed: ['autologger-dev', 'plugin-discover'] });
  try {
    const r = m('bring up the local dev stack with https and openbao', t);
    assert.equal(r.installed[0].name, 'autologger-dev');
    assert.ok(!r.available.some((e: { name: string }) => e.name === 'autologger-dev'));
  } finally {
    t.cleanup();
  }
});

test('disabled plugins still rank, marked enabled: false', () => {
  const r = m('which spec is stale against the specs-with-code gate');
  assert.equal(r.installed[0].name, 'autologger-specs');
  assert.equal(r.installed[0].enabled, false);
});

test('user skills and other marketplaces rank too; plugin-discover never ranks itself', () => {
  assert.deepEqual(m('merge two pdf files and extract pages').installed.map((e: { name: string }) => e.name), ['other-tools']);
  const web = m('take a screenshot of a website and fill forms');
  assert.equal(web.installed[0].kind, 'user-skill');
  assert.equal(web.installed[0].name, 'web-browse');
  const self = m('find the installed plugin or skill that fits an autologger task, offers to install a marketplace plugin');
  assert.ok(!self.installed.some((e: { name: string }) => e.name === 'plugin-discover'));
});

test('threshold: nothing at or above it means none_applicable, with the plugin-advisor record command', () => {
  const r = m('fix a flaky react component test');
  assert.deepEqual([r.installed, r.available, r.none_applicable, r.threshold], [[], [], true, THRESHOLD]);
  const advisorRoot = `${s.claudeDir}/plugins/cache/autologger-marketplace/plugin-advisor/0.1.0`;
  assert.equal(
    r.advisor.record,
    `npx --yes --offline --loglevel=error --package='${advisorRoot}' -- plugin-advisor record --plugin none --kind missing-guidance --summary 'no installed or marketplace plugin fits: fix a flaky react component test' --json`,
  );
  assert.equal(r.advisor.suggest, `npx --yes --offline --loglevel=error --package='${advisorRoot}' -- plugin-advisor suggest --json`);
  // One plain shared word scores 1: below the threshold.
  assert.equal(m('pdf').none_applicable, true);
  assert.match(s.call(['match', 'fix a flaky react component test']).stdout, /Nothing scores 3 or more[\s\S]*plugin-advisor record --plugin none --kind missing-guidance/);
});

test('no advisor line when plugin-advisor is not installed, or disabled', () => {
  const t = sandbox({ installed: ['autologger-mcp'] });
  const u = sandbox({}, {});
  try {
    assert.equal(m('fix a flaky react component test', t).advisor, undefined);
    const catalog = JSON.parse(u.call(['catalog', '--json']).stdout) as Catalog;
    for (const p of catalog.installed) if (p.name === 'plugin-advisor') p.enabled = false;
    assert.equal(match(catalog, 'fix a flaky react component test').advisor, undefined);
  } finally {
    t.cleanup();
    u.cleanup();
  }
});

test('the advisor command quotes the task for the shell and caps its length', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const a = advisorCommands('/p q', `don't ${'x'.repeat(300)}`);
  assert.match(a.record, /--package='\/p q' -- plugin-advisor record/);
  assert.match(a.record, /--summary 'no installed or marketplace plugin fits: don'\\''t x+\.\.\.' --json$/);
  assert.ok(a.record.length < 400);
});

test('deterministic: the same input gives the same output', () => {
  assert.deepEqual(m('sign in to autologger with oauth'), m('sign in to autologger with oauth'));
});

test('match needs task text', () => {
  const r = s.call(['match', '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /match needs a one-line task summary/);
});

test('match reports the mode; with mode off it never lists available plugins', () => {
  const t = sandbox();
  try {
    assert.equal(m('bring up the local dev stack with https', t).mode, 'ask');
    t.call(['settings', 'set', 'mode', 'off']);
    const r = m('bring up the local dev stack with https', t);
    assert.equal(r.mode, 'off');
    assert.deepEqual(r.available, []);
    t.call(['settings', 'set', 'mode', 'notify']);
    assert.equal(m('bring up the local dev stack with https', t).available[0].name, 'autologger-dev');
  } finally {
    t.cleanup();
  }
});
