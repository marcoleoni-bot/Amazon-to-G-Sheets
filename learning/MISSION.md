# Mission: Debugging Sheets automation with Claude

## Why

Marco runs the US transfer-order process every week on an Apps Script that
writes into Google Sheets. When it misbehaves the cost is a whole working day:
the orders still have to go out, by hand, on numbers nobody trusts. Worse, the
failures have mostly been *silent* — the sheet looks finished and is wrong.

The goal is to cut the round trip. Marco should be able to look at a broken run,
decide in a minute or two whether the rules are wrong or the sheet ate the
write, and send Claude the two or three artefacts that settle it — instead of a
screenshot and a week of guessing.

## Success looks like

- Given a bad planner, Marco can say which of the two it is — *wrong answer* or
  *no answer written* — before contacting Claude.
- He sends the evidence that decides it (a formula from the formula bar, the
  error text, which tabs are right vs wrong) unprompted, in the first message.
- He recognises the three environment traps in this project on sight: a filter
  on a tab, a deleted named range, and `getLastRow()` counting junk.
- He can tell Claude *what did not change*, which is the thing a screenshot of
  values can never show.

## Constraints

- One weekly run. Practice opportunities are rare, so lessons must stick from a
  single pass — the debugging happens weeks apart.
- Marco is not a programmer and does not want to become one. Nothing here
  requires reading Apps Script; everything is done from the Sheets UI plus a
  copied line of text.
- Short lessons. This is a tool for getting back to work, not a course.

## Out of scope

- Writing or editing Apps Script.
- The transfer-order *rules* themselves (DOI targets, pallet minimums, the
  Tactical floor) — those live in the planner's own README.
- Google Sheets formula authoring beyond reading one from the formula bar.
