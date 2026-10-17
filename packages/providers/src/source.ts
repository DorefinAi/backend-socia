// Where control-room files come from. FTP (passive mode: Render sits behind NAT, so active mode
// fails on the data channel), or a local folder for development and for the on-prem push fallback.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Writable } from "node:stream";
import { Client } from "basic-ftp";

export interface RemoteFile {
  /** Path inside the share, with forward slashes */
  path: string;
  name: string;
  size: number;
  mtime: Date | null;
}

export interface FileSource {
  list(): Promise<RemoteFile[]>;
  read(path: string): Promise<Buffer>;
  close(): Promise<void>;
}

export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** ftps when the share supports it */
  secure: boolean;
  root: string;
  /** How many folder levels to walk below root */
  depth: number;
}

export class FtpSource implements FileSource {
  private client: Client | null = null;

  constructor(private readonly cfg: FtpConfig) {}

  private async connect(): Promise<Client> {
    if (this.client && !this.client.closed) return this.client;
    const client = new Client(30_000);
    await client.access({ host: this.cfg.host, port: this.cfg.port, user: this.cfg.user, password: this.cfg.password, secure: this.cfg.secure });
    this.client = client;
    return client;
  }

  async list(): Promise<RemoteFile[]> {
    const client = await this.connect();
    const out: RemoteFile[] = [];
    const walk = async (dir: string, level: number) => {
      for (const entry of await client.list(dir)) {
        const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
        if (entry.isDirectory) {
          if (level < this.cfg.depth) await walk(path, level + 1);
        } else if (entry.isFile) {
          out.push({ path, name: entry.name, size: entry.size, mtime: entry.modifiedAt ?? null });
        }
      }
    };
    await walk(this.cfg.root, 0);
    return out;
  }

  async read(path: string): Promise<Buffer> {
    const client = await this.connect();
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    });
    await client.downloadTo(sink, path);
    return Buffer.concat(chunks);
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;
  }
}

export class FolderSource implements FileSource {
  constructor(private readonly root: string, private readonly depth = 2) {}

  async list(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    const walk = async (dir: string, level: number) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (level < this.depth) await walk(full, level + 1);
        } else if (entry.isFile()) {
          const s = await stat(full);
          out.push({ path: relative(this.root, full).split("\\").join("/"), name: entry.name, size: s.size, mtime: s.mtime });
        }
      }
    };
    await walk(this.root, 0);
    return out;
  }

  async read(path: string): Promise<Buffer> {
    return readFile(join(this.root, path));
  }

  async close(): Promise<void> {}
}
