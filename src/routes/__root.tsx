import {
  Outlet,
  Link,
  createRootRoute,
  redirect,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { type ReactNode } from "react";

function NotFoundComponent() {
  return (
    <main style={{ padding: "2rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      <h1>404</h1>
      <p>Page not found.</p>
      <Link to="/">Go home</Link>
    </main>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();

  return (
    <main style={{ padding: "2rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      <h1>This page didn't load</h1>
      <p>Something went wrong on our end. You can try refreshing or head back home.</p>
      <button
        onClick={() => {
          router.invalidate();
          reset();
        }}
      >
        Try again
      </button>{" "}
      <a href="/">Go home</a>
    </main>
  );
}

export const Route = createRootRoute({
  // The demo is the gated wireframe at "/"; every other non-API path redirects there.
  beforeLoad: ({ location }) => {
    if (location.pathname !== "/") throw redirect({ to: "/" });
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Bindory" },
    ],
    links: [{ rel: "icon", href: "/favicon.ico", type: "image/x-icon" }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return <Outlet />;
}
