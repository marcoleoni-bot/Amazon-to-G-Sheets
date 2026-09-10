# Working notes

## How Marco wants to be taught

- Short. One idea per lesson, readable in a few minutes. He has a weekly run
  and a business to operate; this is a tool, not a course.
- Grounded in his own workbooks. Every example so far comes from a real failed
  run, with the real cell contents. Invented examples would not land.
- No Apps Script. He is not a programmer and has not asked to become one.
  Everything must be doable from the Sheets UI plus copying a line of text.

## Observed

- He is already good at the hardest part: he pasted the exact error text and
  the exact broken formula unprompted. Both times, that artefact is what cracked
  the bug. Build on this rather than teaching it from zero.
- He reasons in terms of the *business* process (lanes, pallets, floors), so
  tie debugging concepts to lanes and tabs, not to functions and ranges.

## Practice is rare

One run a week means almost no repetition. Lessons must survive a single pass:
favour a printable reference over anything that needs re-reading, and use
retrieval questions rather than exposition where possible.

## Candidate next lessons

1. Reading the Run header as a diagnostic instrument — it now reports filters
   removed, floors that disagreed, and sheet-vs-rules differences.
2. Telling a *rule* disagreement from a *data* problem: when the Reason column
   says something you disagree with, is the threshold wrong or the input wrong?
3. Changing a dial on the Settings tab and predicting what moves — the cheapest
   way to build a mental model of the rules.
