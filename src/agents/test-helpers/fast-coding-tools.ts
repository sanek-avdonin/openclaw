import { vi } from "vitest";

const stubTool = (name: string) => ({
  name,
  description: `${name} stub`,
  parameters: { type: "object", properties: {} },
  execute: vi.fn(),
});

vi.mock("../tools/image-tool.js", () => ({
  createImageTool: () => stubTool("image"),
}));

vi.mock("../tools/web-tools.js", () => ({
  // Keep web tools “present” but fast (no network) so tool policy
  // group expansion remains representative in unit tests.
  createWebSearchTool: () => stubTool("web_search"),
  createWebFetchTool: () => stubTool("web_fetch"),
}));

vi.mock("../../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  getPluginToolMeta: () => undefined,
}));
