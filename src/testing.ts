// @ghuri/mail/testing — Django's `mail.outbox` for tests.

import { getOutbox, locmemBackend } from './backends/locmem'
import { setEmailBackendOverride } from './connection'
import type { EmailMessage } from './message'

/**
 * Messages sent through the locmem backend, oldest first (Django's `mail.outbox`). Always the same array:
 * `clearOutbox()` empties it in place.
 */
export const outbox: EmailMessage[] = getOutbox()

/** Empty the outbox. */
export function clearOutbox(): void {
  getOutbox().length = 0
}

/**
 * Route every message that would use `EMAIL_BACKEND` to the locmem backend (as Django's test runner does), empty
 * the outbox and return it. Call in `beforeEach`; undo with `restoreEmailBackend()`.
 *
 * ```ts
 * beforeEach(() => useOutbox())
 * afterEach(() => restoreEmailBackend())
 *
 * it('sends a welcome email', async () => {
 *   await signup('jane@example.com')
 *   expect(outbox).toHaveLength(1)
 *   expect(outbox[0].subject).toBe('Welcome')
 * })
 * ```
 */
export function useOutbox(): EmailMessage[] {
  setEmailBackendOverride(locmemBackend())
  clearOutbox()
  return outbox
}

/** Stop routing mail to the outbox: `EMAIL_BACKEND` applies again. The outbox keeps its messages. */
export function restoreEmailBackend(): void {
  setEmailBackendOverride(undefined)
}
