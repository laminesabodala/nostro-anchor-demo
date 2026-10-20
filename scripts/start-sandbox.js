"use strict";
process.env.SANDBOX_PLAYGROUND = "true";
require("../src/server").start().catch(() => {
  console.error("Sandbox startup failed; check the runtime configuration and service lock.");
  process.exitCode = 1;
});
