---
name: first-tasks
description: Starter tasks for new AutoLogger contributors — tracked as GitHub issues labelled "good first issue" (and "help wanted" for larger ones), each sized and pointed at the files involved, with how to verify it. Use when a contributor asks what they could work on, wants a good first issue, or has time to help.
---

# Good first tasks

Every starter task is a GitHub issue in `kwcantrell/autologger`; the issue is the spec (problem,
files, "done when") and the place to say you're taking it. There is no fixed list here — the
labels are the list:

```bash
gh issue list -R kwcantrell/autologger -l "good first issue" --state open   # small / medium
gh issue list -R kwcantrell/autologger -l "help wanted" --state open        # larger: design note first
```

Skip issues that are assigned or have an open PR linked (`gh issue view <n>`). Ask about the
contributor's interests (backend, UI, hardware, docs) and offer 2–3 that fit, with links and a
size estimate from the issue (small = an afternoon, medium = a few days, larger = write a short
design note on the issue first). Before starting, comment on the issue (or self-assign) so two
people don't pick the same one, then follow the `contribute` workflow; the PR says `Closes #<n>`.

If the lists are empty or nothing fits, look for a starter-sized open issue
(`gh issue list -R kwcantrell/autologger --state open -l enhancement`) or a `follow-up` issue, and
offer it — saying it isn't labelled as a starter task yet.

## Keeping the list honest

When you notice a good new starter task, file it with the `file-issue` skill and label it
(`good first issue` for small/medium, `help wanted` for larger). Nothing in this skill needs
updating when tasks open or close.
