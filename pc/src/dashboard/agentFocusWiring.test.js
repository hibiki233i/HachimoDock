/**
 * [Input] Dashboard, matrix card, context and hook sources plus the Rust command registration.
 * [Output] Contract checks that the multi-Agent follow wiring stays connected end to end.
 * [Pos] test node for DeviceDashboard.jsx, ChannelMatrixCard.jsx, DeviceContext.jsx, useFollowedAgentFeeds.js and usePetFollowSwitch.js
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const dashboard = read("DeviceDashboard.jsx");
const matrix = read("dashboard/ChannelMatrixCard.jsx");
const context = read("shell/DeviceContext.jsx");
const feeds = read("dashboard/useFollowedAgentFeeds.js");
const petSwitch = read("dashboard/usePetFollowSwitch.js");
const switchEvents = read("dashboard/useAgentSwitchEvents.js");
const announcer = read("dashboard/useAgentFocusAnnouncer.js");
const resident = read("lib/resident-appearance.js");
const rust = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const permissions = readFileSync(new URL("../../src-tauri/permissions/local-app-commands.json", import.meta.url), "utf8");

test("the focus Agent, not the desktop channel, drives the device Session sync", () => {
  assert.match(dashboard, /const primaryAgentId = currentDisplay\.agentId/);
  assert.match(dashboard, /useAgentFocus\(\{\s*followAgentIds,\s*sessionsByAgent,\s*defaultAgentId: primaryAgentId/);
  assert.match(dashboard, /const selectedAgentId = agentFocus\.focusAgentId \|\| primaryAgentId/);
  assert.match(dashboard, /useP4SessionSync\(\{[\s\S]*agentId: selectedAgentId/);
  assert.match(dashboard, /selectedAgentId === primaryAgentId\s*\?\s*primaryFeed\s*:\s*extraFeeds\[selectedAgentId\] \|\| primaryFeed/);
});

test("the desktop channel is always followed and the others come from the saved follow set", () => {
  assert.match(dashboard, /sanitizeDeviceFollowAgents\(\[primaryAgentId, \.\.\.\(deviceFollowAgents \|\| \[\]\)\]\.filter\(Boolean\)\)/);
  assert.match(dashboard, /followAgentIds\.filter\(\(agentId\) => agentId !== primaryAgentId\)/);
});

test("each fixed Agent gets exactly one feed call in a stable order, and unwanted Agents stay idle", () => {
  assert.match(feeds, /FIXED_AGENT_OPTIONS\.map\(\(agent\) => agent\.id\)/);
  assert.match(feeds, /for \(const id of FIXED_AGENT_IDS\) \{[\s\S]*useAgentSessionFeed\(\{\s*agentId: wanted\.has\(id\) \? id : ""/);
  assert.equal((feeds.match(/useAgentSessionFeed\(\{/g) || []).length, 1);
});

test("pet switching stays enabled when only the primary Agent remains", () => {
  assert.match(dashboard, /usePetFollowSwitch\(\{\s*enabled: isP4Runtime && Boolean\(usb\.connected\),/);
  assert.match(petSwitch, /createPetFollowController\(/);
  assert.doesNotMatch(petSwitch, /usb_sync_appearance/);
  assert.match(petSwitch, /planPetSwitch\(/);
});

test("the matrix card receives the focus through context and keeps its literal mount", () => {
  assert.match(dashboard, /<AgentFocusContext\.Provider value=\{agentFocusValue\}>\s*<ChannelMatrixCard \/>/);
  assert.match(matrix, /useAgentFocusContext\(\)/);
  assert.match(matrix, /focus\.step\(-1\)/);
  assert.match(matrix, /focus\.step\(1\)/);
  assert.match(matrix, /setPetFollowMode\(event\.target\.checked \? "resident" : "follow"\)/);
});

test("joining the follow set stores the pet on the board first and needs a USB link", () => {
  assert.match(matrix, /!usb\?\.connected \|\| usb\.transport === "wifi"/);
  assert.match(matrix, /focus\.preloadAppearance\(\{/);
  assert.match(dashboard, /preloadAppearance: preloadFollowAppearance/);
  assert.match(matrix, /setDeviceFollowAgent\(agent\.id, checked\)/);
  assert.match(matrix, /if \(!outcome\.ok\) \{[\s\S]*return;[\s\S]*setDeviceFollowAgent/);
});

test("joystick Agent keys step the focus and the board is told what it shows", () => {
  assert.match(dashboard, /useAgentSwitchEvents\(\{\s*enabled: isP4Runtime && Boolean\(usb\.connected\) && followAgentIds\.length > 1,[\s\S]*onStep: agentFocus\.step/);
  assert.match(dashboard, /useAgentFocusAnnouncer\(\{[\s\S]*focusAgentId: selectedAgentId/);
  assert.match(switchEvents, /agentSwitchDirection\(event\?\.payload, boardDeviceId\)/);
  assert.match(announcer, /invoke\("usb_send_agent_focus"/);
  assert.match(announcer, /const switched = lastRef\.current\.board === boardDeviceId/);
  assert.match(rust, /async fn usb_send_agent_focus\(/);
  assert.match(rust, /^\s+usb_send_agent_focus,$/m);
  assert.match(permissions, /"usb_send_agent_focus"/);
  assert.match(rust, /"agent_next"\s*\| "agent_previous"/);
});

test("the context persists the follow set and the pet mode", () => {
  for (const field of ["deviceFollowAgents", "setDeviceFollowAgent", "petFollowMode", "setPetFollowMode"]) {
    assert.match(context, new RegExp(`\\b${field}\\b`));
  }
  assert.match(context, /saveDeviceFollowAgents\(next\)/);
  assert.match(context, /savePetFollowMode\(next\)/);
});

test("the frontend command name matches the registered Rust command and its permission", () => {
  assert.match(resident, /invoke\("usb_activate_resident_appearance"/);
  assert.match(rust, /async fn usb_activate_resident_appearance\(/);
  assert.match(rust, /^\s+usb_activate_resident_appearance,$/m);
  assert.match(permissions, /"usb_activate_resident_appearance"/);
});
