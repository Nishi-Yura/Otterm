import { expect, it } from "vitest";
import { folderName } from "./paths";

it("names the last folder of an OSC 7 URL", () => {
  expect(folderName("file:///C:/Users/me/My%20Project")).toBe("My Project");
  expect(folderName("file://host/home/me/%E6%97%A5%E6%9C%AC")).toBe("日本");
  expect(folderName("file:///C:/")).toBe("C:");
  expect(folderName("file:///")).toBe("/");
});
