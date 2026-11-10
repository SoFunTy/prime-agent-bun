// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
const ATTACHMENT_MIME = "application/vnd.prime-agent.attachment+json";
const MAX_SOURCE_IMAGE_BYTES = 20_000_000;
const MAX_SOURCE_IMAGE_PIXELS = 36_000_000;
const MAX_ATTACHMENT_DATA_CHARS = 350_000;
const MAX_ATTACHMENT_DIMENSION = 1200;

function detectMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF") {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function imageDimensions(bytes: Uint8Array, mime: string): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === "image/png") {
      return [view.getUint32(16), view.getUint32(20)];
    }
    if (mime === "image/gif") {
      return [view.getUint16(6, true), view.getUint16(8, true)];
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        const length = view.getUint16(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
        }
        offset += 2 + length;
      }
      return null;
    }
    if (mime === "image/webp" && String.fromCharCode(...bytes.slice(12, 16)) === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return [width, height];
    }
  } catch {
    return null;
  }
  return null;
}

function base64Chars(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Re-encode with Bun.Image when it can decode; `null` when it cannot. */
function shrink(bytes: Uint8Array, dimension: number): string | null {
  const Builder = (Bun as unknown as { Image?: new (input: unknown) => any }).Image;
  if (Builder === undefined) {
    return null;
  }
  try {
    const image = new Builder(bytes);
    if (!Number.isFinite(image.width) || image.width <= 0) {
      return null;
    }
    const scale = Math.min(1, dimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    for (const quality of [82, 70, 55, 40]) {
      const candidate = image.resize(width, height).jpeg({ quality });
      const buffer = typeof candidate.toBuffer === "function" ? candidate.toBuffer() : candidate;
      if (buffer === undefined || buffer === null) {
        continue;
      }
      const data = Buffer.from(buffer).toString("base64");
      if (data.length <= MAX_ATTACHMENT_DATA_CHARS) {
        return data;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export default function createSkill(ctx: { cwd: string; emit(data: Record<string, unknown>): void }) {
  const run = async (options: { paths?: string[]; path?: string } | string[]): Promise<string> => {
    const paths = Array.isArray(options)
      ? options
      : (options?.paths ?? (options?.path !== undefined ? [options.path] : []));
    if (paths.length === 0) {
      throw new TypeError("attach_image requires at least one path");
    }
    const notes: string[] = [];
    for (const path of paths) {
      if (typeof path !== "string" || path === "") {
        throw new TypeError("each path must be a non-empty string");
      }
      const resolved = path.startsWith("~")
        ? path.replace(/^~(?=[/]|$)/, process.env.HOME ?? "")
        : path.startsWith("/")
          ? path
          : `${ctx.cwd}/${path}`;
      const file = Bun.file(resolved);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${resolved}`);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
        throw new Error(
          `${resolved} is larger than ${MAX_SOURCE_IMAGE_BYTES / 1_000_000}MB. Resize it first.`,
        );
      }
      const mime = detectMime(bytes);
      if (mime === null) {
        throw new Error(`${resolved} is not a supported image (jpeg, png, gif, webp)`);
      }
      const dimensions = imageDimensions(bytes, mime);
      if (dimensions !== null && dimensions[0] * dimensions[1] > MAX_SOURCE_IMAGE_PIXELS) {
        throw new Error(
          `${resolved} is larger than ${MAX_SOURCE_IMAGE_PIXELS / 1_000_000}MP. Resize it first.`,
        );
      }
      let mimeType = mime;
      let data = Buffer.from(bytes).toString("base64");
      if (data.length > MAX_ATTACHMENT_DATA_CHARS || (dimensions !== null && Math.max(...dimensions) > MAX_ATTACHMENT_DIMENSION)) {
        const shrunk = shrink(bytes, MAX_ATTACHMENT_DIMENSION);
        if (shrunk === null) {
          throw new Error(
            `${resolved} exceeds the ${Math.floor(MAX_ATTACHMENT_DATA_CHARS / 1000)}KB attachment budget and this Bun build cannot re-encode it. Resize it first.`,
          );
        }
        data = shrunk;
        mimeType = "image/jpeg";
        notes.push(`${path} was resized to fit the attachment budget`);
      }
      ctx.emit({ [ATTACHMENT_MIME]: { mime_type: mimeType, data, path }, "text/plain": `Attached ${path}` });
    }
    const attached = paths.join(", ");
    return notes.length === 0 ? `Attached ${attached}` : `Attached ${attached} (${notes.join("; ")})`;
  };
  const callable = (options: Parameters<typeof run>[0]) => run(options);
  callable.run = run;
  return callable;
}
