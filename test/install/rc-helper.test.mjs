// node --test test/install/rc-helper.test.mjs
// The rc-file part of install.sh's embedded node helper (rc-add, rc-remove), run on its own: the two
// marked PATH lines go into a shell rc file and come out again byte for byte, and a symlinked rc file
// is handled without creating or deleting anything at either end of the link that is not ours.
// Everything happens in a temporary directory.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "..", "install.sh"), "utf8").split("\n");
const start = SRC.findIndex((l) => /HELPER_JS <<'JS_EOF'/.test(l));
const end = SRC.findIndex((l, i) => i > start && l === "JS_EOF");
assert.ok(start > 0 && end > start, "the node helper was not found in install.sh");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sb-rc-helper-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HELPER = path.join(TMP, "helper.cjs");
// install.sh writes `const N = {...};` (names for the probe) in front of the helper
fs.writeFileSync(HELPER, "const N = {};\n" + SRC.slice(start + 1, end).join("\n") + "\n");

const MARK = "# added by stable-build (Arc Foundry)";
const LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const BLOCK = `${MARK}\n${LINE}\n`;
const helper = (...args) => {
  const r = spawnSync(process.execPath, [HELPER, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
let n = 0;
const dir = () => { const d = path.join(TMP, `case-${++n}`); fs.mkdirSync(d); return d; };
const isLink = (f) => fs.lstatSync(f).isSymbolicLink();

test("a missing rc file is created with the two lines, and deleted again when it holds nothing else", () => {
  const d = dir(); const rc = path.join(d, ".zshrc");
  assert.equal(helper("rc-add", rc, MARK, LINE), "created 0");
  assert.equal(fs.readFileSync(rc, "utf8"), BLOCK);
  assert.equal(helper("rc-add", rc, MARK, LINE), "present");
  assert.equal(helper("rc-remove", rc, MARK, LINE, "0", "1"), "deleted");
  assert.equal(fs.existsSync(rc), false);
});

test("a dangling symlink is not followed: nothing is created at its far end", () => {
  const d = dir(); const rc = path.join(d, ".zshrc"); const target = path.join(d, "dotfiles", "zshrc");
  fs.mkdirSync(path.dirname(target));
  fs.symlinkSync(target, rc);
  assert.equal(helper("rc-add", rc, MARK, LINE), "failed");
  assert.equal(fs.existsSync(target), false, "a file was created at the far end of the link");
  assert.ok(isLink(rc));
  assert.equal(helper("rc-remove", rc, MARK, LINE, "0", "1"), "absent");
  assert.ok(isLink(rc), "the user's link was removed");
});

test("a symlink to an existing rc file: the lines go into that file and come out byte for byte, the link stays", () => {
  const d = dir(); const rc = path.join(d, ".zshrc"); const target = path.join(d, "zshrc.real");
  fs.writeFileSync(target, "alias ll='ls -l'"); // no newline at the end
  fs.symlinkSync(target, rc);
  assert.equal(helper("rc-add", rc, MARK, LINE), "added 1");
  assert.ok(isLink(rc));
  assert.equal(fs.readFileSync(target, "utf8"), `alias ll='ls -l'\n${BLOCK}`);
  assert.equal(helper("rc-remove", rc, MARK, LINE, "1", "0"), "removed");
  assert.ok(isLink(rc));
  assert.equal(fs.readFileSync(target, "utf8"), "alias ll='ls -l'");
});

test("a file recorded as created that is now the user's symlink is not deleted: only the two lines go", () => {
  const d = dir(); const rc = path.join(d, ".bashrc"); const target = path.join(d, "bashrc.real");
  fs.writeFileSync(target, BLOCK);
  fs.symlinkSync(target, rc);
  assert.equal(helper("rc-remove", rc, MARK, LINE, "0", "1"), "removed");
  assert.ok(isLink(rc), "the user's link was removed");
  assert.equal(fs.readFileSync(target, "utf8"), "");
});

test("a directory where the rc file should be is reported as failed and left alone", () => {
  const d = dir(); const rc = path.join(d, ".zshrc");
  fs.mkdirSync(rc);
  assert.equal(helper("rc-add", rc, MARK, LINE), "failed");
  assert.deepEqual(fs.readdirSync(rc), []);
});
