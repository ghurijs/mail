import { createContext, type GhuriSettings, runWithContext } from '@ghuri/core'

/** Run `fn` inside a Ghuri context with these settings (and env). */
export function withSettings<T>(
  settings: Partial<GhuriSettings>,
  fn: () => T,
  env: Record<string, unknown> = {},
): T {
  const ctx = createContext({
    env,
    settings: {
      SECRET_KEY: 'test',
      INSTALLED_APPS: [],
      ROOT_URLCONF: [],
      ...settings,
    } as unknown as GhuriSettings,
  })
  return runWithContext(ctx, fn)
}

export function decode(part: { getContent(): string | Uint8Array | undefined }): string {
  const c = part.getContent()
  return typeof c === 'string' ? c : new TextDecoder().decode(c)
}
