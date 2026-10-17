// Object storage. Render services have no shared disk, so raw files and card PNGs live here from
// day one. R2 (or any S3-compatible store) in production; a local folder for development.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** A short-lived link the browser can load, e.g. a card preview */
  url(key: string, seconds?: number): Promise<string>;
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region ?? "auto",
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async url(key: string, seconds = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: seconds });
  }
}

/** Development only: files under a folder, served by the API at /dev-files/<key>. */
export class LocalStorage implements Storage {
  constructor(private readonly root: string, private readonly publicBase: string) {}

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(resolve(this.root))) throw new Error(`Storage key escapes the folder: ${key}`);
    return full;
  }

  async put(key: string, body: Uint8Array, _contentType?: string): Promise<void> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async url(key: string): Promise<string> {
    return `${this.publicBase}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  resolveKey(key: string): string {
    return this.path(join(key));
  }
}
