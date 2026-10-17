// Headless Chromium with a warm pool of pages: launching a browser per card costs about 1 s.
// Each card: set the HTML, wait for the fonts, binary-search the largest headline size that fits
// its box, screenshot. The same text always gives the same size.

import { LARGEST_FITTING_SOURCE } from "@socia/core";
import { chromium, type Browser, type Page } from "playwright";
import { CARD_SIZE, FONT_MAX_PX, FONT_MIN_PX, cardHtml, type CardInput } from "./template";

/** Recycle a page after this many renders, to cap memory drift. */
const RECYCLE_AFTER = 200;

// Sent as a string, not a function: bundlers can wrap functions in helpers (esbuild's __name)
// that do not exist inside the page.
const FIT_SCRIPT = `(() => {
  const el = document.querySelector(".headline");
  const box = el.parentElement;
  const fits = (px) => {
    el.style.fontSize = px + "px";
    return el.scrollHeight <= box.clientHeight && el.scrollWidth <= box.clientWidth;
  };
  const largestFitting = (${LARGEST_FITTING_SOURCE});
  const best = largestFitting(fits, ${FONT_MIN_PX}, ${FONT_MAX_PX});
  fits(best);
  return best;
})()`;

interface PooledPage {
  page: Page;
  uses: number;
}

export class CardRenderer {
  private browser: Browser | null = null;
  private readonly idle: PooledPage[] = [];
  private readonly waiters: ((p: PooledPage) => void)[] = [];

  constructor(private readonly poolSize = 3) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
    for (let i = 0; i < this.poolSize; i++) this.idle.push(await this.newPage());
  }

  private async newPage(): Promise<PooledPage> {
    const page = await this.browser!.newPage({ viewport: { width: CARD_SIZE, height: CARD_SIZE }, deviceScaleFactor: 1 });
    return { page, uses: 0 };
  }

  private acquire(): Promise<PooledPage> {
    const p = this.idle.pop();
    if (p) return Promise.resolve(p);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async release(p: PooledPage): Promise<void> {
    let next = p;
    if (p.uses >= RECYCLE_AFTER) {
      await p.page.close().catch(() => undefined);
      next = await this.newPage();
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(next);
    else this.idle.push(next);
  }

  async render(input: CardInput): Promise<{ png: Buffer; fontPx: number }> {
    if (!this.browser) throw new Error("CardRenderer.start() was not called");
    const pooled = await this.acquire();
    try {
      pooled.uses += 1;
      const { page } = pooled;
      await page.setContent(cardHtml(input), { waitUntil: "load" });
      // Measure only after the real font is in: measuring the fallback gives every card the wrong size
      await page.evaluate("document.fonts.ready.then(() => true)");
      const fontPx = Number(await page.evaluate(FIT_SCRIPT));
      const png = await page.locator("#card").screenshot({ type: "png" });
      return { png, fontPx };
    } finally {
      await this.release(pooled);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
