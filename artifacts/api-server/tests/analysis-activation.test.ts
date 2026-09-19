import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { activationForGrant, matchesAnalysisActivation } from "../src/processor/analysis-activation.js";
import { parseAccountingControl } from "../src/processor/analysis-accounting-contract.js";

test("activation binds one immutable grant, configured target, guide and deadline", () => {
  const at = new Date("2026-09-19T01:00:00.000Z");
  const grant = { input: { guideId: "guide" }, expiresAt: new Date(at.valueOf() + 1000).toISOString() };
  const activation = activationForGrant(randomUUID(), grant, { deploymentRef: "deployment", projectRef: "project", credentialRef: "key", storageRef: "bucket" });
  assert.equal(matchesAnalysisActivation(activation, activation, "guide", at), true);
  for (const expected of [undefined, { ...activation, id: randomUUID() }, { ...activation, grantHash: "a".repeat(64) },
    { ...activation, projectRef: "other" }, { ...activation, credentialRef: "other" }, { ...activation, storageRef: "other" }]) {
    assert.equal(matchesAnalysisActivation(activation, expected, "guide", at), false);
  }
  assert.equal(matchesAnalysisActivation(undefined, activation, "guide", at), false);
  assert.equal(matchesAnalysisActivation(activation, activation, "other-guide", at), false);
  assert.equal(matchesAnalysisActivation(activation, activation, "guide", new Date(grant.expiresAt)), false);
  assert.deepEqual(parseAccountingControl({ halted: false, activation }), { halted: false, activation });
  assert.throws(() => parseAccountingControl({ halted: false, activation: { ...activation, allowAnyGuide: true } }));
});
