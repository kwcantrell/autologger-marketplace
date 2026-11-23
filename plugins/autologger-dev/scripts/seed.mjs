#!/usr/bin/env node
// Seed an AutoLogger dev server with demo data through the public RPC API.
// Usage: node seed.mjs [baseUrl=http://localhost:5173] [email=owner@example.com]
// Needs DEV_LOGIN=1 on the server. Creates the "Smoke Team" team (the sandbox the browser-smoke,
// visual-review, bug-hunt and ui-designer agents write in), a show, and a session with a short
// transcript, events, topics, a dashboard and wiki pages, then prints the session URL.

const base = (process.argv[2] ?? process.env.AUTOLOGGER_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const email = process.argv[3] ?? 'owner@example.com';
let cookie = '';

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }));
  if (!json.ok) throw new Error(`${path}: ${json.error?.code ?? ''} ${json.error?.message ?? res.status}`);
  return json.data;
}
const rpc = (op, input) => post(`/api/rpc/${op}`, input);

await post('/auth/dev-login', { email, name: email.split('@')[0] });
const me = await rpc('me.get');
if (me.status !== 'active') {
  console.error(`${email} is ${me.status}. Approve it in Settings → Admin (or use the first/admin account).`);
  process.exit(1);
}

const team = await rpc('teams.create', { name: 'Smoke Team' });
const show = await rpc('shows.create', { teamId: team.id, name: 'Morning Chat', defaultFrameRate: 29.97 });
const cats = await rpc('categories.save', {
  showId: show.id,
  categories: [
    { name: 'Segment', color: '#3b82f6', kind: 'button' },
    { name: 'Laugh', color: '#f59e0b', kind: 'button' },
    { name: 'Ad read', color: '#22c55e', kind: 'button' },
    { name: 'Audio issue', color: '#ef4444', kind: 'dropdown', options: ['Lav', 'Boom', 'Noise'] },
    { name: 'Note', color: '#a3a3a3', kind: 'text' },
  ],
});
const byName = Object.fromEntries(cats.map((c) => [c.name, c.id]));
const session = await rpc('sessions.create', { showId: show.id, title: 'Morning Chat — demo episode', startTimecode: '01:00:00:00' });

const vtt = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:06.000',
  '<v Dana>Good morning! You will not believe what happened at the airport.',
  '',
  '00:00:06.500 --> 00:00:11.000',
  '<v Sam>Was it the dog again?',
  '',
  '00:04:00.000 --> 00:04:06.000',
  '<v Dana>Okay, news of the week. Three headlines, and yes, one is about the office dog.',
  '',
  '00:13:00.000 --> 00:13:07.000',
  '<v Sam>Our guest today built their first studio in a garage. Welcome to the show.',
  '',
  '00:25:00.000 --> 00:25:05.000',
  '<v Dana>That is the show. Next week, a very special guest.',
].join('\n');
await rpc('transcript.import', { sessionId: session.id, format: 'vtt', content: vtt, mode: 'replace' });

const moments = [
  [0, 'Segment', 'Cold open'],
  [95, 'Laugh', 'Dana’s airport story'],
  [240, 'Segment', 'News of the week'],
  [410, 'Audio issue', 'Lav rustle on guest', 'Lav'],
  [600, 'Ad read', 'Sponsor: coffee'],
  [780, 'Segment', 'Guest interview'],
  [905, 'Laugh', 'Callback to the dog'],
  [1260, 'Note', 'Pick-up needed for intro line'],
  [1500, 'Segment', 'Wrap'],
];
await rpc('events.createMany', {
  sessionId: session.id,
  events: moments.map(([atSec, cat, message, value]) => ({ atSec, categoryId: byName[cat], message, ...(value ? { value } : {}) })),
});
await rpc('topics.replace', {
  sessionId: session.id,
  topics: [
    { startSec: 0, durationSec: 240, title: 'Cold open', summary: 'Dana recaps a chaotic trip through the airport.' },
    { startSec: 240, durationSec: 540, title: 'News of the week', summary: 'Three headlines and a running joke about the office dog.' },
    { startSec: 780, durationSec: 720, title: 'Guest interview', summary: 'The guest talks about building their first studio.' },
    { startSec: 1500, durationSec: 120, title: 'Wrap', summary: 'Plugs and next week’s guest.' },
  ],
});
await rpc('dashboards.save', {
  sessionId: session.id,
  spec: {
    title: 'Episode overview',
    widgets: [
      { id: 'stats', type: 'stat', title: 'Events', span: 1, query: { name: 'summary_stats' }, field: 'events' },
      { id: 'topics', type: 'stat', title: 'Topics', span: 1, query: { name: 'summary_stats' }, field: 'topics' },
      { id: 'cats', type: 'bar', title: 'Events by category', span: 2, query: { name: 'events_by_category' }, x: 'category', y: 'count' },
      { id: 'timeline', type: 'timeline', title: 'Topics', span: 4, query: { name: 'topics' }, at: 'atSec', label: 'label', duration: 'durationSec' },
    ],
  },
});
await rpc('wiki.upsert', { showId: show.id, kind: 'person', title: 'Dana', bodyMd: 'Host of [[Morning Chat]]. Owner of the office dog.' });
await rpc('wiki.upsert', { showId: show.id, kind: 'bit', title: 'The office dog', aliases: ['the dog'], bodyMd: 'Running joke started by [[Dana]].' });
await rpc('wiki.upsert', { showId: show.id, kind: 'session', sessionId: session.id, title: 'Demo episode recap', bodyMd: 'Cold open with [[Dana]], news, a guest interview and a callback to [[The office dog]].' });

console.log(`Seeded team "${team.name}", show "${show.name}", session "${session.title}" (with a transcript).`);
console.log(`Open ${base}/sessions/${session.id}`);
