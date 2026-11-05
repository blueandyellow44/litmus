// Brand copy that more than one surface prints, written once so the header, the
// document title and the reference block cannot word the promise differently.
//
// The tagline is the ruled one (docs/plans/story-first-build-2026-09-13.md,
// Rulings: Design). The engine spec forbids "how it's being bent" as public
// wording, even though the Quiet Reader mocks use it.

export const BRAND_NAME = "LITMUS";
export const TAGLINE = "What happened, and how each outlet told it.";

export const BYLINE_TEXT = "by Max Sheahan";
export const BYLINE_HREF = "https://maxsheahan.com";

// /legal is a static file in public/, so it is linked with a plain anchor: the
// router's catch-all would send a client-side navigation back to the front page.
export const LEGAL_HREF = "/legal";

// The weekly letter (Max, 2026-10-11: Buttondown, weekly). The signup is a plain
// HTML form posted straight to Buttondown, so this is the form's action URL,
// copied from the newsletter's own embed page. Null until that newsletter
// exists: every signup surface renders nothing rather than a form that posts
// nowhere.
export const LETTER_FORM_ACTION: string | null = "https://buttondown.com/api/emails/embed-subscribe/sheahan";

export const LETTER_NAME = "The weekly letter";
export const LETTER_PITCH = "Once a week, the calmest and the hottest telling of the most covered stories.";

// The privacy note is a section of the static legal page.
export const LETTER_PRIVACY_HREF = "/legal#privacy";
