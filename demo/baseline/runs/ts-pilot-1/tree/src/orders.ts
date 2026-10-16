import { readFileSync } from 'node:fs';

export interface OrderItem {
  sku: string;
  price: number;
}

export interface Order {
  order: string;
  customer: string;
  name: string;
  charge: string;
  total: number;
  currency: string;
  items: OrderItem[];
  placed: string;
}

/** Digits only, so "+1 555-010-0001" and WhatsApp's "15550100001" compare equal. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function loadOrders(path: string): Order[] {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${path}: expected an array of orders`);
  data.forEach((o, i) => {
    const ok =
      typeof o?.order === 'string' &&
      typeof o?.customer === 'string' &&
      typeof o?.charge === 'string' &&
      typeof o?.currency === 'string' &&
      typeof o?.placed === 'string' &&
      Number.isInteger(o?.total) &&
      Array.isArray(o?.items) &&
      o.items.every((it: any) => typeof it?.sku === 'string' && Number.isInteger(it?.price));
    if (!ok) throw new Error(`${path}: order at index ${i} is malformed`);
  });
  return data as Order[];
}
