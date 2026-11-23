import { defineConfig, loadEnv, type PluginOption } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

// Notes:
// - Never set ssr.external or resolve.external: the server bundle has no runtime module
//   resolution, so the build fails.
// - Don't add compression plugins: Vercel already compresses at the edge.
export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [];

  if (mode === "development") {
    const { devtools } = await import("@tanstack/devtools-vite");
    plugins.push(
      devtools({
        logging: false,
        eventBusConfig: { enabled: false },
        enhancedLogs: { enabled: false },
        consolePiping: { enabled: false },
        removeDevtoolsOnBuild: false,
      }),
    );
  }

  plugins.push(
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Server-only code must never be bundled into the browser.
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
      // Use src/server.ts (our SSR error wrapper) as the server entry.
      server: { entry: "server" },
    }),
  );

  // Build for Vercel.
  if (command === "build") plugins.push(nitro({ preset: "vercel" }));

  plugins.push(viteReact());

  // Expose VITE_* variables to both the browser and server bundles.
  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "VITE_"))) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  return {
    define,
    css: { transformer: "lightningcss" as const },
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    server: { host: "::", port: 8080 },
    plugins,
  };
});
