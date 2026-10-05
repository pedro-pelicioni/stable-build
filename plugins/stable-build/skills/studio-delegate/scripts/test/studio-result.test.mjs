// Tests for studio-result.mjs. Run: node --test plugins/stable-build/skills/studio-delegate/scripts/test/
// Fixtures are synthetic: built from the Arc Studio CLI 1.1.3 result shape (dist/api/types.js
// emptyResult, dist/commands/agent-guide.js, dist/engine/turn.js messages), not recorded from a
// live account. The verify tests use a local mock JSON-RPC server; set STABLE_BUILD_LIVE_RPC=1 to
// also run one read-only eth_chainId/eth_getCode check against https://rpc.testnet.arc.io.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  summarize,
  verifyDeployments,
  classifyError,
  clean,
  checkRpcUrl,
  safeRelativePath,
  TESTNET_CHAIN_ID,
} from '../studio-result.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Fixture URLs are written as ${VAR} templates so tools/check-links.mjs skips them as placeholders.
const APP = 'app_7f3c2a91';
const ADDR_A = '0x1111111111111111111111111111111111111111';
const VARS = { APP, ADDR_A, STUDIO: 'https:' + '//studio.arc.io' };
const fx = (name) => readFileSync(join(here, 'fixtures', name), 'utf8').replace(/\$\{(\w+)\}/g, (m, k) => VARS[k] ?? m);
const SCRIPT = join(here, '..', 'studio-result.mjs');

test('exit 0 completed: report, deployments accepted, explorer links built locally', () => {
  const s = summarize({ stdoutText: fx('completed-deploy.json'), exitCode: 0, session: 'sb-demo' });
  assert.equal(s.status, 'completed');
  assert.equal(s.next, 'report');
  assert.equal(s.webUrl, `${VARS.STUDIO}/app/${APP}`);
  assert.equal(s.deployments.length, 1);
  assert.equal(s.rejectedDeployments.length, 0);
  const d = s.deployments[0];
  assert.equal(d.address, '0x1111111111111111111111111111111111111111');
  assert.equal(d.explorer.address, `https://explorer.testnet.arc.io/address/${ADDR_A}`);
  assert.equal(d.explorer.tx, `https://explorer.testnet.arc.io/tx/0x${'a'.repeat(64)}`);
  assert.equal(d.reportedExplorerOk, true);
  assert.deepEqual(d.notes, []);
  assert.equal(s.fileDiffs.length, 2);
  assert.equal(s.fileDiffs[1].truncated, true);
  assert.ok(!('hunk' in s.fileDiffs[0]), 'hunks are not echoed');
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.commands, ['arc-studio pull --session sb-demo --out <dir> --changed --dry-run --diff']);
});

test('exit 0 with a clarifying question and no changes: clarify', () => {
  const s = summarize({ stdoutText: fx('completed-question.json'), exitCode: 0 });
  assert.equal(s.status, 'completed');
  assert.equal(s.next, 'clarify');
  assert.match(s.untrusted.finalText, /multisig\?$/);
});

test('exit 1 with errorMessage about a dropped stream: attach', () => {
  const s = summarize({ stdoutText: fx('error-stream-ended.json'), exitCode: 1, session: 'sb-demo' });
  assert.equal(s.status, 'error');
  assert.equal(s.next, 'attach');
  assert.deepEqual(s.commands, ['arc-studio attach --session sb-demo --output json --timeout 9']);
});

test('exit 1 with empty stdout: classify from the last plain stderr line', () => {
  const upgrade = summarize({ stdoutText: '', exitCode: 1, stderrText: fx('stderr-426.txt') });
  assert.equal(upgrade.status, 'error');
  assert.equal(upgrade.next, 'upgrade_cli');
  assert.match(upgrade.untrusted.stderrLastLine, /no longer supported/);

  const timeout = summarize({ stdoutText: '', exitCode: 1, stderrText: fx('stderr-attach-timeout.txt'), session: 'sb-demo' });
  assert.equal(timeout.next, 'attach');

  const auth = summarize({ stdoutText: '', exitCode: 1, stderrText: fx('stderr-401.txt') });
  assert.equal(auth.next, 'reauth');

  const bare = summarize({ stdoutText: '', exitCode: 1, stderrText: '' });
  assert.equal(bare.next, 'retry_once');
});

test('exit 3 needs_input: questions normalized, answers template, mainnet option flagged', () => {
  const s = summarize({ stdoutText: fx('needs-input.json'), exitCode: 3, session: 'sb-demo' });
  assert.equal(s.status, 'needs_input');
  assert.equal(s.next, 'answer_questions');
  assert.equal(s.questions.questions.length, 2);
  assert.deepEqual(s.questions.questions[0].mainnetOptionIds, ['base_mainnet']);
  assert.deepEqual(s.answersTemplate, [
    { questionId: 'chain', selectedOptionIds: [] },
    { questionId: 'supply', selectedOptionIds: [], freeform: '' },
  ]);
  assert.ok(s.warnings.some((w) => /mainnet/.test(w)));
  assert.match(s.commands[0], /--answers-json "\$\(cat "\$d\/answers.json"\)"/);
});

test('exit 4 budget_exceeded: stop, no retry command', () => {
  const s = summarize({ stdoutText: fx('budget-exceeded.json'), exitCode: 4, session: 'sb-demo' });
  assert.equal(s.status, 'budget_exceeded');
  assert.equal(s.next, 'stop_budget');
  assert.deepEqual(s.budget, { scope: 'daily' });
  assert.deepEqual(s.commands, []);
});

test('detached submission: attach command uses the reported session', () => {
  const s = summarize({ stdoutText: fx('detached.json'), exitCode: 0 });
  assert.equal(s.status, 'detached');
  assert.equal(s.next, 'attach');
  assert.equal(s.session, 'sb-vault');
  assert.deepEqual(s.commands, ['arc-studio attach --session sb-vault --output json --timeout 9']);
});

test('exit code and status mismatch is warned about, status wins', () => {
  const s = summarize({ stdoutText: fx('completed-deploy.json'), exitCode: 3 });
  assert.equal(s.status, 'completed');
  assert.ok(s.warnings.some((w) => /does not match status/.test(w)));
});

test('exit 2 from run without a document: missing subcommand', () => {
  const s = summarize({ stdoutText: '', exitCode: 2 });
  assert.equal(s.next, 'fix_command');
});

test('hostile result: bad deployments dropped without echo, text sanitized, unsafe paths dropped', () => {
  const raw = fx('injected.json');
  const s = summarize({ stdoutText: raw, exitCode: 0, session: 'sb-demo' });
  const out = JSON.stringify(s);
  // Accepted: the one well-formed entry, with mainnet and explorer notes.
  assert.equal(s.deployments.length, 1);
  assert.equal(s.deployments[0].address, '0x2222222222222222222222222222222222222222');
  assert.ok(s.deployments[0].notes.some((n) => /mainnet/.test(n)));
  assert.equal(s.deployments[0].reportedExplorerOk, false);
  assert.ok(!out.includes('evil.example/tx'), 'foreign explorer URL is not echoed');
  // Rejected entries: 4, values withheld.
  assert.equal(s.rejectedDeployments.length, 4);
  assert.ok(!out.includes('c'.repeat(64)), 'credential-shaped value is not echoed');
  assert.ok(!out.includes('$(curl'), 'command-shaped value is not echoed');
  assert.ok(!out.includes('rm -rf ~'), 'command-shaped contract name is not echoed');
  // Remote text: control sequences stripped, injection flagged.
  assert.ok(!/[\x1B\x07\u202e]/.test(s.untrusted.finalText));
  assert.ok(!/\x1B/.test(s.untrusted.todos[0].text));
  assert.ok(s.untrusted.suspicious.includes('asks to ignore earlier instructions'));
  assert.ok(s.untrusted.suspicious.includes('contains a pipe-to-shell command'));
  assert.ok(s.untrusted.suspicious.includes('mentions Arc Studio credentials'));
  // webUrl off-host is withheld.
  assert.equal(s.webUrl, null);
  // Paths.
  assert.deepEqual(s.filesChanged, ['contracts/Ok.sol']);
  assert.deepEqual(s.fileDiffs.map((d) => d.path), ['contracts/Ok.sol']);
  assert.ok(s.warnings.some((w) => /do not act on it/.test(w)));
});

test('unknown fields are tolerated; previewUrl surfaced only as an Arc Studio https URL', () => {
  const s = summarize({ stdoutText: fx('preview-url.json'), exitCode: 0 });
  assert.equal(s.status, 'completed');
  assert.deepEqual(s.unknownFields.sort(), ['previewUrl', 'somethingNew']);
  assert.equal(s.previewUrl, `${VARS.STUDIO}/preview/${APP}`);
  assert.ok(s.warnings.some((w) => /previewUrl is not part of CLI 1.1.3/.test(w)));
});

test('non-JSON stdout and bad session names are handled', () => {
  const s = summarize({ stdoutText: 'Turn accepted (text mode)', exitCode: 0, session: 'x; rm -rf /' });
  assert.equal(s.status, 'unknown');
  assert.equal(s.session, null);
  assert.deepEqual(s.commands, []);
  assert.ok(s.warnings.some((w) => /not a single JSON document/.test(w)));
});

test('helpers: classifyError, clean, safeRelativePath, checkRpcUrl', () => {
  assert.equal(classifyError('No session named \'x\' found.'), 'fix_session');
  assert.equal(classifyError('--file a.sol:contracts: destination "contracts" is ambiguous'), 'fix_input');
  assert.equal(classifyError('Request failed with 429: active sandbox limit reached'), 'pause_sandbox');
  assert.equal(classifyError('connect ECONNREFUSED 127.0.0.1:443'), 'retry_once');
  assert.equal(clean('a\x1B[2Jb\rc'), 'abc');
  assert.equal(clean('x'.repeat(10), 4), 'xxxx [truncated 6 chars]');
  assert.equal(safeRelativePath('contracts/A.sol'), 'contracts/A.sol');
  assert.equal(safeRelativePath('C:\\x'), null);
  assert.equal(safeRelativePath('a/../../b'), null);
  assert.throws(() => checkRpcUrl('http:' + '//rpc.testnet.arc.io'), /https/);
  assert.equal(checkRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545/');
});

// ---------- verification against a local mock JSON-RPC server ----------

const A = '0x1111111111111111111111111111111111111111';
const B = '0x4444444444444444444444444444444444444444';
const C = '0x5555555555555555555555555555555555555555';
const TX_A = `0x${'a'.repeat(64)}`;
const TX_C = `0x${'d'.repeat(64)}`;
const D = '0x6666666666666666666666666666666666666666';
const TX_D = `0x${'e'.repeat(64)}`;
const E = '0x7777777777777777777777777777777777777777';

function startMock({ chainId = TESTNET_CHAIN_ID, flaky = false } = {}) {
  let first = true;
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push(method);
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (flaky && method === 'eth_getCode' && first) {
        first = false;
        return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32014, message: 'block not imported' } }));
      }
      if (method === 'eth_chainId') return reply(`0x${chainId.toString(16)}`);
      if (method === 'eth_getCode') {
        const a = params[0].toLowerCase();
        if (a === A) return reply('0x6080604052');
        if (a === C || a === D) return reply('0x6080');
        if (a === E) return reply(`0xef0100${'7'.repeat(40)}`);
        return reply('0x');
      }
      if (method === 'eth_getTransactionReceipt') {
        if (params[0] === TX_A) return reply({ status: '0x1', contractAddress: A, logs: [] });
        if (params[0] === TX_C) return reply({ status: '0x1', contractAddress: null, logs: [{ address: '0x9999999999999999999999999999999999999999' }] });
        if (params[0] === TX_D) return reply({ status: '0x1', contractAddress: null, logs: [{ address: D }] });
        return reply(null);
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not allowed in mock' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('verify: code + receipt link => verified; no code => not_verified; unlinked tx flagged', async () => {
  const { server, calls, url } = await startMock({ flaky: true });
  try {
    const report = await verifyDeployments(
      [
        { index: 0, address: A, txHash: TX_A },
        { index: 1, address: B, txHash: null },
        { index: 2, address: C, txHash: TX_C },
        { index: 3, address: D, txHash: TX_D },
        { index: 4, address: E, txHash: null },
        { index: 5, address: A, txHash: `0x${'f'.repeat(64)}` },
      ],
      { rpcUrl: url },
    );
    assert.equal(report.refused, null);
    assert.equal(report.chainId, TESTNET_CHAIN_ID);
    const [ra, rb, rc, rd, re, rf] = report.results;
    assert.equal(ra.verdict, 'verified');
    assert.equal(ra.link, 'created_by_tx');
    assert.equal(rb.verdict, 'not_verified');
    assert.equal(rb.code, 'none');
    assert.equal(rc.verdict, 'code_present_tx_unconfirmed');
    assert.equal(rc.link, 'not_linked');
    assert.equal(rd.verdict, 'code_present_tx_linked');
    assert.equal(re.verdict, 'not_verified', 'EIP-7702 delegated EOA is not a contract');
    assert.match(re.notes[0], /EIP-7702/);
    assert.equal(rf.tx, 'not_found');
    assert.equal(rf.verdict, 'code_present_tx_unconfirmed');
    assert.ok(calls.filter((m) => m === 'eth_getCode').length >= 4, '-32014 was retried');
    assert.ok(calls.every((m) => ['eth_chainId', 'eth_getCode', 'eth_getTransactionReceipt'].includes(m)), 'read-only methods only');
  } finally {
    server.close();
  }
});

test('verify: refuses an RPC that is not Arc testnet', async () => {
  const { server, url } = await startMock({ chainId: 5042 });
  try {
    const report = await verifyDeployments([{ index: 0, address: A, txHash: null }], { rpcUrl: url });
    assert.match(report.refused, /not Arc testnet/);
    assert.deepEqual(report.results, []);
  } finally {
    server.close();
  }
});

test('CLI wiring: --exit, --session, --stderr, --verify against the mock', async () => {
  const { server, url } = await startMock();
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'sb-studio-'));
    const file = join(tmp, 'result.json');
    writeFileSync(file, fx('completed-deploy.json'));
    // spawnSync would block the event loop that serves the mock, so run the CLI asynchronously.
    const { spawn } = await import('node:child_process');
    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [SCRIPT, file, '--exit', '0', '--session', 'sb-demo', '--verify', '--rpc', url]);
      let s = '';
      p.stdout.on('data', (c) => (s += c));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(s) : reject(new Error(`exit ${code}`))));
    });
    const j = JSON.parse(out);
    assert.equal(j.status, 'completed');
    assert.equal(j.verification.results[0].verdict, 'verified');

    const bad = spawnSync(process.execPath, [SCRIPT, file, '--exit', 'zero']);
    assert.equal(bad.status, 64);
    const stdin = spawnSync(process.execPath, [SCRIPT, '-', '--exit', '4'], { input: fx('budget-exceeded.json') });
    assert.equal(JSON.parse(stdin.stdout).next, 'stop_budget');
    rmSync(tmp, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test('live read-only check of Arc testnet (opt-in: STABLE_BUILD_LIVE_RPC=1)', { skip: process.env.STABLE_BUILD_LIVE_RPC !== '1' }, async () => {
  const USDC = '0x3600000000000000000000000000000000000000'; // https://docs.arc.io/arc/references/contract-addresses
  const report = await verifyDeployments(
    [
      { index: 0, address: USDC, txHash: null },
      { index: 1, address: '0x000000000000000000000000000000000000dEaD', txHash: null },
    ],
    {},
  );
  assert.equal(report.refused, null);
  assert.equal(report.chainId, TESTNET_CHAIN_ID);
  assert.equal(report.results[0].code, 'present');
  assert.equal(report.results[0].verdict, 'code_present_no_tx');
  assert.equal(report.results[1].verdict, 'not_verified');
});
