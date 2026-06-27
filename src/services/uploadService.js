import xlsx from 'xlsx';
import { parse } from 'csv-parse/sync';

/**
 * Validate Indonesian phone number format: 62XXXXXXXXXX
 */
function validatePhone(phone) {
  if (!phone) return null;
  // Normalize: strip spaces, dashes, leading +
  let cleaned = String(phone).replace(/[\s\-+]/g, '');
  // Convert 08xxx to 628xxx
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  }
  // Validate final format
  if (/^62[0-9]{9,12}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

/**
 * Parse uploaded file buffer into rows
 */
export function parseFile(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  let rows = [];

  if (ext === 'csv') {
    rows = parse(buffer.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } else if (ext === 'xlsx' || ext === 'xls') {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(sheet);
  } else {
    throw new Error('Unsupported file type. Use CSV or XLSX.');
  }

  return rows;
}

/**
 * Validate and clean rows.
 * Returns { valid: [...], errors: [...] }
 */
export function validateRows(rows) {
  const valid = [];
  const errors = [];
  const today = new Date();

  rows.forEach((row, index) => {
    const rowNum = index + 2; // +2 for header + 1-index

    // Required: phone
    const phone = validatePhone(row.phone_number || row.phone || row.Phone);
    if (!phone) {
      errors.push({ row: rowNum, error: 'Invalid or missing phone_number' });
      return;
    }

    // Required: name
    const name = (row.name || row.Name || '').trim();
    if (name.length < 2) {
      errors.push({ row: rowNum, error: 'Missing or too-short name' });
      return;
    }

    // Required: purchase_date
    const rawDate = row.purchase_date || row.date || row.Date;
    const purchaseDate = new Date(rawDate);
    if (isNaN(purchaseDate.getTime())) {
      errors.push({ row: rowNum, error: 'Invalid purchase_date' });
      return;
    }
    if (purchaseDate > today) {
      errors.push({ row: rowNum, error: 'Future purchase_date not allowed' });
      return;
    }

    // Required: purchase_amount
    const amount = parseFloat(row.purchase_amount || row.amount || row.Amount);
    if (isNaN(amount) || amount <= 0) {
      errors.push({ row: rowNum, error: 'Invalid purchase_amount (must be > 0)' });
      return;
    }
    if (amount > 10000000) {
      errors.push({ row: rowNum, error: 'purchase_amount exceeds max (likely typo)' });
      return;
    }

    valid.push({
      phone_number: phone,
      name,
      email: (row.email || row.Email || '').trim() || null,
      purchase_date: purchaseDate.toISOString().split('T')[0],
      purchase_amount: amount,
      product_category: (row.product_category || row.category || '').trim() || null,
      quantity: parseInt(row.quantity) || 1,
      source: (row.source || 'other').trim(),
    });
  });

  return { valid, errors };
}

/**
 * Merge duplicate phones within the same upload batch.
 * Keeps each purchase as separate record but dedups customer info.
 */
export function dedupeCustomers(validRows) {
  const customerMap = new Map();

  validRows.forEach((row) => {
    if (!customerMap.has(row.phone_number)) {
      customerMap.set(row.phone_number, {
        phone_number: row.phone_number,
        name: row.name,
        email: row.email,
        purchases: [],
      });
    }
    customerMap.get(row.phone_number).purchases.push({
      purchase_date: row.purchase_date,
      purchase_amount: row.purchase_amount,
      product_category: row.product_category,
      quantity: row.quantity,
      source: row.source,
    });
  });

  return Array.from(customerMap.values());
}

export default { parseFile, validateRows, dedupeCustomers };
