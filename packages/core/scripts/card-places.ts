// Writes the desk card's place lists (frontend cardPlaces.generated.ts) from the backend's own place data (plan C3).
// Run after changing rajasthan-places.json, rajasthan.ts or places.ts, and commit the frontend file it writes; the core
// test card-places.test.ts fails while the committed file differs:
//
//   node --import tsx packages/core/scripts/card-places.ts ../frontend/src/components/Newsroom/BreakingDesk/cardPlaces.generated.ts

import { readFileSync, writeFileSync } from "node:fs";
import { cardPlacesModule } from "../src/breaking/card-places";

const out = process.argv[2];
if (!out) {
  console.error("usage: card-places.ts <path of cardPlaces.generated.ts>");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(new URL("../../../apps/worker/config/rajasthan-places.json", import.meta.url), "utf8"));
writeFileSync(out, cardPlacesModule(raw));
console.log(`→ ${out}`);
