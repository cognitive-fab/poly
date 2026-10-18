// Where the admission key pair lives: outside the project, so a private key is never committed (S126).
import { homedir } from 'node:os'
import { join } from 'node:path'

export const KEY_DIR = process.env.SUPPORT_AGENT_KEYS ?? join(homedir(), '.support-agent')
export const PRIVATE_KEY_FILE = process.env.POLY_ADMISSION_KEY_FILE ?? join(KEY_DIR, 'admission.pem')
export const PUBLIC_KEY_FILE = process.env.POLY_ADMISSION_PUBLIC_KEY_FILE ?? join(KEY_DIR, 'admission.pub.pem')
