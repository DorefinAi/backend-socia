// One spelling for matching. Devanagari has several valid encodings of the same name: precomposed
// or decomposed nukta (क़ U+0958 vs क + U+093C), chandrabindu vs anusvara, stray joiners. Without
// this fold, a name in the text silently fails to match the same name in the directory.
// Apply it to dictionary keys and to the text alike.

export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/़/g, "") // nukta
    .replace(/ँ/g, "ं") // chandrabindu → anusvara
    .replace(/[​-‍﻿]/g, "") // zero-width joiners and spaces
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}
