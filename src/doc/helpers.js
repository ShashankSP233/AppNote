// Small building blocks for the .docx output, so the page files read as
// layout rather than as docx API calls.

import {
  Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, VerticalAlign, ShadingType, HeadingLevel,
} from 'docx';

export const FONT = 'Arial';

export const COLOURS = {
  INK: '000000',
  MUTED: '595959',
  ACCENT: '1F3864',
  WARN: 'A61C00',
  GOOD: '1E6B30',
  RULE: '808080',
  BAND: 'D9E2F3',
  SOFT: 'F2F2F2',
};

/**
 * Table headings carry how much competition there actually was.
 *
 * A reader can tell at a glance, before reading a single figure, whether this
 * purchase was properly tendered. Three or more offers is normal and stays
 * blue. Two is thin and turns the document yellow. A single offer is a
 * single-source purchase and turns it orange.
 */
export const HEADER_THEMES = {
  competitive: {
    key: 'competitive',
    band: 'D9E2F3',
    label: 'Three or more offers compared',
    note: null,
  },
  limited: {
    key: 'limited',
    band: 'FFF2CC',
    label: 'Only two offers compared',
    note: 'The headings on this note are yellow because only two offers were obtained. Three is the norm.',
  },
  single: {
    key: 'single',
    band: 'F8CBAD',
    label: 'Single offer — no competing quotation',
    note: 'The headings on this note are orange because only one offer was obtained. A single-source purchase needs a written justification.',
  },
};

export function headerTheme(vendorCount) {
  const count = Number(vendorCount) || 0;
  if (count >= 3) return HEADER_THEMES.competitive;
  if (count === 2) return HEADER_THEMES.limited;
  return HEADER_THEMES.single;
}

/** How many offers are actually in the comparison on this note. */
export function comparedVendorCount(note) {
  if (note?.comparison?.rows) return note.comparison.rows.length;
  if (Array.isArray(note?.quotations)) {
    return note.quotations.filter((q) => !q.is_excluded && !q.is_superseded).length;
  }
  return 0;
}

/** Points to half-points, which is what docx wants for size. */
export const pt = (points) => Math.round(points * 2);

const SINGLE = { style: BorderStyle.SINGLE, size: 4, color: COLOURS.RULE };
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

export const BOX = { top: SINGLE, bottom: SINGLE, left: SINGLE, right: SINGLE };
export const GRID = { ...BOX, insideHorizontal: SINGLE, insideVertical: SINGLE };
export const NO_BORDER = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

export function text(value, options = {}) {
  return new TextRun({
    text: value === null || value === undefined ? '' : String(value),
    font: FONT,
    size: pt(options.size || 10),
    bold: options.bold || false,
    italics: options.italic || false,
    color: options.color || COLOURS.INK,
    underline: options.underline ? {} : undefined,
    break: options.break || undefined,
  });
}

export function para(value, options = {}) {
  const runs = Array.isArray(value)
    ? value
    : [text(value, options)];

  return new Paragraph({
    children: runs,
    alignment: options.align || AlignmentType.LEFT,
    spacing: {
      before: options.before !== undefined ? options.before * 20 : 0,
      after: options.after !== undefined ? options.after * 20 : 40,
      line: options.line || undefined,
    },
    indent: options.indent ? { left: options.indent * 20 } : undefined,
    border: options.bottomRule
      ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOURS.RULE, space: 2 } }
      : undefined,
    keepNext: options.keepNext || false,
    pageBreakBefore: options.pageBreakBefore || false,
  });
}

export function heading(value, options = {}) {
  return new Paragraph({
    children: [text(value, { bold: true, size: options.size || 12, color: options.color || COLOURS.ACCENT })],
    alignment: options.align || AlignmentType.LEFT,
    spacing: { before: (options.before ?? 8) * 20, after: (options.after ?? 4) * 20 },
    keepNext: true,
    pageBreakBefore: options.pageBreakBefore || false,
  });
}

export function spacer(points = 6) {
  return new Paragraph({ children: [text('')], spacing: { after: points * 20 } });
}

export function bullet(value, options = {}) {
  return new Paragraph({
    children: Array.isArray(value) ? value : [text(value, options)],
    bullet: { level: options.level || 0 },
    spacing: { after: (options.after ?? 2) * 20 },
  });
}

export function cell(content, options = {}) {
  const children = Array.isArray(content)
    ? content
    : [para(content, {
      align: options.align,
      size: options.size || 9.5,
      bold: options.bold,
      italic: options.italic,
      color: options.color,
      after: options.after ?? 1,
    })];

  return new TableCell({
    children,
    width: options.width ? { size: options.width, type: WidthType.PERCENTAGE } : undefined,
    columnSpan: options.span || undefined,
    rowSpan: options.rowSpan || undefined,
    verticalAlign: options.vAlign || VerticalAlign.CENTER,
    shading: options.fill
      ? { type: ShadingType.CLEAR, color: 'auto', fill: options.fill }
      : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    borders: options.borders || undefined,
  });
}

export function headCell(content, options = {}) {
  return cell(content, {
    bold: true,
    fill: options.fill || COLOURS.BAND,
    align: options.align || AlignmentType.CENTER,
    size: options.size || 9.5,
    ...options,
  });
}

/**
 * The note's heading colour, ready to use.
 *
 * Each page builder starts with
 *
 *     const { headCell, band } = themed(note);
 *
 * which deliberately shadows the plain `headCell` above for the rest of that
 * function, so every heading in the document picks up the same colour without
 * seventy call sites having to remember to ask for it. The colour is derived
 * from the note itself rather than held in module state, so two documents
 * being generated at the same time cannot pick up each other's theme.
 */
export function themed(note) {
  const theme = headerTheme(comparedVendorCount(note));
  return {
    theme,
    band: theme.band,
    headCell: (content, options = {}) => headCell(content, { fill: theme.band, ...options }),
  };
}

export function moneyCell(value, options = {}) {
  return cell(value, { align: AlignmentType.RIGHT, ...options });
}

export function table(rows, options = {}) {
  return new Table({
    rows,
    width: { size: options.width || 100, type: WidthType.PERCENTAGE },
    borders: options.borders || GRID,
    columnWidths: options.columnWidths || undefined,
    layout: options.layout || undefined,
  });
}

export function row(cells, options = {}) {
  return new TableRow({
    children: cells,
    tableHeader: options.header || false,
    cantSplit: options.cantSplit !== false,
  });
}

/**
 * The house pattern: a single-cell bordered box holding "Label: value".
 */
export function labelledBox(label, value, options = {}) {
  return table([
    row([
      cell([
        new Paragraph({
          children: [
            text(`${label}: `, { bold: true, size: options.size || 10 }),
            text(value || '', { size: options.size || 10 }),
          ],
          spacing: { after: 20 },
        }),
      ], { width: 100 }),
    ]),
  ], { borders: BOX });
}

/** A bordered, shaded note for warnings and exceptions. */
export function calloutBox(lines, options = {}) {
  const colour = options.tone === 'warn' ? COLOURS.WARN
    : options.tone === 'good' ? COLOURS.GOOD : COLOURS.INK;
  const fill = options.tone === 'warn' ? 'FCE8E6'
    : options.tone === 'good' ? 'E6F4EA' : COLOURS.SOFT;

  const children = (Array.isArray(lines) ? lines : [lines]).map((line, index) => para(line, {
    size: 9,
    color: colour,
    bold: index === 0 && options.boldFirst !== false,
    after: 2,
  }));

  return table([row([cell(children, { width: 100, fill })])], { borders: BOX });
}

export const ALIGN = AlignmentType;
export const VALIGN = VerticalAlign;
export { Paragraph, TextRun, HeadingLevel };

export const DOC_STYLES = {
  default: {
    document: {
      run: { font: FONT, size: pt(10), color: COLOURS.INK },
      paragraph: { spacing: { after: 40, line: 240 } },
    },
  },
};

export const PAGE_MARGINS = {
  top: 720, bottom: 600, left: 720, right: 720,
};

export const LANDSCAPE_MARGINS = {
  top: 600, bottom: 600, left: 600, right: 600,
};
