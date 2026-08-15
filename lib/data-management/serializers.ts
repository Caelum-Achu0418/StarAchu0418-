const BLOB_MARKER = "__aiPhoneBlob";          // legacy: media inlined as base64 dataUrl (read-only compat)
const MEDIA_REF_MARKER = "__aiPhoneMediaRef"; // new: media stored as a separate binary object, referenced by content hash

type SerializedBlob = {
  [BLOB_MARKER]: true;
  mimeType: string;
  dataUrl: string;
};

type SerializedMediaRef = {
  [MEDIA_REF_MARKER]: true;
  mimeType: string;
  ref: string;                  // sha256 of the binary
  encoding: "blob" | "dataurl"; // how to rebuild the original value on restore
};

/** Collects media out-of-band during serialization, returns a content-hash ref (dedupes). */
export type MediaCollector = { add(blob: Blob): Promise<string> };
/** Resolves a media ref back to its raw bytes during deserialization (null if missing). */
export type MediaResolver = (ref: string) => Promise<Uint8Array | null>;

// Only extract sizeable base64 data-URLs; tiny strings stay inline (not worth a separate object).
const MEDIA_DATAURL_RE = /^data:([^;,]*);base64,/i;
const MEDIA_MIN_LENGTH = 2048;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  // Cast: TS 5.7 types Uint8Array as <ArrayBufferLike>, BlobPart wants <ArrayBuffer>.
  return new Blob([bytes as unknown as BlobPart], { type: mimeType || "application/octet-stream" });
}

function dataUrlToBlob(dataUrl: string, mimeType: string): Blob {
  return bytesToBlob(base64ToBytes(extractBase64(dataUrl)), mimeType);
}

function extractBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Chunked to avoid blowing the call-stack / arg limit on large media.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content-addressed media collector (sha256 → dedupes identical media across the backup). */
export function createMediaCollector(): MediaCollector & { media: Map<string, Blob> } {
  const media = new Map<string, Blob>();
  return {
    media,
    async add(blob: Blob): Promise<string> {
      const ref = await sha256Hex(blob);
      if (!media.has(ref)) media.set(ref, blob);
      return ref;
    },
  };
}

export async function serializeValue(value: unknown, collector?: MediaCollector): Promise<unknown> {
  if (value instanceof Blob) {
    if (collector) {
      const ref = await collector.add(value);
      return { [MEDIA_REF_MARKER]: true, mimeType: value.type, ref, encoding: "blob" } satisfies SerializedMediaRef;
    }
    // No collector → legacy inline base64 (kept for callers that don't extract media).
    return { [BLOB_MARKER]: true, mimeType: value.type, dataUrl: await blobToDataUrl(value) } satisfies SerializedBlob;
  }

  if (typeof value === "string") {
    // Big base64 data-URLs (images/audio stored as strings, e.g. theme assets) → extract to binary.
    if (collector && value.length >= MEDIA_MIN_LENGTH) {
      const match = MEDIA_DATAURL_RE.exec(value);
      if (match) {
        // Preserve the exact mime (even empty) so the restored data-URL is byte-identical.
        const mimeType = match[1] ?? "";
        const blob = bytesToBlob(base64ToBytes(extractBase64(value)), mimeType || "application/octet-stream");
        const ref = await collector.add(blob);
        return { [MEDIA_REF_MARKER]: true, mimeType, ref, encoding: "dataurl" } satisfies SerializedMediaRef;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => serializeValue(item, collector)));
  }

  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, child]) => [key, await serializeValue(child, collector)] as const)
    );
    return Object.fromEntries(entries);
  }

  return value;
}

export async function deserializeValue(value: unknown, resolver?: MediaResolver): Promise<unknown> {
  // New media-ref marker → fetch the binary and rebuild original (Blob or dataUrl string).
  if (isPlainObject(value) && value[MEDIA_REF_MARKER] === true) {
    const ref = typeof value.ref === "string" ? value.ref : "";
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream";
    const encoding = value.encoding === "dataurl" ? "dataurl" : "blob";
    const bytes = resolver ? await resolver(ref) : null;
    if (!bytes) {
      // Media object missing → return an empty placeholder so the rest of the record still restores.
      return encoding === "dataurl" ? "" : new Blob([], { type: mimeType });
    }
    return encoding === "dataurl"
      ? `data:${mimeType};base64,${bytesToBase64(bytes)}`
      : bytesToBlob(bytes, mimeType);
  }

  // Legacy inline-base64 marker (old backups) → rebuild Blob directly.
  if (isPlainObject(value) && value[BLOB_MARKER] === true) {
    const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl : "";
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream";
    return dataUrlToBlob(dataUrl, mimeType);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => deserializeValue(item, resolver)));
  }

  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, child]) => [key, await deserializeValue(child, resolver)] as const)
    );
    return Object.fromEntries(entries);
  }

  return value;
}

// 纯算术估算 UTF-8 字节数：逐字符累加，零内存分配。
// 旧实现对每条字符串做 JSON.stringify + new Blob 两次全量复制——大库（几百 MB 的
// base64 媒体串）统计时瞬时内存冲到数据本身的 2~3 倍，移动端 Chrome 直接 OOM 杀页。
// 统计用途不需要字节级精确，省掉引号/转义的出入无所谓。
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; } // 代理对 = 4 字节，跳过低位
    else bytes += 3;
  }
  return bytes;
}

export function estimateValueBytes(value: unknown): number {
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value === undefined) return 0;
  if (value === null) return 4;

  if (typeof value === "string") return utf8Bytes(value) + 2; // + 引号
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;

  if (Array.isArray(value)) {
    if (value.length === 0) return 2;
    return 2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + estimateValueBytes(item), 0);
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return 2;
    return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, child]) => {
      return sum + utf8Bytes(key) + 3 + estimateValueBytes(child); // 键的引号 + 冒号
    }, 0);
  }

  // Date/Map 等少数结构：退回 stringify（个头小，代价可忽略）
  try {
    return utf8Bytes(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}
