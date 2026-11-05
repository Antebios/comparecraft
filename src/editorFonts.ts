const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "fangsong",
]);

export function quoteFontFamily(name: string): string {
  return `"${name.replace(/[\\"\n\r\f\0]/g, (char) => {
    if (char === "\\" || char === '"') return `\\${char}`;
    return `\\${char.charCodeAt(0).toString(16)} `;
  })}"`;
}

/** Stored values remain CSS family lists; selected literal names are quoted. */
export function fontSettingForFamily(name: string): string {
  return name ? quoteFontFamily(name) : "";
}

export function editorFontCss(value: string): string {
  const font = value.trim();
  if (!font) return "var(--default-mono)";
  const family = CSS.supports("font-family", `${font}, monospace`) ? font : quoteFontFamily(font);
  return `${family}, monospace`;
}

export function singleFontFamily(value: string): { name: string; generic: boolean } | undefined {
  const font = value.trim();
  if (/^[-\p{L}\p{N}_ ]+$/u.test(font)) return { name: font, generic: GENERIC_FAMILIES.has(font.toLowerCase()) };
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')$/s.exec(font);
  if (!quoted) return undefined;
  const name = (quoted[1] ?? quoted[2]).replace(/\\(?:([0-9a-f]{1,6})\s?|(.))/gi, (_, hex: string | undefined, char: string) => {
    const code = hex ? parseInt(hex, 16) : 0;
    return hex ? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd") : char;
  });
  return { name, generic: false };
}
