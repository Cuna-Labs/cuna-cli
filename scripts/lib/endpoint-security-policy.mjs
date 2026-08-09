const PROHIBITED_WINDOWS_EXECUTION_PATTERNS = Object.freeze([
  { id: "windows-rundll32", pattern: /\brundll32(?:\.exe)?\b/iu },
  { id: "windows-url-dll-handler", pattern: /url\.dll\s*,\s*FileProtocolHandler/iu },
  { id: "encoded-powershell", pattern: /\bpowershell(?:\.exe)?\b[^\r\n]*-EncodedCommand\b/iu },
  { id: "dynamic-powershell-compilation", pattern: /\bAdd-Type\b/iu },
  { id: "credential-pinvoke", pattern: /\badvapi32\.dll\b/iu },
]);

export function assertEndpointSecuritySource(source, label = "source") {
  for (const control of PROHIBITED_WINDOWS_EXECUTION_PATTERNS) {
    if (control.pattern.test(source)) {
      throw new Error(`${label} violates endpoint-security policy: ${control.id}`);
    }
  }
}
