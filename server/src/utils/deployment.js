import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built client bundle's path, and whether it actually exists right
// now - this is the SAME check index.js uses to decide whether to serve
// the frontend itself (the single-service setup used on Render - see its
// own long comment) or leave the client to run separately via Vite's own
// dev server (plain local development, where this folder never exists).
// Pulled out here so other modules (routes/auth.js's password-reset link)
// can ask the same "is the frontend the same origin as me, or not"
// question without duplicating this path arithmetic and risking it
// drifting out of sync with index.js's own copy.
export const clientDistPath = path.join(__dirname, "../../../client/dist");
export const isSingleServiceDeployment = fs.existsSync(clientDistPath);
