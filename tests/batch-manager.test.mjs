import assert from 'node:assert/strict';
import { processBatch, STATUS, stats } from '../js/batch-manager.js';
import { MemoryStore } from '../js/storage.js';

const mk = (names) => names.map((n) => ({ name: n, size: 10 }));
const proc = (tag) => async (f) => {
  if (f.name.startsWith('bad')) throw new Error('hỏng');
  const fields = {}; fields.invoiceNo = { value: `${tag}-${f.name}`, source: 'test' }; fields.amount = { value: 1000 };
  return { fields, status: STATUS.OK };
};
const results = [];
const t = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' → ' + e.message]); } };

await t('Lô B thay thế hoàn toàn lô A, không còn dữ liệu A', async () => {
  const s = new MemoryStore();
  await processBatch({ files: mk(['a1.xml', 'a2.pdf']), processFile: proc('A'), store: s });
  await processBatch({ files: mk(['b1.xml']), processFile: proc('B'), store: s });
  const { invoices } = await s.loadCurrent();
  assert.equal(invoices.length, 1);
  assert.ok(!JSON.stringify(invoices).includes('A-'));
  assert.equal(s.files.size, 1);
});
await t('Lô lỗi hoàn toàn: giữ nguyên lô A', async () => {
  const s = new MemoryStore();
  await processBatch({ files: mk(['a1.xml', 'a2.xml']), processFile: proc('A'), store: s });
  const r = await processBatch({ files: mk(['bad1.xml', 'x.docx']), processFile: proc('B'), store: s });
  assert.equal(r.committed, false); assert.equal(r.errors.length, 2);
  assert.equal((await s.loadCurrent()).invoices.length, 2);
});
await t('Lô lỗi một phần: chỉ giữ tệp hợp lệ, báo lỗi tệp hỏng', async () => {
  const s = new MemoryStore();
  const r = await processBatch({ files: mk(['ok1.xml', 'bad.pdf', 'ok2.png']), processFile: proc('C'), store: s });
  assert.equal(r.committed, true); assert.equal(r.invoices.length, 2); assert.equal(r.errors[0].name, 'bad.pdf');
  assert.deepEqual((await s.loadCurrent()).invoices.map((i) => i.order), [0, 1]);
});
await t('Hủy giữa chừng: không ghi gì, lô cũ giữ nguyên', async () => {
  const s = new MemoryStore();
  await processBatch({ files: mk(['a.xml']), processFile: proc('A'), store: s });
  const ac = new AbortController();
  const p = processBatch({ files: mk(['b1.xml', 'b2.xml']), store: s, signal: ac.signal,
    processFile: async (f) => { ac.abort(); return proc('B')(f); } });
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal((await s.loadCurrent()).invoices[0].fileName, 'a.xml');
});
await t('Ghi thất bại: lô cũ giữ nguyên', async () => {
  const s = new MemoryStore();
  await processBatch({ files: mk(['a.xml']), processFile: proc('A'), store: s });
  s.failNext = true;
  await assert.rejects(processBatch({ files: mk(['b.xml']), processFile: proc('B'), store: s }));
  assert.equal((await s.loadCurrent()).invoices[0].fileName, 'a.xml');
});
await t('Trường chưa nhận dạng để trống, thống kê đúng sau khi xóa', async () => {
  const s = new MemoryStore();
  const r = await processBatch({ files: mk(['a.xml', 'b.xml', 'c.xml']), processFile: async () => ({}), store: s });
  assert.equal(r.invoices[0].fields.sellerTax.value, '');
  await s.deleteInvoices([r.invoices[0].id]);
  const st = stats((await s.loadCurrent()).invoices);
  assert.equal(st.total, 2); assert.equal(st.unread, 2); assert.equal(st.read, 0);
});
results.forEach(([a, b]) => console.log(a, b));
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
