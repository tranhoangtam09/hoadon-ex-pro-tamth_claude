// Kiểm tra định dạng nghiệp vụ. Không suy đoán: giá trị không hợp lệ trả về null/flag, không tự sửa.
const W = [31, 29, 23, 19, 17, 13, 7, 5, 3];

/** MST 10 số hoặc 13 số (10-xxx). Trả về {ok, normalized, checksum:'ok'|'fail'|'na'}. */
export function checkTax(raw) {
  const d = String(raw ?? '').replace(/[\s.]/g, '');
  const m = /^(\d{10})(?:-?(\d{3}))?$/.exec(d);
  if (!m) return { ok: false, normalized: String(raw ?? '').trim(), checksum: 'na' };
  const base = m[1], r = base.slice(0, 9).split('').reduce((s, c, i) => s + Number(c) * W[i], 0) % 11;
  // r = 0 → số kiểm tra tính ra 10, chưa xác minh được quy tắc: không phạt.
  const checksum = r === 0 ? 'na' : (10 - r === Number(base[9]) ? 'ok' : 'fail');
  return { ok: true, normalized: m[2] ? `${base}-${m[2]}` : base, checksum };
}

/** Nhận ISO (có thể kèm giờ), dd/mm/yyyy, dd-mm-yyyy. Trả về 'dd/mm/yyyy' hoặc null nếu không hợp lệ. */
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let y, mo, d, m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s))) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s))) [d, mo, y] = [m[1], m[2], m[3]];
  else return null;
  [y, mo, d] = [+y, +mo, +d];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || y < 1990 || y > 2100) return null;
  return `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
}

/** Số tiền: "1.234.567,89", "1,234,567.89", "1234567.5". Trả về {value, ambiguous} hoặc null. */
export function parseMoney(raw) {
  let s = String(raw ?? '').replace(/[\s₫đĐ]|VN[DĐ]/gi, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  let ambiguous = false, dec = null;
  if (dots && commas) dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (dots + commas === 1) {
    const sep = dots ? '.' : ',', tail = s.split(sep)[1];
    if (tail.length === 3) { ambiguous = true; dec = null; } // "1.234": nghìn hay thập phân?
    else dec = sep;
  } else if (dots > 1 || commas > 1) dec = null;
  if (dec) { const [a, b] = s.split(dec); s = a.replace(/[.,]/g, '') + '.' + b.replace(/[.,]/g, ''); }
  else s = s.replace(/[.,]/g, '');
  const value = Number(s);
  return Number.isFinite(value) ? { value, ambiguous } : null;
}

/** Tiền hàng + thuế (± chiết khấu) = tổng thanh toán, sai số tối đa 1 đồng. null nếu thiếu số liệu. */
export function totalsConsistent({ pre, tax, total, discount = 0 }) {
  if ([pre, tax, total].some((v) => v == null)) return null;
  return [0, discount].some((dc) => Math.abs(pre + tax - dc - total) <= 1);
}
