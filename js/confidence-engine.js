import { STATUS } from './batch-manager.js';
// Confidence là điểm tin cậy của nguồn/ngữ cảnh, KHÔNG phải xác suất đúng thực tế.
export const REQUIRED = ['sellerName', 'sellerTax', 'serial', 'invoiceNo', 'invoiceDate', 'amount'];
export const classify = (c) => (c == null ? 'missing' : c >= 95 ? 'high' : c >= 80 ? 'check' : 'manual');
export function recordStatus(fields) {
  if (Object.values(fields).some((f) => f.status === 'conflict')) return STATUS.CONFLICT;
  if (REQUIRED.some((k) => fields[k].value === '' || fields[k].value == null)) return STATUS.MISSING;
  const low = Object.values(fields).some((f) => f.confidence != null && f.confidence < 95);
  return low ? STATUS.REVIEW : STATUS.OK;
}
