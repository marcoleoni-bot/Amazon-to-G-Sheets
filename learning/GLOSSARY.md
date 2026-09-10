# Debugging Sheets automation — glossary

The shared language for this workspace. Lessons use these words and only these
words for these ideas.

## Terms

**Silent write**:
A write the script believes it made and the sheet did not accept. No error is
raised and the cell keeps its previous content.
_Avoid_: failed write, dropped save

**Wrong answer**:
A cell holding a freshly calculated number you disagree with. The fault is in
the rules.
_Avoid_: bad output, miscalculation

**No answer written**:
A cell the script never managed to change, still holding a pasted value or an
older formula. The fault is in the environment.
_Avoid_: blank cell, missing formula

**Leftover**:
A formula from an earlier version of the workbook, left in place because this
run's write was silent. Recognised by not matching what the script writes now.
_Avoid_: stale formula, old formula

**Contrast**:
The diagnostic move of comparing a broken tab against a working one that ran
through the same code. Narrows the cause to what differs between them.
_Avoid_: comparison, A/B

**Environment trap**:
A property of the sheet — a filter, a protected range, hidden rows, stray
content far below the data — that changes what a write does without changing
what the code says.
_Avoid_: sheet quirk, gotcha
