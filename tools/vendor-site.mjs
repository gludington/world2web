#!/usr/bin/env node
// Puts the current packages/site into a test site repo as a vendored tarball,
// so a real host (Vercel, Netlify, Cloudflare) builds this exact code without
// an npm release. See CONTRIBUTING.md, "A site change on a real host".
//
//   pnpm site:vendor <path-or-owner/repo> [--no-push]
//
// <path-or-owner/repo> is either a local clone of the site repo or a GitHub
// "owner/repo", which gets cloned into a temporary directory. The site repo
// must already use @world2web/site, so this can't clobber an unrelated repo.
// Publish to Web leaves the resulting file: dependency alone.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@world2web/site";
const VENDORED = "vendor/world2web-site.tgz";
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = process.argv.slice(2);
const push = !args.includes("--no-push");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("Usage: pnpm site:vendor <path-or-owner/repo> [--no-push]");
  process.exit(1);
}

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();

const scratch = mkdtempSync(join(tmpdir(), "w2w-vendor-"));
try {
  // 1. The site repo: a local clone, or clone owner/repo from GitHub.
  let siteDir = resolve(target);
  if (!existsSync(siteDir)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(target)) throw new Error(`No such folder, and not an owner/repo name: ${target}`);
    siteDir = join(scratch, "site");
    console.log(`Cloning ${target}...`);
    run("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${target}.git`, siteDir]);
  }
  const pkgPath = join(siteDir, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")) : null;
  if (!pkg?.dependencies?.[PACKAGE]) {
    throw new Error(`${siteDir} doesn't depend on ${PACKAGE}; refusing to touch it.`);
  }

  // 2. Pack the package exactly as npm would publish it.
  const packDir = join(scratch, "pack");
  mkdirSync(packDir);
  run("pnpm", ["pack", "--pack-destination", packDir], { cwd: join(repoRoot, "packages/site") });
  const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");

  // 3. Vendor it and point the dependency at it.
  mkdirSync(join(siteDir, "vendor"), { recursive: true });
  copyFileSync(join(packDir, tarball), join(siteDir, VENDORED));
  pkg.dependencies[PACKAGE] = `file:./${VENDORED}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // 4. Commit (and push), recording where the package came from.
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  const sha = run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
  const dirty = run("git", ["status", "--porcelain", "--", "packages/site"], { cwd: repoRoot }) ? " + uncommitted changes" : "";
  run("git", ["add", VENDORED, "package.json"], { cwd: siteDir });
  if (!run("git", ["status", "--porcelain", "--", VENDORED, "package.json"], { cwd: siteDir })) {
    console.log("Already vendored at this exact version; nothing to commit.");
  } else {
    run("git", ["commit", "--quiet", "-m", `Vendor ${PACKAGE} from world2web ${branch}@${sha}${dirty}`], { cwd: siteDir });
    console.log(`Committed ${VENDORED} (${branch}@${sha}${dirty}).`);
    if (push) {
      run("git", ["push", "--quiet"], { cwd: siteDir });
      console.log("Pushed. Your host should start building it now.");
    } else {
      console.log(`Not pushed (--no-push). The commit is in ${siteDir}.`);
    }
  }
} catch (err) {
  console.error(`site:vendor: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Keep a temp clone around only when its unpushed commit would be lost.
  if (push || existsSync(resolve(target))) rmSync(scratch, { recursive: true, force: true });
}
