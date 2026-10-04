// A JSON Schema check for the subset the published command schemas use (type, properties, required, items, enum,
// additionalProperties): enough to hold every command's output to its schema (PF9.2) with no dependency.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (t, v) => { const k = typeOf(v); return t === k || (t === 'number' && k === 'integer'); };

/** The ways `value` breaks `schema`, as paths with reasons; [] when it fits. */
export function schemaProblems(schema, value, path = '$') {
  const out = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => fits(t, value))) return [`${path}: ${typeOf(value)} is not ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) out.push(`${path}.${k}: required and absent`);
    for (const [k, v] of Object.entries(value)) {
      const s = schema.properties?.[k];
      if (s) out.push(...schemaProblems(s, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not in the schema`);
      else if (typeof schema.additionalProperties === 'object') out.push(...schemaProblems(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  if (typeOf(value) === 'array' && schema.items) value.forEach((v, i) => out.push(...schemaProblems(schema.items, v, `${path}[${i}]`)));
  return out;
}
