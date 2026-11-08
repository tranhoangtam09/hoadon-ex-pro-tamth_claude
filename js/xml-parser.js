// Bộ tách XML nhỏ, độc lập namespace, tên thẻ không phân biệt hoa/thường. Chạy được cả trình duyệt lẫn Node.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dec = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
const local = (n) => n.split(':').pop().toLowerCase();

export function parseXml(src) {
  const root = { name: '#root', children: [], text: '' }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s\/>!?]+)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/gy;
  re.lastIndex = 0; let m, pos = 0; const s = String(src).replace(/^\uFEFF/, '');
  while (pos < s.length && (m = (re.lastIndex = pos, re.exec(s)))) {
    pos = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length < 2 || top.name !== local(m[2])) throw new Error(`XML sai định dạng: thẻ đóng </${m[2]}> không khớp`); stack.pop(); }
    else if (m[3]) { const n = { name: local(m[3]), children: [], text: '' }; top.children.push(n); if (!m[5]) stack.push(n); }
    else if (m[6] !== undefined) top.text += dec(m[6]);
  }
  if (pos < s.length) throw new Error('XML sai định dạng: ký tự không hợp lệ');
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('XML sai định dạng: thiếu thẻ đóng hoặc không có phần tử gốc');
  return root.children[0];
}

export const text = (n) => (n ? n.text.trim() : '');
export function findAll(n, name, out = []) { for (const c of n.children) { if (c.name === name) out.push(c); findAll(c, name, out); } return out; }
/** Thẻ hậu duệ đầu tiên có nội dung theo thứ tự alias. */
export function pick(n, aliases) {
  if (!n) return '';
  for (const a of aliases) { const f = findAll(n, a).find((x) => text(x)); if (f) return text(f); }
  return '';
}
