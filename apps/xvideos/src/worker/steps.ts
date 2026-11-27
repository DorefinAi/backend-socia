// Which step a clip goes to next (README §3): probe, then read when speech is on, then the screen read for its
// headline when the file's name holds none, then the desk. Pure.

import type { XvClipRow, XvStep } from "../db/schema";

export type XvNextStep = (clip: Pick<XvClipRow, "heading">) => XvStep | null;

export function xvNextSteps(opts: { speech: boolean; headline: boolean }): { afterProbe: XvNextStep; afterRead: XvNextStep } {
  const afterRead: XvNextStep = (clip) => (opts.headline && !clip.heading ? "headline" : null);
  return { afterProbe: (clip) => (opts.speech ? "read" : afterRead(clip)), afterRead };
}
