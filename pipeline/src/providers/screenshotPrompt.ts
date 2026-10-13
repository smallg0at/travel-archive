/**
 * The brief for a phone screenshot whose contents nobody has vouched for — the
 * 2,365 the package allowlist keeps off the wire.
 *
 * It is deliberately not the caption brief. That one describes camera photos and
 * the allowlisted travel screens, where naming a place and transcribing a plaque
 * or a timetable is the entire point; this one assumes the screen may hold
 * something private and describes the screen rather than what is on it. The
 * allowlist is what draws that line: a screen it admits goes down the ordinary
 * path, everything else lands here, and nothing is transcribed either way.
 *
 * Both rules came from measurement, not taste:
 *
 * - Name the kind of screen and nothing about its contents. A local model
 *   captioned two real chat screenshots as "a humorous chat conversation
 *   discussing voice assistants like Siri" and "a mobile messaging thread
 *   discussing technology and making jokes about emergency numbers" (2026-10-13)
 *   — not a transcription, a summary, which leaks the same content by another
 *   door. `detectSensitive` returns clean on both: it looks for identifying
 *   shapes, not for subject matter, so the brief is the guard.
 * - Nothing is transcribed from an unknown screen.
 *
 * The same wording inside the ordinary caption brief was tried and reverted the
 * same day: on the doc pool it suppressed a train ticket screen entirely,
 * halved a school activity list and an exhibition display, and dropped naming
 * from 42% to 25% — costs paid on material that is not private at all.
 */

/** What the screen is, never what it says. */
export const SCREENSHOT_PROMPT = `You are describing a phone screenshot for a personal archive. It may hold private material, so describe the screen itself and not its contents.
- what: what kind of screen this is, at most 8 words — "a chat conversation", "a bank screen", "a photo viewer".
- caption: one plain sentence about the screen as an object: the kind of interface, the app it belongs to, how it is laid out. Never what it says.
- personal content: never summarise, characterise, quote or transcribe a conversation, a message, an email, a notification or a personal record — a name beside an address, a phone number, an account, a booking or ID number, a health note. Name the kind of screen it is and stop there.
- extracted_text: always null. Nothing on an unknown screen is transcribed.`;

/**
 * The companion question, asked separately: should this screen be described at
 * all? Nothing in the pipeline asks it today — the allowlist decides — and a
 * model verdict must never release content, only rank what a person should look
 * at (a model that calls a private message a game screen has already misjudged
 * the thing the question is about).
 */
export const SCREENSHOT_VERDICT_PROMPT = `This is a phone screenshot. Do not transcribe any private content from it.
Answer with one JSON object and nothing else: {"what":"<what this screen is, max 8 words>","sensitive":true|false,"why":"<max 12 words>"}

sensitive=true if the screen holds any of: a person's name, a chat or mail body,
a payment or bank detail, a booking or ID number together with a name, a phone
number or address, health information, or anything else you would not show a stranger.
sensitive=false if it is a map, a timetable, weather, a ticket with no name on it,
a settings screen, a game UI, or a photo of the screen with nothing personal in it.`;
