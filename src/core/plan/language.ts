/**
 * The language a video is written, spoken and captioned in.
 *
 * This is not the interface language. The studio's own surface is English; what a video
 * says is a separate decision, made per video, because a brand can perfectly well
 * publish German thought leadership and English product announcements in the same week.
 *
 * Gemini's TTS infers the language from the text itself and the prebuilt voices are not
 * bound to one, so adding a language here costs nothing beyond naming it.
 */
export const CONTENT_LANGUAGES = ["en", "de", "fr", "es", "it", "nl", "pt", "pl"] as const;

export type ContentLanguage = typeof CONTENT_LANGUAGES[number];

export const LANGUAGE_NAMES: Record<ContentLanguage, string> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  pl: "Polish",
};

/** What the owner sees in a picker: the language named in itself. */
export const LANGUAGE_ENDONYMS: Record<ContentLanguage, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  nl: "Nederlands",
  pt: "Português",
  pl: "Polski",
};

export const isContentLanguage = (value: unknown): value is ContentLanguage =>
  typeof value === "string" && (CONTENT_LANGUAGES as readonly string[]).includes(value);

export const languageName = (language: string) =>
  isContentLanguage(language) ? LANGUAGE_NAMES[language] : language;
