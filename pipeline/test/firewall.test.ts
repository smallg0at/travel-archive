import { describe, expect, it } from "vitest";
import { elevationScript } from "../src/firewall.js";

/**
 * The Allow button failed on machines whose temp path contains a space: the
 * elevation script passed the script path as one element of a `-ArgumentList`
 * array, which Start-Process joins with spaces without quoting. Nothing in the
 * app's own tests noticed, because this machine's path has no spaces.
 *
 * These assert the constructed PowerShell, not the UAC prompt.
 */
describe("elevationScript", () => {
  it("quotes the script path so a space in it cannot split the argument", () => {
    const script = elevationScript("C:\\Users\\First Last\\AppData\\Local\\Temp\\pa\\firewall.ps1");
    expect(script).toContain('-File "C:\\Users\\First Last\\AppData\\Local\\Temp\\pa\\firewall.ps1"');
  });

  it("passes the arguments as one quoted string, not an array", () => {
    const script = elevationScript("C:\\Temp\\pa\\firewall.ps1");
    expect(script).toContain("-ArgumentList '");
    expect(script).not.toContain("@(");
    // One argument list, not five separate elements.
    expect(script.match(/-ArgumentList/g)).toHaveLength(1);
  });

  it("doubles an apostrophe so the outer single-quoted string stays valid", () => {
    const script = elevationScript("C:\\Users\\o'brien\\AppData\\Local\\Temp\\pa\\firewall.ps1");
    expect(script).toContain("o''brien");
  });
});
