// S194, as ruled on the keyring change: a test's child process (a command line, a server, a stand-in) loads the
// certificates the test admitted with its own keyring anchors only when it accepts them, as the test process does
// (runtime-helpers). Preloaded with `node --import`; a production runtime never preloads it.
import { acceptTestAnchors } from '@poly/runtime';

acceptTestAnchors();
