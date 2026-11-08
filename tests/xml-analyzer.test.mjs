// DỮ LIỆU TỰ DỰNG (không phải hóa đơn thật). Chỉ chứng minh parser đúng với cấu trúc chuẩn NĐ123/TT78.
// Cần nghiệm thu lại bằng XML thật của nhà cung cấp (MISA, Viettel, VNPT...) và giá trị chuẩn.
import assert from 'node:assert/strict';
import { extractFromXml } from '../js/invoice-analyzer.js';
import { checkTax, parseDate, parseMoney } from '../js/invoice-validator.js';
import { parseXml } from '../js/xml-parser.js';

const SELLER = '0312345673', BUYER = '0100000003'; // MST hư cấu, đúng số kiểm tra
const mk = ({ ns = '', pfx = '', up = false, lines, total = '1100000', pre = '1000000', tax = '100000', date = '2026-09-11', sellerTax = SELLER, extra = '' } = {}) => {
  const t = (n) => (up ? n.toUpperCase() : n);
  const o = (n) => `<${pfx}${t(n)}>`, c = (n) => `</${pfx}${t(n)}>`, e = (n, v) => `${o(n)}${v}${c(n)}`;
  const ls = (lines || [{ n: 'Dịch vụ A', tc: '1' }]).map((l) => o('HHDVu') + e('TChat', l.tc) + e('THHDVu', l.n) + e('ThTien', '500000') + c('HHDVu')).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><${pfx}${t('HDon')}${ns}>${o('DLHDon')}${o('TTChung')}${e('KHMSHDon', '1')}${e('KHHDon', 'C26TAA')}${e('SHDon', '126')}${e('NLap', date)}${e('DVTTe', 'VND')}${c('TTChung')}` +
    `${o('NDHDon')}${o('NBan')}${e('Ten', 'CÔNG TY BÁN HÀNG &amp; DỊCH VỤ')}${e('MST', sellerTax)}${e('DChi', '1 Nguyễn Huệ')}${c('NBan')}` +
    `${o('NMua')}${e('Ten', 'CÔNG TY MUA')}${e('MST', BUYER)}${e('DChi', '2 Lê Lợi')}${c('NMua')}${o('DSHHDVu')}${ls}${c('DSHHDVu')}` +
    `${o('TToan')}${e('TgTCThue', pre)}${e('TgTThue', tax)}${e('TgTTTBSo', total)}${c('TToan')}${c('NDHDon')}${extra}${c('DLHDon')}</${pfx}${t('HDon')}>`;
};
const R = [], t = async (n, fn) => { try { await fn(); R.push(['PASS', n]); } catch (e) { R.push(['FAIL', `${n} → ${e.message}`]); } };
const v = (r, k) => r.fields[k].value;

await t('Cấu trúc chuẩn: đủ các trường, người bán ≠ người mua', () => {
  const r = extractFromXml(mk());
  assert.equal(v(r, 'sellerName'), 'CÔNG TY BÁN HÀNG & DỊCH VỤ'); assert.equal(v(r, 'sellerTax'), SELLER);
  assert.equal(v(r, 'buyerName'), 'CÔNG TY MUA'); assert.equal(v(r, 'buyerTax'), BUYER);
  assert.equal(v(r, 'formNo'), '1'); assert.equal(v(r, 'serial'), 'C26TAA'); assert.equal(v(r, 'invoiceNo'), '126');
  assert.equal(v(r, 'invoiceDate'), '11/09/2026'); assert.equal(v(r, 'amount'), 1100000); assert.equal(r.status, 'ok');
});
await t('Namespace mặc định và tiền tố namespace', () => {
  for (const x of [mk({ ns: ' xmlns="http://example.test/inv"' }), mk({ ns: ' xmlns:inv="http://example.test/inv"', pfx: 'inv:' })]) {
    const r = extractFromXml(x); assert.equal(v(r, 'invoiceNo'), '126'); assert.equal(v(r, 'sellerTax'), SELLER);
  }
});
await t('Tên thẻ viết hoa', () => assert.equal(v(extractFromXml(mk({ up: true })), 'invoiceNo'), '126'));
await t('Nhiều dòng hàng: nối tên, bỏ chiết khấu/ghi chú, không trùng', () => {
  const r = extractFromXml(mk({ lines: [{ n: 'Hàng 1', tc: '1' }, { n: 'Hàng 2', tc: '1' }, { n: 'Hàng 1', tc: '1' }, { n: 'Chiết khấu', tc: '3' }, { n: 'Ghi chú', tc: '4' }] }));
  assert.equal(v(r, 'description'), 'Hàng 1; Hàng 2');
});
await t('Ngày: ISO có giờ, dd/mm/yyyy, ngày sai', () => {
  assert.equal(v(extractFromXml(mk({ date: '2026-09-11T08:30:00' })), 'invoiceDate'), '11/09/2026');
  assert.equal(v(extractFromXml(mk({ date: '05-01-2026' })), 'invoiceDate'), '05/01/2026');
  const bad = extractFromXml(mk({ date: '2026-02-30' })); assert.equal(bad.status, 'review'); assert.ok(bad.notes.some((n) => n.includes('Ngày')));
});
await t('Số tiền lệch tổng → cần rà soát, không tự sửa', () => {
  const r = extractFromXml(mk({ total: '1200000' })); assert.equal(v(r, 'amount'), 1200000); assert.equal(r.status, 'review');
});
await t('MST sai định dạng / sai số kiểm tra bị đánh dấu', () => {
  assert.equal(extractFromXml(mk({ sellerTax: '12345' })).status, 'review');
  const r = extractFromXml(mk({ sellerTax: '0312345674' })); assert.equal(r.status, 'review'); assert.equal(v(r, 'sellerTax'), '0312345674');
});
await t('Thiếu trường: để trống, báo thiếu, không suy đoán', () => {
  const x = mk().replace(/<SHDon>126<\/SHDon>/, '').replace(/<NLap>[^<]*<\/NLap>/, '');
  const r = extractFromXml(x); assert.equal(v(r, 'invoiceNo'), ''); assert.equal(v(r, 'invoiceDate'), ''); assert.equal(r.status, 'missing');
});
await t('XML sai định dạng ném lỗi', () => {
  for (const x of ['<a><b></a>', '<a>', 'không phải xml', '<a/><b/>', '']) assert.throws(() => parseXml(x));
});
await t('Tiện ích: MST (2 MST công khai đã biết), tiền, ngày', () => {
  assert.equal(checkTax('0100109106').checksum, 'ok'); assert.equal(checkTax('0101243150').checksum, 'ok');
  assert.equal(checkTax('0100109106-001').normalized, '0100109106-001'); assert.equal(checkTax('01001091').ok, false);
  assert.deepEqual(parseMoney('1.234.567,89'), { value: 1234567.89, ambiguous: false });
  assert.deepEqual(parseMoney('1,234,567.89'), { value: 1234567.89, ambiguous: false });
  assert.deepEqual(parseMoney('1234567.5'), { value: 1234567.5, ambiguous: false });
  assert.deepEqual(parseMoney('1.234.567'), { value: 1234567, ambiguous: false });
  assert.equal(parseMoney('1.234').ambiguous, true); assert.equal(parseMoney('abc'), null);
  assert.equal(parseDate('31/04/2026'), null); assert.equal(parseDate('29/02/2028'), '29/02/2028');
});
R.forEach(([a, b]) => console.log(a, b));
process.exit(R.some((r) => r[0] === 'FAIL') ? 1 : 0);
