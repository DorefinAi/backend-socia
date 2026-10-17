// The card renderer's auto-fit. Binary search for the largest font size whose text still fits the
// headline box. The browser does the measuring; this is the search, kept pure so it can be tested
// and so the render worker and any preview use the same steps.

export function largestFitting(fits: (px: number) => boolean, min: number, max: number): number {
  let lo = Math.ceil(min);
  let hi = Math.floor(max);
  let best = lo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** The same search as a string, for page.evaluate() inside Chromium. */
export const LARGEST_FITTING_SOURCE = largestFitting.toString();
