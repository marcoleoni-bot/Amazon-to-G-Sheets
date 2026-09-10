# Debugging Sheets automation — resources

## Knowledge

- [Apps Script: `Sheet.getFilter()`](https://developers.google.com/apps-script/reference/spreadsheet/sheet#getfilter)
  The API for reading and removing a tab's filter. Use for: understanding the
  fix that now runs before every write.
- [Apps Script: `Range.setValues()` / `setFormulas()`](https://developers.google.com/apps-script/reference/spreadsheet/range#setvaluesvalues)
  The two calls that do all the writing in this project. Use for: seeing what
  the documentation does — and does not — promise about when a write applies.
- [Apps Script best practices: batch operations](https://developers.google.com/apps-script/guides/support/best-practices)
  Why the planner groups adjacent columns into one call. Use for: when a run is
  slow or times out.
- [Google Sheets: filter views vs filters](https://support.google.com/docs/answer/3540681)
  A *filter view* is private to you and does not hide rows for a script; a
  *filter* does. Use for: deciding which one to use when reviewing a lane.
- The planner's own [`apps-script/README.md`](../apps-script/README.md)
  Every fault found so far, with the evidence that found it. Use for: "has this
  happened before?" — it usually has.

## Wisdom (communities)

- [r/GoogleAppsScript](https://www.reddit.com/r/GoogleAppsScript/)
  Active, practitioner-heavy, tolerant of "why does this silently do nothing"
  questions. Use for: sanity-checking whether a behaviour is known.
- [Stack Overflow `google-apps-script`](https://stackoverflow.com/questions/tagged/google-apps-script)
  Use for: searching a symptom before asking. Most silent-failure quirks are
  already written up by someone.

Not yet proposed as a commitment — Marco has one run a week and little spare
time. Revisit if a question comes up that Claude cannot settle from evidence.

## Gaps

- No authoritative source found stating that `setValues`/`setFormulas` skip
  filter-hidden rows. The conclusion here rests on evidence from Marco's own
  workbooks (three lanes, same code, only the filtered one failing) rather than
  on documentation. Worth a community question if it recurs.
