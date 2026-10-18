import { readFileSync } from "node:fs";

export interface Item {
  sku: string;
  price: number; // minor units (cents)
}

export interface Order {
  order: string;
  customer: string; // WhatsApp ID (phone number, digits only)
  name: string;
  charge: string; // Stripe charge ID
  total: number; // minor units
  currency: string;
  items: Item[];
  placed: string; // YYYY-MM-DD
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function loadOrders(path: string): Order[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of orders`);
  return raw.map((o, i) => validateOrder(o, `${path}[${i}]`));
}

function validateOrder(o: any, where: string): Order {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  if (typeof o !== "object" || o === null) fail("not an object");
  for (const k of ["order", "customer", "name", "charge", "currency", "placed"]) {
    if (typeof o[k] !== "string" || o[k] === "") fail(`missing ${k}`);
  }
  if (!Number.isInteger(o.total) || o.total <= 0) fail("total must be a positive integer");
  if (!Array.isArray(o.items) || o.items.length === 0) fail("items must be a non-empty array");
  for (const it of o.items) {
    if (typeof it?.sku !== "string" || !Number.isInteger(it?.price) || it.price <= 0) {
      fail("each item needs a sku and a positive integer price");
    }
  }
  if (Number.isNaN(Date.parse(o.placed))) fail("placed is not a date");
  return { ...o, customer: normalizePhone(o.customer), currency: o.currency.toLowerCase() };
}

export function formatMoney(minor: number, currency: string): string {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(minor / 10 ** digits);
}
