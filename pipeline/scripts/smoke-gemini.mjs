// One-off smoke test for the Gemini provider, isolated from the full
// pipeline (no OneDrive/Azure needed) — just proves the @google/genai
// structured-output call shape in providers/gemini.ts actually works
// against the real API. Run after `npm run build`:
//   node scripts/smoke-gemini.mjs
import { geminiProvider } from "../dist/providers/gemini.js";

// A minimal valid 1x1 red PNG — content doesn't matter, this is only
// checking that the request/response contract (schema, JSON parsing) works.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

console.log("Testing geminiProvider.captionPhoto()...");
try {
  const caption = await geminiProvider.captionPhoto({
    imageBase64: TINY_PNG_BASE64,
    mediaType: "image/png",
  });
  console.log("OK:", caption);
} catch (err) {
  console.error("FAILED:", err);
  process.exitCode = 1;
}

console.log("\nTesting geminiProvider.summarizeDay()...");
try {
  const summary = await geminiProvider.summarizeDay({
    date: "2024-04-15",
    place: "a city, South Korea",
    photos: [
      { id: "p1", caption: "Museum placard about celadon pottery.", tags: ["museum", "ceramics"], contentType: "document", notable: true },
      { id: "p2", caption: "Bowl of tteokbokki at a street stall.", tags: ["food", "street-food"], contentType: "food", notable: false },
    ],
  });
  console.log("OK:", summary);
} catch (err) {
  console.error("FAILED:", err);
  process.exitCode = 1;
}
