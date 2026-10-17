// The X card, 1080×1080. PLACEHOLDER LAYOUT: the client supplies the real template, logo and
// licensed font (spec §11 Q4 and Q11). When it arrives, rebuild it here once; the variable slot is
// .headline inside the fixed .headline-box, and everything else is static.
//
// Fonts are inlined as data URIs. Nothing is fetched at render time: a slow CDN would mean a
// wrong-sized card.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const CARD_SIZE = 1080;
export const FONT_MIN_PX = 28;
export const FONT_MAX_PX = 96;

const require = createRequire(import.meta.url);

function fontDataUri(file: string): string {
  const path = require.resolve(`@fontsource/noto-sans-devanagari/files/${file}`);
  return `data:font/woff2;base64,${readFileSync(path).toString("base64")}`;
}

let fontCss: string | null = null;

/** Noto Sans Devanagari 700, Devanagari and Latin subsets, with the ranges fontsource uses. */
export function cardFontCss(): string {
  fontCss ??= `
@font-face { font-family: "Card"; font-weight: 700; font-display: block;
  src: url(${fontDataUri("noto-sans-devanagari-devanagari-700-normal.woff2")}) format("woff2");
  unicode-range: U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+20F0, U+25CC, U+A830-A839, U+A8E0-A8FF, U+11B00-11B09; }
@font-face { font-family: "Card"; font-weight: 700; font-display: block;
  src: url(${fontDataUri("noto-sans-devanagari-latin-700-normal.woff2")}) format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }`;
  return fontCss;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface CardInput {
  headline: string;
  /** Brand line in the top band */
  brand?: string;
  /** Account handle in the footer */
  handle?: string;
}

export function cardHtml({ headline, brand = "1st India News", handle = "@1stIndiaNews" }: CardInput): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${cardFontCss()}
* { box-sizing: border-box; margin: 0; }
html, body { width: ${CARD_SIZE}px; height: ${CARD_SIZE}px; background: #0e1116; }
#card { position: relative; width: ${CARD_SIZE}px; height: ${CARD_SIZE}px; overflow: hidden;
  background: linear-gradient(180deg, #121722 0%, #0b0d12 100%); font-family: "Card", sans-serif; color: #fff; }
.band { position: absolute; top: 0; left: 0; right: 0; height: 132px; background: #d7141a;
  display: flex; align-items: center; padding: 0 64px; font-size: 44px; letter-spacing: 0.02em; }
.headline-box { position: absolute; top: 230px; left: 80px; width: 920px; height: 520px;
  display: flex; align-items: center; justify-content: center; text-align: center; overflow: hidden; }
.headline { font-weight: 700; line-height: 1.5; text-wrap: balance; }
.foot { position: absolute; bottom: 0; left: 0; right: 0; height: 120px; border-top: 6px solid #d7141a;
  display: flex; align-items: center; justify-content: space-between; padding: 0 64px; font-size: 34px; color: #c9ced8; }
</style></head><body><div id="card">
<div class="band">${escapeHtml(brand)}</div>
<div class="headline-box"><div class="headline">${escapeHtml(headline)}</div></div>
<div class="foot"><span>${escapeHtml(handle)}</span><span>${escapeHtml(brand)}</span></div>
</div></body></html>`;
}
