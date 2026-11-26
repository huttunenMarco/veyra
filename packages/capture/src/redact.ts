/** Remove credentials from any string before it is logged or reported. */
export function redact(text: string, secrets: Array<string | null | undefined> = []): string {
  let out = text.replace(/(rtsps?|https?):\/\/[^/\s@]*@/gi, '$1://***@');
  for (const s of secrets) {
    if (s && s.length >= 3) {
      out = out.split(s).join('***');
      const enc = encodeURIComponent(s);
      if (enc !== s) out = out.split(enc).join('***');
    }
  }
  return out;
}
