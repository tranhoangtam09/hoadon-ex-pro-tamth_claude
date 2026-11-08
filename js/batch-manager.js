// Quản lý lô: xử lý độc lập trong vùng tạm, chỉ thay lô cũ khi có ít nhất một tệp hợp lệ.
export const STATUS = { OK: 'ok', REVIEW: 'review', MISSING: 'missing', CONFLICT: 'conflict', UNREAD: 'unread', ERROR: 'error' };
export const STATUS_LABEL = { ok: 'Đủ dữ liệu', review: 'Cần rà soát', missing: 'Thiếu dữ liệu', conflict: 'Có xung đột', unread: 'Chưa đọc', error: 'Lỗi' };
export const FIELD_KEYS = ['sellerName', 'sellerTax', 'sellerAddress', 'buyerName', 'buyerTax', 'buyerAddress',
  'formNo', 'serial', 'invoiceNo', 'invoiceDate', 'amount', 'currency', 'description'];
export const SUPPORTED = ['xml', 'pdf', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp'];

export const ext = (name) => (name.split('.').pop() || '').toLowerCase();
// Trường rỗng: không suy đoán, không điền giả.
export const createField = () => ({ value: '', source: null, bbox: null, confidence: null, verified: false, edited: false, history: [] });
export const emptyFields = () => Object.fromEntries(FIELD_KEYS.map((k) => [k, createField()]));

let seq = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function stats(invoices) {
  const n = (s) => invoices.filter((i) => i.status === s).length;
  const amount = invoices.reduce((t, i) => { const v = Number(i.fields.amount.value); return t + (Number.isFinite(v) ? v : 0); }, 0);
  return { total: invoices.length, read: invoices.filter((i) => i.status !== STATUS.UNREAD && i.status !== STATUS.ERROR).length,
    ok: n(STATUS.OK), review: n(STATUS.REVIEW), missing: n(STATUS.MISSING), conflict: n(STATUS.CONFLICT), unread: n(STATUS.UNREAD), amount };
}

/**
 * processFile(file, ctx) -> { fields?, status?, notes? }; ném lỗi nếu không đọc được.
 * Trả về { committed, invoices, errors }. Hủy (signal) hoặc lỗi toàn bộ: KHÔNG ghi gì, lô cũ giữ nguyên.
 */
export async function processBatch({ files, processFile, store, onProgress = () => {}, signal }) {
  const batchId = uid('batch'), staged = [], blobs = [], errors = [];
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new DOMException('Đã hủy xử lý', 'AbortError');
    const f = files[i];
    onProgress({ index: i, total: files.length, name: f.name });
    try {
      if (!SUPPORTED.includes(ext(f.name))) throw new Error(`Định dạng .${ext(f.name)} không được hỗ trợ`);
      const r = (await processFile(f, { batchId, signal })) || {};
      const id = uid('inv');
      staged.push({ id, batchId, order: staged.length, fileName: f.name, fileType: ext(f.name), size: f.size ?? 0,
        fields: { ...emptyFields(), ...(r.fields || {}) }, status: r.status || STATUS.UNREAD, notes: r.notes || [] });
      blobs.push({ id, blob: f });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push({ name: f.name, message: e.message });
    }
  }
  if (signal?.aborted) throw new DOMException('Đã hủy xử lý', 'AbortError');
  if (!staged.length) return { committed: false, invoices: [], errors };
  await store.commitBatch({ id: batchId, createdAt: new Date().toISOString(), count: staged.length }, staged, blobs);
  return { committed: true, invoices: staged, errors };
}
