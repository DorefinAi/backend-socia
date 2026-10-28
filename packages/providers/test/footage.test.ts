// The newsroom FTP is read-only for Socia. These tests prove the footage reader can only list and
// download, and that no code on the Samvadia path even names an FTP write.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FTP_READ_ONLY_MEMBERS, FolderFootage, FtpFootage, cleanSharePath, readOnlyFtp } from "../src/footage";

const WRITES = ["uploadFrom", "appendFrom", "uploadFromDir", "rename", "remove", "removeDir", "removeEmptyDir", "ensureDir", "clearWorkingDir", "send", "sendIgnoringError", "cd", "cdup"];

/** A stand-in for basic-ftp's Client that records every member touched. */
function fakeFtp(tree: Record<string, { name: string; size: number; isDir?: boolean }[]>, files: Record<string, Buffer> = {}) {
  const touched: string[] = [];
  const target = {
    closed: false,
    async access() {},
    async list(dir: string) {
      const entries = tree[dir];
      if (!entries) throw Object.assign(new Error("550 No such file or directory"), { code: 550 });
      return entries.map((e) => ({ name: e.name, size: e.size, isDirectory: !!e.isDir, isFile: !e.isDir, modifiedAt: new Date(0) }));
    },
    async downloadTo(sink: NodeJS.WritableStream, path: string) {
      const data = files[path];
      if (!data) throw Object.assign(new Error("550"), { code: 550 });
      // basic-ftp listens for the sink's errors; so does this fake
      await new Promise<void>((resolve, reject) => {
        sink.once("error", reject);
        sink.write(data, (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      this.closed = true;
    },
    // Writes exist on the real client; the wrapper must never let them through
    ...Object.fromEntries(WRITES.map((w) => [w, async () => { throw new Error(`WRITE ${w} reached the server`); }])),
  };
  const spy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string") touched.push(prop);
      return Reflect.get(t, prop);
    },
  });
  return { client: spy, touched };
}

describe("readOnlyFtp", () => {
  it("blocks every write and raw command before it reaches the client", () => {
    const { client, touched } = fakeFtp({});
    const ro = readOnlyFtp(client) as unknown as Record<string, unknown>;
    for (const w of WRITES) expect(() => ro[w], w).toThrow(/read-only/);
    expect(touched.filter((t) => WRITES.includes(t))).toEqual([]);
  });

  it("lets only list, download, access and close through", () => {
    expect([...FTP_READ_ONLY_MEMBERS].sort()).toEqual(["access", "close", "closed", "downloadTo", "list"]);
  });

  it("cannot be modified", () => {
    const ro = readOnlyFtp(fakeFtp({}).client) as unknown as Record<string, unknown>;
    expect(() => {
      ro.uploadFrom = () => undefined;
    }).toThrow();
  });
});

describe("FtpFootage", () => {
  const folder = "/BARAN/oct2026/26102026/261026_BRN_DHAN_AV_MUKESH";
  const tree = {
    [folder]: [
      { name: "261026_BRN_DHAN_AV_MUKESH_01.jpg", size: 10 },
      { name: "261026_BRN_DHAN_AV_MUKESH.mp4", size: 20 },
      { name: "261026_BRN_DHAN_AV_MUKESH.xml", size: 1 },
      { name: ".DS_Store", size: 1 },
      { name: "VISUALS", size: 0, isDir: true },
    ],
    [`${folder}/VISUALS`]: [{ name: "raw.mp4", size: 30 }],
    "/BARAN/oct2026/26102026": [{ name: "single.jpg", size: 7 }],
  };

  it("lists a story folder and one level of subfolders, skipping sidecars, using only reads", async () => {
    const fake = fakeFtp(tree, { [`${folder}/261026_BRN_DHAN_AV_MUKESH_01.jpg`]: Buffer.from("jpgdata") });
    const ftp = new FtpFootage({ host: "localhost", port: 21, user: "u", password: "p", secure: false }, () => fake.client);
    const files = await ftp.listStoryFolder(`${folder}/`);
    expect(files.map((f) => f.name).sort()).toEqual(["261026_BRN_DHAN_AV_MUKESH.mp4", "261026_BRN_DHAN_AV_MUKESH_01.jpg", "VISUALS/raw.mp4"]);
    expect(files.find((f) => f.name === "VISUALS/raw.mp4")!.path).toBe(`${folder}/VISUALS/raw.mp4`);
    expect((await ftp.read(`${folder}/261026_BRN_DHAN_AV_MUKESH_01.jpg`, 100)).toString()).toBe("jpgdata");
    await ftp.close();
    expect(new Set(fake.touched)).toEqual(new Set(["access", "list", "downloadTo", "close", "closed"]));
  });

  it("treats a path to one file as that file, and a missing folder as empty", async () => {
    const ftp = new FtpFootage({ host: "h", port: 21, user: "u", password: "p", secure: false }, () => fakeFtp(tree).client);
    expect((await ftp.listStoryFolder("/BARAN/oct2026/26102026/single.jpg")).map((f) => f.size)).toEqual([7]);
    expect(await ftp.listStoryFolder("/BARAN/nope")).toEqual([]);
  });

  it("refuses a download over the size cap", async () => {
    const fake = fakeFtp(tree, { "/big.jpg": Buffer.alloc(50) });
    const ftp = new FtpFootage({ host: "h", port: 21, user: "u", password: "p", secure: false }, () => fake.client);
    await expect(ftp.read("/big.jpg", 10)).rejects.toThrow(/cap/);
  });
});

describe("FolderFootage", () => {
  it("maps share paths into the folder and never outside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "socia-footage-"));
    const dir = join(root, "Ajmer", "2026", "OCT 2026", "261026", "261026_AJM_HADSA_AV_SHUBHAM");
    await mkdir(join(dir, "VISUALS"), { recursive: true });
    await writeFile(join(dir, "a.jpg"), "a");
    await writeFile(join(dir, "VISUALS", "b.mp4"), "bb");
    await writeFile(join(dir, "Thumbs.db"), "x");
    const f = new FolderFootage(root);
    const files = await f.listStoryFolder("/Ajmer/2026/OCT 2026/261026/261026_AJM_HADSA_AV_SHUBHAM/");
    expect(files.map((x) => [x.name, x.size])).toEqual([["a.jpg", 1], ["VISUALS/b.mp4", 2]]);
    expect(files[0]!.path).toBe("/Ajmer/2026/OCT 2026/261026/261026_AJM_HADSA_AV_SHUBHAM/a.jpg");
    expect(await f.listStoryFolder("/Ajmer/missing")).toEqual([]);
    await expect(f.listStoryFolder("/../../etc")).rejects.toThrow(/\.\./);
    await expect(f.read(files[1]!.path, 1)).rejects.toThrow(/cap/);
  });

  it("cleans share paths", () => {
    expect(cleanSharePath("\\BARAN\\oct2026\\x\\")).toBe("/BARAN/oct2026/x");
    expect(cleanSharePath("//Ajmer/./2026/")).toBe("/Ajmer/2026");
  });
});

describe("no FTP writes on the Samvadia path", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const SOURCES = ["../src/footage.ts", "../../db/src/samvadia.ts", "../../../apps/worker/src/stages/samvadia.ts"];
  const FORBIDDEN = /\b(uploadFrom|appendFrom|uploadFromDir|rename|removeDir|removeEmptyDir|ensureDir|clearWorkingDir|sendIgnoringError)\s*\(|\.remove\s*\(|\.send\s*\(|\b(STOR|APPE|DELE|RNFR|RNTO|MKD|RMD|SITE)\s/;

  it.each(SOURCES)("%s calls no FTP write", async (rel) => {
    const code = (await readFile(join(here, rel), "utf8"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(FORBIDDEN);
  });
});
