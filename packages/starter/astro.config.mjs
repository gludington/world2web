// Your World2Web site. Everything about how it looks and works comes from
// the @world2web/site package -- this repo only holds your content, which
// the World2Web Foundry module publishes into content/.
import { defineConfig } from "astro/config";
import world2web from "@world2web/site";

export default defineConfig({
  output: "static",
  integrations: [world2web()],
});
