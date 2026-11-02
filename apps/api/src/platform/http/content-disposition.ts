/**
 * A Content-Disposition header that is valid for any file name. People upload files named in their own language
 * ("वेतन पर्ची.pdf", "Lohnzettel März.pdf"); Node refuses a header with non-ASCII or control characters, which used to
 * turn those downloads into errors. The ASCII `filename` is a safe fallback for old clients, and `filename*`
 * (RFC 6266 / RFC 5987) carries the real name in UTF-8.
 */
export function contentDisposition(type: 'attachment' | 'inline', fileName: string): string {
  const name = (fileName || 'download').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').slice(0, 200) || 'download';
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%;]/g, '').trim() || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The name to store for an uploaded file. Multipart parsers hand over the name decoded as Latin-1 although browsers
 * send UTF-8, so "वेतन.pdf" arrives garbled; it is decoded again here. Names keep letters in every language, and lose
 * only what could be misread as a path or break a header: control characters, slashes and <>:"|?*.
 */
export function safeFileName(original: string, fallback: string): string {
  let name = original ?? '';
  if (/[\u0080-ÿ]/.test(name) && !/[^\u0000-ÿ]/.test(name)) {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    if (!utf8.includes('�')) name = utf8;
  }
  name = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 200);
  return name || fallback;
}
