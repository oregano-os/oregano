// Roster parsing and authorization use a fictional company with distinct
// teams, roles, and rights so hardcoded company assumptions fail immediately.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { authorizeApproval, authorizePrincipalApproval, parseRoster, slackPrincipal } from "../../state-store/roster.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "acme-casas");
const roster = parseRoster(readFileSync(join(FIXTURE, "handbook", "roster.md"), "utf8"));

const TEAM = "TFIXTURE1";
const DANA = "UFOUNDER1"; // R1-R4
const MIGUEL = "ULEAD0001"; // R1-R3
const PRIYA = "UASSIST01"; // R1 only
const TOMAS = "UEXTERN01"; // inactive, no rights
const BOT = "UBOTOPS01"; // agent identity

test("parses every member of the fixture roster", () => {
  assert.equal(roster.length, 5);
  assert.deepEqual(
    roster.map((m) => m.role),
    ["founder", "lead", "assistant", "contractor", "agent"],
  );
});

test("canonical principal is team-scoped", () => {
  assert.equal(slackPrincipal(TEAM, DANA), "slack:TFIXTURE1:UFOUNDER1");
});

test("the founder may approve money (R4)", () => {
  const result = authorizeApproval(roster, TEAM, DANA, "R4");
  assert.equal(result.ok, true);
  assert.equal(result.member?.name, "Dana");
});

test("one level short is refused with a reason naming the roster", () => {
  const result = authorizeApproval(roster, TEAM, MIGUEL, "R4");
  assert.equal(result.ok, false);
  assert.match(result.reason, /roster/);
  assert.match(result.reason, /Miguel/);
});

test("the wrong-user case: R1-only member cannot approve R3", () => {
  const result = authorizeApproval(roster, TEAM, PRIYA, "R3");
  assert.equal(result.ok, false);
  assert.equal(result.member?.role, "assistant");
});

test("an unknown principal is refused, not silently allowed", () => {
  const result = authorizeApproval(roster, TEAM, "UNOBODY99", "R1");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in the roster/);
});

test("a member of ANOTHER workspace with the same user id is refused", () => {
  // Team-scoping is the whole point of the canonical principal.
  const result = authorizeApproval(roster, "TOTHERWS1", DANA, "R3");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in the roster/);
});

test("inactive members can never approve (identity spec §5)", () => {
  for (const level of ["R1", "R2", "R3", "R4"]) {
    const result = authorizeApproval(roster, TEAM, TOMAS, level);
    assert.equal(result.ok, false, `inactive member must not approve ${level}`);
    assert.match(result.reason, /inactive/, "the refusal must name the reason");
  }
});

test("inactive is refused STRUCTURALLY — even with rights still listed", () => {
  // The dangerous real-world case: someone leaves, the line is flagged
  // inactive, but may_approve was forgotten. Rights must not decide alone.
  const stale = roster.map((m) =>
    m.userId === TOMAS ? { ...m, mayApprove: ["R1", "R2", "R3", "R4"] } : m,
  );
  const result = authorizeApproval(stale, TEAM, TOMAS, "R4");
  assert.equal(result.ok, false);
  assert.match(result.reason, /inactive/);
});

test("agent identities never approve (identity spec §2)", () => {
  for (const level of ["R1", "R2", "R3", "R4"]) {
    const result = authorizeApproval(roster, TEAM, BOT, level);
    assert.equal(result.ok, false, `agent must not approve ${level}`);
    assert.match(result.reason, /agent/, "the refusal must name the reason");
  }
});

test("agents are refused STRUCTURALLY — even if granted rights by mistake", () => {
  const misconfigured = roster.map((m) =>
    m.userId === BOT ? { ...m, mayApprove: ["R3"] } : m,
  );
  const result = authorizeApproval(misconfigured, TEAM, BOT, "R3");
  assert.equal(result.ok, false);
  assert.match(result.reason, /agents never approve/);
});

test("every roster member carries a team-scoped identity", () => {
  for (const member of roster) {
    assert.ok(member.teamId, `${member.name} has no team_id`);
    assert.ok(member.userId, `${member.name} has no user_id`);
  }
});

test("non-Slack agent principals are parsed and can never approve", () => {
  const genericRoster = parseRoster(`---
members:
  - role: agent
    name: Growth Agent
    type: agent
    identities:
      companyos:
        principal: "companyos:fixture:growth"
    may_approve: [R4]
---
# Roster
`);
  assert.deepEqual(genericRoster[0]?.principals, ["companyos:fixture:growth"]);
  const result = authorizePrincipalApproval(genericRoster, "companyos:fixture:growth", "R4");
  assert.equal(result.ok, false);
  assert.match(result.reason, /agents never approve/);
});

test("service principals are refused structurally even when granted approval rights", () => {
  const serviceRoster = parseRoster(`---
members:
  - role: automation
    name: Sprint Service
    type: service
    identities:
      companyos:
        principal: "companyos:fixture:sprint"
    may_approve: [R4]
---
# Roster
`);
  const result = authorizePrincipalApproval(serviceRoster, "companyos:fixture:sprint", "R4");
  assert.equal(result.ok, false);
  assert.match(result.reason, /services never approve/);
});
