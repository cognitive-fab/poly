// Loaded before a README command by test/ex-inbox-readme.mjs: points the per-user keyring configuration (anchors.json,
// which `poly anchor keyrings` writes and the runtime reads) at a folder of the test's, so a test never writes the
// real user's. It changes nothing else.
import { useTestAnchors } from '@poly/core';

if (process.env.POLY_TEST_ANCHORS) useTestAnchors(process.env.POLY_TEST_ANCHORS);
