// b9: the city tags the composer put on a post (handle_pick.headingPlace.tags) are not the desk's typed tags, so they are
// never learned as topic rules nor staged for review. No database needed.
import { describe, expect, it } from "vitest";
import { composerCityTags, typedHashtags, type DraftHandlePick } from "../src";

const pick = (tags: string[]): DraftHandlePick => ({
  cls: "other", why: "", warnings: [], handles: [],
  headingPlace: { tags, district: "Jaipur", town: null, source: "fallback", placement: "trailing", card: null },
});

describe("the composer's city tags", () => {
  it("are read from headingPlace, lower-cased without the #", () => {
    expect([...composerCityTags(pick(["#Jaipur", "#नैनवां"]))]).toEqual(["jaipur", "नैनवां"]);
    expect(composerCityTags(null).size).toBe(0);
    expect(composerCityTags({ cls: "other", why: "", warnings: [], handles: [] }).size).toBe(0);
  });

  it("are not typed hashtags; a tag the desk typed beside them still is", () => {
    const typed = typedHashtags({ hashtags: ["#RajasthanWithFirstIndia", "#Jaipur", "#JaswantYadav"], hashtagSuggestions: [], handlePick: pick(["#Jaipur"]) });
    expect([...typed.values()]).toEqual(["#JaswantYadav"]);
  });

  it("a draft from before b9 (no headingPlace) behaves as before: every non-footer, non-suggested tag is typed", () => {
    const typed = typedHashtags({ hashtags: ["#RajasthanWithFirstIndia", "#Jaipur"], hashtagSuggestions: [], handlePick: { cls: "other", why: "", warnings: [], handles: [] } });
    expect([...typed.values()]).toEqual(["#Jaipur"]);
    expect([...typedHashtags({ hashtags: ["#Kota"], hashtagSuggestions: [] }).values()]).toEqual(["#Kota"]);
  });
});
