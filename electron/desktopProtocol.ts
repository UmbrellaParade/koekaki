import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { DESKTOP_SCHEME, resolveDesktopAssetPath } from './desktopContract.js'

export * from './desktopContract.js'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://generativelanguage.googleapis.com https://api.openai.com https://api.anthropic.com",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true,
      },
    },
  ])
}

export function createDesktopProtocolHandler(rendererRoot: string) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }

    const assetPath = resolveDesktopAssetPath(request.url, rendererRoot)
    if (!assetPath) return new Response('Not found', { status: 404 })

    try {
      const response = await net.fetch(pathToFileURL(assetPath).toString())
      if (!response.ok) return new Response('Not found', { status: 404 })

      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', CSP)
      headers.set('Cross-Origin-Resource-Policy', 'same-origin')
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
}
