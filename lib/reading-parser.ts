// lib/reading-parser.ts — File parsing for TXT, EPUB, PDF.

// ── PDF.js CDN loader ──
const PDFJS_VERSION = "3.11.174"; // stable version available on cdnjs
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let _pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) { resolve((window as any).pdfjsLib); return; }
        const script = document.createElement("script");
        script.src = `${PDFJS_CDN}/pdf.min.mjs`;
        script.type = "module";
        // pdf.min.mjs is ESM, use a different approach — load the UMD build
        script.src = `${PDFJS_CDN}/pdf.min.js`;
        script.type = "text/javascript";
        script.onload = () => {
            const lib = (window as any).pdfjsLib;
            if (lib) {
                lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
                resolve(lib);
            } else {
                reject(new Error("pdfjsLib not found after script load"));
            }
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js from CDN"));
        document.head.appendChild(script);
    });
    return _pdfjsPromise;
}

type PdfSource = ArrayBuffer | Blob;

export type ParsedChapter = {
    title: string;
    paragraphs: string[];
};

export type ParsedBook = {
    title: string;
    author?: string;
    chapters: ParsedChapter[];
};

export type TxtDecodeResult = {
    text: string;
    encoding: string;
};

const TXT_DECODER_CANDIDATES = ["utf-8", "gb18030", "gbk", "big5", "utf-16le", "utf-16be"];

function decodeWithEncoding(buffer: ArrayBuffer, encoding: string): string | null {
    try {
        return new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
        return null;
    }
}

function scoreDecodedTxt(text: string): number {
    const sample = text.slice(0, 24000);
    if (!sample.trim()) return -100000;

    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    const nulCount = (sample.match(/\u0000/g) || []).length;
    const controlCount = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const cjkCount = (sample.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const punctuationCount = (sample.match(/[，。！？；：“”‘’、（）《》…]/g) || []).length;
    const readableCount = (sample.match(/[A-Za-z0-9\s]/g) || []).length;

    return cjkCount * 3
        + punctuationCount * 2
        + readableCount * 0.15
        - replacementCount * 80
        - nulCount * 100
        - controlCount * 20;
}

export function decodeTxtArrayBuffer(buffer: ArrayBuffer): TxtDecodeResult {
    const bytes = new Uint8Array(buffer);
    const bomCandidates: Array<[string, boolean]> = [];

    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        bomCandidates.push(["utf-8", true]);
    } else if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        bomCandidates.push(["utf-16le", true]);
    } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        bomCandidates.push(["utf-16be", true]);
    }

    for (const [encoding] of bomCandidates) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text !== null) return { text, encoding };
    }

    let best: TxtDecodeResult | null = null;
    let bestScore = -Infinity;

    for (const encoding of TXT_DECODER_CANDIDATES) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text === null) continue;
        const score = scoreDecodedTxt(text);
        if (score > bestScore) {
            bestScore = score;
            best = { text, encoding };
        }
    }

    return best ?? { text: decodeWithEncoding(buffer, "utf-8") ?? "", encoding: "utf-8" };
}

// ── Chapter heading patterns ──
const CHAPTER_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集篇]/,       // 第X章, 第X节, 第X回...
    /^Chapter\s+\d+/i,                                        // Chapter 1
    /^CHAPTER\s+[IVXLCDM\d]+/,                                // CHAPTER IV
    /^卷[零一二三四五六七八九十百千\d]+/,                       // 卷一
    /^={3,}/,                                                  // ===
    /^-{3,}/,                                                  // ---
    /^#{1,3}\s+/,                                              // Markdown # heading
];

function isChapterHeading(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 60) return false;
    return CHAPTER_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Parse TXT content into chapters and paragraphs.
 * Splits by chapter headings, then by blank lines for paragraphs.
 */
export function parseTxtContent(text: string, fileName?: string): ParsedBook {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    // First pass: find chapter boundaries
    const chapterStarts: { lineIdx: number; title: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (isChapterHeading(lines[i])) {
            chapterStarts.push({ lineIdx: i, title: lines[i].trim().replace(/^#{1,3}\s+/, "") });
        }
    }

    // Extract title from first non-empty line (if before first chapter)
    let bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    if (chapterStarts.length > 0 && chapterStarts[0].lineIdx > 0) {
        for (let i = 0; i < chapterStarts[0].lineIdx; i++) {
            if (lines[i].trim()) { bookTitle = lines[i].trim(); break; }
        }
    }

    // No chapters found → entire text is one chapter
    if (chapterStarts.length === 0) {
        return {
            title: bookTitle,
            chapters: [{
                title: "全文",
                paragraphs: splitParagraphs(lines),
            }],
        };
    }

    // Build chapters
    const chapters: ParsedChapter[] = [];
    for (let i = 0; i < chapterStarts.length; i++) {
        const start = chapterStarts[i].lineIdx + 1; // skip heading line
        const end = i + 1 < chapterStarts.length ? chapterStarts[i + 1].lineIdx : lines.length;
        const chapterLines = lines.slice(start, end);
        const paragraphs = splitParagraphs(chapterLines);
        if (paragraphs.length > 0) {
            chapters.push({ title: chapterStarts[i].title, paragraphs });
        }
    }

    // If there's content before the first chapter, add it as a prologue
    if (chapterStarts[0].lineIdx > 1) {
        const prologueLines = lines.slice(0, chapterStarts[0].lineIdx);
        const paragraphs = splitParagraphs(prologueLines);
        if (paragraphs.length > 0) {
            chapters.unshift({ title: "序", paragraphs });
        }
    }

    return { title: bookTitle, chapters };
}

/** Split lines into paragraphs by blank lines, merging consecutive non-blank lines. */
function splitParagraphs(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
        if (line.trim() === "") {
            if (current.length > 0) {
                paragraphs.push(current.join("\n").trim());
                current = [];
            }
        } else {
            current.push(line);
        }
    }
    if (current.length > 0) {
        paragraphs.push(current.join("\n").trim());
    }

    return paragraphs.filter(p => p.length > 0);
}

// ── EPUB Parsing ──

/**
 * Parse EPUB file into chapters and paragraphs.
 * EPUB is a ZIP containing XHTML files.
 */
export async function parseEpubFile(arrayBuffer: ArrayBuffer, fileName?: string): Promise<ParsedBook> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. Find container.xml → rootfile path
    const containerXml = await zip.file("META-INF/container.xml")?.async("text");
    if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/);
    if (!rootfileMatch) throw new Error("Invalid EPUB: no rootfile");
    const rootfilePath = rootfileMatch[1];
    const rootDir = rootfilePath.includes("/") ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1) : "";

    // 2. Parse OPF (package document)
    const opfXml = await zip.file(rootfilePath)?.async("text");
    if (!opfXml) throw new Error("Invalid EPUB: missing OPF");

    // Extract title and author
    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const authorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    const bookTitle = titleMatch?.[1]?.trim() || fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const author = authorMatch?.[1]?.trim();

    // 3. Extract spine order (reading order)
    const spineItems: string[] = [];
    const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
    if (spineMatch) {
        const itemRefPattern = /idref="([^"]+)"/g;
        let m;
        while ((m = itemRefPattern.exec(spineMatch[1])) !== null) {
            spineItems.push(m[1]);
        }
    }

    // 4. Build id → href map from manifest
    const idToHref = new Map<string, string>();
    const manifestMatch = opfXml.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
    if (manifestMatch) {
        const itemPattern = /id="([^"]+)"[^>]*href="([^"]+)"/g;
        let m;
        while ((m = itemPattern.exec(manifestMatch[1])) !== null) {
            idToHref.set(m[1], m[2]);
        }
    }

    // 5. Read each spine item and extract text
    const chapters: ParsedChapter[] = [];
    for (const itemId of spineItems) {
        const href = idToHref.get(itemId);
        if (!href) continue;
        const filePath = rootDir + decodeURIComponent(href);
        const html = await zip.file(filePath)?.async("text");
        if (!html) continue;

        // Extract text from HTML
        const { title, paragraphs } = extractTextFromHtml(html);
        if (paragraphs.length === 0) continue;
        chapters.push({ title: title || `第${chapters.length + 1}章`, paragraphs });
    }

    if (chapters.length === 0) {
        return { title: bookTitle, author, chapters: [{ title: "全文", paragraphs: ["（EPUB 解析失败，未找到文本内容）"] }] };
    }

    return { title: bookTitle, author, chapters };
}

/** Extract readable text from HTML/XHTML content. */
function extractTextFromHtml(html: string): { title: string; paragraphs: string[] } {
    // Try to extract title from <title> or <h1>-<h3>
    const titleMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
        || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]).trim() : "";

    // Extract text from <p>, <div>, <li> tags
    const paragraphs: string[] = [];
    const blockPattern = /<(?:p|div|li)[^>]*>([\s\S]*?)<\/(?:p|div|li)>/gi;
    let match;
    while ((match = blockPattern.exec(html)) !== null) {
        const text = stripHtmlTags(match[1]).trim();
        if (text.length > 0) paragraphs.push(text);
    }

    // Fallback: strip all tags and split by newlines
    if (paragraphs.length === 0) {
        const plainText = stripHtmlTags(html).trim();
        if (plainText) {
            const lines = plainText.split(/\n{2,}/).map(l => l.trim()).filter(l => l.length > 0);
            paragraphs.push(...lines);
        }
    }

    return { title, paragraphs };
}

function stripHtmlTags(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/\s+/g, " ");
}

// ── PDF Parsing ──

/**
 * Parse PDF file into chapters (pages) and paragraphs.
 * Each page becomes a "chapter" since PDFs don't have semantic chapters.
 */
export type PdfParagraphMeta = {
    text: string;
    pageNum: number;       // 1-based page number
    yRatio: number;        // 0-1 vertical position within the page (0=top, 1=bottom)
};
export const PDF_PAGES_PER_CHAPTER = 5;

export type ParsedPdfChunk = ParsedChapter & {
    startPage: number;
    endPage: number;
    pdfMeta: PdfParagraphMeta[];
};

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

async function openPdfDocument(source: PdfSource): Promise<{ pdf: any; dispose: () => Promise<void> }> {
    const pdfjsLib = await loadPdfjs();
    if (source instanceof Blob) {
        const url = URL.createObjectURL(source);
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        return {
            pdf,
            dispose: async () => {
                URL.revokeObjectURL(url);
            },
        };
    }

    const pdf = await pdfjsLib.getDocument(new Uint8Array(source)).promise;
    return {
        pdf,
        dispose: async () => {},
    };
}

async function readPdfBaseMeta(pdf: any, fileName?: string) {
    const bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    return {
        title: (info?.Title as string | undefined) || bookTitle,
        author: (info?.Author as string | undefined)?.trim() || undefined,
        totalPages: pdf.numPages,
    };
}

export async function inspectPdfFile(source: PdfSource, fileName?: string): Promise<ParsedBook & { totalPages: number }> {
    const { pdf, dispose } = await openPdfDocument(source);
    try {
        const base = await readPdfBaseMeta(pdf, fileName);
        const chapters: ParsedChapter[] = [];
        for (let startPage = 1; startPage <= base.totalPages; startPage += PDF_PAGES_PER_CHAPTER) {
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chapters.push({
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: [],
            });
        }
        return { title: base.title, author: base.author, totalPages: base.totalPages, chapters };
    } finally {
        try {
            await pdf.destroy?.();
        } catch {
            // Ignore cleanup failures from PDF.js.
        }
        await dispose();
    }
}

export async function parsePdfPageRange(
    source: PdfSource,
    options: { startPage: number; endPage: number; fileName?: string },
): Promise<{ title: string; author?: string; totalPages: number; chunks: ParsedPdfChunk[] }> {
    const { pdf, dispose } = await openPdfDocument(source);
    const base = await readPdfBaseMeta(pdf, options.fileName);
    const startPage = Math.max(1, Math.min(base.totalPages, options.startPage));
    const endPage = Math.max(startPage, Math.min(base.totalPages, options.endPage));
    const chunkMap = new Map<number, ParsedPdfChunk>();

    const ensureChunk = (pageNum: number) => {
        const chunkStart = Math.floor((pageNum - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        let chunk = chunkMap.get(chunkStart);
        if (!chunk) {
            const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chunk = {
                title: buildPdfChunkTitle(chunkStart, chunkEnd),
                startPage: chunkStart,
                endPage: chunkEnd,
                paragraphs: [],
                pdfMeta: [],
            };
            chunkMap.set(chunkStart, chunk);
        }
        return chunk;
    };

    for (let i = startPage; i <= endPage; i += 1) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const pageHeight = viewport.height;
        const chunk = ensureChunk(i);

        const items = textContent.items as { str?: string; transform?: number[] }[];
        const lines: { text: string; y: number }[] = [];
        let currentLine = "";
        let currentY = -1;

        for (const item of items) {
            const str = item.str || "";
            if (!str.trim()) continue;
            const y = item.transform ? item.transform[5] : 0;

            if (currentY < 0 || Math.abs(y - currentY) < 3) {
                currentLine += str;
                if (currentY < 0) currentY = y;
            } else {
                if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });
                currentLine = str;
                currentY = y;
            }
        }
        if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });

        let paraText = "";
        let paraY = 0;
        for (let j = 0; j < lines.length; j += 1) {
            if (paraText === "") {
                paraText = lines[j].text;
                paraY = lines[j].y;
            } else {
                const gap = Math.abs(lines[j].y - lines[j - 1].y);
                if (gap > 20) {
                    if (paraText.length > 5) {
                        const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
                        chunk.pdfMeta.push(meta);
                        chunk.paragraphs.push(meta.text);
                    }
                    paraText = lines[j].text;
                    paraY = lines[j].y;
                } else {
                    paraText += " " + lines[j].text;
                }
            }
        }
        if (paraText.length > 5) {
            const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
            chunk.pdfMeta.push(meta);
            chunk.paragraphs.push(meta.text);
        }

        page.cleanup?.();
        if (i % 12 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    try {
        await pdf.destroy?.();
    } catch {
        // Ignore cleanup failures from PDF.js.
    }
    await dispose();

    return {
        title: base.title,
        author: base.author,
        totalPages: base.totalPages,
        chunks: [...chunkMap.values()].sort((a, b) => a.startPage - b.startPage),
    };
}
