const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  info: (msg) => console.log(`${stamp()}  ${msg}`),
  step: (msg) => console.log(`${stamp()}  → ${msg}`),
  ok: (msg) => console.log(`${stamp()}  ✓ ${msg}`),
  warn: (msg) => console.warn(`${stamp()}  ! ${msg}`),
  fail: (msg) => console.error(`${stamp()}  ✗ ${msg}`),
  blank: () => console.log(''),
};

export function heading(text) {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}
