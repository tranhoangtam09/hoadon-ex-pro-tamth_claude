// Trích xuất từ XML hóa đơn điện tử. Người bán / người mua chỉ lấy từ đúng nhóm thẻ của mỗi bên.
import { createField } from './batch-manager.js';
import { parseXml, findAll, pick } from './xml-parser.js';
import { checkTax, parseDate, parseMoney, totalsConsistent } from './invoice-validator.js';
import { recordStatus } from './confidence-engine.js';

const A = { // Nhóm alias: chuẩn NĐ123/TT78 trước, định dạng cũ sau (định dạng cũ CHƯA kiểm chứng trên tệp thật).
  seller: ['nban', 'seller'], buyer: ['nmua', 'buyer'], head: ['ttchung', 'invoicedata'],
  name: ['ten', 'sellerlegalname', 'buyerlegalname', 'legalname'], tax: ['mst', 'sellertaxcode', 'buyertaxcode', 'taxcode'],
  addr: ['dchi', 'selleraddressline', 'buyeraddressline', 'addressline'],
  form: ['khmshdon', 'templatecode'], serial: ['khhdon', 'invoiceseries'], no: ['shdon', 'invoicenumber'],
  date: ['nlap', 'invoiceissueddate'], cur: ['dvtte', 'currencycode'],
  total: ['tgtttbso', 'totalamountwithvat'], pre: ['tgtcthue', 'totalamountwithoutvat'], tax$: ['tgtthue', 'totalvatamount'], disc: ['ttcktmai'],
};
const oldSide = { seller: { name: ['sellerlegalname'], tax: ['sellertaxcode'], addr: ['selleraddressline'] }, buyer: { name: ['buyerlegalname'], tax: ['buyertaxcode'], addr: ['buyeraddressline'] } };

const fld = (value, conf, source, extra = {}) => ({ ...createField(), value, confidence: value === '' ? null : conf, source: value === '' ? null : source, ...extra });

export function extractFromXml(xmlText) {
  const root = parseXml(xmlText), notes = [];
  const side = (key) => {
    const box = A[key].map((n) => findAll(root, n)[0]).find(Boolean) || null;
    const get = (k) => pick(box, A[k]) || pick(root, oldSide[key][k]);
    return { name: get('name'), tax: get('tax'), addr: get('addr') };
  };
  const S = side('seller'), B = side('buyer');
  const head = A.head.map((n) => findAll(root, n)[0]).find(Boolean) || root;
  const h = (k) => pick(head, A[k]) || pick(root, A[k]);
  const f = {};

  f.sellerName = fld(S.name, 98, 'xml:NBan/Ten'); f.sellerAddress = fld(S.addr, 98, 'xml:NBan/DChi');
  f.buyerName = fld(B.name, 98, 'xml:NMua/Ten'); f.buyerAddress = fld(B.addr, 98, 'xml:NMua/DChi');
  for (const [k, v, label] of [['sellerTax', S.tax, 'MST người bán'], ['buyerTax', B.tax, 'MST người mua']]) {
    const t = checkTax(v);
    let conf = 98; if (v !== '' && !t.ok) { conf = 60; notes.push(`${label} sai định dạng`); } else if (t.checksum === 'fail') { conf = 85; notes.push(`${label} không khớp số kiểm tra`); }
    f[k] = fld(v === '' ? '' : t.normalized, conf, `xml:${k === 'sellerTax' ? 'NBan' : 'NMua'}/MST`);
  }
  f.formNo = fld(h('form'), 98, 'xml:TTChung/KHMSHDon'); f.serial = fld(h('serial'), 98, 'xml:TTChung/KHHDon');
  f.invoiceNo = fld(h('no'), 98, 'xml:TTChung/SHDon'); f.currency = fld(h('cur'), 98, 'xml:TTChung/DVTTe');
  const rawDate = h('date'), d = parseDate(rawDate);
  if (rawDate && !d) notes.push('Ngày hóa đơn không hợp lệ');
  f.invoiceDate = fld(rawDate ? (d || rawDate) : '', d ? 98 : 50, 'xml:TTChung/NLap');

  const money = (k) => { const r = pick(root, A[k]); return r ? parseMoney(r) : null; };
  const tot = money('total'), pre = money('pre'), tx = money('tax$'), dc = money('disc');
  const cons = totalsConsistent({ pre: pre?.value, tax: tx?.value, total: tot?.value, discount: dc?.value ?? 0 });
  let conf = 98; if (tot?.ambiguous) { conf = 80; notes.push('Số tiền có dấu phân cách chưa rõ nghĩa'); }
  if (cons === false) { conf = Math.min(conf, 70); notes.push('Tiền hàng + thuế không khớp tổng thanh toán'); }
  f.amount = fld(tot ? tot.value : '', conf, 'xml:TToan/TgTTTBSo');
  if (!tot && pick(root, A.total)) notes.push('Không đọc được tổng thanh toán');

  const names = []; // bỏ dòng chiết khấu (TChat=3) và ghi chú (TChat=4)
  for (const it of findAll(root, 'hhdvu')) { const tc = pick(it, ['tchat']); if (tc === '3' || tc === '4') continue; const n = pick(it, ['thhdvu']); if (n && !names.includes(n)) names.push(n); }
  f.description = fld(names.join('; '), 98, 'xml:DSHHDVu/HHDVu/THHDVu');

  const fields = Object.assign(Object.fromEntries(Object.keys(f).map((k) => [k, f[k]])), {});
  return { fields, status: recordStatus(fields), notes, extra: { lineCount: names.length } };
}
