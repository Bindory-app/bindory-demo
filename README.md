# Bindory

Bindory is a mobile-first Pokémon TCG collecting app where users interact with Mori, their AI collector agent.

Mori is the main way to use the app. Bindory is designed for phone-sized screens, with a centered mobile layout on desktop. It is built with TanStack Start and TypeScript.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

Builds and unit tests do not need provider credentials. [`.env.example`](.env.example) lists the server configuration with mock values. Chat uses Vercel AI Gateway; HarnessRouter credentials are only for Sync from Collectr. Never commit real credentials.
