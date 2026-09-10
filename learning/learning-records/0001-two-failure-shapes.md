# Two failure shapes: wrong answer vs no answer written

Established that every planner failure so far is either a cell the script
calculated and Marco disagrees with (rules), or a cell the script never managed
to write (environment) — and that the formula bar separates them in seconds
while the grid value cannot. Future sessions should assume this distinction is
known and build on it rather than re-teaching it.

## Evidence

Marco supplied, unprompted, both artefacts that resolve this distinction: the
full error text listing all fourteen failing columns, and the literal contents
of a bad cell's formula bar (`=ROUNDUP((100-O8)*F8/Q8,0)`, the old template's
leftover). He was already doing the right thing without a name for it.

## Implications

- Do not spend a lesson on "how to describe a bug". He describes them well.
- The gap is knowing *which* artefacts decide the question, and reading the
  formula bar rather than the value. That is lesson 1.
- Next lessons can assume the vocabulary in GLOSSARY.md.
