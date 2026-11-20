// autologger's custom-dashboard save-time rules, copied from autologger-2's
// `packages/contract/src/customDashboards.ts` (DASHBOARD_IMPORT_ALLOWLIST, DASHBOARD_DENIED_ELEMENTS,
// DASHBOARD_DENIED_GLOBALS, CUSTOM_DASHBOARD_LIMITS) at main 457b8598. A plugin cannot import
// autologger, so test/dashboard.test.ts checks this copy against the contract file when an
// autologger-2 checkout is on the machine. `annotate` pre-checks dashboards against it; autologger's
// save_dashboard validates them again, authoritatively.

/** The store limits used here: the TSX source and the title (characters). */
export const MAX_TSX_CHARS = 100_000;
export const MAX_TITLE_CHARS = 200;
/** Imported bindings across every import. */
export const MAX_IMPORT_SPECIFIERS = 60;

export const UI_COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  alert: ['Alert', 'AlertDescription', 'AlertTitle'],
  avatar: ['Avatar', 'AvatarBadge', 'AvatarFallback', 'AvatarGroup', 'AvatarGroupCount', 'AvatarImage'],
  badge: ['Badge', 'badgeVariants'],
  button: ['Button', 'buttonVariants', 'TOUCH_TARGET'],
  card: ['Card', 'CardAction', 'CardContent', 'CardDescription', 'CardFooter', 'CardHeader', 'CardTitle'],
  checkbox: ['Checkbox'],
  empty: ['Empty', 'EmptyContent', 'EmptyDescription', 'EmptyHeader', 'EmptyMedia', 'EmptyTitle'],
  field: ['Field', 'FieldContent', 'FieldDescription', 'FieldError', 'FieldGroup', 'FieldLabel', 'FieldLegend', 'FieldSeparator', 'FieldSet', 'FieldTitle'],
  input: ['Input'],
  item: ['Item', 'ItemActions', 'ItemContent', 'ItemDescription', 'ItemFooter', 'ItemGroup', 'ItemHeader', 'ItemMedia', 'ItemSeparator', 'ItemTitle'],
  kbd: ['Kbd', 'KbdGroup'],
  label: ['Label'],
  'radio-group': ['RadioGroup', 'RadioGroupItem'],
  'scroll-area': ['ScrollArea', 'ScrollBar'],
  separator: ['Separator'],
  skeleton: ['Skeleton'],
  spinner: ['Spinner'],
  table: ['Table', 'TableBody', 'TableCaption', 'TableCell', 'TableFooter', 'TableHead', 'TableHeader', 'TableRow'],
  tabs: ['Tabs', 'TabsContent', 'TabsList', 'TabsTrigger'],
  textarea: ['Textarea'],
  toggle: ['Toggle', 'toggleVariants'],
  'toggle-group': ['ToggleGroup', 'ToggleGroupItem'],
};

export const DATA_EXPORTS = [
  'useSession',
  'useEvents',
  'useTranscriptParagraphs',
  'useTranscriptWords',
  'useTopics',
  'useWikiPages',
  'useWikiPage',
  'useAggregates',
  'useMedia',
  'formatTimecode',
  'formatDuration',
  'Unavailable',
  'YouTubePlayer',
] as const;

export const REACT_EXPORTS = ['useState', 'useMemo', 'useEffect', 'useReducer', 'useCallback', 'useRef', 'Fragment'] as const;

/** Module specifier -> the names a dashboard may import from it. */
export const IMPORT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  react: REACT_EXPORTS,
  '@autologger/dashboard': DATA_EXPORTS,
  '@/lib/utils': ['cn'],
  ...Object.fromEntries(Object.entries(UI_COMPONENTS).map(([name, names]) => [`@/components/ui/${name}`, names])),
};

export const DENIED_ELEMENTS = ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'] as const;

export const DENIED_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'postMessage',
  'parent',
  'top',
  'opener',
  'frames',
  'window',
  'globalThis',
  'self',
  'document',
  'location',
  'history',
  'eval',
  'Function',
  'importScripts',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'setInterval',
  'require',
] as const;
