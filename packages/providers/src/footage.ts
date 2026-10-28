// A story's footage folder on the newsroom FTP (Samvadia stores it as items.footage_path, e.g.
// /BARAN/oct2026/26102026/<slug>/). Socia only ever LOOKS at the FTP: it lists folders and downloads
// files. The FTP client is wrapped so any other call (upload, rename, delete, mkdir, raw commands)
// throws before it reaches the server. A local folder with the same layout stands in for development.

import { readdir, readFile, stat } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { Client } from "basic-ftp";

export interface FootageFile {
  /** Absolute path on the share, forward slashes, e.g. /BARAN/oct2026/26102026/x/photo1.jpg */
  path: string;
  /** Name relative to the story folder; "sub/clip.mp4" for a file one level down */
  name: string;
  size: number;
  mtime: Date | null;
}

export interface FootageSource {
  readonly kind: "ftp" | "folder";
  /**
   * The files in a story folder and one level of subfolders (how Samvadia's matcher counts them).
   * A path that names a single file returns just that file. A missing path returns [].
   */
  listStoryFolder(path: string): Promise<FootageFile[]>;
  /** The whole file; throws when it is larger than maxBytes */
  read(path: string, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Sidecar and system files Samvadia's matcher also skips */
const SKIP = [/^\./, /^thumbs\.db$/i, /\.(xml|xmp|thm|lrv|tmp|part|filepart|ds_store)$/i];
const skip = (name: string) => SKIP.some((re) => re.test(name));

/** Normalise a share path: forward slashes, one leading slash, no trailing slash, no "..". */
export function cleanSharePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) throw new Error(`Footage path may not contain "..": ${path}`);
  return `/${parts.join("/")}`;
}

// ─── FTP, read only ──────────────────────────────────────────────────────────

/** The only basic-ftp members Socia may touch. Everything here reads; nothing writes. */
export const FTP_READ_ONLY_MEMBERS = ["access", "list", "downloadTo", "close", "closed"] as const;

/**
 * Wraps a basic-ftp Client so only FTP_READ_ONLY_MEMBERS are reachable. uploadFrom, appendFrom,
 * rename, remove, removeDir, ensureDir, clearWorkingDir, send and the rest throw on access.
 */
export function readOnlyFtp<T extends object>(client: T): Pick<Client, (typeof FTP_READ_ONLY_MEMBERS)[number]> {
  const allowed = new Set<PropertyKey>(FTP_READ_ONLY_MEMBERS);
  return new Proxy(client, {
    get(target, prop) {
      if (!allowed.has(prop)) {
        // then is probed by await; answering undefined keeps the proxy from looking like a promise
        if (prop === "then") return undefined;
        throw new Error(`The newsroom FTP is read-only for Socia: "${String(prop)}" is blocked`);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() {
      throw new Error("The newsroom FTP client cannot be changed");
    },
  }) as unknown as Pick<Client, (typeof FTP_READ_ONLY_MEMBERS)[number]>;
}

export interface FootageFtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  timeoutMs?: number;
}

type ReadOnlyClient = ReturnType<typeof readOnlyFtp>;

export class FtpFootage implements FootageSource {
  readonly kind = "ftp" as const;
  private client: ReadOnlyClient | null = null;

  /** makeClient is for tests; production uses basic-ftp in passive mode (its only mode) */
  constructor(private readonly cfg: FootageFtpConfig, private readonly makeClient: () => object = () => new Client(cfg.timeoutMs ?? 30_000)) {}

  private async connect(): Promise<ReadOnlyClient> {
    if (this.client && !this.client.closed) return this.client;
    const client = readOnlyFtp(this.makeClient());
    await client.access({ host: this.cfg.host, port: this.cfg.port, user: this.cfg.user, password: this.cfg.password, secure: this.cfg.secure });
    this.client = client;
    return client;
  }

  private async entries(client: ReadOnlyClient, dir: string) {
    try {
      return await client.list(dir);
    } catch (err) {
      // 550: no such folder (the footage is not there yet, or the path is a file)
      if ((err as { code?: number }).code === 550) return null;
      throw err;
    }
  }

  async listStoryFolder(path: string): Promise<FootageFile[]> {
    const client = await this.connect();
    const dir = cleanSharePath(path);
    const top = await this.entries(client, dir);
    if (!top) {
      // Maybe a single file: look for it in its parent folder
      const parent = posix.dirname(dir);
      const base = posix.basename(dir);
      const siblings = (await this.entries(client, parent)) ?? [];
      const hit = siblings.find((e) => e.isFile && e.name === base);
      return hit ? [{ path: dir, name: hit.name, size: hit.size, mtime: hit.modifiedAt ?? null }] : [];
    }
    // Some servers answer LIST <file> with the file itself
    if (top.length === 1 && top[0]!.isFile && top[0]!.name === posix.basename(dir)) {
      return [{ path: dir, name: top[0]!.name, size: top[0]!.size, mtime: top[0]!.modifiedAt ?? null }];
    }
    const out: FootageFile[] = [];
    for (const e of top) {
      if (skip(e.name)) continue;
      if (e.isDirectory) {
        for (const sub of (await this.entries(client, `${dir}/${e.name}`)) ?? []) {
          if (sub.isFile && !skip(sub.name)) out.push({ path: `${dir}/${e.name}/${sub.name}`, name: `${e.name}/${sub.name}`, size: sub.size, mtime: sub.modifiedAt ?? null });
        }
      } else if (e.isFile) {
        out.push({ path: `${dir}/${e.name}`, name: e.name, size: e.size, mtime: e.modifiedAt ?? null });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const client = await this.connect();
    const chunks: Buffer[] = [];
    let total = 0;
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        total += chunk.length;
        if (total > maxBytes) return done(new Error(`File is over the ${maxBytes}-byte cap`));
        chunks.push(chunk);
        done();
      },
    });
    await client.downloadTo(sink, cleanSharePath(path));
    return Buffer.concat(chunks);
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;
  }
}

// ─── Local folder with the FTP's layout (development and tests) ──────────────

export class FolderFootage implements FootageSource {
  readonly kind = "folder" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private local(path: string): string {
    const full = resolve(this.root, `.${cleanSharePath(path)}`);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`Footage path escapes the folder: ${path}`);
    return full;
  }

  async listStoryFolder(path: string): Promise<FootageFile[]> {
    const dir = cleanSharePath(path);
    const full = this.local(dir);
    const s = await stat(full).catch(() => null);
    if (!s) return [];
    if (s.isFile()) return [{ path: dir, name: posix.basename(dir), size: s.size, mtime: s.mtime }];
    const out: FootageFile[] = [];
    for (const e of await readdir(full, { withFileTypes: true })) {
      if (skip(e.name)) continue;
      if (e.isDirectory()) {
        for (const sub of await readdir(this.local(`${dir}/${e.name}`), { withFileTypes: true })) {
          if (!sub.isFile() || skip(sub.name)) continue;
          const p = `${dir}/${e.name}/${sub.name}`;
          const st = await stat(this.local(p));
          out.push({ path: p, name: `${e.name}/${sub.name}`, size: st.size, mtime: st.mtime });
        }
      } else if (e.isFile()) {
        const p = `${dir}/${e.name}`;
        const st = await stat(this.local(p));
        out.push({ path: p, name: e.name, size: st.size, mtime: st.mtime });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const full = this.local(path);
    const s = await stat(full);
    if (s.size > maxBytes) throw new Error(`File is over the ${maxBytes}-byte cap`);
    return readFile(full);
  }

  async close(): Promise<void> {}
}
