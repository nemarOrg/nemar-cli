import { describe, expect, test } from "bun:test";
import { getInstallInstruction, parseVersion } from "../src/lib/prerequisites";

describe("getInstallInstruction", () => {
  const tool = {
    installInstructions: {
      macos: "brew install x",
      linux: "apt install x",
      windows: "winget install x",
    },
  };
  test("returns the platform-specific instruction", () => {
    expect(getInstallInstruction(tool, "macos")).toBe("brew install x");
    expect(getInstallInstruction(tool, "linux")).toBe("apt install x");
    expect(getInstallInstruction(tool, "windows")).toBe("winget install x");
  });
});

describe("parseVersion", () => {
  test("extracts a semver-ish version from --version output", () => {
    expect(parseVersion("git version 2.43.0")).toBe("2.43.0");
    expect(parseVersion("deno 1.46.3 (release, aarch64-apple-darwin)")).toBe("1.46.3");
    expect(parseVersion("aws-cli/2.15.0 Python/3.11.4")).toBe("2.15.0");
  });
  test("accepts a two-part version", () => {
    expect(parseVersion("git-annex version: 10.20240")).toBe("10.20240");
  });
  test("returns undefined when there is no version", () => {
    expect(parseVersion("no numbers here")).toBeUndefined();
  });
});
