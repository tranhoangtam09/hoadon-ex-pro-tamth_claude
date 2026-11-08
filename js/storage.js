// Lưu trữ cục bộ. IndexedDB cho trình duyệt, MemoryStore cho kiểm thử. Cùng một giao diện.
const DB = 'hdex-tamth', VER = 1;
const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx) => new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error || new Error('Giao dịch bị hủy')); });

export class IdbStore {
  async init() {
    this.db = await new Promise((ok, no) => {
      const o = indexedDB.open(DB, VER);
      o.onupgradeneeded = () => {
        const d = o.result;
        d.createObjectStore('meta');
        d.createObjectStore('invoices', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
      };
      o.onsuccess = () => ok(o.result); o.onerror = () => no(o.error);
    });
  }
  // Thay thế lô hiện tại trong MỘT giao dịch: lỗi thì giữ nguyên lô cũ.
  async commitBatch(batch, invoices, files) {
    const tx = this.db.transaction(['meta', 'invoices', 'files'], 'readwrite');
    tx.objectStore('invoices').clear(); tx.objectStore('files').clear();
    tx.objectStore('meta').put(batch, 'currentBatch');
    invoices.forEach((i) => tx.objectStore('invoices').put(i));
    files.forEach((f) => tx.objectStore('files').put(f));
    await done(tx);
  }
  async loadCurrent() {
    const tx = this.db.transaction(['meta', 'invoices']);
    const [batch, invoices] = await Promise.all([req(tx.objectStore('meta').get('currentBatch')), req(tx.objectStore('invoices').getAll())]);
    return { batch: batch || null, invoices: invoices.sort((a, b) => a.order - b.order) };
  }
  async updateInvoice(inv) { const tx = this.db.transaction('invoices', 'readwrite'); tx.objectStore('invoices').put(inv); await done(tx); }
  async deleteInvoices(ids) {
    const tx = this.db.transaction(['invoices', 'files'], 'readwrite');
    ids.forEach((id) => { tx.objectStore('invoices').delete(id); tx.objectStore('files').delete(id); });
    await done(tx);
  }
  async getFile(id) { return req(this.db.transaction('files').objectStore('files').get(id)); }
  async clearAll() {
    const tx = this.db.transaction(['meta', 'invoices', 'files'], 'readwrite');
    ['meta', 'invoices', 'files'].forEach((s) => tx.objectStore(s).clear());
    await done(tx);
  }
}

export class MemoryStore {
  constructor() { this.batch = null; this.invoices = []; this.files = new Map(); }
  async init() {}
  async commitBatch(batch, invoices, files) {
    if (this.failNext) { this.failNext = false; throw new Error('Ghi thất bại (giả lập)'); }
    this.batch = batch; this.invoices = structuredClone(invoices); this.files = new Map(files.map((f) => [f.id, f]));
  }
  async loadCurrent() { return { batch: this.batch, invoices: structuredClone(this.invoices) }; }
  async updateInvoice(inv) { this.invoices = this.invoices.map((i) => (i.id === inv.id ? structuredClone(inv) : i)); }
  async deleteInvoices(ids) { this.invoices = this.invoices.filter((i) => !ids.includes(i.id)); ids.forEach((id) => this.files.delete(id)); }
  async getFile(id) { return this.files.get(id); }
  async clearAll() { this.batch = null; this.invoices = []; this.files.clear(); }
}
