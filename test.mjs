// Run: node --test test.mjs
//
// The logic and the suite live in logic.shared.js / suite.shared.js (plain
// CJS-compatible scripts shared with playground.html) — this file only wires
// them to node:test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import logic from "./logic.shared.js";
import suite from "./suite.shared.js";

suite.registerSuite({ describe, test, assert }, logic);
