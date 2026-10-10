// Speaker turns in broadcast transcripts: the quote silo for speech that has no
// quotation marks.
//
// The quote silo (quotedSpans) finds speech by its quotation marks. A broadcast
// transcript has none: PBS NewsHour and NPR print each turn under a speaker
// label, so a defense secretary's own words sat in the body as plain text and
// were marked as the outlet's. Observed live 2026-10-02: PBS's Hegseth segment
// published his "no fatties, no trannies, no beardos" line as the coverage's
// MOST HYSTERICAL wording and his "We are no longer the woke department" as its
// MOST PRACTICAL, while the scorer's own rationale said "those are his words,
// not the outlet's voice".
//
// The outlet's voice in a transcript is its host and its reporters. Every other
// labelled speaker (a newsmaker in a clip, a guest in an interview) is quoted
// speech, and their turns are siloed exactly as a quotation is.
//
// Who is staff is read from the labels themselves, by each outlet's convention:
//   NPR   "MICHEL MARTIN, HOST:" / "GUY MARZORATI, BYLINE:" mark staff; every
//         other speaker ("XAVIER BECERRA:") is a guest or a clip.
//   PBS   staff are labelled by bare name ("Geoff Bennett:"); a guest's first
//         label carries a title ("Peter Feaver, Duke University:") and a
//         newsmaker's may lead with one ("President Donald Trump:").
// A speaker is matched across labels by surname, so "Peter Feaver:" later in
// the piece is still the guest and NPR's "MARZORATI:" is still the reporter.
//
// The trade is deliberate. Misreading a host as a guest drops that host's
// highlights (a highlight lost); misreading a guest as staff publishes a quote
// as the outlet's framing (a false claim about the outlet). The rules lean to
// the first.

const STAFF_ROLE = /\b(HOST|BYLINE|ANCHOR|CORRESPONDENT|REPORTER|MODERATOR)\b/i;

// Honorifics that mark a speaker as a newsmaker when a PBS label leads with one.
const TITLE_PREFIX =
  /^(President|Vice President|Former President|Sen\.|Senator|Rep\.|Representative|Gov\.|Governor|Secretary|Mayor|Gen\.|General|Adm\.|Admiral|Dr\.|Judge|Justice|Prime Minister|Chancellor|Pope|King|Queen|Prince|Speaker|Leader|Attorney General)\s/;

// A label line: the speaker's name, optionally a comma-separated role or title,
// optionally a parenthetical ("(through interpreter)"), then a colon. PBS puts
// the label on its own line; NPR puts the turn's first words after it.
const LABEL = /^([A-Z][^:\n]{0,100}?):(?:[ \t]*$|[ \t]+(?=\S))/gm;

interface Label {
  start: number; // index of the label's first character
  bodyStart: number; // index where the turn's speech begins
  name: string; // the name alone, title prefix stripped
  surname: string;
  titled: boolean; // a comma role, a parenthetical, or a leading honorific
  staffRole: boolean;
  allCaps: boolean;
  standalone: boolean; // nothing follows the colon on the label's line
}

function parseLabel(match: RegExpExecArray): Label | null {
  const raw = match[1]!.trim();
  const [beforeParen] = raw.split("(");
  const [namePart, ...roleParts] = beforeParen!.split(",");
  const name0 = namePart!.trim();
  const role = roleParts.join(",").trim();
  const allCaps = name0 === name0.toUpperCase() && /[A-Z]/.test(name0);
  const titlePrefix = TITLE_PREFIX.test(name0);
  const name = name0.replace(TITLE_PREFIX, "").trim();
  const words = name.split(/\s+/).filter(Boolean);
  // A person's name: one to four capitalised words. One word is allowed only in
  // NPR's all-caps convention ("MARZORATI:"), where it is the surname repeat.
  if (words.length === 0 || words.length > 4) return null;
  if (words.length === 1 && !allCaps) return null;
  // PBS's mixed-case labels stand alone on their line with the colon tight
  // against the name; a mid-sentence "said in a statement:" or a caption
  // "Photograph:" does not.
  const standalone = /:[ \t]*$/.test(match[0]);
  if (!allCaps && (!standalone || /\s$/.test(match[1]!))) return null;
  if (!words.every((w) => /^[A-Z][A-Za-z.'’\-]*$/.test(w))) return null;
  // A role must read as a role, not a sentence ("Here is what he said").
  if (role.split(/\s+/).length > 10) return null;
  return {
    start: match.index,
    bodyStart: match.index + match[0].length,
    name,
    surname: words[words.length - 1]!.toUpperCase(),
    titled: titlePrefix || role.length > 0 || raw.includes("("),
    staffRole: STAFF_ROLE.test(role),
    allCaps,
    standalone,
  };
}

function labelsIn(text: string): Label[] {
  const out: Label[] = [];
  for (const m of text.matchAll(LABEL)) {
    const label = parseLabel(m as RegExpExecArray);
    if (label) out.push(label);
  }
  return out;
}

// Spans of the text spoken by someone other than the outlet's own host and
// reporters. Empty for anything that is not a transcript (fewer than two
// speaker labels), so ordinary articles are untouched.
export function nonStaffSpeechSpans(text: string): Array<[number, number]> {
  const parsed = labelsIn(text);
  // All-caps labels are a transcript only in NPR's convention, which names its
  // staff. Without a HOST or BYLINE label they are newsletter section heads
  // ("FIRST ON FOX:", "WORKING OUT THE KINKS:"), not speakers.
  const nprStyle = parsed.some((l) => l.allCaps && l.staffRole);
  const labels = parsed.filter((l) => !l.allCaps || nprStyle);
  if (labels.length < 2 || new Set(labels.map((l) => l.surname)).size < 2) return [];
  // A mixed-case transcript has a host who speaks more than once, untitled, and
  // at least one titled guest. Two stray name-like lines are not a transcript.
  if (!nprStyle) {
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l.surname, (counts.get(l.surname) ?? 0) + 1);
    const titledNames = new Set(labels.filter((l) => l.titled).map((l) => l.surname));
    const hasHost = [...counts].some(([name, n]) => n >= 2 && !titledNames.has(name));
    if (!hasHost || titledNames.size === 0) return [];
  }

  const staff = new Set<string>();
  const outside = new Set<string>();
  for (const l of labels) {
    if (l.staffRole) staff.add(l.surname);
    else if (l.allCaps || l.titled) outside.add(l.surname);
  }
  // NPR (all caps): staff only when a label says so. PBS: staff unless any of
  // the speaker's labels carried a title. A staff role wins over a title.
  const isStaff = (l: Label) => staff.has(l.surname) || (!l.allCaps && !outside.has(l.surname));

  const spans: Array<[number, number]> = [];
  labels.forEach((l, i) => {
    if (isStaff(l)) return;
    const end = i + 1 < labels.length ? labels[i + 1]!.start : text.length;
    if (end > l.bodyStart) spans.push([l.bodyStart, end]);
  });
  return spans;
}
