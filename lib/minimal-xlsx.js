/**
 * npm 없이 .xlsx 생성 (ZIP + OOXML). 병동/주치의 색상 · 레이아웃 · 입력 샘플 시트.
 */
const zlib = require('zlib');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
}

function colLetter(index0) {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function sanitizeSheetName(name) {
  return String(name || 'Sheet').replace(/[\\/*?:\[\]]/g, '_').slice(0, 31) || 'Sheet';
}

const SCHEDULE_COL_WIDTHS = [11, 9, 9, 11, 9, 9, 16, 32, 9, 9, 11, 16, 11];
const PASTE_TEMPLATE_HEADERS = ['호실', '환자명', '메모(선택)', '구분', '병동', '주치의', '출발', '귀원'];
const PASTE_COL_WIDTHS = [10, 11, 24, 10, 9, 16, 9, 9];

const WARD_ROW_RGB = {
  '4': 'FFEFF6FF', '5': 'FFF0FDF4', '7': 'FFFFF7ED', '8': 'FFFAF5FF', '9': 'FFFDF2F8',
  other: 'FFF8FAFC', '': 'FFFFFFFF'
};
const WARD_COL_RGB = {
  '4': 'FFDBEAFE', '5': 'FFDCFCE7', '7': 'FFFFEDD5', '8': 'FFF3E8FF', '9': 'FFFCE7F3',
  other: 'FFE2E8F0', '': 'FFF1F5F9'
};

const DOCTOR_PALETTE = [
  'FFE0F2FE', 'FFFCE7F3', 'FFFEF3C7', 'FFD1FAE5', 'FFEDE9FE', 'FFFFE4E6',
  'FFCCFBF1', 'FFE9D5FF', 'FFFFEDD5', 'FFBBF7D0', 'FFE2E8F0', 'FFFEF9C3',
  'FFDDD6FE', 'FFBAE6FD', 'FFFBCFE8', 'FFD9F99D'
];

function doctorFillRgb(name) {
  const s = String(name || '미지정').trim() || '미지정';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return DOCTOR_PALETTE[h % DOCTOR_PALETTE.length];
}

function collectRowStyleKeys(rows) {
  const wardKeys = new Set(['other', '']);
  const doctorKeys = new Set(['미지정']);
  (rows || []).forEach((row) => {
    if (!row || typeof row !== 'object') return;
    if (row.__sheetRole) return;
    const w = row.__wardKey != null ? String(row.__wardKey) : 'other';
    wardKeys.add(w || 'other');
    doctorKeys.add(String(row.__doctorKey || '미지정').trim() || '미지정');
  });
  return { wardKeys: [...wardKeys], doctorKeys: [...doctorKeys] };
}

function buildStyleRegistry(allRows) {
  const { wardKeys, doctorKeys } = collectRowStyleKeys(allRows);
  const fills = [];
  const fillRgbToId = new Map();
  const addFill = (rgb) => {
    const key = rgb || 'FFFFFFFF';
    if (fillRgbToId.has(key)) return fillRgbToId.get(key);
    const id = fills.length;
    fills.push(key);
    fillRgbToId.set(key, id);
    return id;
  };

  addFill('FFFFFFFF');
  addFill('FFBFBFBF');
  const headerFillId = addFill('FF0C4A6E');
  const sampleHeaderFill = addFill('FF0369A1');
  const sampleHintFill = addFill('FFE0F2FE');
  const sampleExampleFill = addFill('FFFFFBEB');
  const samplePasteFill = addFill('FFECFDF5');

  const wardRowFill = {};
  const wardColFill = {};
  wardKeys.forEach((k) => {
    const wk = k === '' ? 'other' : k;
    wardRowFill[k] = addFill(WARD_ROW_RGB[wk] || WARD_ROW_RGB.other);
    wardColFill[k] = addFill(WARD_COL_RGB[wk] || WARD_COL_RGB.other);
  });
  const doctorFill = {};
  doctorKeys.forEach((d) => {
    doctorFill[d] = addFill(doctorFillRgb(d));
  });

  const cellXfs = [];
  const xfKeyToId = new Map();
  const regXf = (fontId, fillId, bold, borderId) => {
    const b = borderId != null ? borderId : 1;
    const key = `${fontId}|${fillId}|${bold ? 1 : 0}|${b}`;
    if (xfKeyToId.has(key)) return xfKeyToId.get(key);
    const id = cellXfs.length;
    cellXfs.push({ fontId, fillId, bold: !!bold, borderId: b });
    xfKeyToId.set(key, id);
    return id;
  };

  const xfDefault = regXf(0, 0, false, 0);
  const xfHeader = regXf(1, headerFillId, true, 1);
  const xfSampleHeader = regXf(1, sampleHeaderFill, true, 1);
  const xfSampleHint = regXf(0, sampleHintFill, false, 1);
  const xfSampleExample = regXf(0, sampleExampleFill, false, 1);
  const xfSamplePasteCol = regXf(0, samplePasteFill, false, 1);
  const xfSampleEmpty = regXf(0, 0, false, 1);

  const wardRowXf = {};
  const wardColXf = {};
  Object.keys(wardRowFill).forEach((k) => {
    wardRowXf[k] = regXf(0, wardRowFill[k], false, 1);
    wardColXf[k] = regXf(0, wardColFill[k], false, 1);
  });
  const doctorXf = {};
  Object.keys(doctorFill).forEach((d) => {
    doctorXf[d] = regXf(0, doctorFill[d], false, 1);
  });

  const COL_WARD = 1;
  const COL_RM = 4;
  const COL_DOCTOR = 6;

  const resolveCellStyle = (row, colIndex) => {
    if (!row || typeof row !== 'object') return xfDefault;
    if (row.__sheetRole === 'sampleHeader') return xfSampleHeader;
    if (row.__sheetRole === 'sampleHint') return xfSampleHint;
    if (row.__sheetRole === 'sampleExample') {
      if (colIndex <= 2) return xfSamplePasteCol;
      return xfSampleExample;
    }
    if (row.__sheetRole === 'sampleEmpty') {
      if (colIndex <= 2) return xfSamplePasteCol;
      return xfSampleEmpty;
    }
    if (row.__sheetRole === 'guide') return regXf(0, 0, false, 0);
    const wKey = row.__wardKey != null ? String(row.__wardKey) : 'other';
    const dKey = String(row.__doctorKey || '미지정').trim() || '미지정';
    if (colIndex === COL_WARD) return wardColXf[wKey] ?? wardColXf.other ?? xfDefault;
    if (colIndex === COL_RM || colIndex === COL_DOCTOR) return doctorXf[dKey] ?? xfDefault;
    return wardRowXf[wKey] ?? wardRowXf.other ?? xfDefault;
  };

  const resolvePasteTemplateStyle = (row, colIndex) => {
    if (!row) return xfDefault;
    if (row.__sheetRole === 'sampleHeader') return xfSampleHeader;
    if (row.__sheetRole === 'sampleHint') return xfSampleHint;
    if (row.__sheetRole === 'sampleExample') {
      return colIndex <= 2 ? xfSamplePasteCol : xfSampleExample;
    }
    if (row.__sheetRole === 'sampleEmpty') {
      return colIndex <= 2 ? xfSamplePasteCol : xfSampleEmpty;
    }
    return xfSampleEmpty;
  };

  const fillsXml = fills.map((rgb, i) => {
    if (i === 0) return '<fill><patternFill patternType="none"/></fill>';
    if (i === 1) return '<fill><patternFill patternType="gray125"/></fill>';
    return `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  }).join('');

  const thinBorder = '<left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom>';
  const bordersXml = `<border><left/><right/><top/><bottom/><diagonal/></border><border>${thinBorder}<diagonal/></border>`;

  const fontsXml = [
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>'
  ].join('');

  const xfsXml = cellXfs.map((xf) => {
    let apply = ' applyFill="1" applyBorder="1"';
    if (xf.bold) apply += ' applyFont="1"';
    if (xf.borderId === 0) apply = xf.bold ? ' applyFont="1"' : '';
    return `<xf numFmtId="0" fontId="${xf.fontId}" fillId="${xf.fillId}" borderId="${xf.borderId}" xfId="0"${apply}/>`;
  }).join('');

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">${fontsXml}</fonts>
<fills count="${fills.length}">${fillsXml}</fills>
<borders count="2">${bordersXml}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${cellXfs.length}">${xfsXml}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  return {
    stylesXml, xfHeader, resolveCellStyle, resolvePasteTemplateStyle, xfDefault, xfSampleHeader
  };
}

function rowCellValue(row, header) {
  if (!row || typeof row !== 'object') return '';
  if (header.startsWith('__')) return '';
  return row[header] != null ? row[header] : '';
}

function buildColsXml(widths) {
  if (!widths || !widths.length) return '';
  const parts = widths.map((w, i) => {
    const n = i + 1;
    return `<col min="${n}" max="${n}" width="${w}" customWidth="1"/>`;
  });
  return `<cols>${parts.join('')}</cols>`;
}

function sheetViewsXml(freezeRows) {
  if (!freezeRows || freezeRows < 1) return '';
  const y = freezeRows;
  return `<sheetViews><sheetView tabSelected="0" workbookViewId="0"><pane ySplit="${y}" topLeftCell="A${y + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
}

function writeRowXml(lines, rowIndex, cells, rowObj, styleRegistry, resolveStyle, opts) {
  const ht = opts && opts.headerRow && rowIndex === 1 ? ' ht="24" customHeight="1"' : '';
  lines.push(`<row r="${rowIndex}"${ht}>`);
  cells.forEach((val, ci) => {
    const ref = `${colLetter(ci)}${rowIndex}`;
    let sAttr = '';
    if (styleRegistry && resolveStyle) {
      const si = resolveStyle(rowObj, ci, !!opts?.isHeader);
      if (si != null && si > 0) sAttr = ` s="${si}"`;
    }
    lines.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`);
  });
  lines.push('</row>');
}

function buildScheduleSheetXml(headers, rows, styleRegistry, colWidths) {
  const dataRows = Array.isArray(rows) ? rows : [];
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  lines.push(sheetViewsXml(1));
  lines.push(buildColsXml(colWidths || SCHEDULE_COL_WIDTHS));
  lines.push('<sheetData>');
  const resolve = (row, ci, isHeader) =>
    isHeader ? styleRegistry.xfHeader : styleRegistry.resolveCellStyle(row, ci);
  writeRowXml(lines, 1, headers, null, styleRegistry, resolve, { isHeader: true, headerRow: true });
  dataRows.forEach((row, i) => {
    writeRowXml(lines, i + 2, headers.map((h) => rowCellValue(row, h)), row, styleRegistry, resolve, {});
  });
  lines.push('</sheetData>');
  const lastRow = Math.max(1, dataRows.length + 1);
  const lastCol = colLetter(headers.length - 1);
  lines.push(`<autoFilter ref="A1:${lastCol}${lastRow}"/>`);
  lines.push('</worksheet>');
  return Buffer.from(lines.join(''), 'utf8');
}

function buildPasteTemplateSheetXml(headers, rows, styleRegistry) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  lines.push(sheetViewsXml(2));
  lines.push(buildColsXml(PASTE_COL_WIDTHS));
  lines.push('<sheetData>');
  const resolve = (row, ci, isHeader) => {
    if (isHeader) return styleRegistry.xfSampleHeader;
    return styleRegistry.resolvePasteTemplateStyle(row, ci);
  };
  let rowNum = 1;
  rows.forEach((row) => {
    const role = row.__sheetRole;
    const cells = role === 'sampleHint'
      ? [row.text || '', '', '', '', '', '', '', '']
      : headers.map((h) => rowCellValue(row, h));
    const isHeader = role === 'sampleHeader';
    writeRowXml(lines, rowNum, cells, row, styleRegistry, resolve, { isHeader, headerRow: isHeader });
    rowNum++;
  });
  lines.push('</sheetData>');
  const lastCol = colLetter(headers.length - 1);
  lines.push(`<autoFilter ref="A2:${lastCol}${Math.max(2, rowNum - 1)}"/>`);
  lines.push('</worksheet>');
  return Buffer.from(lines.join(''), 'utf8');
}

function buildGuideSheetXml(lines, styleRegistry) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  out.push(buildColsXml([72]));
  out.push('<sheetData>');
  (lines || []).forEach((text, i) => {
    writeRowXml(out, i + 1, [text], { __sheetRole: 'guide' }, styleRegistry, () => 0, {});
  });
  out.push('</sheetData>');
  out.push('</worksheet>');
  return Buffer.from(out.join(''), 'utf8');
}

/**
 * @param {string} boardDate YYYY-MM-DD
 */
function buildPasteTemplateRows(boardDate) {
  const dateLabel = boardDate || '선택한 날짜';
  const hintRow = {
    __sheetRole: 'sampleHint',
    text: `※ 아래 초록 열(호실·환자명·메모)만 복사해 메신저 현황판 「여러 명 붙여넣기」에 붙여넣으면 됩니다. 구분·병동·주치의·시간은 현황판에서 먼저 맞춰 주세요. (일정 날짜: ${dateLabel})`
  };
  const header = { __sheetRole: 'sampleHeader' };
  PASTE_TEMPLATE_HEADERS.forEach((h) => { header[h] = h; });
  const examples = [
    { __sheetRole: 'sampleExample', '호실': '503호', '환자명': '김OO', '메모(선택)': 'MRI', '구분': '외진', '병동': '4병동', '주치의': 'RM4 손OO', '출발': '09:00', '귀원': '12:00' },
    { __sheetRole: 'sampleExample', '호실': '505', '환자명': '이OO', '메모(선택)': '', '구분': '외출', '병동': '5병동', '주치의': '', '출발': '14:00', '귀원': '17:00' },
    { __sheetRole: 'sampleExample', '호실': '701호', '환자명': '박OO', '메모(선택)': 'CT', '구분': '외박', '병동': '7병동', '주치의': 'RM7', '출발': '10:00', '귀원': '15:00' }
  ];
  const emptyRows = [];
  for (let i = 0; i < 25; i++) {
    const r = { __sheetRole: 'sampleEmpty' };
    PASTE_TEMPLATE_HEADERS.forEach((h) => { r[h] = ''; });
    emptyRows.push(r);
  }
  return [hintRow, header, ...examples, ...emptyRows];
}

function buildGuideLines(boardDate) {
  const d = boardDate || '(현황판에서 선택한 날짜)';
  return [
    '병동 일정 현황판 — 엑셀 입력 안내',
    '',
    `■ 일정 날짜: ${d}`,
    '■ 「입력샘플」 시트: 호실·환자명·메모를 적거나, 엑셀/메모장에서 복사해 넣으세요.',
    '■ 메신저 등록: 현황판 → 「여러 명 붙여넣기」→ 초록색 3열(호실·환자명·메모)만 복사·붙여넣기 → 일괄 등록.',
    '■ 구분·병동·주치의·출발·귀원 시간은 현황판 상단에서 한 번 설정하면, 붙여넣기한 모든 줄에 같이 적용됩니다.',
    '■ 데이터 시트(전체·병동별): 병동·주치의·RM 열은 색으로 구분됩니다. 첫 행 필터로 정렬·검색 가능.',
    '',
    '구분 예: 외진, 외출, 외박, 검사, 입원, 퇴원 등 (현황판 구분과 동일)',
    '병동 예: 4병동, 5병동, 7병동, 8병동, 9병동 · 호실만 넣으면 병동 자동 추정도 가능합니다.'
  ];
}

function buildSampleSheets(boardDate) {
  return [
    {
      name: '입력샘플',
      kind: 'pasteTemplate',
      headers: PASTE_TEMPLATE_HEADERS,
      rows: buildPasteTemplateRows(boardDate)
    },
    {
      name: '붙여넣기안내',
      kind: 'guide',
      lines: buildGuideLines(boardDate)
    }
  ];
}

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach(({ name, data }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crcVal = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crcVal, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crcVal, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  });
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * @param {{ name: string, rows?: object[], kind?: string, headers?: string[], lines?: string[] }[]} sheets
 * @param {string[]} headers
 * @param {{ boardDate?: string, includeSampleSheets?: boolean }} [options]
 */
function buildXlsxBuffer(sheets, headers, options) {
  const opts = options || {};
  const hdrs = headers && headers.length ? headers : [];
  let normalized = (sheets || []).map((s, i) => ({
    name: sanitizeSheetName(s.name || `Sheet${i + 1}`),
    kind: s.kind || 'schedule',
    rows: s.rows || [],
    headers: s.headers,
    lines: s.lines
  }));
  if (opts.includeSampleSheets !== false) {
    normalized = [...buildSampleSheets(opts.boardDate || ''), ...normalized];
  }
  if (normalized.length === 0) {
    normalized.push({ name: 'Sheet1', kind: 'schedule', rows: [] });
  }

  const scheduleRows = normalized.filter((sh) => sh.kind === 'schedule' || !sh.kind).flatMap((sh) => sh.rows);
  const styleRegistry = buildStyleRegistry([
    ...scheduleRows,
    ...buildPasteTemplateRows(opts.boardDate)
  ]);

  const sheetPaths = normalized.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`);
  const entries = [];

  entries.push({
    name: '[Content_Types].xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetPaths.map((p) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`, 'utf8')
  });

  entries.push({
    name: '_rels/.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8')
  });

  const sheetRels = normalized.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('\n');

  entries.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
<Relationship Id="rId${normalized.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8')
  });

  const sheetTags = normalized.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');

  entries.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets>
</workbook>`, 'utf8')
  });

  entries.push({
    name: 'xl/styles.xml',
    data: Buffer.from(styleRegistry.stylesXml, 'utf8')
  });

  normalized.forEach((sh, i) => {
    let data;
    if (sh.kind === 'pasteTemplate') {
      data = buildPasteTemplateSheetXml(sh.headers || PASTE_TEMPLATE_HEADERS, sh.rows, styleRegistry);
    } else if (sh.kind === 'guide') {
      data = buildGuideSheetXml(sh.lines || buildGuideLines(opts.boardDate), styleRegistry);
    } else {
      data = buildScheduleSheetXml(hdrs, sh.rows, styleRegistry, SCHEDULE_COL_WIDTHS);
    }
    entries.push({ name: sheetPaths[i], data });
  });

  return zipStore(entries);
}

module.exports = { buildXlsxBuffer, sanitizeSheetName, buildSampleSheets, PASTE_TEMPLATE_HEADERS };
