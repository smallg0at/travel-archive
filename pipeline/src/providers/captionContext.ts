import type { CaptionContext } from "./types.js";

/**
 * Where and when a photo was taken, as a prompt block. Shared by every
 * provider, so a caption means the same thing whichever model wrote it.
 *
 * Framed hard as naming help. Context invites a model to assert what it cannot
 * see — a photo tagged "the railway museum" becomes "a locomotive in the
 * the railway museum" whether or not the picture shows one — and a caption that
 * confidently states the wrong thing is worse than a vague one, because
 * everything downstream reads captions as observations.
 *
 * The map's nearest named place gets its own caution: at street level the
 * nearest object is often a neighbour of the subject — the café inside the
 * museum, one platform of the station — so it is a candidate name, not a fact.
 */
export function captionContextBlock(context: CaptionContext | null): string {
  if (!context) return "";
  const lines: string[] = [];
  if (context.takenAt) lines.push(`Taken: ${context.takenAt} (the camera's clock)`);
  if (context.trip) lines.push(`Part of a trip the owner called: ${context.trip}`);
  if (context.place) lines.push(`Town, from GPS (a hint, not confirmed by this image): ${context.place}`);
  if (context.venue) lines.push(`Nearest named place on the map at those coordinates: ${context.venue}`);
  if (context.street) lines.push(`Street: ${context.street}`);
  if (context.dayNote) lines.push(`The owner's own note about this day: "${context.dayNote}"`);
  if (!lines.length && !context.isVideo) return "";
  const videoLine = context.isVideo
    ? "This image is the **poster frame of a video**, not a photograph — describe what this frame shows, and do not describe motion, sound or anything the single frame cannot support."
    : null;
  return [
    "",
    "",
    "CONTEXT — use it only to name what you can already see, never to add what you cannot:",
    ...(videoLine ? [videoLine] : []),
    ...lines,
    "",
    "If this context lets you name a place, a building or an exhibit that the image shows, use the name. " +
      "The map's nearest named place can be a neighbour of what is photographed, so use it only where the image agrees. " +
      "The owner's note is about the whole day, not necessarily this photo. " +
      "If the image does not support the context, ignore it and describe only what is in the frame. " +
      "Never state that the photo was taken somewhere on the strength of the context alone.",
  ].join("\n");
}
