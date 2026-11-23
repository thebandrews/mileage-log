import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { logRows, type ReportSummary, type Trip, type Vehicle } from '@mileage/shared';

// Landscape US Letter.
const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 36;
const ROW_H = 14;
const SIZE = 8;

// Columns shown in the PDF, mapped to logRows() indexes.
const COLUMNS: { title: string; index: number; width: number; align?: 'right' }[] = [
  { title: 'Date', index: 0, width: 52 },
  { title: 'Time', index: 1, width: 30 },
  { title: 'Vehicle', index: 3, width: 70 },
  { title: 'Odo start', index: 4, width: 48, align: 'right' },
  { title: 'Odo end', index: 5, width: 48, align: 'right' },
  { title: 'Miles', index: 6, width: 34, align: 'right' },
  { title: 'Type', index: 7, width: 54 },
  { title: 'From', index: 8, width: 92 },
  { title: 'Destination', index: 9, width: 110 },
  { title: 'Business purpose', index: 10, width: 112 },
  { title: 'Client', index: 11, width: 70 },
];

/** Standard PDF fonts only cover WinAnsi; swap anything else so drawing never throws. */
function winAnsi(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/→/g, '->')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

const LINE_H = 10;
const MAX_LINES = 4;

function truncate(text: string, font: PDFFont, width: number): string {
  let t = text;
  if (font.widthOfTextAtSize(t, SIZE) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, SIZE) > width) t = t.slice(0, -1);
  return `${t}...`;
}

/** Word-wrap to the column width so destinations and purposes stay readable in full. */
function wrap(text: string, font: PDFFont, width: number): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, SIZE) <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = truncate(word, font, width);
    }
  }
  if (line) lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = truncate(`${lines[MAX_LINES - 1]} ...`, font, width);
  }
  return lines.length ? lines : [''];
}

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const miles = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export async function renderLogPdf(opts: {
  title: string;
  ownerName: string | null;
  trips: readonly Trip[];
  vehicles: readonly Vehicle[];
  summary: ReportSummary;
  rateNote: string;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const rows = logRows(opts.trips, opts.vehicles, opts.summary.timezone);
  const grey = rgb(0.4, 0.4, 0.4);
  const rule = rgb(0.8, 0.8, 0.8);

  let page: PDFPage;
  let y = 0;
  let pageNo = 0;

  const header = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pageNo++;
    y = PAGE_H - MARGIN;
    page.drawText(winAnsi(opts.title), { x: MARGIN, y: y - 12, size: 14, font: bold });
    const sub = [opts.ownerName, `${opts.summary.from} to ${opts.summary.to}`].filter(Boolean).join('  |  ');
    page.drawText(winAnsi(sub), { x: MARGIN, y: y - 28, size: 9, font, color: grey });
    page.drawText(`Page ${pageNo}`, { x: PAGE_W - MARGIN - 40, y: y - 12, size: 8, font, color: grey });
    y -= 50;
    let x = MARGIN;
    for (const c of COLUMNS) {
      const w = bold.widthOfTextAtSize(c.title, SIZE);
      page.drawText(c.title, { x: c.align === 'right' ? x + c.width - w - 4 : x, y, size: SIZE, font: bold });
      x += c.width;
    }
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: rule });
    y -= ROW_H - 2;
  };

  header();
  for (const row of rows) {
    const cells = COLUMNS.map((c) => wrap(row[c.index] ?? '', font, c.width - 6));
    const height = Math.max(...cells.map((l) => l.length)) * LINE_H + (ROW_H - LINE_H);
    if (y - height < MARGIN + 40) header();
    let x = MARGIN;
    COLUMNS.forEach((c, i) => {
      cells[i].forEach((text, n) => {
        const w = font.widthOfTextAtSize(text, SIZE);
        page!.drawText(text, { x: c.align === 'right' ? x + c.width - w - 4 : x, y: y - n * LINE_H, size: SIZE, font });
      });
      x += c.width;
    });
    y -= height;
  }
  if (rows.length === 0) {
    page!.drawText('No trips in this period.', { x: MARGIN, y, size: SIZE + 1, font, color: grey });
    y -= ROW_H;
  }

  // Totals block.
  if (y < MARGIN + 60) header();
  y -= 8;
  page!.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: PAGE_W - MARGIN, y: y + 10 }, thickness: 0.75, color: rule });
  const t = opts.summary.totals;
  const lines = [
    `Business ${miles(t.business)} mi  |  Personal ${miles(t.personal)} mi  |  Commute ${miles(t.commute)} mi  |  Unclassified ${miles(t.unclassified)} mi  |  Total ${miles(t.total)} mi in ${t.trips} trips`,
    `Business value ${money(t.businessValueCents)} (${opts.rateNote})`,
  ];
  if (opts.summary.incompleteBusinessTrips > 0) {
    lines.push(`${opts.summary.incompleteBusinessTrips} business trip(s) missing a destination or purpose.`);
  }
  for (const line of lines) {
    page!.drawText(winAnsi(line), { x: MARGIN, y, size: 9, font: line === lines[0] ? bold : font });
    y -= 13;
  }
  return doc.save();
}
