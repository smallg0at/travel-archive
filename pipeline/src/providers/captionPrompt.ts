/**
 * The captioning brief, in one place.
 *
 * It used to be copied into both providers — `openaiCompatible.ts` said "the
 * same cataloguing brief Gemini gets" while holding its own copy, so a change to
 * one left the two captioning different things under the same field names.
 * Nothing enforced the sameness; this does.
 *
 * The script rule exists because of a measurement. On 2026-10-13 a local model
 * transcribing a Chinese weather screen wrote 舒适度 as 舒 followed by U+CF8C (쾌,
 * a Hangul syllable — the Korean word for the same idea), a cross-lingual
 * look-alike rather than mojibake: the bytes are valid UTF-8, and an audit of
 * 32,831 photos found the cloud-written Chinese text clean on this axis. Chinese
 * stays Chinese.
 *
 * A privacy rule lived here for part of that day and was moved out
 * (`screenshotPrompt.ts`). This brief describes camera photos and the allowlisted
 * travel screens; the screens whose contents nobody has vouched for are the
 * local-only pass's job, and that is the case the rule was written for. Keeping
 * it here measurably cost naming (42% → 25%), transcription volume (0.88 → 0.73
 * of the cloud's, with one document suppressed entirely) and time (24 → 32-37 s
 * a call) on material that is not private at all.
 */
export const CAPTION_PROMPT = `You are cataloging a personal photo library that mixes travel photos, everyday snapshots, and phone screenshots. There are no people to identify — focus on place, subject, and content.
- content_type: scene, document (signs/plaques/menus/text-heavy), food, landscape, screenshot (a screen capture, not a camera photo), or other.
- caption: one plain sentence, no preamble.
- tags: 3-6 short lowercase tags.
- extracted_text: if this is primarily a sign, museum plaque, menu, or document, transcribe its text in full. Otherwise null.
- notable: true only if this photo should get its own write-up; false for routine snapshots that can be folded into a day summary.
- script: transcribe in the script the text is really written in, and in the form it is written in. Chinese stays Chinese — never look-alike Japanese kana or Korean Hangul — and its characters keep their own form: never convert Simplified to Traditional or Traditional to Simplified. A 2017 school notice photographed in Simplified came back as 活動教室 / 體能 / 護膚, and search cannot match that against 活动教室. If a character is not legible, leave it out rather than substituting a similar one.`;

/** The OpenAI-compatible providers' JSON shape. Gemini carries the same contract as a schema. */
export const CAPTION_JSON = `Reply with ONE JSON object and nothing else:
{"content_type":"scene|document|food|landscape|screenshot|other","caption":"one plain sentence","tags":["3-6 short lowercase tags"],"extracted_text":"full transcribed text, or null","notable":true|false}`;
