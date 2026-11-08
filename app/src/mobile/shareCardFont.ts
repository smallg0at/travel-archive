/**
 * Loads the serif the editorial card is set in.
 *
 * Android's WebView has no Chinese serif: `serif` resolves to Noto Serif for
 * Latin and falls back to Noto Sans CJK for hanzi, so an editorial card would
 * silently arrive in the sans-serif it was chosen to avoid. The app therefore
 * ships a 1.3MB subset (weight 600, the 6,763 hanzi of GB2312 plus Latin and
 * punctuation, built by `scripts/build-card-font.py`) under a private family
 * name, so a system font of the same name can never shadow it.
 *
 * Loading is lazy and idempotent: a canvas will silently draw with the fallback
 * if the face has not finished loading, and only the gallery card needs it, so
 * it is fetched the first time an editorial card is painted.
 */

const FAMILY = "Noto Serif SC Archive";
const URL = "/fonts/NotoSerifSC-SemiBold.woff2";

let loading: Promise<void> | null = null;

export function ensureCardFont(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      if (typeof FontFace === "undefined") return;
      try {
        const face = new FontFace(FAMILY, `url("${URL}") format("woff2")`, {
          weight: "600",
          style: "normal",
          display: "block",
        });
        await face.load();
        document.fonts.add(face);
      } catch (error) {
        // Offline first run, a blocked asset, or an old WebView: the card still
        // renders, in whatever serif the platform has for Latin and a sans for
        // hanzi. Worth a warning, not a failed share.
        console.warn("Card font unavailable:", error);
      }
    })();
  }
  return loading;
}
