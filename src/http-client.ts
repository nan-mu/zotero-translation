import { DocumentStatus } from "./constants";
import { diagnostics } from "./diagnostics";
import { isSha256Hex, sha256Bytes } from "./hasher";
import { settings } from "./settings";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class HttpClientError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "HttpClientError";
    this.status = status;
    this.code = code;
  }
}

export interface DocumentRecord {
  id: string;
  status: DocumentStatus;
}

function authHeaders(token: string, extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function requestJson<T>(
  method: string,
  path: string,
  options: {
    body?: string | Uint8Array | ArrayBuffer;
    headers?: Record<string, string>;
    successStatuses?: number[];
  } = {},
): Promise<{ status: number; data: T }> {
  const baseUrl = settings.getBaseUrl();
  settings.assertSafeEndpoint(baseUrl);
  const token = settings.getToken();
  if (!token) {
    throw new AuthError("Token is empty");
  }

  const url = joinUrl(baseUrl, path);
  const successStatuses = options.successStatuses || [200, 202];

  try {
    const xhr = await Zotero.HTTP.request(method, url, {
      headers: authHeaders(token, options.headers),
      body: options.body,
      responseType: "json",
      timeout: 120000,
    });
    const status = xhr.status;
    if (status === 401 || status === 403) {
      throw new AuthError(`HTTP ${status}`);
    }
    if (!successStatuses.includes(status)) {
      const errBody = xhr.response;
      const code = errBody?.error?.code;
      const message =
        errBody?.error?.message || `HTTP ${status} for ${method} ${path}`;
      throw new HttpClientError(message, status, code);
    }
    return { status, data: xhr.response as T };
  } catch (e) {
    if (e instanceof AuthError || e instanceof HttpClientError) {
      throw e;
    }
    // Zotero.HTTP may throw with status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyErr = e as any;
    const status = Number(anyErr?.status || anyErr?.xmlhttp?.status || 0);
    if (status === 401 || status === 403) {
      throw new AuthError(`HTTP ${status}`);
    }
    throw e;
  }
}

export class HttpClient {
  async health(): Promise<boolean> {
    try {
      const { data } = await requestJson<{ ok?: boolean }>("GET", "/v1/health", {
        successStatuses: [200],
      });
      return Boolean(data?.ok);
    } catch (e) {
      if (e instanceof AuthError) {
        throw e;
      }
      // Fallback: list documents validates URL + token + JSON shape
      await this.listDocuments();
      return true;
    }
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    const { data } = await requestJson<{ documents: DocumentRecord[] }>(
      "GET",
      "/v1/documents",
      { successStatuses: [200] },
    );
    const docs = Array.isArray(data?.documents) ? data.documents : [];
    const seen = new Set<string>();
    const out: DocumentRecord[] = [];
    for (const d of docs) {
      if (!d?.id || !isSha256Hex(d.id)) {
        diagnostics.warn(`Skipping invalid document id from server`);
        continue;
      }
      if (seen.has(d.id)) {
        continue;
      }
      seen.add(d.id);
      if (d.status !== "pending" && d.status !== "down" && d.status !== "error") {
        diagnostics.error(
          `Unknown status for ${diagnostics.shortHash(d.id)}: ${String(d.status)}`,
        );
        continue;
      }
      out.push({ id: d.id, status: d.status });
    }
    return out;
  }

  async submitDocument(
    hash: string,
    pdfBytes: Uint8Array,
  ): Promise<DocumentRecord> {
    const { status, data } = await requestJson<DocumentRecord>(
      "POST",
      "/v1/documents",
      {
        headers: {
          "Content-Type": "application/pdf",
          "X-Document-SHA256": hash,
        },
        body: pdfBytes,
        successStatuses: [200, 202],
      },
    );
    diagnostics.info(
      `Submit ${diagnostics.shortHash(hash)} -> HTTP ${status} status=${data.status}`,
    );
    return data;
  }

  async downloadDual(
    hash: string,
    destPath: string,
  ): Promise<{ artifactSha256: string; bytes: Uint8Array }> {
    const baseUrl = settings.getBaseUrl();
    settings.assertSafeEndpoint(baseUrl);
    const token = settings.getToken();
    const url = joinUrl(baseUrl, `/v1/documents/${hash}/files/dual`);

    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: authHeaders(token, { Accept: "application/pdf" }),
      responseType: "arraybuffer",
      timeout: 300000,
    });

    if (xhr.status === 401 || xhr.status === 403) {
      throw new AuthError(`HTTP ${xhr.status}`);
    }
    if (xhr.status === 409 || xhr.status === 404) {
      throw new HttpClientError(
        `Download not ready/found: ${xhr.status}`,
        xhr.status,
      );
    }
    if (xhr.status !== 200) {
      throw new HttpClientError(`Download failed: ${xhr.status}`, xhr.status);
    }

    const bytes = new Uint8Array(xhr.response as ArrayBuffer);
    if (bytes.length === 0) {
      throw new Error("Empty dual PDF response");
    }
    // PDF magic
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (head !== "%PDF") {
      throw new Error("Downloaded file is not a PDF");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getHeader = (name: string): string => {
      try {
        return String(xhr.getResponseHeader?.(name) || "");
      } catch {
        return "";
      }
    };
    const contentLength = Number(getHeader("Content-Length") || "0");
    if (contentLength > 0 && contentLength !== bytes.length) {
      throw new Error(
        `Content-Length mismatch: header=${contentLength} body=${bytes.length}`,
      );
    }
    const artifactHeader = getHeader("X-Artifact-SHA256").toLowerCase();
    const computed = await sha256Bytes(bytes);
    if (artifactHeader && artifactHeader !== computed) {
      throw new Error("X-Artifact-SHA256 mismatch");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const IOUtilsAny = (globalThis as any).IOUtils;
    if (IOUtilsAny?.write) {
      await IOUtilsAny.write(destPath, bytes);
    } else {
      throw new Error("IOUtils.write unavailable for dual PDF");
    }

    return { artifactSha256: computed, bytes };
  }

  async deleteDocument(hash: string): Promise<void> {
    await requestJson<{ ack: boolean }>("DELETE", `/v1/documents/${hash}`, {
      successStatuses: [200],
    });
  }

  async retryDocument(hash: string): Promise<DocumentRecord> {
    const { data } = await requestJson<DocumentRecord>(
      "POST",
      `/v1/documents/${hash}/retry`,
      {
        headers: { "Content-Type": "application/json" },
        body: "{}",
        successStatuses: [200, 202],
      },
    );
    return data;
  }
}

export const httpClient = new HttpClient();
