// Polite HTTPS reads from the public web, for the Web Scraper: Google News and Google Trends RSS,
// GDELT, the Rajasthan publishers' RSS feeds, and (once per URL) an article page's og:image and the
// image itself. Every read has a timeout, a size cap and a clear User-Agent; only https, and never an
// address inside a private network (feed content decides some of these URLs, so it is not trusted).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface WebResponse {
  status: number;
  contentType: string;
  body: Buffer;
  /** After redirects */
  url: string;
}

export interface GetOptions {
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  /** Keep the first maxBytes and stop reading, instead of failing (an HTML page's <head> is at the start) */
  truncate?: boolean;
}

/** One GET. Tests pass a fake that serves recorded fixtures; production uses politeGet. */
export type WebGet = (url: string, opts?: GetOptions) => Promise<WebResponse>;

export class WebError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const MAX_REDIRECTS = 3;

/** Loopback, private, link-local, CGNAT, multicast, reserved: never fetched. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new WebError(`Only https is fetched (got ${url.protocol})`);
  if (url.username || url.password) throw new WebError("URLs with credentials are not fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new WebError("Local hosts are not fetched");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new WebError(`${host} resolves to a private address`);
}

/**
 * GET with a timeout, a byte cap, the given User-Agent, and redirects followed by hand (each hop is
 * checked again). Throws WebError on refusal, timeout or an over-size body; returns any HTTP status.
 */
export function politeGet(userAgent: string): WebGet {
  return async (target, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const signal = AbortSignal.timeout(timeoutMs);
    let url = new URL(target);
    for (let hop = 0; ; hop++) {
      await assertPublic(url);
      let res: Response;
      try {
        res = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": userAgent, accept: opts.accept ?? "*/*", "accept-language": "hi-IN,hi;q=0.9,en-IN;q=0.8" } });
      } catch (err) {
        // undici says only "fetch failed"; the reason (ECONNRESET, a TLS error, ...) is in the cause
        const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
        const detail = cause?.code ?? cause?.message;
        throw new WebError(signal.aborted ? `Timed out after ${timeoutMs / 1000} s` : `${String((err as Error)?.message ?? err)}${detail ? ` (${detail})` : ""}`);
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new WebError("Too many redirects");
        url = new URL(location, url);
        continue;
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes && !opts.truncate) {
        await res.body?.cancel().catch(() => undefined);
        throw new WebError(`Response is ${declared} bytes, over the ${maxBytes} cap`, res.status);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (err) {
            throw new WebError(signal.aborted ? `Timed out after ${timeoutMs / 1000} s` : String((err as Error)?.message ?? err));
          }
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            if (!opts.truncate) throw new WebError(`Response is over the ${maxBytes} byte cap`, res.status);
            chunks.push(Buffer.from(chunk.value).subarray(0, chunk.value.byteLength - (size - maxBytes)));
            break;
          }
          chunks.push(Buffer.from(chunk.value));
        }
      }
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks), url: url.toString() };
    }
  };
}

/** Text of a 200 response, or a WebError naming what went wrong (429 included) */
export async function getText(get: WebGet, url: string, opts?: GetOptions): Promise<string> {
  const res = await get(url, opts);
  if (res.status !== 200) {
    const hint = res.status === 429 ? " (rate limited)" : "";
    throw new WebError(`HTTP ${res.status}${hint}`, res.status);
  }
  return res.body.toString("utf8");
}
