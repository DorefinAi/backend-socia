import { describe, expect, it } from "vitest";
import { xvDayFolders, xvFingerprint, xvIsVideo, xvMarks, xvMatchFolder, xvScanDays } from "../src/share/rules";

describe("xvMarks: names as the desk writes them on the share", () => {
  const cases: [string, boolean, boolean, string][] = [
    ["x...done......42 करोड़ के फर्जी GST घोटाले का खुलासा  Didwana News .mp4", true, true, "42 करोड़ के फर्जी GST घोटाले का खुलासा Didwana News"],
    ["x......done.......जन्मदिन के जश्न की आड़ में युवकों का तांडव  Rajsamand News.mp4", true, true, "जन्मदिन के जश्न की आड़ में युवकों का तांडव Rajsamand News"],
    ["x...dpone,...पूर्व मंत्री Shanti Dhariwal  Kota News .mp4", true, true, "पूर्व मंत्री Shanti Dhariwal Kota News"],
    ["x......done......ashok gehlot.mp4", true, true, "ashok gehlot"],
    ["x..doneकांग्रेस, भाजपा, RLP में मुकाबला  Didwana News.mp4", true, true, "कांग्रेस, भाजपा, RLP में मुकाबला Didwana News"],
    ["X....Doneगांव में छाई शोक की लहर  Nagaur News.mp4", true, true, "गांव में छाई शोक की लहर Nagaur News"],
    ["X......GEHLOT...done.mp4", true, true, "GEHLOT"],
    ["x...jaipurrr.mp4", true, false, "jaipurrr"],
    ["x.....JO.mp4", true, false, "JO"],
    ["X...JODH.mp4", true, false, "JODH"],
    ["X..BARA.mp4", true, false, "BARA"],
    ["x....COMU(0).mp4", true, false, "COMU(0)"],
    ["x...donkey fair.mp4", true, false, "donkey fair"],
    ["Road Accident Bharatpur में बड़ा सड़क हादसा  Rajasthan News.mp4", false, false, "Road Accident Bharatpur में बड़ा सड़क हादसा Rajasthan News"],
    ["xylophone.mp4", false, false, "xylophone"],
    ["2026-11-24 13-03-00.mkv", false, false, "2026-11-24 13-03-00"],
  ];
  it.each(cases)("%s", (name, picked, done, title) => {
    expect(xvMarks(name)).toEqual({ picked, done, title });
  });
});

describe("share folders", () => {
  it("names the day in IST", () => {
    // 20:00 UTC on 24 Nov is 01:30 IST on 25 Nov
    expect(xvDayFolders(new Date("2026-11-24T20:00:00Z"))).toEqual({ year: "2026", month: "NOVEMBER 2026", day: "25-11-2026" });
  });
  it("scans today and yesterday", () => {
    expect(xvScanDays(new Date("2026-12-01T06:00:00Z")).map((d) => d.day)).toEqual(["01-12-2026", "30-11-2026"]);
  });
  it("matches the month folder without case", () => {
    expect(xvMatchFolder(["August 2026", "NOVEMBER 2026", "logo2"], "AUGUST 2026")).toBe("August 2026");
    expect(xvMatchFolder(["logo2"], "AUGUST 2026")).toBeNull();
  });
  it("knows video files", () => {
    expect(["a.mp4", "b.MKV", "c.mpg"].map(xvIsVideo)).toEqual([true, true, true]);
    expect(["d.png", "e.mpg.ese2"].map(xvIsVideo)).toEqual([false, false]);
  });
  it("fingerprints by size and time", () => {
    expect(xvFingerprint(123, new Date(5000))).toBe("123:5000");
  });
});
