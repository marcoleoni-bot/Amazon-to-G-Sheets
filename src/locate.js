/**
 * Selectors are written as plain data — {role, name} / {label} / {text} / {css}
 * — so re-recording after an Amazon reskin means editing selectors.js, not
 * editing code. Each entry is a *list* of candidates tried in order, because a
 * button that is "Request .csv Download" in one marketplace is
 * "Anforderung .csv Download" in another.
 */

export function toLocator(scope, descriptor) {
  if (typeof descriptor === 'string') return scope.locator(descriptor);
  if (descriptor.role) {
    return scope.getByRole(descriptor.role, {
      name: descriptor.name,
      exact: descriptor.exact ?? false,
    });
  }
  if (descriptor.label) return scope.getByLabel(descriptor.label);
  if (descriptor.placeholder) return scope.getByPlaceholder(descriptor.placeholder);
  if (descriptor.text) return scope.getByText(descriptor.text);
  if (descriptor.testId) return scope.getByTestId(descriptor.testId);
  if (descriptor.css) return scope.locator(descriptor.css);
  throw new Error(`Unrecognised selector descriptor: ${JSON.stringify(descriptor)}`);
}

/**
 * Try each candidate; return the first that becomes visible.
 * Returns null rather than throwing, so callers can decide whether a missing
 * element is fatal or just means "this step wasn't needed on this page".
 */
export async function findFirst(scope, candidates, { timeout = 15_000 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const per = Math.max(2000, Math.floor(timeout / Math.max(list.length, 1)));

  for (const descriptor of list) {
    const locator = toLocator(scope, descriptor).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: per });
      return { locator, descriptor };
    } catch {
      // next candidate
    }
  }
  return null;
}

export async function clickFirst(scope, candidates, { timeout = 15_000, what = 'element' } = {}) {
  const found = await findFirst(scope, candidates, { timeout });
  if (!found) {
    throw new Error(`Could not find ${what}. Tried: ${JSON.stringify(candidates)}`);
  }
  await found.locator.click();
  return found;
}
