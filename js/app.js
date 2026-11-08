import { IdbStore } from './storage.js';
import { processBatch, stats, STATUS, STATUS_LABEL, SUPPORTED, ext } from './batch-manager.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => new Intl.NumberFormat('vi-VN').format(n);

const store = new IdbStore();
const state = { invoices: [], selected: new Set(), mergeSelection: new Set(), sort: { key: 'order', dir: 1 }, q: '', flt: '', abort: null };

// Phase 2: chưa có bộ đọc. Trả về hồ sơ rỗng trạng thái "Chưa đọc" — KHÔNG tạo dữ liệu giả.
// Phase 3 thay hàm này bằng pipeline XML → PDF text → OCR.
const processFile = async () => ({ status: STATUS.UNREAD, notes: ['Chưa có bộ máy đọc (Giai đoạn 3)'] });

async function expandFiles(list) {
  const out = [], errors = [];
  for (const f of list) {
    if (ext(f.name) !== 'zip') { out.push(f); continue; }
    try {
      const JSZip = (await import('../vendor/jszip.min.js').then((m) => m.default || window.JSZip)) || window.JSZip;
      const zip = await JSZip.loadAsync(f);
      for (const e of Object.values(zip.files)) {
        if (e.dir || !SUPPORTED.includes(ext(e.name))) continue;
        out.push(new File([await e.async('blob')], e.name.split('/').pop()));
      }
    } catch (e) { errors.push({ name: f.name, message: 'Không mở được ZIP (thiếu vendor/jszip.min.js hoặc tệp hỏng)' }); }
  }
  return { files: out, errors };
}

async function handleFiles(list) {
  if (state.abort) return;
  const { files, errors: zipErrors } = await expandFiles([...list]);
  showErrors(zipErrors);
  if (!files.length) return;
  state.abort = new AbortController();
  setProgress(0, files.length, '');
  try {
    const r = await processBatch({ files, processFile, store, signal: state.abort.signal,
      onProgress: (p) => setProgress(p.index, p.total, p.name) });
    showErrors([...zipErrors, ...r.errors]);
    if (r.committed) { state.invoices = r.invoices; state.selected.clear(); state.mergeSelection.clear(); }
    else showErrors([...zipErrors, ...r.errors, { name: 'Lô mới', message: 'Không có tệp hợp lệ, giữ nguyên lô hiện tại' }]);
  } catch (e) {
    showErrors([{ name: 'Lô mới', message: e.name === 'AbortError' ? 'Đã hủy, giữ nguyên lô hiện tại' : `Lỗi: ${e.message}. Giữ nguyên lô hiện tại` }]);
  } finally { state.abort = null; $('#prog').hidden = true; render(); }
}

function setProgress(i, n, name) {
  $('#prog').hidden = false; $('#barfill').style.width = `${(i / n) * 100}%`;
  $('#progtxt').textContent = `Đang xử lý ${i + 1}/${n} ${name}`;
}
function showErrors(errs) { $('#errs').innerHTML = errs.map((e) => `<li>${esc(e.name)}: ${esc(e.message)}</li>`).join(''); }

const COLS = [
  ['order', 'STT', (i) => i.order + 1], ['fileName', 'Tên tệp', (i) => i.fileName],
  ['sellerName', 'Tên đơn vị', (i) => i.fields.sellerName.value], ['sellerTax', 'MST', (i) => i.fields.sellerTax.value],
  ['formNo', 'Mẫu số', (i) => i.fields.formNo.value], ['serial', 'Ký hiệu', (i) => i.fields.serial.value],
  ['invoiceNo', 'Số hóa đơn', (i) => i.fields.invoiceNo.value], ['invoiceDate', 'Ngày', (i) => i.fields.invoiceDate.value],
  ['amount', 'Số tiền', (i) => i.fields.amount.value, true], ['description', 'Nội dung', (i) => i.fields.description.value],
  ['status', 'Trạng thái', (i) => STATUS_LABEL[i.status]],
];

function visible() {
  const q = state.q.toLowerCase(), g = COLS.find((c) => c[0] === state.sort.key)[2];
  return state.invoices
    .filter((i) => (!state.flt || i.status === state.flt) && (!q || COLS.some((c) => String(c[2](i) ?? '').toLowerCase().includes(q))))
    .sort((a, b) => { const x = g(a), y = g(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi')) * state.sort.dir; });
}

function render() {
  const s = stats(state.invoices);
  $('#dash').innerHTML = [['Tổng hóa đơn', s.total, ''], ['Đọc thành công', s.read, ''], ['Đủ dữ liệu', s.ok, ''],
    ['Cần rà soát', s.review, 'review'], ['Thiếu dữ liệu', s.missing, 'missing'], ['Có xung đột', s.conflict, 'conflict'],
    ['Chưa đọc', s.unread, 'unread'], ['Tổng số tiền', fmt(s.amount), '']]
    .map(([l, v, c]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  const rows = visible();
  $('#empty').hidden = state.invoices.length > 0;
  $('#tbl').innerHTML = state.invoices.length ? `<thead><tr><th><input type="checkbox" id="all" aria-label="Chọn tất cả"></th>${COLS.map((c) =>
    `<th tabindex="0" data-k="${c[0]}">${c[1]}${state.sort.key === c[0] ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((i) =>
    `<tr><td><input type="checkbox" data-id="${i.id}" ${state.selected.has(i.id) ? 'checked' : ''} aria-label="Chọn ${esc(i.fileName)}"></td>${COLS.map((c) => {
      const v = c[2](i); return c[0] === 'status' ? `<td><span class="pill ${i.status}">${esc(v)}</span></td>` :
        `<td${c[3] ? ' class="num"' : ''}>${c[3] && v !== '' ? fmt(v) : esc(v)}</td>`; }).join('')}</tr>`).join('')}</tbody>` : '';
}

async function remove(ids, msg) {
  if (!ids.length) return;
  if (!confirm(`${msg} (${ids.length} hồ sơ)? Thao tác này không hoàn tác được.`)) return;
  await store.deleteInvoices(ids);
  state.invoices = state.invoices.filter((i) => !ids.includes(i.id)).map((i, n) => ({ ...i, order: n }));
  ids.forEach((id) => { state.selected.delete(id); state.mergeSelection.delete(id); });
  for (const i of state.invoices) await store.updateInvoice(i);
  render();
}

function bind() {
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => handleFiles(ev.dataTransfer.files));
  $('#pick').addEventListener('change', (ev) => { handleFiles(ev.target.files); ev.target.value = ''; });
  $('#cancel').addEventListener('click', () => state.abort?.abort());
  $('#q').addEventListener('input', (ev) => { state.q = ev.target.value; render(); });
  $('#flt').innerHTML += Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#flt').addEventListener('change', (ev) => { state.flt = ev.target.value; render(); });
  $('#delSel').addEventListener('click', () => remove([...state.selected], 'Xóa các hóa đơn đã chọn'));
  $('#delUnread').addEventListener('click', () => remove(state.invoices.filter((i) => i.status === STATUS.UNREAD || i.status === STATUS.ERROR).map((i) => i.id), 'Xóa hồ sơ chưa nhận dạng được'));
  $('#delAll').addEventListener('click', async () => {
    if (!state.invoices.length || !confirm('Xóa toàn bộ lô hiện tại? Thao tác này không hoàn tác được.')) return;
    await store.clearAll(); state.invoices = []; state.selected.clear(); state.mergeSelection.clear(); render();
  });
  $('#tbl').addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-k]');
    if (th) { const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; render(); }
    if (ev.target.id === 'all') { const on = ev.target.checked; visible().forEach((i) => (on ? state.selected.add(i.id) : state.selected.delete(i.id))); render(); }
    const id = ev.target.dataset?.id; if (id) { ev.target.checked ? state.selected.add(id) : state.selected.delete(id); }
  });
}

(async function init() {
  bind();
  try { await store.init(); const { invoices } = await store.loadCurrent(); state.invoices = invoices; }
  catch (e) { showErrors([{ name: 'Lưu trữ', message: 'Không mở được IndexedDB. Dữ liệu sẽ mất khi tải lại trang.' }]); store.commitBatch = async () => {}; store.loadCurrent = async () => ({ invoices: [] }); store.deleteInvoices = store.updateInvoice = store.clearAll = async () => {}; }
  render();
})();
