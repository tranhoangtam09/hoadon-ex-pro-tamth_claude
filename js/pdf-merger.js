// Gộp tối đa 10 tệp PDF/ảnh thành một PDF bằng pdf-lib. Không sửa nội dung từng tệp: trang PDF được sao chép nguyên,
// ảnh JPG/PNG được nhúng nguyên (không nén lại). Lỗi bất kỳ tệp nào → dừng và báo rõ tệp đó, không xuất PDF thiếu.
export const MAX_FILES = 10;
export const MERGE_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'];
const ext = (n) => (n.split('.').pop() || '').toLowerCase();
const starts = (b, sig) => sig.every((x, i) => b[i] === x);

export class MergeError extends Error { constructor(problems) { super(problems.map((p) => `${p.name}: ${p.message}`).join('\n')); this.problems = problems; } }

/** Đọc hướng EXIF của JPEG (1 = bình thường). */
export function jpegOrientation(b) {
  if (!starts(b, [0xff, 0xd8])) return 1;
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const m = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78) { // "Ex"
      const t = o + 10, le = b[t] === 0x49, u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const u32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) return u16(e + 8); }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}

/**
 * items: [{ name, bytes: Uint8Array }]. rasterize(bytes, name) -> Promise<Uint8Array PNG> (trình duyệt) cho WEBP/TIFF và JPEG có xoay EXIF.
 * Trả về { bytes, pageCount }.
 */
export async function mergeToPdf(PDFLib, items, { rasterize } = {}) {
  if (!items.length) throw new MergeError([{ name: '(danh sách)', message: 'Chưa chọn tệp nào' }]);
  if (items.length > MAX_FILES) throw new MergeError([{ name: '(danh sách)', message: `Tối đa ${MAX_FILES} tệp mỗi lần gộp, hiện có ${items.length}` }]);
  const { PDFDocument } = PDFLib, out = await PDFDocument.create(), problems = [];
  for (const it of items) {
    try {
      const e = ext(it.name), b = it.bytes;
      if (!MERGE_EXT.includes(e)) throw new Error(`Định dạng .${e} không được hỗ trợ`);
      if (e === 'pdf') {
        if (!starts(b, [0x25, 0x50, 0x44, 0x46])) throw new Error('Không phải tệp PDF hợp lệ');
        const src = await PDFDocument.load(b, { ignoreEncryption: false });
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
        continue;
      }
      let img, bytes = b;
      const isJpg = starts(b, [0xff, 0xd8]), isPng = starts(b, [0x89, 0x50, 0x4e, 0x47]);
      if (!(isJpg && (e === 'jpg' || e === 'jpeg') && jpegOrientation(b) === 1) && !(isPng && e === 'png')) {
        if (!rasterize) throw new Error(`Không xử lý được .${e} (cần xoay EXIF hoặc chuyển định dạng trong trình duyệt)`);
        bytes = await rasterize(b, it.name);
      }
      img = starts(bytes, [0xff, 0xd8]) ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      const s = Math.min(842 / Math.max(img.width, img.height), 0.75), w = img.width * s, h = img.height * s;
      out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    } catch (err) {
      const enc = /encrypt/i.test(err.message) || err.name === 'EncryptedPDFError';
      problems.push({ name: it.name, message: enc ? 'PDF được mã hóa/đặt mật khẩu, cần gỡ mật khẩu trước' : err.message });
    }
  }
  if (problems.length) throw new MergeError(problems);
  return { bytes: await out.save(), pageCount: out.getPageCount() };
}
