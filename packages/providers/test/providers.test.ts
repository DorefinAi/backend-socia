import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeXClient, FolderSource, LocalStorage, XApiClient, XRateLimited, decryptSecret, encryptSecret,
  oauth1Header, parseSparqlRows,
} from "../src";

describe("oauth1Header", () => {
  // The worked example from X's "Creating a signature" documentation
  it("matches the documented signature", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});

describe("XApiClient", () => {
  const auth = { header: async () => "Bearer t" };

  it("posts JSON with the media id and builds the permalink", async () => {
    const calls: { url: string; body: string }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ data: { id: "123" } }), { status: 201 });
    };
    const x = new XApiClient({ auth, username: "1stIndiaNews", fetch: fake });
    expect(await x.createPost("खबर", ["m1"])).toEqual({ id: "123" });
    expect(JSON.parse(calls[0]!.body)).toEqual({ text: "खबर", media: { media_ids: ["m1"] } });
    expect(x.permalink("123")).toBe("https://x.com/1stIndiaNews/status/123");
  });

  it("turns a 429 into XRateLimited with the reset time", async () => {
    const fake: typeof fetch = async () => new Response("", { status: 429, headers: { "x-rate-limit-reset": "1900000000" } });
    const x = new XApiClient({ auth, username: "a", fetch: fake });
    const err = await x.createPost("t", []).catch((e) => e);
    expect(err).toBeInstanceOf(XRateLimited);
    expect(err.resetAt.getTime()).toBe(1_900_000_000_000);
  });

  it("treats deleting a missing post as done", async () => {
    const fake: typeof fetch = async () => new Response("{}", { status: 404 });
    await new XApiClient({ auth, username: "a", fetch: fake }).deletePost("1");
  });
});

describe("FakeXClient", () => {
  it("remembers posts for reconciliation", async () => {
    const x = new FakeXClient();
    const since = new Date(Date.now() - 1000);
    const { id } = await x.createPost("hello", []);
    expect((await x.recentPosts(since)).map((p) => p.id)).toEqual([id]);
  });
});

describe("secrets", () => {
  it("round-trips and refuses a wrong key", () => {
    const k1 = Buffer.alloc(32, 1).toString("base64");
    const k2 = Buffer.alloc(32, 2).toString("base64");
    const sealed = encryptSecret("refresh-token", k1);
    expect(decryptSecret(sealed, k1)).toBe("refresh-token");
    expect(() => decryptSecret(sealed, k2)).toThrow();
  });
});

describe("FolderSource and LocalStorage", () => {
  it("lists nested files and stores by key", async () => {
    const root = await mkdtemp(join(tmpdir(), "socia-"));
    await mkdir(join(root, "breaking"));
    await writeFile(join(root, "breaking", "JPR_METRO.txt"), "x");
    const files = await new FolderSource(root).list();
    expect(files.map((f) => f.path)).toEqual(["breaking/JPR_METRO.txt"]);

    const store = new LocalStorage(join(root, "store"), "http://localhost/dev-files");
    await store.put("cards/a b.png", new Uint8Array([1, 2]), "image/png");
    expect([...(await store.get("cards/a b.png"))]).toEqual([1, 2]);
    expect(await store.url("cards/a b.png")).toBe("http://localhost/dev-files/cards/a%20b.png");
    await expect(store.put("../escape", new Uint8Array(), "x")).rejects.toThrow();
  });
});

describe("parseSparqlRows", () => {
  it("strips the @ and falls back to the Hindi label", () => {
    const rows = parseSparqlRows([
      { item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Q1" }, hiLabel: { value: "भजनलाल शर्मा" }, handle: { value: "@BhajanlalBjp" } },
    ]);
    expect(rows[0]).toEqual({ qid: "Q1", label: "भजनलाल शर्मा", labelHi: "भजनलाल शर्मा", handle: "BhajanlalBjp", description: null });
  });
});
