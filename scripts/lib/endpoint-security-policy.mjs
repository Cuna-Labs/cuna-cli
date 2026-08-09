const PROHIBITED_WINDOWS_EXECUTION_PATTERNS = Object.freeze([
  { id: "windows-rundll32", pattern: /\brundll32(?:\.exe)?\b/iu },
  { id: "windows-url-dll-handler", pattern: /url\.dll\s*,\s*FileProtocolHandler/iu },
  {
    id: "encoded-powershell",
    pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\b/iu,
  },
  { id: "dynamic-powershell-compilation", pattern: /\bAdd-Type\b/iu },
  { id: "credential-pinvoke", pattern: /\badvapi32\.dll\b/iu },
]);

const COMPACT_PROHIBITED_TOKENS = Object.freeze([
  { id: "windows-rundll32", token: "rundll32" },
  { id: "windows-url-dll-handler", token: "urldllfileprotocolhandler" },
  { id: "dynamic-powershell-compilation", token: "addtype" },
  { id: "credential-pinvoke", token: "advapi32dll" },
]);

function compactSource(source) {
  return source.normalize("NFKC").replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

export function assertEndpointSecuritySource(source, label = "source") {
  for (const control of PROHIBITED_WINDOWS_EXECUTION_PATTERNS) {
    if (control.pattern.test(source)) {
      throw new Error(`${label} violates endpoint-security policy: ${control.id}`);
    }
  }
  const compact = compactSource(source);
  for (const control of COMPACT_PROHIBITED_TOKENS) {
    if (compact.includes(control.token)) {
      throw new Error(`${label} violates endpoint-security policy: ${control.id}`);
    }
  }
  if (
    compact.includes("powershell") &&
    /(?:encodedcommand|encodedcomman|encodedcomma|encodedcomm|encodedcom|encodedco|encodedc)/u.test(compact)
  ) {
    throw new Error(`${label} violates endpoint-security policy: encoded-powershell`);
  }
}
