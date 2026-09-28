/**
 * Label and value rows for a person, one per line, values in one column.
 *
 * Human outputs printed bare values (`active  admitted  assigned`) or raw
 * record keys (`environment_credential_variable  null`), which only a reader
 * who already knew the JSON record could decode. The JSON record keeps its
 * keys; this is the terminal's rendering of the same facts.
 */
export function labelledLines(
  rows: readonly (readonly [label: string, value: string])[],
  indent = "",
): string {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`).join("\n");
}
