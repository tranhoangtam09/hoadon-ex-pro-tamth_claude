import { IdbStore } from './storage.js';
import { extractFromXml } from './invoice-analyzer.js';
import { exportExcel, inspectTemplate, TEMPLATES } from './excel-exporter.js';
import { mergeToPdf, MergeError, MAX_FILES, MERGE_EXT } from './pdf-merger.js';
import { processBatch, stats, STATUS, STATUS_LABEL, SUPPORTED, ext } from './batch-manager.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => new Intl.NumberFormat('vi-VN').format(n);

const store = new IdbStore();
const state = { invoices: [], selected: new Set(), mergeSelection: new Set(), mergeList: [], tpl: {}, sort: { key: 'order', dir: 1 }, q: '', flt: '', abort: null };

// XML: bộ đọc thật. PDF/ảnh: chưa có bộ đọc (Giai đoạn 3b) nên để trống, KHÔNG tạo dữ liệu giả.
const processFile = async (file) => {
  if (ext(file.name) === 'xml') return extractFromXml(await file.text()); // XML lỗi sẽ ném lỗi → tệp bị loại khỏi lô
  return { status: STATUS.UNREAD, notes: ['Chưa có bộ đọc cho PDF/ảnh'] };
};

const libs = {};
function loadLib(name, src, global) {
  return (libs[name] ||= new Promise((ok, no) => {
    if (window[global]) return ok(window[global]);
    const el = document.createElement('script'); el.src = src;
    el.onload = () => (window[global] ? ok(window[global]) : no(new Error(`Thiếu ${global}`)));
    el.onerror = () => { delete libs[name]; no(new Error(`Không tải được ${src}`)); }; document.head.append(el);
  }));
}
const JSZipP = () => loadLib('jszip', 'vendor/jszip.min.js', 'JSZip');
const PDFLibP = () => loadLib('pdflib', 'vendor/pdf-lib.min.js', 'PDFLib');

async function expandFiles(list) {
  const out = [], errors = [];
  for (const f of list) {
    if (ext(f.name) !== 'zip') { out.push(f); continue; }
    try {
      const zip = await (await JSZipP()).loadAsync(f);
      for (const e of Object.values(zip.files)) {
        if (e.dir || !SUPPORTED.includes(ext(e.name))) continue;
        out.push(new File([await e.async('blob')], e.name.split('/').pop()));
      }
    } catch (e) { errors.push({ name: f.name, message: `Không mở được ZIP: ${e.message}` }); }
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
    if (r.committed) { state.invoices = r.invoices; state.selected.clear(); state.mergeSelection.clear(); state.mergeList = []; renderMerge(); }
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
      const v = c[2](i); return c[0] === 'status' ? `<td><span class="pill ${i.status}" title="${esc((i.notes||[]).join('; '))}">${esc(v)}</span></td>` :
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
    await store.clearAll(); state.invoices = []; state.selected.clear(); state.mergeSelection.clear(); state.mergeList = []; renderMerge(); render();
  });
  $('#tbl').addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-k]');
    if (th) { const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; render(); }
    if (ev.target.id === 'all') { const on = ev.target.checked; visible().forEach((i) => (on ? state.selected.add(i.id) : state.selected.delete(i.id))); render(); }
    const id = ev.target.dataset?.id; if (id) { ev.target.checked ? state.selected.add(id) : state.selected.delete(id); }
  });
}

// ---------- Xuất Excel ----------
const download = (data, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const FILE_NAME = { transfer: 'Bang_ke_hoa_don_chuyen_khoan_VND', compensation: 'Bang_ke_hoa_don_bu_dap_VND' };

function renderTpl(kind) {
  const box = document.querySelector(`.tpl[data-kind="${kind}"]`), t = state.tpl[kind], st = box.querySelector('.st'), go = box.querySelector('.go');
  const ready = t?.ok; st.className = 'st ' + (!t ? 'muted' : ready ? 'ok' : 'bad');
  st.textContent = !t ? 'Chưa tải mẫu' : ready ? `Sẵn sàng xuất Excel (${t.name})` : 'Mẫu không hợp lệ';
  go.disabled = !ready;
  if (t && !ready) $('#xerr').innerHTML = t.errors.map((e) => `<li>${esc(TEMPLATES[kind].label)}: ${esc(e)}</li>`).join('');
}
async function setTemplate(kind, file) {
  $('#xerr').innerHTML = '';
  const buf = await file.arrayBuffer(), r = await inspectTemplate(await JSZipP(), buf, kind);
  state.tpl[kind] = { ...r, name: file.name, buf };
  if (r.ok) await store.setMeta('tpl:' + kind, { name: file.name, buf }); else await store.delMeta('tpl:' + kind);
  renderTpl(kind);
}
async function doExport(kind) {
  $('#xerr').innerHTML = '';
  try {
    const r = await exportExcel(await JSZipP(), state.tpl[kind].buf, kind, state.invoices, { party: $('#party').value });
    const gaps = state.invoices.filter((i) => i.status === STATUS.MISSING || i.status === STATUS.UNREAD).length;
    download(r.data, `${FILE_NAME[kind]}_${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const msgs = [...r.warnings, ...(gaps ? [`${gaps} hóa đơn thiếu dữ liệu hoặc chưa đọc: ô tương ứng để trống, hãy bổ sung trước khi nộp`] : []), ...(state.invoices.length ? [] : ['Chưa có hóa đơn: tệp xuất chỉ có dòng trống theo mẫu'])];
    $('#xerr').innerHTML = msgs.map((m) => `<li>${esc(m)}</li>`).join('');
  } catch (e) { $('#xerr').innerHTML = `<li>${esc(e.message)}</li>`; }
}

// ---------- Gộp PDF / ảnh ----------
function renderMerge() {
  $('#mlist').innerHTML = state.mergeList.map((m, i) => `<li><span class="nm">${esc(m.name)}</span><button data-a="up" data-i="${i}" aria-label="Lên" ${i ? '' : 'disabled'}>▲</button><button data-a="dn" data-i="${i}" aria-label="Xuống" ${i < state.mergeList.length - 1 ? '' : 'disabled'}>▼</button><button data-a="rm" data-i="${i}" aria-label="Bỏ">✕</button></li>`).join('')
    || '<li class="muted">Chưa có tệp nào.</li>';
  $('#mgo').disabled = !state.mergeList.length;
}
function addToMerge(files) {
  const errs = [];
  for (const f of files) {
    if (!MERGE_EXT.includes(ext(f.name)) || ext(f.name).startsWith('tif')) { errs.push(`${f.name}: định dạng không được hỗ trợ khi gộp (dùng PDF, JPG, PNG, WEBP)`); continue; }
    if (state.mergeList.length >= MAX_FILES) { errs.push(`${f.name}: đã đủ ${MAX_FILES} tệp, không thêm được`); continue; }
    state.mergeList.push({ name: f.name, blob: f });
  }
  $('#merr').innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join(''); renderMerge();
}
// WEBP, hoặc JPEG có xoay EXIF → PNG qua canvas (trình duyệt tự áp dụng hướng EXIF khi giải mã).
async function rasterize(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
  return new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/png'))).arrayBuffer());
}
async function doMerge() {
  $('#merr').innerHTML = ''; $('#mgo').disabled = true;
  try {
    const items = []; for (const m of state.mergeList) items.push({ name: m.name, bytes: new Uint8Array(await m.blob.arrayBuffer()) });
    const r = await mergeToPdf(await PDFLibP(), items, { rasterize });
    download(r.bytes, `Hoa_don_gop_${stamp()}.pdf`, 'application/pdf');
    $('#merr').innerHTML = `<li class="muted">Đã gộp ${items.length} tệp thành PDF ${r.pageCount} trang.</li>`;
  } catch (e) { $('#merr').innerHTML = (e instanceof MergeError ? e.problems.map((p) => `${p.name}: ${p.message}`) : [e.message]).map((m) => `<li>${esc(m)}</li>`).join(''); }
  finally { renderMerge(); }
}
function bindTools() {
  document.querySelectorAll('.tpl').forEach((box) => {
    const kind = box.dataset.kind;
    box.querySelector('input[type=file]').addEventListener('change', (ev) => { if (ev.target.files[0]) setTemplate(kind, ev.target.files[0]); ev.target.value = ''; });
    box.querySelector('.go').addEventListener('click', () => doExport(kind));
  });
  $('#mpick').addEventListener('change', (ev) => { addToMerge([...ev.target.files]); ev.target.value = ''; });
  $('#mfromsel').addEventListener('click', async () => {
    const picked = state.invoices.filter((i) => state.selected.has(i.id) && MERGE_EXT.includes(i.fileType));
    const files = []; for (const i of picked) { const r = await store.getFile(i.id); if (r) files.push(new File([r.blob], i.fileName)); }
    addToMerge(files);
  });
  $('#mclear').addEventListener('click', () => { state.mergeList = []; $('#merr').innerHTML = ''; renderMerge(); });
  $('#mgo').addEventListener('click', doMerge);
  $('#mlist').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-a]'); if (!b) return; const i = +b.dataset.i, L = state.mergeList;
    if (b.dataset.a === 'rm') L.splice(i, 1); else { const j = b.dataset.a === 'up' ? i - 1 : i + 1; [L[i], L[j]] = [L[j], L[i]]; }
    renderMerge();
  });
}

(async function init() {
  bind(); bindTools(); renderMerge();
  try { await store.init(); const { invoices } = await store.loadCurrent(); state.invoices = invoices;
    for (const kind of Object.keys(TEMPLATES)) { const m = await store.getMeta('tpl:' + kind); if (m) { const r = await inspectTemplate(await JSZipP(), m.buf, kind); state.tpl[kind] = { ...r, name: m.name, buf: m.buf }; renderTpl(kind); } } }
  catch (e) { showErrors([{ name: 'Lưu trữ', message: 'Không mở được IndexedDB. Dữ liệu sẽ mất khi tải lại trang.' }]); store.commitBatch = async () => {}; store.loadCurrent = async () => ({ invoices: [] }); store.deleteInvoices = store.updateInvoice = store.clearAll = store.setMeta = store.delMeta = async () => {}; store.getMeta = async () => undefined; }
  render();
})();
