// The platform's digest: "sha256:" + hex SHA-256 of the canonical JSON.
import { canonical } from './canonical.mjs';
import { sha256hex } from './sha256.mjs';

export const digest = (value) => `sha256:${sha256hex(canonical(value))}`;

/** Digest of raw text (a file), LF-normalised so a CRLF checkout hashes the same. */
export const digestText = (text) => `sha256:${sha256hex(String(text).replace(/\r\n/g, '\n'))}`;
