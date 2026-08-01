// Worker entrypoint. Routes /api/* by hand (Cloudflare Workers don't have
// Pages Functions' file-based routing) and falls through to the static
// assets binding for everything else — the site itself lives in public/.

import { handleSubmitGame } from "./api/submit-game.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit-game" && request.method === "POST") {
      return handleSubmitGame(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
