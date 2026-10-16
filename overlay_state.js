"use strict";
// Keep the current presentation across renderer reloads, without reviving cleared advice.
function create() {
  let state = null, advice = null, computing = null;
  return {
    accept(ch, m) {
      if (ch === "state") { state = m; if (m.idle || m.phase !== "active" || m.advicePaused) { advice = null; computing = null; } }
      const blocked = state && (state.advicePaused || state.idle || state.phase !== "active");
      if (ch === "advice" && !blocked) { advice = m; computing = null; }
      if (ch === "computing" && !blocked) computing = m;
      if (ch === "clear") { advice = null; computing = null; }
    },
    replay(send) {
      if (state) send("state", state);
      if (advice) send("advice", advice);
      if (computing) send("computing", computing);
    }
  };
}
module.exports = { create };
