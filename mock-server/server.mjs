/**
 * Mock translation HTTP API for local plugin development.
 * Not a BabelDOC backend — in-memory tasks only.
 *
 * Env:
 *   PORT=8765
 *   TOKEN=dev-token
 *   PENDING_MS=3000   delay before pending -> down
 *   FAIL_HASH=...     force error for a specific source hash
 *   CORRUPT_DUAL=1    return non-PDF for dual download
 *   BAD_ARTIFACT_HASH=1  wrong X-Artifact-SHA256 header
 */
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8765);
const TOKEN = process.env.TOKEN || "dev-token";
const PENDING_MS = Number(process.env.PENDING_MS || 3000);

/** @type {Map<string, { status: string, source: Buffer|null, dual: Buffer|null, dualHash: string|null }>} */
const tasks = new Map();

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function authOk(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function minimalPdf(label) {
  // Tiny valid-enough PDF for import testing
  const content = `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 20 100 Td (${label}) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000361 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
433
%%EOF
`;
  return Buffer.from(content, "utf8");
}

function scheduleComplete(hash) {
  setTimeout(() => {
    const t = tasks.get(hash);
    if (!t || t.status !== "pending") {
      return;
    }
    if (process.env.FAIL_HASH && process.env.FAIL_HASH === hash) {
      t.status = "error";
      return;
    }
    const dual = minimalPdf(`dual-${hash.slice(0, 8)}`);
    t.dual = dual;
    t.dualHash = sha256(dual);
    t.status = "down";
    console.log(`[mock] ${hash.slice(0, 12)} -> down`);
  }, PENDING_MS);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";

  if (!authOk(req)) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid or missing token");
  }

  try {
    if (method === "GET" && path === "/v1/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (method === "GET" && path === "/v1/documents") {
      const documents = [...tasks.entries()].map(([id, t]) => ({
        id,
        status: t.status,
      }));
      return sendJson(res, 200, { documents });
    }

    if (method === "POST" && path === "/v1/documents") {
      const body = await readBody(req);
      const computed = sha256(body);
      const claimed = String(req.headers["x-document-sha256"] || "").toLowerCase();
      if (claimed && claimed !== computed) {
        return sendError(res, 422, "HASH_MISMATCH", "SHA-256 mismatch");
      }
      const existing = tasks.get(computed);
      if (existing) {
        return sendJson(res, 200, { id: computed, status: existing.status });
      }
      tasks.set(computed, {
        status: "pending",
        source: body,
        dual: null,
        dualHash: null,
      });
      console.log(`[mock] submitted ${computed.slice(0, 12)} (${body.length} bytes)`);
      scheduleComplete(computed);
      return sendJson(res, 202, { id: computed, status: "pending" });
    }

    const dualMatch = path.match(
      /^\/v1\/documents\/([0-9a-f]{64})\/files\/dual$/,
    );
    if (method === "GET" && dualMatch) {
      const hash = dualMatch[1];
      const t = tasks.get(hash);
      if (!t) {
        return sendError(res, 404, "NOT_FOUND", "Unknown document");
      }
      if (t.status !== "down" || !t.dual) {
        return sendError(res, 409, "NOT_READY", "Document not ready");
      }
      let payload = t.dual;
      let artifact = t.dualHash;
      if (process.env.CORRUPT_DUAL === "1") {
        payload = Buffer.from("not-a-pdf");
        artifact = sha256(payload);
      }
      if (process.env.BAD_ARTIFACT_HASH === "1") {
        artifact = "0".repeat(64);
      }
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": payload.length,
        "X-Artifact-SHA256": artifact,
      });
      return res.end(payload);
    }

    const delMatch = path.match(/^\/v1\/documents\/([0-9a-f]{64})$/);
    if (method === "DELETE" && delMatch) {
      tasks.delete(delMatch[1]);
      return sendJson(res, 200, { ack: true });
    }

    const retryMatch = path.match(/^\/v1\/documents\/([0-9a-f]{64})\/retry$/);
    if (method === "POST" && retryMatch) {
      const hash = retryMatch[1];
      const t = tasks.get(hash);
      if (!t) {
        return sendError(res, 404, "NOT_FOUND", "Unknown document");
      }
      if (t.status === "pending" || t.status === "down") {
        return sendJson(res, 200, { id: hash, status: t.status });
      }
      t.status = "pending";
      t.dual = null;
      t.dualHash = null;
      scheduleComplete(hash);
      return sendJson(res, 202, { id: hash, status: "pending" });
    }

    return sendError(res, 404, "NOT_FOUND", `No route ${method} ${path}`);
  } catch (e) {
    console.error(e);
    return sendError(res, 500, "INTERNAL", "Internal error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] http://127.0.0.1:${PORT}  token=${TOKEN}`);
  console.log(`[mock] PENDING_MS=${PENDING_MS}`);
});
