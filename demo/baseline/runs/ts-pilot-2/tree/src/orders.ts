import { readFile } from "node:fs/promises";

export interface OrderItem {
  sku: string;
  price: number; // minor units (e.g. cents)
}

export interface Order {
  order: string;
  customer: string; // WhatsApp phone number, digits only, with country code
  name: string;
  charge: string; // Stripe charge id
  total: number; // minor units
  currency: string;
  items: OrderItem[];
  placed: string; // YYYY-MM-DD
}

export async function loadOrders(file: string): Promise<Order[]> {
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${file}: expected an array of orders`);
  return data.map((o, i) => validateOrder(o, `${file}[${i}]`));
}

function validateOrder(o: any, where: string): Order {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  if (typeof o !== "object" || o === null) fail("not an object");
  for (const key of ["order", "customer", "name", "charge", "currency", "placed"]) {
    if (typeof o[key] !== "string" || o[key] === "") fail(`missing or invalid "${key}"`);
  }
  if (!Number.isInteger(o.total) || o.total <= 0) fail(`invalid "total"`);
  if (!Array.isArray(o.items) || o.items.length === 0) fail(`invalid "items"`);
  const skus = new Set<string>();
  for (const item of o.items) {
    if (typeof item?.sku !== "string" || !Number.isInteger(item.price) || item.price < 0) {
      fail(`invalid item ${JSON.stringify(item)}`);
    }
    if (skus.has(item.sku)) fail(`duplicate sku ${item.sku}`);
    skus.add(item.sku);
  }
  const itemSum = o.items.reduce((s: number, i: OrderItem) => s + i.price, 0);
  if (itemSum > o.total) fail(`items sum (${itemSum}) exceeds total (${o.total})`);
  if (Number.isNaN(Date.parse(`${o.placed}T00:00:00Z`))) fail(`invalid "placed" date`);
  return {
    ...o,
    customer: normalizePhone(o.customer),
    currency: o.currency.toLowerCase(),
  } as Order;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function formatMoney(amount: number, currency: string): string {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(amount / 10 ** digits);
}
