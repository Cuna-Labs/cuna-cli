const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const MARK = /^[\p{Mark}\p{Cf}]+$/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3/u;

export function terminalCellWidth(value: string): number {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) width += graphemeCellWidth(segment);
  return width;
}

export function truncateTerminalLine(value: string, columns: number): string {
  if (!Number.isSafeInteger(columns) || columns < 1) return "";
  if (terminalCellWidth(value) <= columns) return value;
  if (columns === 1) return "…";
  let result = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    const segmentWidth = graphemeCellWidth(segment);
    if (width + segmentWidth + 1 > columns) break;
    result += segment;
    width += segmentWidth;
  }
  return `${result}…`;
}

function graphemeCellWidth(grapheme: string): number {
  if (grapheme.length === 0 || MARK.test(grapheme)) return 0;
  if (EMOJI.test(grapheme)) return 2;
  for (const symbol of grapheme) {
    const codePoint = symbol.codePointAt(0);
    if (codePoint !== undefined && isWideCodePoint(codePoint)) return 2;
  }
  return 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
