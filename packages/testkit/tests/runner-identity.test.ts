import assert from "node:assert/strict";
import { test } from "node:test";
import { findActiveHumanRosterMember } from "../../runner-vercel/src/lib/identity.ts";
import type { RosterMember } from "../../state-store/roster.ts";

const roster: RosterMember[] = [
  { role: "operator", name: "Ada", userId: "U-ACTIVE", mayApprove: ["R3"], status: "active" },
  { role: "operator", name: "Inactive", userId: "U-INACTIVE", mayApprove: ["R3"], status: "inactive" },
  { role: "agent", name: "Agent", userId: "U-AGENT", mayApprove: [], status: "active", type: "agent" },
];

const author = (userId: string, overrides: Partial<{ isBot: boolean | "unknown"; isMe: boolean; isSystem: boolean }> = {}) => ({
  userId,
  isBot: false as boolean | "unknown",
  isMe: false,
  ...overrides,
});

test("the Runner admits only active roster humans before model invocation", () => {
  assert.equal(findActiveHumanRosterMember(roster, author("U-ACTIVE"))?.name, "Ada");
  assert.equal(findActiveHumanRosterMember(roster, author("U-UNKNOWN")), undefined);
  assert.equal(findActiveHumanRosterMember(roster, author("U-INACTIVE")), undefined);
  assert.equal(findActiveHumanRosterMember(roster, author("U-AGENT")), undefined);
  assert.equal(findActiveHumanRosterMember(roster, author("U-ACTIVE", { isBot: true })), undefined);
  assert.equal(findActiveHumanRosterMember(roster, author("U-ACTIVE", { isMe: true })), undefined);
  assert.equal(findActiveHumanRosterMember(roster, author("U-ACTIVE", { isSystem: true })), undefined);
});
