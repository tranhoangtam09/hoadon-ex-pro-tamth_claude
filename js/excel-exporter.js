// Ghi dữ liệu vào MẪU EXCEL GỐC bằng cách vá trực tiếp OOXML (JSZip). Chỉ sửa sheet dữ liệu và sharedStrings;
// styles, độ rộng cột, ô gộp, sheet hướng dẫn, printerSettings, theme... giữ nguyên từng byte.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colName = (i) => String.fromCharCode(65 + i);
const FIRST_DATA_ROW = 3, HEADER_ROW = 2;

const N = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? { t: 'e' } : { t: 'n', v: Number(v) });
const T = (v) => (v === '' || v == null ? { t: 'e' } : { t: 's', v: String(v) });
const E = { t: 'e' };

export const TEMPLATES = {
  transfer: {
    label: 'Bảng kê hóa đơn chuyển khoản VND', sheet: 'Bảng kê hóa đơn',
    headers: ['stt', 'ma so thue don vi thu huong', 'ten don vi thu huong', 'so tai khoan thu huong', 'ky hieu mau so', 'ky hieu hoa don', 'so hoa don', 'ngay hoa don', 'so tien hoa don', 'loai tien', 'mat hang', 'so tien nhan no'],
    limits: [10, 35, 500, 25, 10, 15, 250, 15, null, null, 500, null],
    // opt.party: 'buyer' (mặc định, theo đặc tả "thụ hưởng/người mua") hoặc 'seller'
    row: (n, f, opt) => { const p = opt.party === 'seller' ? 'seller' : 'buyer'; return [{ t: 'n', v: n }, T(f[p + 'Tax'].value), T(f[p + 'Name'].value), E, T(f.formNo.value), T(f.serial.value), T(f.invoiceNo.value), T(f.invoiceDate.value), N(f.amount.value), T(f.currency.value), T(f.description.value), E]; },
  },
  compensation: {
    label: 'Bảng kê hóa đơn bù đắp VND', sheet: 'Bảng kê hóa đơn GN bù đắp',
    headers: ['stt', 'ma so thue don vi phat hanh', 'ten don vi phat hanh', 'ky hieu mau so', 'ky hieu hoa don', 'so hoa don', 'ngay hoa don', 'so tien hoa don', 'loai tien', 'mat hang', 'so tien nhan no', 'ngay da thanh toan', 'so tien da thanh toan'],
    limits: [10, 35, 500, 10, 15, 250, 15, null, null, 500, null, 15, null],
    // Đơn vị phát hành luôn là NGƯỜI BÁN.
    row: (n, f) => [{ t: 'n', v: n }, T(f.sellerTax.value), T(f.sellerName.value), T(f.formNo.value), T(f.serial.value), T(f.invoiceNo.value), T(f.invoiceDate.value), N(f.amount.value), T(f.currency.value), T(f.description.value), E, E, E],
  },
};

function readSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join(''));
}
const rowsOf = (xml) => [...xml.matchAll(/<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)].map((m) => ({ r: +m[1], xml: m[0], index: m.index }));
const refsOf = (xml) => [...xml.matchAll(/<c\b[^>]*\bt="s"[^>]*>\s*<v>(\d+)<\/v>/g)].map((m) => +m[1]);

async function locate(zip, kind) {
  const spec = TEMPLATES[kind], errors = [];
  const wb = zip.file('xl/workbook.xml'), rels = zip.file('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return { ok: false, errors: ['Không phải tệp .xlsx hợp lệ'] };
  const wbXml = await wb.async('string'), relXml = await rels.async('string');
  const sh = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unesc((/\bname="([^"]*)"/.exec(m[0]) || [])[1] || ''), rid: (/\br:id="([^"]*)"/.exec(m[0]) || [])[1] }));
  const target = sh.find((s) => s.name === spec.sheet);
  if (!target) return { ok: false, errors: [`Không có sheet "${spec.sheet}" (có: ${sh.map((s) => s.name).join(', ') || 'không có'})`] };
  const rel = [...relXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => new RegExp(`\\bId="${target.rid}"`).test(r));
  const path = 'xl/' + ((/\bTarget="([^"]*)"/.exec(rel || '') || [])[1] || '').replace(/^\/?(xl\/)?/, '');
  const f = zip.file(path); if (!f) return { ok: false, errors: ['Không tìm thấy dữ liệu sheet'] };
  const xml = await f.async('string');
  const sstFile = zip.file('xl/sharedStrings.xml'), sst = sstFile ? readSharedStrings(await sstFile.async('string')) : [];
  const rows = rowsOf(xml), hdr = rows.find((r) => r.r === HEADER_ROW), tpl = rows.find((r) => r.r === FIRST_DATA_ROW);
  if (!hdr) errors.push(`Thiếu dòng tiêu đề (dòng ${HEADER_ROW})`);
  if (!tpl) errors.push(`Thiếu dòng mẫu định dạng (dòng ${FIRST_DATA_ROW})`);
  if (hdr) {
    const cells = new Map([...hdr.xml.matchAll(/<c\b[^>]*?\br="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((m) => {
      const inner = m[3] || '', v = /<v>(\d+)<\/v>/.exec(inner);
      const text = /\bt="s"/.test(m[2]) && v ? sst[+v[1]] : [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join('');
      return [m[1], text];
    }));
    spec.headers.forEach((h, i) => { if (!norm(cells.get(colName(i))).startsWith(h)) errors.push(`Cột ${colName(i)}: tiêu đề không khớp mẫu "${h}" (hiện là "${norm(cells.get(colName(i))).slice(0, 40)}")`); });
    if (cells.size > spec.headers.length) errors.push('Mẫu có nhiều cột hơn cấu trúc quy định');
  }
  return { ok: !errors.length, errors, path, xml, rows, tpl, sstPath: sstFile ? 'xl/sharedStrings.xml' : null };
}

export async function inspectTemplate(JSZip, buf, kind) {
  try { const r = await locate(await JSZip.loadAsync(buf), kind); return { ok: r.ok, errors: r.errors }; }
  catch (e) { return { ok: false, errors: ['Không đọc được tệp: ' + e.message] }; }
}

/** rows: mảng `fields` của từng hóa đơn. Trả về { data: Uint8Array, warnings: [] }. */
export async function exportExcel(JSZip, buf, kind, invoices, opt = {}) {
  const spec = TEMPLATES[kind], zip = await JSZip.loadAsync(buf), L = await locate(zip, kind), warnings = [];
  if (!L.ok) throw new Error('Mẫu không hợp lệ: ' + L.errors.join('; '));
  const styleOf = new Map([...L.tpl.xml.matchAll(/<c\b[^>]*?\br="([A-Z]+)3"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => [m[1], (/\bs="(\d+)"/.exec(m[2]) || [])[1]]));
  const rowTag = /<row\b[^>]*>/.exec(L.tpl.xml)[0];
  const cols = spec.headers.length, count = Math.max(invoices.length, 1);

  let out = '';
  for (let k = 0; k < count; k++) {
    const r = FIRST_DATA_ROW + k, cells = invoices[k] ? spec.row(k + 1, invoices[k].fields, opt) : Array(cols).fill(E);
    out += rowTag.replace(/\br="\d+"/, `r="${r}"`) + cells.map((c, i) => {
      const ref = colName(i) + r, s = styleOf.get(colName(i)) != null ? ` s="${styleOf.get(colName(i))}"` : '';
      if (!invoices[k]) return `<c r="${ref}"${s}/>`;
      if (c.t === 's') {
        if (spec.limits[i] && c.v.length > spec.limits[i]) warnings.push(`Dòng ${r}, cột ${colName(i)}: dài ${c.v.length} ký tự, vượt giới hạn ${spec.limits[i]} của mẫu`);
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(c.v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''))}</t></is></c>`;
      }
      return c.t === 'n' ? `<c r="${ref}"${s}><v>${c.v}</v></c>` : `<c r="${ref}"${s}/>`;
    }).join('') + '</row>';
  }
  // Bỏ mọi dòng từ dòng 3 trở xuống (dữ liệu mẫu cũ), giữ dòng 1-2 nguyên văn.
  const removed = L.rows.filter((r) => r.r >= FIRST_DATA_ROW), kept = L.rows.filter((r) => r.r < FIRST_DATA_ROW);
  const sd0 = L.xml.indexOf('<sheetData>'), sd1 = L.xml.indexOf('</sheetData>');
  let xml = L.xml.slice(0, sd0) + '<sheetData>' + kept.map((r) => r.xml).join('') + out + L.xml.slice(sd1);
  xml = xml.replace(/<dimension ref="A1:([A-Z]+)\d+"\/>/, `<dimension ref="A1:$1${FIRST_DATA_ROW + count - 1}"/>`);
  zip.file(L.path, xml, { createFolders: false });

  // Xóa chuỗi dữ liệu mẫu cũ khỏi sharedStrings (giữ nguyên chỉ số để sheet khác không lệch).
  if (L.sstPath) {
    const refsRemoved = removed.flatMap((r) => refsOf(r.xml)), keptSet = new Set(kept.flatMap((r) => refsOf(r.xml)));
    for (const name of Object.keys(zip.files)) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name) && name !== L.path) refsOf(await zip.file(name).async('string')).forEach((i) => keptSet.add(i));
    const blank = new Set(refsRemoved.filter((i) => !keptSet.has(i)));
    let sst = await zip.file(L.sstPath).async('string'), idx = 0;
    sst = sst.replace(/<si>[\s\S]*?<\/si>/g, (m) => (blank.has(idx++) ? '<si><t></t></si>' : m));
    sst = sst.replace(/\bcount="(\d+)"/, (_, c) => `count="${Math.max(0, +c - refsRemoved.length)}"`);
    zip.file(L.sstPath, sst, { createFolders: false });
  }
  return { data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), warnings };
}
