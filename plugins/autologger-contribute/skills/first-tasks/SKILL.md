---
name: first-tasks
description: Starter tasks for new AutoLogger contributors — tracked as GitHub issues labelled "good first issue" (and "help wanted" for larger ones), each sized and pointed at the files involved, with how to verify it. Use when a contributor asks what they could work on, wants a good first issue, or has time to help.
---

# Good first tasks

Every starter task is a GitHub issue in `kwcantrell/autologger`; the issue is the spec (problem,
files, "done when") and the place to say you're taking it. The list below is a snapshot — get the
live one first:

```bash
gh issue list -R kwcantrell/autologger -l "good first issue" --state open
gh issue list -R kwcantrell/autologger -l "help wanted" --state open
```

Skip issues that are assigned or have an open PR linked (`gh issue view <n>`). Ask about the
contributor's interests (backend, UI, hardware, docs) and offer 2–3 that fit, with links. Before
starting, comment on the issue (or self-assign) so two people don't pick the same one, then follow
the `contribute` workflow; the PR says `Closes #<n>`.

## Small (an afternoon)

- [#103](https://github.com/kwcantrell/autologger/issues/103) **Shrink the main web chunk**
  (~790 kB) — find what's in it with a bundle visualizer, lazy-load what the first screen doesn't
  need or split vendor code. Web.
- [#97](https://github.com/kwcantrell/autologger/issues/97) **Link from the sign-in page back to
  the landing page.** Web.

## Medium (a few days)

- [#104](https://github.com/kwcantrell/autologger/issues/104) **Sweep abandoned uploads** —
  worker job that removes `uploading` segments (and objects) older than a day. Server / worker.
- [#105](https://github.com/kwcantrell/autologger/issues/105) **Companion presence across
  instances** — publish connect/disconnect on the bus. Server / hardware.
- [#106](https://github.com/kwcantrell/autologger/issues/106) **Show-level change log with undo**
  — show wiki pages and event-button changes, reusing the Agents tab. Web.

## Larger (write a short design note on the issue first)

- [#107](https://github.com/kwcantrell/autologger/issues/107) **Waveform peaks on the timeline.**
  Worker + web.
- [#108](https://github.com/kwcantrell/autologger/issues/108) **Playwright end-to-end smoke
  tests.** Dev tooling.
- [#109](https://github.com/kwcantrell/autologger/issues/109) **Opt-in real Deepgram integration
  test.** Media.

## Keeping the list honest

When a task here is closed, or you notice a good new starter task, update the issue labels
(`good first issue` for small/medium, `help wanted` for larger) and this list in the same
marketplace PR (`improve-plugins`). New tasks are filed with the `file-issue` skill.
