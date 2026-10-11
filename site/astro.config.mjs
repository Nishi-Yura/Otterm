// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc from "starlight-typedoc";

// API reference: TypeDoc reads packages/api/src/index.d.ts (the source of truth for mod types)
// and writes Markdown into the content collection. Japanese pages live at the root and
// English pages under en/, so each locale gets its own generated folder ("api" and "en/api").
// Both groups are listed in the sidebar with autogenerate, which Starlight resolves per locale.
const apiEntry = "../packages/api/src/index.d.ts";
const apiTsconfig = "../packages/api/tsconfig.json";

export default defineConfig({
  integrations: [
    starlight({
      title: "otterm",
      description: "otterm のドキュメント。ユーザーガイド、Mod 作者ガイド、API リファレンス。",
      defaultLocale: "root",
      locales: {
        root: { label: "日本語", lang: "ja" },
        en: { label: "English", lang: "en" },
      },
      plugins: [
        starlightTypeDoc({
          entryPoints: [apiEntry],
          tsconfig: apiTsconfig,
          output: "api",
          typeDoc: { name: "@otterm/api", excludeInternal: true },
        }),
        starlightTypeDoc({
          entryPoints: [apiEntry],
          tsconfig: apiTsconfig,
          output: "en/api",
          typeDoc: { name: "@otterm/api", excludeInternal: true },
        }),
      ],
      sidebar: [
        {
          label: "ユーザーガイド",
          translations: { en: "User guide" },
          items: [{ autogenerate: { directory: "guide" } }],
        },
        {
          label: "Mod 作者ガイド",
          translations: { en: "Mod author guide" },
          items: [{ autogenerate: { directory: "mods" } }],
        },
        {
          label: "API リファレンス",
          translations: { en: "API reference" },
          collapsed: true,
          items: [{ autogenerate: { directory: "api" } }],
        },
      ],
    }),
  ],
});
