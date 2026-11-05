// PDF → plain text for chat / agent attachments, with pdfjs-dist (legacy build, no worker
// thread: the worker module is loaded in-process as pdfjs' "fake worker"). Loaded lazily so
// the ~2 MB parser only costs anything the first time someone attaches a PDF.

export const PDF_MAX_CHARS = 60_000;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let loading: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    // pdfjs picks this up instead of spawning a worker (no worker file to locate inside the asar)
    (globalThis as Record<string, unknown>).pdfjsWorker = worker;
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  loading.catch(() => (loading = null));
  return loading;
}

export interface PdfText {
  text: string;
  pages: number;
  truncated: boolean;
}

/** Extract the text of a PDF, page by page ("--- page 2 ---"), capped at maxChars. */
export async function extractPdfText(data: Uint8Array, maxChars = PDF_MAX_CHARS): Promise<PdfText> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdfjs detaches the buffer it is given
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const maxPages = 200;
  let text = '';
  let truncated = false;
  try {
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      page.cleanup();
      const pageText = lines.map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const chunk = `${doc.numPages > 1 ? `--- page ${i} ---\n` : ''}${pageText}\n\n`;
      if (text.length + chunk.length > maxChars) {
        text += chunk.slice(0, Math.max(0, maxChars - text.length));
        truncated = true;
        break;
      }
      text += chunk;
    }
  } finally {
    void task.destroy();
  }
  return { text: text.trim(), pages: doc.numPages, truncated };
}
