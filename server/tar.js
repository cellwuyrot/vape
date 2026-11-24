/**
 * Минимальный tar (формат ustar): упаковка и распаковка резервных копий.
 *
 * Внешних архиваторов нет ни в контейнере node:alpine, ни в зависимостях,
 * а копия из одного файла удобнее каталога: её проще выгрузить в S3 и проверить
 * контрольной суммой. Сжатие — штатным node:zlib.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const BLOCK = 512;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";

function header(name, size, mtime, typeflag = "0") {
  const buf = Buffer.alloc(BLOCK);

  let prefix = "";
  let fileName = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", name.length - 100 + 1);
    if (cut === -1) throw new Error(`Слишком длинное имя в архиве: ${name}`);
    prefix = name.slice(0, cut);
    fileName = name.slice(cut + 1);
  }

  buf.write(fileName, 0, 100, "utf8");
  buf.write(octal(0o644, 8), 100, 8);
  buf.write(octal(0, 8), 108, 8);
  buf.write(octal(0, 8), 116, 8);
  buf.write(octal(size, 12), 124, 12);
  buf.write(octal(Math.floor(mtime / 1000), 12), 136, 12);
  buf.write("        ", 148, 8); // место контрольной суммы на время подсчёта
  buf.write(typeflag, 156, 1);
  buf.write("ustar\0", 257, 6);
  buf.write("00", 263, 2);
  if (prefix) buf.write(prefix, 345, 155, "utf8");

  const checksum = buf.reduce((sum, byte) => sum + byte, 0);
  buf.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buf;
}

const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Список файлов каталога с путями относительно него. */
export async function walk(dir, base = dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else if (entry.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

/**
 * Собирает архив из списка записей.
 * @param {Array<{name: string, content?: Buffer, file?: string}>} entries
 */
export async function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = entry.content ?? (await fsp.readFile(entry.file));
    const mtime = entry.file ? (await fsp.stat(entry.file)).mtimeMs : Date.now();
    chunks.push(header(entry.name, content.length, mtime), content, padding(content.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // завершающие пустые блоки
  return Buffer.concat(chunks);
}

export const createTarGz = async (entries) => gzip(await createTar(entries), { level: 6 });

/** Разбирает архив в список { name, content }. */
export function extractTar(buffer) {
  const files = [];
  let offset = 0;

  while (offset + BLOCK <= buffer.length) {
    const head = buffer.subarray(offset, offset + BLOCK);
    if (head.every((byte) => byte === 0)) break;

    const readString = (start, length) => {
      const raw = head.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString("utf8");
    };

    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const size = parseInt(readString(124, 12).trim() || "0", 8);
    const typeflag = readString(156, 1) || "0";

    offset += BLOCK;
    const content = buffer.subarray(offset, offset + size);
    offset += size + padding(size).length;

    if (typeflag === "0" || typeflag === "\0") {
      files.push({ name: prefix ? `${prefix}/${name}` : name, content: Buffer.from(content) });
    }
  }
  return files;
}

export const extractTarGz = async (buffer) => extractTar(await gunzip(buffer));

/** Разворачивает архив в каталог — используется проверкой восстановления. */
export async function extractTarGzToDir(buffer, dir) {
  const files = await extractTarGz(buffer);
  for (const file of files) {
    const target = path.resolve(dir, file.name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Подозрительный путь в архиве: ${file.name}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, file.content);
  }
  return files.map((f) => f.name);
}

export const exists = (file) => fs.existsSync(file);
