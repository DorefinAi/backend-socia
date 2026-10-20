// The X card, 1080×1080. PLACEHOLDER LAYOUT: the client supplies the real template and logo
// (spec §11 Q4 and Q11); the font is the client's Mangal. When the template arrives, rebuild it
// here once; the variable slot is .headline inside the fixed .headline-box, and everything else is static.
//
// Fonts are inlined as data URIs. Nothing is fetched at render time: a slow CDN would mean a
// wrong-sized card.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CARD_SIZE = 1080;
export const FONT_MIN_PX = 28;
export const FONT_MAX_PX = 96;

// apps/worker/fonts, reached from src/card/ under tsx and from dist/ once bundled
const FONT_DIR = [new URL("../../fonts/", import.meta.url), new URL("../fonts/", import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((dir) => existsSync(dir + "mangal.ttf"));

function fontDataUri(file: string): string {
  if (!FONT_DIR) throw new Error("card fonts not found: expected apps/worker/fonts/mangal.ttf");
  return `data:font/ttf;base64,${readFileSync(FONT_DIR + file).toString("base64")}`;
}

let fontCss: string | null = null;

/** Mangal: regular for the band and footer, bold for the headline. Covers Devanagari and Latin. */
export function cardFontCss(): string {
  fontCss ??= `
@font-face { font-family: "Card"; font-weight: 400; font-display: block;
  src: url(${fontDataUri("mangal.ttf")}) format("truetype"); }
@font-face { font-family: "Card"; font-weight: 700; font-display: block;
  src: url(${fontDataUri("mangalb.ttf")}) format("truetype"); }`;
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
