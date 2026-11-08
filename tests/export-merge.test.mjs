// Kiểm thử xuất Excel trên HAI MẪU GỐC thật (tests/templates) và gộp PDF/ảnh. Dữ liệu hóa đơn là TỰ DỰNG.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const JSZip = require('/opt/npm-tools/node_modules/jszip'), PDFLib = require('/opt/npm-tools/node_modules/pdf-lib');
const { exportExcel, inspectTemplate } = await import('../js/excel-exporter.js');
const { mergeToPdf, MergeError } = await import('../js/pdf-merger.js');
const { emptyFields } = await import('../js/batch-manager.js');

const R = [], t = async (n, fn) => { try { await fn(); R.push(['PASS', n]); } catch (e) { R.push(['FAIL', `${n} → ${e.message}`]); } };
const inv = (o) => { const f = emptyFields(); for (const [k, v] of Object.entries(o)) f[k].value = v; return { fields: f }; };
const A = inv({ sellerName: 'CÔNG TY BÁN & CO <A>', sellerTax: '0312345673', buyerName: 'CÔNG TY MUA', buyerTax: '0100000003', formNo: '1', serial: 'C26TAA', invoiceNo: '000126', invoiceDate: '11/09/2026', amount: 1100000, currency: 'VND', description: 'Tôm giống; Dịch vụ' });
const B = inv({ sellerName: 'ĐƠN VỊ B', sellerTax: '', invoiceNo: '7', invoiceDate: '', amount: '' }); // thiếu dữ liệu
const tpl = { transfer: fs.readFileSync('tests/templates/mau_chuyen_khoan.xlsx'), compensation: fs.readFileSync('tests/templates/mau_bu_dap.xlsx') };
const SHEET = { transfer: 'xl/worksheets/sheet1.xml', compensation: 'xl/worksheets/sheet1.xml' };
// Chỉ quét phần dữ liệu (sheet + sharedStrings). workbook.xml của mẫu gốc có siêu dữ liệu absPath của người tạo mẫu, giữ nguyên.
const textOf = async (zip) => (await Promise.all(Object.keys(zip.files).filter((n) => /^xl\/(worksheets\/sheet\d+|sharedStrings)\.xml$/.test(n)).map((n) => zip.file(n).async('string')))).join('\n');

for (const kind of ['transfer', 'compensation']) {
  const cols = kind === 'transfer' ? 12 : 13;
  await t(`[${kind}] mẫu gốc được nhận là hợp lệ`, async () => assert.deepEqual(await inspectTemplate(JSZip, tpl[kind], kind), { ok: true, errors: [] }));
  await t(`[${kind}] mẫu của loại kia bị từ chối`, async () => assert.equal((await inspectTemplate(JSZip, tpl[kind === 'transfer' ? 'compensation' : 'transfer'], kind)).ok, false));
  const many = Array.from({ length: 15 }, (_, i) => (i === 1 ? B : A));
  const { data, warnings } = await exportExcel(JSZip, tpl[kind], kind, many, { party: 'buyer' });
  const outZip = await JSZip.loadAsync(data), inZip = await JSZip.loadAsync(tpl[kind]);
  await t(`[${kind}] mọi phần khác ngoài sheet dữ liệu và sharedStrings giữ nguyên từng byte`, async () => {
    assert.deepEqual(Object.keys(outZip.files).sort(), Object.keys(inZip.files).sort());
    for (const n of Object.keys(inZip.files)) { if (n === SHEET[kind] || n === 'xl/sharedStrings.xml' || inZip.files[n].dir) continue;
      assert.ok(Buffer.compare(await inZip.file(n).async('nodebuffer'), await outZip.file(n).async('nodebuffer')) === 0, `${n} bị thay đổi`); }
  });
  await t(`[${kind}] phần ngoài dữ liệu của sheet (cols, merge, view, tiêu đề dòng 1-2) giữ nguyên`, async () => {
    const a = await inZip.file(SHEET[kind]).async('string'), b = await outZip.file(SHEET[kind]).async('string');
    const strip = (x) => x.replace(/<dimension[^>]*>/, '').replace(/<row r="(?:[3-9]|\d{2,})"[\s\S]*?<\/row>/g, '');
    assert.equal(strip(a), strip(b));
    assert.match(b, new RegExp(`<dimension ref="A1:${kind === 'transfer' ? 'L' : 'M'}17"/>`));
  });
  await t(`[${kind}] kiểu ô (style) mỗi cột của mọi dòng dữ liệu bằng dòng mẫu gốc, 15 dòng, STT 1..15`, async () => {
    const a = await inZip.file(SHEET[kind]).async('string'), b = await outZip.file(SHEET[kind]).async('string');
    const sty = (x, r) => [...(new RegExp(`<row r="${r}"[\\s\\S]*?</row>`).exec(x)[0]).matchAll(/<c r="([A-Z]+)\d+" s="(\d+)"/g)].map((m) => m[1] + m[2]).join();
    for (let r = 3; r <= 17; r++) assert.equal(sty(b, r), sty(a, 3));
    assert.equal(sty(b, 17).split(',').length, cols);
    assert.deepEqual([...b.matchAll(/<c r="A(\d+)"[^>]*><v>(\d+)<\/v>/g)].filter((m) => +m[1] >= 3).map((m) => +m[2]), Array.from({ length: 15 }, (_, i) => i + 1));
  });
  await t(`[${kind}] không còn dữ liệu mẫu cũ ở bất kỳ phần nào của tệp`, async () => {
    const all = await textOf(outZip);
    for (const x of ['TAN PHAT LOC', 'SHRIMP IMPROVEMENT', 'HI26-190', '1900651704', 'Tôm bố mẹ', 'BKMH', '110626234567']) assert.ok(!all.includes(x), `còn "${x}"`);
  });
  await t(`[${kind}] đọc lại bằng openpyxl: đúng cột, đúng kiểu, thiếu dữ liệu để trống`, async () => {
    fs.writeFileSync(`/tmp/out_${kind}.xlsx`, data);
    const py = `import openpyxl,json
ws=openpyxl.load_workbook('/tmp/out_${kind}.xlsx')['${kind === 'transfer' ? 'Bảng kê hóa đơn' : 'Bảng kê hóa đơn GN bù đắp'}']
print(json.dumps([[ (c.value,c.data_type,c.number_format) for c in ws[r]] for r in (3,4)],ensure_ascii=False)); print(ws.max_row)`;
    const [rows, maxRow] = execSync(`python3 -c "${py.replace(/"/g, '\\"')}"`).toString().trim().split('\n'); const [r3, r4] = JSON.parse(rows);
    assert.equal(maxRow, '17');
    const v = (r) => r.map((c) => c[0]);
    if (kind === 'transfer') { assert.deepEqual(v(r3), [1, '0100000003', 'CÔNG TY MUA', null, '1', 'C26TAA', '000126', '11/09/2026', 1100000, 'VND', 'Tôm giống; Dịch vụ', null]); assert.equal(r3[1][1], 's'); assert.equal(r3[8][1], 'n'); assert.equal(r3[8][2], '_(* #,##0_);_(* \\(#,##0\\);_(* "-"??_);_(@_)'); assert.deepEqual(v(r4), [2, null, null, null, null, null, '7', null, null, null, null, null]); }
    else { assert.deepEqual(v(r3), [1, '0312345673', 'CÔNG TY BÁN & CO <A>', '1', 'C26TAA', '000126', '11/09/2026', 1100000, 'VND', 'Tôm giống; Dịch vụ', null, null, null]); assert.equal(r3[7][2], '#,##0'); assert.deepEqual(v(r4), [2, null, 'ĐƠN VỊ B', null, null, '7', null, null, null, null, null, null, null]); }
  });
  await t(`[${kind}] LibreOffice mở được và chuyển đổi thành công`, async () => {
    execSync(`cd /tmp && rm -rf lo_${kind} && soffice --headless --convert-to csv --outdir lo_${kind} out_${kind}.xlsx >/dev/null 2>&1`, { timeout: 120000 });
    const csv = fs.readFileSync(`/tmp/lo_${kind}/out_${kind}.csv`, 'utf8'); assert.ok(csv.includes('CÔNG TY'), 'csv thiếu dữ liệu');
  });
  await t(`[${kind}] không có hóa đơn: giữ 1 dòng trống đúng định dạng, không dữ liệu cũ`, async () => {
    const z = await JSZip.loadAsync((await exportExcel(JSZip, tpl[kind], kind, [], {})).data), x = await z.file(SHEET[kind]).async('string');
    assert.ok(!/<row r="4"/.test(x)); assert.ok(!(await textOf(z)).includes('TAN PHAT LOC'));
  });
}
await t('[transfer] chọn người bán thì MST/tên lấy từ người bán; mặc định người mua', async () => {
  const get = async (opt) => { const z = await JSZip.loadAsync((await exportExcel(JSZip, tpl.transfer, 'transfer', [A], opt)).data); return z.file(SHEET.transfer).async('string'); };
  assert.match(await get({ party: 'seller' }), /0312345673/); assert.match(await get({}), /0100000003/);
});
await t('Cảnh báo khi vượt giới hạn ký tự của mẫu, không tự cắt dữ liệu', async () => {
  const r = await exportExcel(JSZip, tpl.compensation, 'compensation', [inv({ sellerTax: '1'.repeat(40), sellerName: 'x', serial: 'S' })], {});
  assert.ok(r.warnings.some((w) => w.includes('cột B'))); assert.ok((await (await JSZip.loadAsync(r.data)).file(SHEET.compensation).async('string')).includes('1'.repeat(40)));
});

// ---- Gộp PDF / ảnh ----
const mkPdf = async (sizes) => { const d = await PDFLib.PDFDocument.create(); sizes.forEach((s) => d.addPage(s)); return new Uint8Array(await d.save()); };
const png = new Uint8Array(fs.readFileSync('tests/fixtures/a.png')), jpg = new Uint8Array(fs.readFileSync('tests/fixtures/b.jpg'));
await t('Gộp PDF + ảnh đúng thứ tự, đúng số trang, trang PDF giữ kích thước gốc', async () => {
  const items = [{ name: 'p1.pdf', bytes: await mkPdf([[300, 400], [300, 400]]) }, { name: 'a.png', bytes: png }, { name: 'p2.pdf', bytes: await mkPdf([[500, 200]]) }, { name: 'b.JPG', bytes: jpg }];
  const r = await mergeToPdf(PDFLib, items); assert.equal(r.pageCount, 5);
  const d = await PDFLib.PDFDocument.load(r.bytes), sz = d.getPages().map((p) => p.getSize());
  assert.deepEqual([sz[0], sz[1], sz[3]].map((s) => [s.width, s.height]), [[300, 400], [300, 400], [500, 200]]);
  assert.equal(Math.round(sz[2].width), 90); assert.equal(Math.round(sz[4].height), 105); // ảnh: 120x80 px và 100x140 px × 0,75
});
await t('Quá 10 tệp bị từ chối', async () => {
  const one = { name: 'x.pdf', bytes: await mkPdf([[100, 100]]) };
  assert.equal((await mergeToPdf(PDFLib, Array(10).fill(one))).pageCount, 10);
  await assert.rejects(mergeToPdf(PDFLib, Array(11).fill(one)), (e) => e instanceof MergeError && /Tối đa 10/.test(e.message));
});
await t('Tệp lỗi / sai định dạng: báo đúng tên tệp, không xuất PDF thiếu', async () => {
  const ok = { name: 'ok.pdf', bytes: await mkPdf([[100, 100]]) };
  await assert.rejects(mergeToPdf(PDFLib, [ok, { name: 'hong.pdf', bytes: new Uint8Array([1, 2, 3, 4]) }, { name: 'x.docx', bytes: new Uint8Array([1]) }, { name: 'a.tif', bytes: png }]),
    (e) => e.problems.length === 3 && e.problems.map((p) => p.name).join() === 'hong.pdf,x.docx,a.tif');
});
await t('PDF mã hóa được báo cụ thể', async () => {
  const d = await PDFLib.PDFDocument.create(); d.addPage([100, 100]); // pdf-lib không tạo được PDF mã hóa: giả lập bằng trailer có /Encrypt trỏ tới một đối tượng có thật
  const b = new Uint8Array(await d.save({ useObjectStreams: false })); const s = Buffer.from(b).toString('latin1').replace(/trailer\s*<</, 'trailer\n<< /Encrypt 1 0 R');
  await assert.rejects(mergeToPdf(PDFLib, [{ name: 'khoa.pdf', bytes: new Uint8Array(Buffer.from(s, 'latin1')) }]), (e) => e instanceof MergeError && /mã hóa/.test(e.message));
});
R.forEach(([a, b]) => console.log(a, b)); console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} PASS`);
process.exit(R.some((r) => r[0] === 'FAIL') ? 1 : 0);
