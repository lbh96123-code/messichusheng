"use strict";
// Electron resolves production loadFile("overlay.html") from its entry directory.
// Keep that directory at the app root while the test implementation stays in test/.
require("./test/native_overlay_smoke.js");
