const MAXIMUM_BROWSER_URL_BYTES = 8 * 1024;

export function isBoundedHttpsBrowserUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || Buffer.byteLength(value, "utf8") > MAXIMUM_BROWSER_URL_BYTES) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
