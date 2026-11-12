// Image type and size from the file's own first bytes, never from the header the client sent. Used by
// the card upload (routes/desk.ts) and the card backgrounds (routes/templates.ts).

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk, which must come straight after the signature. Null if not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null | "no_header" {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return "no_header";
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** EXIF orientation (tag 0x0112) from an APP1 "Exif" segment; 1 when absent or unreadable. */
function exifOrientation(buf: Buffer, start: number, end: number): number {
  if (end - start < 14 || buf.toString("latin1", start, start + 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const order = buf.toString("latin1", tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const u16 = (at: number) => (at + 2 <= end ? (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at)) : -1);
  const u32 = (at: number) => (at + 4 <= end ? (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at)) : -1);
  const ifd = u32(tiff + 4);
  if (ifd < 0) return 1;
  const count = u16(tiff + ifd);
  for (let n = 0; n < count; n++) {
    const entry = tiff + ifd + 2 + n * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Width and height as displayed: from the first SOF marker, swapped when EXIF orientation is 5–8
 * (rotated 90°). Null if not a JPEG; "no_header" if it has no readable frame header.
 */
export function jpegSize(buf: Buffer): { width: number; height: number } | null | "no_header" {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return "no_header";
    const marker = buf[i + 1]!;
    // Fill bytes, and markers with no length (TEM, RSTn)
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // End of image or start of scan before any frame header
    if (marker === 0xd9 || marker === 0xda) return "no_header";
    const length = buf.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > buf.length) return "no_header";
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(buf, i + 4, end);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return "no_header";
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    i = end;
  }
  return "no_header";
}

