import { describe, expect, it } from "vitest";
import { conversionConfidence, decodeBytes, detectEncoding, krutiToUnicode } from "../src";

// Hand-encoded with the provisional table. Replace with the 30-file regression set from the control
// room once the real .ttf and files arrive (spec §6.2).
const CASES: [string, string][] = [
  ["vkt fnYyh esa", "आज दिल्ली में"],
  ["jktLFkku", "राजस्थान"],
  ["t;iqj", "जयपुर"],
  ["eq[;ea=h", "मुख्यमंत्री"],
  ["dk;Z", "कार्य"],
  ["/keZ", "धर्म"],
  ["Hkkjr", "भारत"],
  ["fo/kkulHkk", "विधानसभा"],
  ["iz'kklu", "प्रशासन"],
  ["dksVk", "कोटा"],
  ["lM+d", "सड़क"],
  ["iqfyl", "पुलिस"],
  ["ckfj'k", "बारिश"],
  ["mn;iqj", "उदयपुर"],
  ["ljdkj", "सरकार"],
  ["fLFkfr", "स्थिति"],
  ["vkSj", "और"],
  ["ƒ„ gtkj djksM+", "१२ हजार करोड़"],
  ["dgk fd dke 'kq: gksxkA", "कहा कि काम शुरू होगा।"],
];

describe("krutiToUnicode", () => {
  it.each(CASES)("%s → %s", (kruti, unicode) => {
    expect(krutiToUnicode(kruti)).toBe(unicode);
  });

  it("moves the i-matra past a whole conjunct", () => {
    expect(krutiToUnicode("fiz;")).toBe("प्रिय");
  });

  it("leaves plain digits and spaces alone", () => {
    expect(krutiToUnicode("2026 esa")).toBe("2026 में");
  });
});

describe("conversionConfidence", () => {
  it("is 1 for clean Devanagari", () => {
    expect(conversionConfidence("आज दिल्ली में")).toBe(1);
  });

  it("drops when Latin letters are left over", () => {
    expect(conversionConfidence("आज Qx में")).toBeLessThan(0.97);
  });
});

describe("detectEncoding", () => {
  it("spots Unicode Hindi so it is not converted twice", () => {
    expect(detectEncoding("आज दिल्ली में बारिश")).toBe("unicode");
  });

  it("treats Latin noise as Kruti Dev", () => {
    expect(detectEncoding("vkt fnYyh esa ckfj'k")).toBe("krutidev");
  });
});

describe("decodeBytes", () => {
  it("reads Notepad ANSI as Windows-1252", () => {
    const { text, charset } = decodeBytes(new Uint8Array([0x83, 0x84]));
    expect(charset).toBe("windows-1252");
    expect(text).toBe("ƒ„");
  });

  it("reads UTF-8 with a BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("आज")]);
    expect(decodeBytes(bytes)).toEqual({ text: "आज", charset: "utf-8" });
  });
});
