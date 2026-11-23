// R8: the frontend's committed card place lists must equal what the backend data generates today. The frontend checkout is
// ../../frontend next to this repo, or SOCIA_FRONTEND_DIR; without either the comparison is skipped and said so.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PlaceBook } from "../src";
import { cardPlacesModule } from "../src/breaking/card-places";

const raw = JSON.parse(readFileSync(new URL("../../../apps/worker/config/rajasthan-places.json", import.meta.url), "utf8"));
const frontend = process.env.SOCIA_FRONTEND_DIR ?? fileURLToPath(new URL("../../../../frontend", import.meta.url));
const committed = join(frontend, "src/components/Newsroom/BreakingDesk/cardPlaces.generated.ts");

describe("card place lists (C3, R8)", () => {
  it.skipIf(!existsSync(committed))(`the committed frontend file matches the backend data (${committed})`, () => {
    expect(readFileSync(committed, "utf8").replace(/\r\n/g, "\n")).toBe(cardPlacesModule(raw));
  });

  it("national names keep their spaces; everyday-word towns are out in every spelling", () => {
    const text = cardPlacesModule(raw);
    expect(text).toContain(`"name": "Uttar Pradesh"`);
    expect(text).not.toMatch(/"name": "UttarPradesh"/);
    expect(PlaceBook.everydayWord("आन्धी")).toBe(true);
    expect(PlaceBook.everydayWord("आंधी")).toBe(true);
    const towns = JSON.parse(/CARD_TOWNS: readonly string\[\] = (\[.*\]);/.exec(text)![1]!) as string[];
    expect(towns).not.toContain("आंधी");
    expect(towns).not.toContain("आन्धी");
    expect(towns).not.toContain("बाप");
  });
});
