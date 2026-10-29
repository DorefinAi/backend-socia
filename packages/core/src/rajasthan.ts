// Rajasthan's 41 districts (after the December 2024 rollback of 9 of the 17 new districts), Latin and
// Devanagari, with the common spellings. Used to tag web trends with a district when the org's own
// hashtag_rules do not already name it; the hashtag rules always win for the tag itself.

export interface District {
  /** As written in English copy: "Sawai Madhopur" */
  name: string;
  hi: string;
  aliases: string[];
}

export const RAJASTHAN_DISTRICTS: District[] = [
  { name: "Ajmer", hi: "अजमेर", aliases: [] },
  { name: "Alwar", hi: "अलवर", aliases: [] },
  { name: "Balotra", hi: "बालोतरा", aliases: [] },
  { name: "Banswara", hi: "बांसवाड़ा", aliases: ["बांसवाडा"] },
  { name: "Baran", hi: "बारां", aliases: [] },
  { name: "Barmer", hi: "बाड़मेर", aliases: ["बाडमेर"] },
  { name: "Beawar", hi: "ब्यावर", aliases: [] },
  { name: "Bharatpur", hi: "भरतपुर", aliases: [] },
  { name: "Bhilwara", hi: "भीलवाड़ा", aliases: ["भीलवाडा"] },
  { name: "Bikaner", hi: "बीकानेर", aliases: [] },
  { name: "Bundi", hi: "बूंदी", aliases: ["बूँदी"] },
  { name: "Chittorgarh", hi: "चित्तौड़गढ़", aliases: ["Chittaurgarh", "Chittor", "चित्तौड़"] },
  { name: "Churu", hi: "चूरू", aliases: [] },
  { name: "Dausa", hi: "दौसा", aliases: [] },
  { name: "Deeg", hi: "डीग", aliases: [] },
  { name: "Dholpur", hi: "धौलपुर", aliases: [] },
  { name: "Didwana-Kuchaman", hi: "डीडवाना-कुचामन", aliases: ["Didwana", "Kuchaman", "डीडवाना", "कुचामन"] },
  { name: "Dungarpur", hi: "डूंगरपुर", aliases: [] },
  { name: "Hanumangarh", hi: "हनुमानगढ़", aliases: [] },
  { name: "Jaipur", hi: "जयपुर", aliases: [] },
  { name: "Jaisalmer", hi: "जैसलमेर", aliases: [] },
  { name: "Jalore", hi: "जालोर", aliases: ["Jalor", "जालौर"] },
  { name: "Jhalawar", hi: "झालावाड़", aliases: ["झालावाड"] },
  { name: "Jhunjhunu", hi: "झुंझुनूं", aliases: ["Jhunjhunun", "झुंझुनू"] },
  { name: "Jodhpur", hi: "जोधपुर", aliases: [] },
  { name: "Karauli", hi: "करौली", aliases: [] },
  { name: "Khairthal-Tijara", hi: "खैरथल-तिजारा", aliases: ["Khairthal", "Tijara", "खैरथल", "तिजारा"] },
  { name: "Kota", hi: "कोटा", aliases: [] },
  { name: "Kotputli-Behror", hi: "कोटपूतली-बहरोड़", aliases: ["Kotputli", "Behror", "कोटपूतली", "बहरोड़"] },
  { name: "Nagaur", hi: "नागौर", aliases: [] },
  { name: "Pali", hi: "पाली", aliases: [] },
  { name: "Phalodi", hi: "फलोदी", aliases: [] },
  { name: "Pratapgarh", hi: "प्रतापगढ़", aliases: [] },
  { name: "Rajsamand", hi: "राजसमंद", aliases: [] },
  { name: "Salumbar", hi: "सलूंबर", aliases: ["Salumber", "सलूम्बर"] },
  { name: "Sawai Madhopur", hi: "सवाई माधोपुर", aliases: [] },
  { name: "Sikar", hi: "सीकर", aliases: [] },
  { name: "Sirohi", hi: "सिरोही", aliases: [] },
  { name: "Sri Ganganagar", hi: "श्रीगंगानगर", aliases: ["Ganganagar", "Shri Ganganagar", "गंगानगर"] },
  { name: "Tonk", hi: "टोंक", aliases: [] },
  { name: "Udaipur", hi: "उदयपुर", aliases: [] },
];
