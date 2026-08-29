// Vercel serverless entrypoint. An Express app is already a valid Node
// request handler ((req, res) => ...), so no adapter is needed — this file
// only exists because Vercel's Node runtime looks for a handler under api/.
// vercel.json rewrites every request here while preserving the original
// path, so app.js's own /api/... routes still match unchanged.
import { app } from "../src/app.js";

// Vercel's Node runtime pre-reads the request body to populate its own
// req.body/req.query convenience properties, which drains the stream
// before express.json() ever gets to it — every JSON POST (the Telegram
// webhook, most visibly) was silently landing with an empty body as a
// result. This opts out so Express's own body-parser is the only thing
// touching the raw stream. Must live in this file specifically — Vercel
// only reads `config` from the actual function entry, not from app.js.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default app;
