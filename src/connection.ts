import { ImproperlyConfigured, tryGetContext } from '@ghuri/core'
import {
  type BaseEmailBackend,
  type ConnectionOptions,
  type EmailBackendConfig,
  isBackendConfig,
} from './backends/base'
import { consoleBackend } from './backends/console'

const OVERRIDE_KEY = Symbol.for('ghuri.mail.backendOverride')
const g = globalThis as Record<symbol, unknown>

/** Replace `EMAIL_BACKEND` process-wide (used by `@ghuri/mail/testing`; `undefined` restores the setting). */
export function setEmailBackendOverride(config: EmailBackendConfig | undefined): void {
  if (config === undefined) delete g[OVERRIDE_KEY]
  else g[OVERRIDE_KEY] = config
}

function configuredBackend(): EmailBackendConfig {
  const override = g[OVERRIDE_KEY] as EmailBackendConfig | undefined
  if (override) return override
  const ctx = tryGetContext()
  const configured = ctx?.settings.EMAIL_BACKEND
  if (configured !== undefined && configured !== null) {
    if (!isBackendConfig(configured)) {
      throw new ImproperlyConfigured(
        'EMAIL_BACKEND must be a backend config such as cloudflareEmailBackend(), resendBackend({ apiKey }) or ' +
          'consoleBackend().',
      )
    }
    return configured
  }
  if (ctx?.settings.DEBUG) return consoleBackend()
  throw new ImproperlyConfigured(
    ctx
      ? 'EMAIL_BACKEND is not set. Set it in settings, e.g. EMAIL_BACKEND: cloudflareEmailBackend() or ' +
          'resendBackend({ apiKey: env.RESEND_API_KEY }). (Only DEBUG falls back to consoleBackend().)'
      : 'No Ghuri context to read EMAIL_BACKEND from. Send email inside a request, runWithContext() or after ' +
          'app.setup(env), or pass a connection.',
  )
}

/**
 * Open a connection to an email backend (Django's `get_connection()`). Without `backend`, uses `EMAIL_BACKEND`;
 * `options` (`failSilently` plus backend-specific overrides) are passed to the backend.
 *
 * ```ts
 * const conn = getConnection()
 * await conn.sendMessages([message1, message2])
 * ```
 */
export function getConnection(
  backend?: EmailBackendConfig | null,
  options: ConnectionOptions = {},
): BaseEmailBackend {
  const config = backend ?? configuredBackend()
  if (!isBackendConfig(config))
    throw new ImproperlyConfigured('getConnection() needs an email backend config.')
  return config.create(tryGetContext()?.env ?? {}, options)
}
