import { test } from "node:test";
import assert from "node:assert/strict";
import { launchAgentPlist, LAUNCH_AGENT_LABEL } from "../src/installer/macos.js";

test("LaunchAgent plist runs the agent at login, keeps it alive, and escapes the path", () => {
  const xml = launchAgentPlist("/Users/me/My Apps & Tools/dc-custom", "/Users/me/Library/Logs/dc-custom/agent.log");
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(xml, /<string>\/Users\/me\/My Apps &amp; Tools\/dc-custom<\/string>\s*<string>--run<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(xml, /Apps & Tools/); // raw ampersand would break the XML
});
