// Deliberately does NO caching. This site's whole point is showing the
// latest handicaps/games right after a submission, and stale caches have
// already caused real bugs here (wrong targets, a feature "missing" on a
// phone). The service worker exists so browsers treat the site as an
// installable app; every request still goes straight to the network, so an
// installed copy behaves exactly like the website.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
