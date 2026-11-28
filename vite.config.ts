import { defineConfig, loadEnv, type PluginOption } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

// Notes:
// - Never set ssr.external or resolve.external: the server bundle has no runtime module
//   resolution, so the build fails.
// - Don't add compression plugins: Vercel already compresses at the edge.
export default defineConfig(({ command, mode }) => {
  const plugins: PluginOption[] = [
    tanstackStart({
      // Server-only code must never be bundled into the browser.
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
      // Use src/server.ts (our SSR error wrapper) as the server entry.
      server: { entry: "server" },
    }),
  ];

  // Build for Vercel. Give /api/mori-chat an explicit 60 s ceiling (supported across all Vercel
  // plans including Hobby without Fluid Compute) so a worst-case tool turn (25 s Apify sold lookup
  // in parallel with 12 s Browse + two 15 s-header AI Gateway calls) finishes instead of being
  // cut off silently by the default function timeout.
  if (command === "build")
    plugins.push(
      nitro({
        preset: "vercel",
        vercel: {
          functionRules: {
            "/api/mori-chat": { maxDuration: 60 },
            "/api/whatsapp-webhook": { maxDuration: 60 },
          },
        },
      }),
    );

  plugins.push(viteReact());

  // Expose VITE_* variables to both the browser and server bundles.
  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "VITE_"))) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  return {
    define,
    resolve: {
      tsconfigPaths: true,
      alias: { "@": `${process.cwd()}/src` },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    },
    server: { host: "::", port: 8080 },
    plugins,
  };
});
