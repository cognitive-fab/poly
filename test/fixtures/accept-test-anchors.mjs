// S194, as ruled on the keyring change: a test's child process (a command line, a server, a stand-in) loads the
// certificates the test admitted with its own keyring anchors only when it accepts them, as the test process does
// (runtime-helpers). Preloaded with `node --import`; a production runtime never preloads it. S210: load verifies the
// chain from the anchor, so the child reads the test's anchor folder, which the preload's URL names (`?anchors=`).
import './home-guard.mjs';
import { acceptTestAnchors } from '@poly/runtime';
import { useTestAnchors } from '@poly/core';

acceptTestAnchors();
const dir = new URL(import.meta.url).searchParams.get('anchors');
if (dir) useTestAnchors(dir);
