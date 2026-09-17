import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { connectDB } from "./db.js";
import { requireAuth } from "./middleware/auth.js";
import { ensureDefaultAdmin } from "./services/auth.js";
import authRouter from "./routes/auth.js";
import workersRouter from "./routes/workers.js";
import jobsRouter from "./routes/jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// /api/auth handles its own auth per-route (login is intentionally public;
// see routes/auth.js) - everything else requires being logged in.
app.use("/api/auth", authRouter);
app.use("/api/workers", requireAuth, workersRouter);
app.use("/api/jobs", requireAuth, jobsRouter);

// 404 for unknown API routes
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Serve the built React app (see README > Deploying it live) so this one
// server can host both the API and the frontend - simplest single-service
// setup for a host like Render, and means there's no separate CORS story in
// production since everything's same-origin. Only kicks in once
// `npm run build` has actually produced client/dist; in normal local
// development that folder doesn't exist (the client instead runs on its own
// via Vite's dev server on :5173, proxying /api to this server - see
// client/vite.config.js), so none of this changes local dev at all.
const clientDistPath = path.join(__dirname, "../../client/dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  // Anything left over that isn't an /api request (already handled/404'd
  // above) is a client-side route (react-router) - hand back index.html and
  // let the browser's React app take it from there, same as any SPA.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err.name === "ValidationError") {
    return res.status(400).json({ error: err.message });
  }
  if (err.code === 11000) {
    return res.status(409).json({ error: "A record with that value already exists (duplicate email?)" });
  }
  res.status(500).json({ error: "Something went wrong on the server" });
});

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error("[startup] failed to connect to MongoDB:", err.message);
    console.error(
      "[startup] make sure MongoDB is running and MONGO_URI in .env is correct. See README.md."
    );
    process.exit(1);
  }

  try {
    await ensureDefaultAdmin();
  } catch (err) {
    console.error("[startup] failed to set up a default login:", err.message);
    console.error("[startup] see README > Login & user accounts for the AUTH_SECRET setup step.");
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start();
