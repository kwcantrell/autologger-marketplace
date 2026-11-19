// A structural check of FCPXML against the FCPXML 1.10 DTD's content models, for the elements this
// plugin writes: allowed children in order, required attributes, and the time value syntax. (Apple's
// DTD ships inside Final Cut Pro, so the rules are transcribed here; xmllint checks well-formedness.)

export interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Parses the plain XML this plugin writes (no CDATA, comments or processing instructions besides the prolog). */
export function parseXml(xml: string): El {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '').replace(/^<!DOCTYPE[^>]*>\s*/, '');
  const root: El = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: El[] = [root];
  const re = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const top = stack[stack.length - 1] as El;
    if (m[5] !== undefined) {
      if (m[5].trim() !== '') top.text += decode(m[5]);
      continue;
    }
    if (m[1] === '/') {
      if (top.name !== m[2]) throw new Error(`</${m[2]}> closes <${top.name}>`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1] as string] = decode(a[2] as string);
    const el: El = { name: m[2] as string, attrs, children: [], text: '' };
    top.children.push(el);
    if (m[4] !== '/') stack.push(el);
  }
  if (stack.length !== 1) throw new Error('unclosed elements');
  const [doc] = root.children;
  if (!doc || root.children.length !== 1) throw new Error('expected one root element');
  return doc;
}

/** Content model: children as a sequence of [names, min, max] groups, and required/optional attributes. */
interface Model {
  seq: [string[], number, number][];
  required: string[];
  optional: string[];
}
const ANY = Infinity;
const ANCHOR = ['asset-clip', 'clip', 'title', 'gap', 'ref-clip', 'sync-clip', 'mc-clip', 'audition', 'video', 'audio', 'spine'];
const MARKERS = ['marker', 'chapter-marker', 'rating', 'keyword', 'analysis-marker'];
const MODELS: Record<string, Model> = {
  fcpxml: { seq: [[['import-options'], 0, 1], [['resources'], 0, 1], [['library', 'event', 'project'], 0, ANY]], required: ['version'], optional: [] },
  resources: { seq: [[['asset', 'effect', 'format', 'media', 'locator', 'object-tracker'], 0, ANY]], required: [], optional: [] },
  format: { seq: [], required: ['id'], optional: ['name', 'frameDuration', 'fieldOrder', 'width', 'height', 'paspH', 'paspV', 'colorSpace', 'projection', 'stereoscopic'] },
  asset: {
    seq: [[['media-rep'], 1, ANY], [['metadata'], 0, 1]],
    required: ['id'],
    optional: ['name', 'uid', 'start', 'duration', 'hasVideo', 'format', 'hasAudio', 'videoSources', 'audioSources', 'audioChannels', 'audioRate', 'customLUTOverride', 'colorSpaceOverride', 'projectionOverride', 'stereoscopicOverride', 'heroEye'],
  },
  'media-rep': { seq: [[['bookmark'], 0, 1]], required: ['kind', 'src'], optional: ['sig', 'suggestedFilename'] },
  metadata: { seq: [[['md'], 0, ANY]], required: [], optional: [] },
  md: { seq: [], required: ['key'], optional: ['value', 'editable', 'type', 'displayName', 'displayDescription', 'source'] },
  effect: { seq: [], required: ['id', 'name', 'uid'], optional: ['src'] },
  library: { seq: [[['event'], 0, ANY], [['smart-collection'], 0, ANY]], required: [], optional: ['location', 'colorProcessing'] },
  event: { seq: [[['clip', 'audition', 'mc-clip', 'ref-clip', 'sync-clip', 'asset-clip', 'collection-folder', 'keyword-collection', 'smart-collection', 'project'], 0, ANY]], required: [], optional: ['name', 'uid'] },
  project: { seq: [[['sequence'], 1, 1]], required: [], optional: ['name', 'uid', 'id', 'modDate'] },
  sequence: {
    seq: [[['note'], 0, 1], [['spine'], 1, 1], [['metadata'], 0, 1]],
    required: ['format'],
    optional: ['duration', 'tcStart', 'tcFormat', 'audioLayout', 'audioRate', 'renderFormat', 'keywords'],
  },
  spine: { seq: [[['asset-clip', 'clip', 'title', 'gap', 'ref-clip', 'sync-clip', 'mc-clip', 'audition', 'transition', 'video', 'audio'], 0, ANY]], required: [], optional: ['name', 'offset', 'format', 'lane'] },
  'asset-clip': {
    seq: [[['note'], 0, 1], [['conform-rate'], 0, 1], [['timeMap'], 0, 1], [ANCHOR, 0, ANY], [MARKERS, 0, ANY], [['metadata'], 0, 1]],
    required: ['ref'],
    optional: ['lane', 'offset', 'name', 'start', 'duration', 'enabled', 'format', 'tcStart', 'tcFormat', 'audioRole', 'videoRole', 'srcEnable', 'audioStart', 'audioDuration', 'modDate'],
  },
  gap: { seq: [[['note'], 0, 1], [ANCHOR, 0, ANY], [MARKERS, 0, ANY], [['metadata'], 0, 1]], required: [], optional: ['name', 'offset', 'start', 'duration', 'enabled'] },
  title: {
    seq: [[['note'], 0, 1], [['param'], 0, ANY], [['text'], 0, ANY], [['text-style-def'], 0, ANY], [ANCHOR, 0, ANY], [MARKERS, 0, ANY], [['metadata'], 0, 1]],
    required: ['ref'],
    optional: ['lane', 'offset', 'name', 'start', 'duration', 'enabled', 'role'],
  },
  text: { seq: [[['text-style'], 0, ANY]], required: [], optional: ['display-style', 'roll-up-height', 'position', 'placement', 'alignment'] },
  'text-style-def': { seq: [[['text-style'], 1, 1]], required: ['id'], optional: ['name'] },
  'text-style': {
    seq: [[['param'], 0, ANY]],
    required: [],
    optional: ['ref', 'font', 'fontSize', 'fontFace', 'fontColor', 'backgroundColor', 'bold', 'italic', 'strokeColor', 'strokeWidth', 'baseline', 'shadowColor', 'shadowOffset', 'shadowBlurRadius', 'kerning', 'alignment', 'lineSpacing', 'tabStops', 'baselineOffset', 'underline'],
  },
  marker: { seq: [], required: ['start', 'value'], optional: ['duration', 'completed', 'note'] },
};
const TIME_ATTRS = new Set(['offset', 'start', 'duration', 'tcStart', 'frameDuration']);
const TIME = /^(0|[1-9]\d*(\/[1-9]\d*)?)s$/;

/** Problems found; empty means the document fits the content models above. */
export function checkFcpxml(root: El): string[] {
  const problems: string[] = [];
  const visit = (el: El, path: string): void => {
    const model = MODELS[el.name];
    const here = `${path}/${el.name}`;
    if (!model) {
      problems.push(`${here}: element not expected in this plugin's output`);
      return;
    }
    for (const a of model.required) if (el.attrs[a] === undefined) problems.push(`${here}: missing required attribute ${a}`);
    for (const a of Object.keys(el.attrs)) {
      if (!model.required.includes(a) && !model.optional.includes(a)) problems.push(`${here}: attribute ${a} is not declared`);
      if (TIME_ATTRS.has(a) && !TIME.test(el.attrs[a] as string)) problems.push(`${here}: ${a}="${el.attrs[a]}" is not an FCPXML time`);
    }
    let i = 0;
    for (const [names, min, max] of model.seq) {
      let n = 0;
      while (i < el.children.length && names.includes((el.children[i] as El).name) && n < max) {
        i++;
        n++;
      }
      if (n < min) problems.push(`${here}: needs at least ${min} of ${names.join('|')}`);
    }
    if (i < el.children.length) problems.push(`${here}: <${(el.children[i] as El).name}> is not allowed at position ${i + 1}`);
    if (el.text !== '' && el.name !== 'text-style') problems.push(`${here}: unexpected text`);
    for (const c of el.children) visit(c, here);
  };
  visit(root, '');
  return problems;
}

/** Seconds of an FCPXML time, as an exact fraction [num, den]. */
export function timeFraction(value: string): [number, number] {
  const m = /^(\d+)(?:\/(\d+))?s$/.exec(value);
  if (!m) throw new Error(`not a time: ${value}`);
  return [Number(m[1]), Number(m[2] ?? 1)];
}

export function find(el: El, name: string): El[] {
  const out: El[] = [];
  const walk = (e: El): void => {
    if (e.name === name) out.push(e);
    e.children.forEach(walk);
  };
  walk(el);
  return out;
}
