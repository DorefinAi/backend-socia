// Breaking files' bytes: UTF-8 and Notepad's "Unicode" (UTF-16) are read; anything that is not text is rejected.

import { describe, expect, it } from "vitest";
import { decodeBreakingFile } from "../src";

const STORY = "जयपुर: सड़क हादसे में दो घायल\nपुलिस मौके पर पहुंची\n";
const utf8 = (s: string) => new TextEncoder().encode(s);
function utf16(s: string, order: "le" | "be", bom: boolean): Uint8Array {
  const out: number[] = bom ? (order === "le" ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(...(order === "le" ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff]));
  }
  return new Uint8Array(out);
}

describe("decodeBreakingFile", () => {
  it("reads UTF-8, with or without a byte-order mark", () => {
    expect(decodeBreakingFile(utf8(STORY))).toEqual({ text: STORY, charset: "utf-8" });
    expect(decodeBreakingFile(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(STORY)]))).toEqual({ text: STORY, charset: "utf-8" });
  });

  it("reads Notepad's Unicode (UTF-16 LE or BE), with or without a byte-order mark", () => {
    expect(decodeBreakingFile(utf16(STORY, "le", true))).toEqual({ text: STORY, charset: "utf-16le" });
    expect(decodeBreakingFile(utf16(STORY, "be", true))).toEqual({ text: STORY, charset: "utf-16be" });
    // Latin-heavy text (a file-name line) has zero bytes in every other place: guessed without a mark
    const latin = "BTN_RJ_BREAKING_1_15NOV\n\nJaipur: two hurt in a road accident\n";
    expect(decodeBreakingFile(utf16(latin, "le", false))).toEqual({ text: latin, charset: "utf-16le" });
    expect(decodeBreakingFile(utf16(latin, "be", false))).toEqual({ text: latin, charset: "utf-16be" });
  });

  it("keeps a good file with a stray broken byte (shown as U+FFFD)", () => {
    const long = STORY.repeat(20);
    const bytes = utf8(long);
    const broken = new Uint8Array([...bytes.slice(0, 40), 0xff, ...bytes.slice(40)]);
    const out = decodeBreakingFile(broken);
    expect(out).toMatchObject({ charset: "utf-8" });
    expect("text" in out && out.text.includes("�")).toBe(true);
  });

  it("rejects bytes in no text encoding (e.g. an old ANSI / Kruti Dev file) and binary data", () => {
    // Every byte above 0x7F and no valid UTF-8 sequence: mostly junk when read as UTF-8
    const ansi = new Uint8Array(Array.from({ length: 200 }, (_, i) => 0xa0 + (i % 0x5f)));
    expect(decodeBreakingFile(ansi)).toEqual({ unreadable: expect.stringContaining("not text the desk saves") });
    // A picture or document saved with a .txt name: control bytes and NULs all through
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
    expect(decodeBreakingFile(png)).toHaveProperty("unreadable");
    expect(decodeBreakingFile(new Uint8Array([...utf8("जयपुर"), 0, ...utf8(" खबर")]))).toEqual({ unreadable: expect.stringContaining("binary data") });
  });

  it("passes an empty file on as empty text (the parser fails it: no headline)", () => {
    expect(decodeBreakingFile(new Uint8Array())).toEqual({ text: "", charset: "utf-8" });
  });
});
