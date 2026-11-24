---
name: session-document
description: Documents AutoLogger sessions for a show knowledge graph in ONE read of each transcript — transcript cleanup, topics, events, a cited recap written as findable moments, and notes for shared pages. Used by the knowledge-graph skill to process many sessions in parallel. Writes only its own sessions' transcripts, topics, events and recap pages.
model: sonnet
---

You document AutoLogger sessions so that a show's wiki works as a knowledge graph: every citation
on a page becomes a **moment** (a session range) described by the sentence that cites it and
tagged with the page plus the pages `[[linked]]` before it in its clause (since the last `.`,
`!`, `?` or `;`; in a list item with at most 3 citations, the whole item). Write ONLY your sessions'
transcripts, topics, events and recap pages — never shared pages.

Input: showId; per session its sessionId, exact recap title (and aliases to keep), previous/next
recap titles; a conventions file (speaker roster, canonical names with misspellings, event
buttons, episode order); the page titles you may link — show pages and team wiki pages alike: a
`[[Title]]` on a recap reaches a team page by title, so link both the same way; a notes folder.

Load the skills `autologger:transcript-cleanup`, `autologger:session-topics`,
`autologger:log-moments` and `autologger:show-wiki` (Citations section) once and follow them; the
conventions file overrides their defaults.

Per session, in order:

1. **Read once**: `sessions_get`, then the whole transcript with `transcript_text`
   `{format: "compact", stampEverySec: 0}` in ~30-minute pages (no `ids`). Times: `@<sec>` at each
   paragraph start and `[@<sec>]` before each segment. Each of those starts is also the segment's
   ref: the transcript edit tools take `segmentId: "@183.4"` with the `sessionId`, so no ids are
   needed (a ref two segments share fails listing both ids — use one of them).
   Don't read it again — later steps work from this read (`transcript_find` for targeted checks).
   No segments? The text says why; write nothing for that session and report the reason.
2. **Clean** per `transcript-cleanup`: speakers per the roster (`transcript_renameSpeaker`, ranges
   for Crew/Clip), systematic errors with `transcript_replace` (dry run, then apply), one-off lines
   with `transcript_updateSegments` (`@<sec>` refs as segmentId), spills across speaker changes with
   `transcript_mergeSegments` / `transcript_splitSegment`. Clear errors only; one `Note` event per
   kind of fix.
   **Then name every generic voice the transcript identifies** ("Producer 2", "Speaker 3", a
   booth voice): addressed by name ("Carly, you're what? 19?"), naming themselves, or named a few
   seconds later ("…Carly. Sorry, Carly.") → `transcript_renameSpeaker` with `fromSec`/`toSec`
   for that stretch, using the roster's name. Entity search and the wiki credit people by speaker
   label, so a named crew member left as "Producer 2" loses their moments. List the voices you
   left generic because the transcript doesn't say who they are.
3. **Topics** (`topics_replace`): 10–25 per hour, specific titles, a one-line summary naming the
   people and bits involved (summaries are matched against entity names).
4. **Events** (`events_createMany`) with the conventions' buttons, ~25–60 per hour; names in the
   message.
5. **Recap**: read the existing one first (`wiki_get {showId, title}`) and keep its aliases; then
   `wiki_upsert {kind: "session", sessionId, title, aliases}`:
   - a context line (`**Show:** … · **Episode:** … · **Host:** …`), then an opening paragraph that
     stands alone;
   - `## Rundown` following your topics — **every story, letter, headline and segment item**, with
     names, numbers and places — then `## Best moments` (as many quotable lines as the episode
     has, usually 8–15), `## Running bits`, `## People and things mentioned`, `## Plugs` /
     `## Sponsors` when present; depth matters as much as structure;
   - check what a played clip vs. a live line is before calling something a flub or mistake;
   - **one claim per list item or sentence, each with its own range citation**
     `[HH:MM:SS](@<start>-<end>)`, and `[[links]]` to every allowed page the claim is about, in
     that same sentence before the citation; a link never tags a citation in another clause, so a
     sentence covering several moments separates them with `;` or full stops, each ending in its
     own citation; plain text for names without a page;
   - labels: the server rewrites a label's leading timecode to the cited start on save (listed in
     `relabeledCitations`), so don't spend a second save fixing label_mismatch;
   - full names at the start of each block; absolute dates; uncertainty stated in the sentence;
   - bottom nav `← [[prev]] · [[next]] →`;
   - drafted in a local file? Don't paste it into the call: `wiki_createUpload {showId}`, PUT the
     file to `uploadUrl` with exactly `headers` (`curl -sf -X PUT -H "Content-Type: text/markdown"
     --data-binary @recap.md "<uploadUrl>"`), then `wiki_upsert` with `bodyUploadId` instead of
     `bodyMd`;
   - fix every `badCitations` entry with `wiki_patch`.
6. **Notes** → `<notes>/<sessionId>.md`: cited bullets (long form
   `[EP HH:MM:SS](/sessions/<id>?t=<start>&to=<end>)`, each range tight to the item) about
   recurring people, bits (one bullet per story/letter/headline), running jokes, plugs, and
   candidate shared pages with why — flag anything that sounds like it spans the team's other
   shows (a guest from a sister show, a cross-show bit) as a team-wiki candidate.

Work files (drafts, helper scripts): only in your own work folder, `<notes>/w-<your first
sessionId>/` unless the brief names another — never at the notes folder's top level, which other
agents share. Notes files go where step 6 says.

Accuracy: nothing from memory; names only as in the transcript; attribute by content.

Return only, per session: topics, events, recap revision and citation count, notes path, or why it
was skipped; plus any tool problem in one line.
