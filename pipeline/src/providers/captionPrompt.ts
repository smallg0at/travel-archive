/**
 * The captioning brief, in one place.
 *
 * It used to be copied into both providers — `openaiCompatible.ts` said "the
 * same cataloguing brief Gemini gets" while holding its own copy, so a change to
 * one left the two captioning different things under the same field names.
 * Nothing enforced the sameness; this does.
 *
 * The private-content rule below exists because of a measurement. On 2026-10-13
 * two chat screenshots with no app name in the filename were captioned by a
 * local model as "a humorous chat conversation discussing voice assistants like
 * Siri" and "a mobile messaging thread discussing technology and making jokes
 * about emergency numbers" — it did not transcribe them, it *summarised* them,
 * which is the same leak by another door. The pipeline's own text scan
 * (`detectSensitive`) returns clean on both, because it looks for identifying
 * shapes (card and ID formats, the owner's own term list) and not for subject
 * matter. So the brief is what has to say it.
 */
export const CAPTION_PROMPT = `You are cataloging a personal photo library that mixes travel photos, everyday snapshots, and phone screenshots. There are no people to identify — focus on place, subject, and content.
- content_type: scene, document (signs/plaques/menus/text-heavy), food, landscape, screenshot (a screen capture, not a camera photo), or other.
- caption: one plain sentence, no preamble.
- tags: 3-6 short lowercase tags.
- extracted_text: if this is primarily a sign, museum plaque, menu, ticket, timetable or other document, transcribe its text. Otherwise null.
- notable: true only if this photo should get its own write-up; false for routine snapshots that can be folded into a day summary.
- personal content: never summarise, characterise, quote or transcribe a conversation, a message, an email, a notification or a personal record — a name beside an address, a phone number, an account, booking or ID number, a health note. For a screen holding any of that, name the kind of screen it is ("a chat conversation", "an email list", "a bank screen") and set extracted_text to null. This holds for every content_type, document included.`;

/** The OpenAI-compatible providers' JSON shape. Gemini carries the same contract as a schema. */
export const CAPTION_JSON = `Reply with ONE JSON object and nothing else:
{"content_type":"scene|document|food|landscape|screenshot|other","caption":"one plain sentence","tags":["3-6 short lowercase tags"],"extracted_text":"text transcribed from a sign/plaque/menu/ticket, or null — never a message, a name or a number","notable":true|false}`;
