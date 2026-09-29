/**
 * A static file server for previewing `docs-dist/`, so `npm run docs:dev` does
 * not need a dependency that is not already here. Node's http module is enough:
 * the docs site is a directory of HTML with two static assets.
 *
 *   node scripts/docs/serve.mjs [--port 4173] [--dir docs-dist]
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function parseArgs(argv) {
  const options = { port: 4173, dir: join(REPO_ROOT, "docs-dist") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") options.port = Number(argv[++i]);
    else if (argv[i] === "--dir") options.dir = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

/** Maps a URL path to a file, following the trailing-slash directory index. */
function resolveFile(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(root, `.${normalize(decoded)}`);
  // normalize() can leave ".." in place for crafted input; refuse anything that
  // escapes the served directory.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate)) return null;
  if (statSync(candidate).isDirectory()) {
    const index = join(candidate, "index.html");
    return existsSync(index) ? index : null;
  }
  return candidate;
}

function serve() {
  const { port, dir } = parseArgs(process.argv.slice(2));
  if (!existsSync(dir)) {
    process.stderr.write(`docs: nothing to serve at ${dir}. Run "npm run docs:build" first.\n`);
    process.exit(1);
  }

  createServer((request, response) => {
    const { pathname } = new URL(request.url, `http://localhost:${port}`);
    const file = resolveFile(dir, pathname);
    if (!file) {
      const fallback = join(dir, "404.html");
      response.writeHead(404, { "content-type": TYPES[".html"] });
      createReadStream(existsSync(fallback) ? fallback : file).pipe(response);
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  }).listen(port, () => {
    process.stdout.write(`docs: serving ${dir} at http://localhost:${port}/\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve();
}
