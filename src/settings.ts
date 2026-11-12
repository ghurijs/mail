import { type GhuriSettings, tryGetContext } from '@ghuri/core'
import type { EmailBackendConfig } from './backends/base'

declare module '@ghuri/core' {
  interface GhuriSettings {
    /**
     * The email backend: `cloudflareEmailBackend()`, `resendBackend({ apiKey })`, `smtpBackend()` (from
     * `@ghuri/mail/smtp`), `consoleBackend()`, `locmemBackend()` or `dummyBackend()`. When unset, `consoleBackend()`
     * is used in `DEBUG` and sending raises `ImproperlyConfigured` otherwise.
     */
    EMAIL_BACKEND?: EmailBackendConfig
    /** Sender of `sendMail()` / `EmailMessage` when none is given (default `'webmaster@localhost'`). */
    DEFAULT_FROM_EMAIL?: string
    /** Sender of `mailAdmins()` / `mailManagers()` (default `'root@localhost'`). */
    SERVER_EMAIL?: string
    /** Prefix of `mailAdmins()` / `mailManagers()` subjects (default `'[Ghuri] '`). */
    EMAIL_SUBJECT_PREFIX?: string
    /** Addresses that get `mailAdmins()` (`['Jane <jane@example.com>']`). */
    ADMINS?: string[]
    /** Addresses that get `mailManagers()`. */
    MANAGERS?: string[]
    /** Seconds before a network backend (Resend, SMTP) gives up; `null` waits forever (default). */
    EMAIL_TIMEOUT?: number | null
  }
}

export const DEFAULT_FROM_EMAIL = 'webmaster@localhost'
export const DEFAULT_SERVER_EMAIL = 'root@localhost'
export const DEFAULT_EMAIL_SUBJECT_PREFIX = '[Ghuri] '

/** Read a setting from the current context, with a fallback (works outside a context too). */
export function mailSetting<K extends keyof GhuriSettings>(
  name: K,
  fallback: NonNullable<GhuriSettings[K]>,
): NonNullable<GhuriSettings[K]> {
  const v = tryGetContext()?.settings[name]
  return (v === undefined || v === null ? fallback : v) as NonNullable<GhuriSettings[K]>
}

/** `EMAIL_TIMEOUT` (seconds) or `null`. */
export function emailTimeout(): number | null {
  const v = tryGetContext()?.settings.EMAIL_TIMEOUT
  return typeof v === 'number' ? v : null
}
