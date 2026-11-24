// P7 (owner, 25 Nov 2026): a story from Rajasthan's state capital, which the desk tags #Jaipur by hand when the copy
// names no city: the CM, the Chief Secretary, the secretariat, the Rajasthan High Court, the assembly. Only ever an
// OFFER, and never on copy that names Delhi, another state or a foreign country (the CS's Seoul visit, the HC judge's
// Delhi visit, the Speaker back from Ahmedabad stay unoffered).

import type { PlaceBook } from "./places";
import { withoutRoutesAndBuildings } from "./parse";

const B = "(?<![\\p{L}\\p{M}\\p{N}])";
const E = "(?![\\p{L}\\p{M}\\p{N}])";
/** The capital's offices and institutions; "पूर्व मुख्यमंत्री" and "विधानसभा क्षेत्र/चुनाव/सीट" are not */
const CAPITAL = new RegExp(
  [
    `(?<!पूर्व[\\s\\u00a0\\u2010\\u2011-]*)${B}(?:मुख्यमंत्री|सीएम|CM)${E}`,
    `भजनलाल\\s*शर्मा`,
    `${B}मुख्य\\s*सचिव${E}`,
    `${B}CS${E}`,
    `${B}(?:शासन\\s*)?सचिवालय${E}`,
    `${B}राजस्थान\\s*(?:हाईकोर्ट|हाई\\s*कोर्ट|उच्च\\s*न्यायालय)${E}`,
    `${B}विधानसभा${E}(?!\\s*(?:क्षेत्र|क्षेत्रों|चुनाव|सीट|सीटों|उपचुनाव))`,
  ].join("|"),
  "u",
);
/** Foreign places the places file does not know (it knows the states, the big cities and a few countries) */
const FOREIGN = new RegExp(
  `${B}(?:विदेश|सियोल|कोरिया|लंदन|ब्रिटेन|दुबई|सिंगापुर|जापान|टोक्यो|न्यूयॉर्क|वाशिंगटन|पेरिस|फ्रांस|जर्मनी|रूस|मॉस्को|चीन|बीजिंग|कनाडा|ऑस्ट्रेलिया)${E}`,
  "u",
);

/** Whether the copy is a Rajasthan state-capital story with no other state or country in it */
export function stateCapitalStory(text: string, book: PlaceBook): boolean {
  const t = text.normalize("NFC");
  if (!CAPITAL.test(t) || FOREIGN.test(t)) return false;
  return !book.find(withoutRoutesAndBuildings(t)).some((m) => m.entry.data.kind === "national");
}
