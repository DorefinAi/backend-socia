// The polite web client refuses what it must never fetch. No network: every case is refused before a request.

import { describe, expect, it } from "vitest";
import { getText, politeGet, privateAddress, type WebGet } from "../src";

describe("privateAddress", () => {
  it("knows loopback, private, link-local, CGNAT and IPv6 local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "142.250.183.14", "172.32.0.1", "2404:6800:4009::200e"]) expect(privateAddress(ip), ip).toBe(false);
  });
});

describe("politeGet", () => {
  const get = politeGet("SociaTest/0");

  it("fetches https only, and never a local or private address", async () => {
    await expect(get("http://example.com/")).rejects.toThrow(/Only https/);
    await expect(get("https://localhost/x")).rejects.toThrow(/Local hosts/);
    await expect(get("https://127.0.0.1/x")).rejects.toThrow(/private address/);
    await expect(get("https://[::1]/x")).rejects.toThrow(/private address/);
    await expect(get("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/private address/);
    await expect(get("https://user:pw@example.com/")).rejects.toThrow(/credentials/);
  });
});

describe("getText", () => {
  it("returns a 200's text and names a 429 as rate limited", async () => {
    const fake = (status: number): WebGet => async (url) => ({ status, contentType: "text/xml", body: Buffer.from("<rss/>"), url });
    expect(await getText(fake(200), "https://a.in/")).toBe("<rss/>");
    await expect(getText(fake(429), "https://a.in/")).rejects.toThrow("HTTP 429 (rate limited)");
  });
});
