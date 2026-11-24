/**
 * Подпись запросов AWS Signature Version 4 — на node:crypto, без aws-sdk.
 *
 * Тот же алгоритм используют российские S3-совместимые хранилища:
 * Яндекс Object Storage, VK Cloud, Selectel, Cloud.ru. Функции чистые,
 * поэтому проверяются юнит-тестами по официальным векторам AWS.
 */
import crypto from "node:crypto";

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

export const EMPTY_BODY_HASH = sha256Hex("");

/** 20240131T120000Z и 20240131 — обе формы нужны подписи. */
export function amzDates(date = new Date()) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Кодирование пути по правилам AWS: слеш не трогаем, остальное — строгий RFC 3986.
 * encodeURIComponent оставляет ! ' ( ) * незакодированными, из-за чего подпись «плывёт».
 */
export function encodeRfc3986(value, keepSlash = false) {
  const encoded = encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

export const canonicalUri = (key) =>
  `/${String(key).replace(/^\/+/, "")}`.split("/").map((part, i) => (i === 0 ? part : encodeRfc3986(part))).join("/");

export function canonicalQuery(query = {}) {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key] ?? "")}`)
    .join("&");
}

export function signingKey({ secretAccessKey, dateStamp, region, service }) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Возвращает заголовки, с которыми запрос примет любое S3-совместимое хранилище.
 * @returns {{headers: Record<string,string>, canonicalRequest: string, stringToSign: string}}
 */
export function signRequest({
  method,
  host,
  path: uriPath,
  query = {},
  headers = {},
  payloadHash = EMPTY_BODY_HASH,
  accessKeyId,
  secretAccessKey,
  region,
  service = "s3",
  date = new Date(),
  // Заголовок с хешом тела обязателен только для S3; для других сервисов
  // его отсутствие позволяет сверяться с эталонными векторами AWS.
  includeContentSha = service === "s3",
}) {
  const { amzDate, dateStamp } = amzDates(date);

  const allHeaders = {
    host,
    ...(includeContentSha ? { "x-amz-content-sha256": payloadHash } : {}),
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };

  const signedHeaderNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${allHeaders[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    uriPath,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signature = crypto
    .createHmac("sha256", signingKey({ secretAccessKey, dateStamp, region, service }))
    .update(stringToSign)
    .digest("hex");

  return {
    headers: {
      ...allHeaders,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export { sha256Hex };
