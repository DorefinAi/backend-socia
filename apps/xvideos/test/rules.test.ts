import { describe, expect, it } from "vitest";
import { xvDayDate, xvDayFolders, xvFingerprint, xvHeading, xvIsVideo, xvMarks, xvMatchFolder, xvMonthOf, xvScanMonths, xvToday } from "../src/share/rules";

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

describe("xvHeading: the posted title when the name is one", () => {
  // Real names from the share, 27 Nov 2026
  const cases: [string, string | null][] = [
    [
      "SI भर्ती पेपर लीक प्रकरण में10 हजार का इनामी श्रीराम बिश्नोई गिरफ्तार  Special Operations Group   Jaipur News.mp4",
      "SI भर्ती पेपर लीक प्रकरण में10 हजार का इनामी श्रीराम बिश्नोई गिरफ्तार | Special Operations Group | Jaipur News",
    ],
    [
      "x...done....PM Modi की अध्यक्षता में कैबिनेट की बैठक में फैसला, परिसीमन बिल में संशोधन की मंजूरी-सूत्र  Delhi News .mp4",
      "PM Modi की अध्यक्षता में कैबिनेट की बैठक में फैसला, परिसीमन बिल में संशोधन की मंजूरी-सूत्र | Delhi News",
    ],
    ["X......GEHLOT...done.mp4", null],
    ["x...done....JAIPUR POLICE.mp4", null],
    ["X...JDR Hadsa.mp4", null],
    ["murti meena Bite.mp4", null],
    ["------------chomu.mp4", null],
    ["1oSqE_Rs5J0e_NKA.mp4", null],
    // Hindi but too short: a name, not a headline
    ["x...अशोक गहलोत.mp4", null],
  ];
  it.each(cases)("%s", (name, heading) => {
    expect(xvHeading(name)).toBe(heading);
  });

  it("takes only two or more plain spaces as \" | \": no-break and zero-width spaces are one space", () => {
    const words = "पंचायत चुनाव में भाजपा और कांग्रेस के बीच कड़ा मुकाबला";
    expect(xvHeading(`${words}  Kota News.mp4`)).toBe(`${words} Kota News`);
    expect(xvHeading(`${words}  Kota​ News.mp4`)).toBe(`${words} Kota News`);
    expect(xvHeading(`${words}　Kota News.mp4`)).toBe(`${words} Kota News`);
    expect(xvHeading(`${words}   Kota News.mp4`)).toBe(`${words} | Kota News`);
  });

  it("keeps a done mark at the end out of the heading, and needs Hindi", () => {
    expect(xvHeading("X......पंचायत चुनाव में भाजपा और कांग्रेस के बीच मुकाबला  Kota News...done.mp4")).toBe("पंचायत चुनाव में भाजपा और कांग्रेस के बीच मुकाबला | Kota News");
    expect(xvHeading("Road accident on the Jaipur Delhi highway today.mp4")).toBeNull();
  });
});

describe("share folders", () => {
  it("names the day in IST", () => {
    // 20:00 UTC on 24 Nov is 01:30 IST on 25 Nov
    expect(xvDayFolders(new Date("2026-11-24T20:00:00Z"))).toEqual({ year: "2026", month: "NOVEMBER 2026", day: "25-11-2026" });
  });
  it("scans this month, and last month in a new month's first days", () => {
    expect(xvScanMonths(new Date("2026-11-27T06:00:00Z"))).toEqual([{ year: "2026", month: "NOVEMBER 2026" }]);
    expect(xvScanMonths(new Date("2027-01-03T06:00:00Z"))).toEqual([
      { year: "2027", month: "JANUARY 2027" },
      { year: "2026", month: "DECEMBER 2026" },
    ]);
  });
  it("names today in IST, not UTC", () => {
    // 19:00 UTC on 27 Nov is 00:30 IST on 28 Nov
    expect(xvToday(new Date("2026-11-27T19:00:00Z"))).toBe("2026-11-28");
    expect(xvToday(new Date("2026-11-27T18:00:00Z"))).toBe("2026-11-27");
  });
  it("finds a day's month folder", () => {
    expect(xvMonthOf("2026-11-30")).toEqual({ year: "2026", month: "NOVEMBER 2026" });
    expect(xvMonthOf("2027-01-01")).toEqual({ year: "2027", month: "JANUARY 2027" });
  });
  it("reads a day folder's date, and nothing else", () => {
    expect(xvDayDate("27-11-2026")).toBe("2026-11-27");
    expect(xvDayDate(" 7-11-2026 ")).toBe("2026-11-07");
    expect(xvDayDate("27.11.2026")).toBe("2026-11-27");
    expect(["31-02-2026", "Convert 3 pm", "2026-11-27", "27-11-26"].map(xvDayDate)).toEqual([null, null, null, null]);
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
