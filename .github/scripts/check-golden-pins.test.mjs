/**
 * Tests for the golden-pin gate.
 *
 * Two halves. The pure half exercises path matching and trailer parsing
 * directly. The end-to-end half builds throwaway git repositories shaped like
 * this one — a `crates/stt-core/tests/fixtures/v2-golden/` writer tree with a
 * hash pin in it, and a `packages/core/test/fixtures/` reader tree beside it —
 * and spawns the real script against them with `--repo`, because the only
 * thing worth asserting about a gate is its exit code on a real diff.
 *
 * Both trees are exercised, not just the writer one: the reader-side fixtures
 * joined the watched set on 2026-08-10, and a gate whose new root has no test
 * is a root nobody will notice falling out again.
 *
 * Run: node --test .github/scripts/check-golden-pins.test.mjs
 * (Node's directory discovery skips dot-directories, so name the file.)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkGoldenPins,
  isFlagged,
  isPinnedPath,
  missingPinnedRoots,
  parseTrailers,
  PINNED_ROOTS,
  rebuildWindowValues,
  REPO_ROOT,
} from './check-golden-pins.mjs';

const SCRIPT = fileURLToPath(
  new URL('./check-golden-pins.mjs', import.meta.url),
);
const FIXTURE_DIR = 'crates/stt-core/tests/fixtures/v2-golden';
/** The reader-side tree, watched since 2026-08-10. */
const TS_FIXTURE_DIR = 'packages/core/test/fixtures';

const tempRepos = [];
after(() => {
  for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true });
});

function git(repo, args, input) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function writeFile(repo, rel, body) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * A miniature of this repo: same fixture paths on BOTH sides, so the gate's
 * existence guard is satisfied and the path rules are exercised against real
 * strings rather than stand-ins.
 */
function makeRepo({ withFixtures = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'golden-pins-'));
  tempRepos.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'gate@example.invalid']);
  git(repo, ['config', 'user.name', 'Gate Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  // Never let the developer's global hooks run inside a test repo.
  git(repo, ['config', 'core.hooksPath', join(repo, '.no-hooks')]);
  writeFile(repo, 'crates/stt-core/src/pack/mod.rs', '// pack writer\n');
  writeFile(repo, 'packages/core/src/archive.ts', '// packed reader\n');
  if (withFixtures) {
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"aaa"}\n',
    );
    writeFile(repo, `${FIXTURE_DIR}/single/manifest.json`, '{"v":2}\n');
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/packed-golden/manifest.json`,
      '{"v":2}\n',
    );
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/paged-golden/packs/64c8.sttp`,
      'binaryish\n',
    );
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'chore: seed']);
  return { repo, base: git(repo, ['rev-parse', 'HEAD']).trim() };
}

function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--cleanup=whitespace', '-F', '-'], message);
}

function runGate(repo, extra = []) {
  const r = spawnSync('node', [SCRIPT, '--repo', repo, ...extra], {
    encoding: 'utf8',
    // A stray GOLDEN_PINS_BASE in the developer's shell must not steer a test.
    env: { ...process.env, GOLDEN_PINS_BASE: '', GITHUB_BASE_REF: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('isPinnedPath', () => {
  test('every file under the v2-golden tree is pinned', () => {
    assert.equal(isPinnedPath(`${FIXTURE_DIR}/expected-hashes.json`), true);
    assert.equal(isPinnedPath(`${FIXTURE_DIR}/single/manifest.json`), true);
    assert.equal(isPinnedPath(`${FIXTURE_DIR}/paged/packs/07ac.sttp`), true);
    assert.equal(isPinnedPath(`${FIXTURE_DIR}/paged/index/257a.sttd`), true);
    assert.equal(isPinnedPath(FIXTURE_DIR), true);
  });

  test('every file under the reader-side fixture tree is pinned', () => {
    // Added 2026-08-10: ~110 golden objects with the same regression-oracle
    // role had been churning entirely outside the gate.
    assert.equal(
      isPinnedPath(`${TS_FIXTURE_DIR}/packed-golden/manifest.json`),
      true,
    );
    assert.equal(
      isPinnedPath(`${TS_FIXTURE_DIR}/paged-golden/packs/64c8.sttp`),
      true,
    );
    assert.equal(
      isPinnedPath(`${TS_FIXTURE_DIR}/paged-golden-single/index/c591.sttd`),
      true,
    );
    assert.equal(
      isPinnedPath(`${TS_FIXTURE_DIR}/legacy-shape/points/tile.arrow`),
      true,
    );
    assert.equal(
      isPinnedPath(`${TS_FIXTURE_DIR}/v2-golden-tracks/manifest.json`),
      true,
    );
    assert.equal(isPinnedPath(TS_FIXTURE_DIR), true);
  });

  test('a sibling directory with the same prefix is NOT pinned', () => {
    // The `/` in the prefix test is what keeps `v2-golden-archive` out.
    assert.equal(
      isPinnedPath('crates/stt-core/tests/fixtures/v2-golden-archive/m.json'),
      false,
    );
    assert.equal(
      isPinnedPath('crates/stt-core/tests/fixtures/v1-golden/manifest.json'),
      false,
    );
    assert.equal(
      isPinnedPath('packages/core/test/fixtures-scratch/manifest.json'),
      false,
    );
    assert.equal(isPinnedPath('packages/layers/test/fixtures/x.json'), false);
  });

  test('ordinary source and doc paths are not pinned', () => {
    assert.equal(isPinnedPath('crates/stt-core/src/pack/mod.rs'), false);
    assert.equal(isPinnedPath('docs/roadmap/README.md'), false);
    assert.equal(isPinnedPath('packages/core/src/tileset.ts'), false);
    assert.equal(isPinnedPath('.github/workflows/ci.yml'), false);
    // The helper that RE-CUTS a fixture is code, not a pin — it lives in
    // test/helpers, one level up from the fixture tree, and editing it is an
    // ordinary change.
    assert.equal(
      isPinnedPath('packages/core/test/helpers/packed-fixture.ts'),
      false,
    );
    assert.equal(
      isPinnedPath('packages/core/test/packed-v2-golden.test.ts'),
      false,
    );
    assert.equal(
      isPinnedPath('packages/core/scripts/make-v2-golden.sh'),
      false,
    );
  });

  test('the hash pin stays watched wherever it is moved', () => {
    assert.equal(isPinnedPath('expected-hashes.json'), true);
    assert.equal(
      isPinnedPath('crates/stt-build/tests/expected-hashes.json'),
      true,
    );
    assert.equal(isPinnedPath('tools/bench/not-expected-hashes.json'), false);
  });

  test('non-string and empty input is not pinned', () => {
    assert.equal(isPinnedPath(''), false);
    assert.equal(isPinnedPath(null), false);
    assert.equal(isPinnedPath(undefined), false);
    assert.equal(isPinnedPath(42), false);
  });
});

describe('trailer parsing', () => {
  test('a Rebuild-Window: R1 trailer in the last paragraph flags the commit', () => {
    const msg =
      'fix(encode): pin attribute ranges globally\n\nRebuild-Window: R1\n';
    assert.deepEqual(rebuildWindowValues(msg), ['R1']);
    assert.equal(isFlagged(msg), true);
  });

  test('it still counts alongside other trailers', () => {
    const msg = [
      'feat!: the R1 rebuild',
      '',
      'Body text.',
      '',
      'Rebuild-Window: R1',
      'Co-Authored-By: Someone <s@example.invalid>',
    ].join('\n');
    assert.equal(isFlagged(msg), true);
  });

  test('key and value match case-insensitively', () => {
    assert.equal(isFlagged('subject\n\nrebuild-window: r1\n'), true);
    assert.equal(isFlagged('subject\n\nREBUILD-WINDOW: R1\n'), true);
  });

  test('a commit with no trailers is not flagged', () => {
    assert.equal(isFlagged('fix: something unrelated\n'), false);
    assert.equal(
      isFlagged('fix: something\n\nA plain body paragraph.\n'),
      false,
    );
  });

  test('naming the trailer in PROSE does not flag the commit', () => {
    // This is the reason the gate parses trailers instead of grepping: the
    // commit that introduces the gate quotes the phrase and must not flag.
    const inBody = [
      'ci: add the golden-pin gate',
      '',
      'Pin changes must carry Rebuild-Window: R1 in a trailer.',
      '',
      'Co-Authored-By: Someone <s@example.invalid>',
    ].join('\n');
    assert.equal(isFlagged(inBody), false);

    const proseOnly = [
      'ci: add the golden-pin gate',
      '',
      'We now require Rebuild-Window: R1 on any pin change.',
    ].join('\n');
    assert.equal(isFlagged(proseOnly), false);
  });

  test('a bare subject line that looks like a trailer is not a trailer', () => {
    assert.equal(parseTrailers('Rebuild-Window: R1').length, 0);
    assert.equal(isFlagged('Rebuild-Window: R1'), false);
  });

  test('a different window value is reported, not accepted', () => {
    const msg = 'chore: bytes moved\n\nRebuild-Window: R2\n';
    assert.deepEqual(rebuildWindowValues(msg), ['R2']);
    assert.equal(isFlagged(msg), false);
  });

  test('folded continuation lines fold into the previous value', () => {
    const msg =
      'subject\n\nRebuild-Window: R1\nNote: a value\n  continued here\n';
    const t = parseTrailers(msg);
    assert.equal(t.at(-1).value, 'a value continued here');
    assert.equal(isFlagged(msg), true);
  });

  test('CRLF messages parse the same', () => {
    assert.equal(isFlagged('subject\r\n\r\nRebuild-Window: R1\r\n'), true);
  });
});

describe('the fixture-existence guard', () => {
  test('every pinned root exists in THIS repo', () => {
    // The guard the policy turns on. If the golden fixtures are relocated,
    // this fails here rather than silently ungating the gate in CI.
    assert.deepEqual(missingPinnedRoots(REPO_ROOT), []);
    assert.equal(PINNED_ROOTS.length, 3);
    // Both fixture trees are watched, and each carries its OWN oracle and
    // regenerator — a message naming the wrong regenerator sends the reader to
    // re-bless the wrong tree.
    const dirs = PINNED_ROOTS.filter((r) => r.kind === 'dir').map(
      (r) => r.path,
    );
    assert.deepEqual(dirs, [
      'crates/stt-core/tests/fixtures/v2-golden',
      'packages/core/test/fixtures',
    ]);
    for (const root of PINNED_ROOTS) {
      assert.ok(root.oracle, `${root.path} must name its oracle`);
      assert.ok(root.regen, `${root.path} must name its regenerator`);
    }
    assert.equal(
      new Set(PINNED_ROOTS.filter((r) => r.kind === 'dir').map((r) => r.regen))
        .size,
      2,
      'the two trees must not share a regenerator',
    );
  });

  test('a tree without the fixtures reports every root as missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'golden-pins-empty-'));
    tempRepos.push(empty);
    const missing = missingPinnedRoots(empty);
    assert.equal(missing.length, PINNED_ROOTS.length);
    assert.equal(missing[0].problem, 'not found');
  });

  test('the guard short-circuits the whole check', () => {
    const empty = mkdtempSync(join(tmpdir(), 'golden-pins-empty-'));
    tempRepos.push(empty);
    const report = checkGoldenPins({ repo: empty });
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'guard');
  });

  test('relocated fixtures fail LOUDLY end to end', () => {
    const { repo, base } = makeRepo({ withFixtures: false });
    writeFile(repo, 'crates/stt-core/src/pack/mod.rs', '// edited\n');
    commit(repo, 'refactor: unrelated\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no longer matches the tree/);
    assert.match(r.stderr, /PINNED_ROOTS/);
    assert.match(r.stderr, /Do not delete this check/);
  });
});

describe('the gate, end to end', () => {
  test('touching a fixture WITHOUT the trailer fails', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"bbb"}\n',
    );
    commit(repo, 'chore: re-bless the golden hashes\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /golden pins: 1 change\(s\) moved a golden byte pin/,
    );
    assert.match(r.stderr, /expected-hashes\.json/);
    // It teaches, it does not merely block.
    assert.match(r.stderr, /§13\.1/);
    assert.match(r.stderr, /encoder bug/);
    assert.match(r.stderr, /git commit --trailer 'Rebuild-Window: R1'/);
    assert.equal(r.stdout, '');
  });

  test('a pack file counts, not just the hash pin', () => {
    const { repo, base } = makeRepo();
    writeFile(repo, `${FIXTURE_DIR}/paged/packs/07aca.sttp`, 'binaryish\n');
    commit(repo, 'chore: add a pack\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /07aca\.sttp/);
  });

  test('touching a READER-side fixture WITHOUT the trailer fails', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/packed-golden/manifest.json`,
      '{"v":3}\n',
    );
    commit(repo, 'chore: re-bless the TS packed golden\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /packed-golden\/manifest\.json/);
    assert.match(r.stderr, /§13\.1/);
  });

  test('a reader-side pack counts, and the writer tree is untouched', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/paged-golden/packs/64c8.sttp`,
      'moved\n',
    );
    commit(repo, 'chore: recut a reader pack\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /64c8\.sttp/);
    assert.doesNotMatch(r.stderr, /v2-golden\/single/);
  });

  test('the failure message names the regenerator for BOTH trees', () => {
    // The teaching half of the gate: whichever tree you touched, the message
    // has to hand you the right command, not the other one.
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/packed-golden/manifest.json`,
      '{"v":4}\n',
    );
    commit(repo, 'chore: bytes moved\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /cargo run -p stt-core --example make-golden-fixture/,
    );
    assert.match(r.stderr, /packages\/core\/scripts\/make-v2-golden\.sh/);
    assert.match(r.stderr, /crates\/stt-core\/tests\/v2_golden\.rs/);
    assert.match(r.stderr, /packages\/core\/test\/packed-v2-golden\.test\.ts/);
    assert.match(r.stderr, /encoder bug/);
  });

  test('a change touching BOTH trees is reported once, with both paths', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"zzz"}\n',
    );
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/v2-golden-tracks/manifest.json`,
      '{"v":3}\n',
    );
    commit(repo, 'chore: rebuild everything\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /golden pins: 1 change\(s\)/);
    assert.match(r.stderr, /expected-hashes\.json/);
    assert.match(r.stderr, /v2-golden-tracks\/manifest\.json/);
  });

  test('a reader-side pin change WITH the trailer passes', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/paged-golden-single/manifest.json`,
      '{"v":3}\n',
    );
    commit(
      repo,
      'feat!: v3 manifests on the reader side\n\nBytes move once, reviewed.\n\nRebuild-Window: R1\n',
    );
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 pin change\(s\) flagged `Rebuild-Window: R1`/);
  });

  test('deleting a fixture counts too', () => {
    const { repo, base } = makeRepo();
    rmSync(join(repo, FIXTURE_DIR, 'single/manifest.json'));
    commit(repo, 'chore: drop a golden manifest\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /single\/manifest\.json/);
  });

  test('touching a fixture WITH the trailer passes', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"ccc"}\n',
    );
    commit(
      repo,
      'feat!: global attribute-range pin\n\nBytes move once, reviewed.\n\nRebuild-Window: R1\n',
    );
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 pin change\(s\) flagged `Rebuild-Window: R1`/);
  });

  test('a wrong trailer value fails, and says what it found', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"ddd"}\n',
    );
    commit(repo, 'chore: move bytes\n\nRebuild-Window: R2\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /found `Rebuild-Window: R2` — expected `R1`/);
  });

  test('non-fixture diffs pass', () => {
    const { repo, base } = makeRepo();
    writeFile(repo, 'crates/stt-core/src/pack/mod.rs', '// tweaked\n');
    writeFile(repo, 'docs/roadmap/README.md', '# roadmap\n');
    commit(repo, 'refactor(pack): tidy the writer\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /golden pins: 1 commit\(s\) checked/);
    assert.match(r.stdout, /none touch the pins/);
  });

  test('an empty range passes', () => {
    const { repo } = makeRepo();
    const r = runGate(repo, ['--base', 'HEAD']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /golden pins: 0 commit\(s\) checked/);
  });

  test('only the pin-touching commit needs the flag', () => {
    const { repo, base } = makeRepo();
    writeFile(repo, 'crates/stt-core/src/pack/mod.rs', '// step 1\n');
    commit(repo, 'refactor(pack): step one\n');
    writeFile(repo, `${FIXTURE_DIR}/single/manifest.json`, '{"v":3}\n');
    commit(repo, 'feat!: re-encode\n\nRebuild-Window: R1\n');
    writeFile(repo, 'docs/roadmap/README.md', '# roadmap\n');
    commit(repo, 'docs: note the rebuild\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /golden pins: 3 commit\(s\) checked/);
  });

  test('a pin moved and then reverted still fails (per-commit, not net diff)', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"eee"}\n',
    );
    commit(repo, 'wip: try a thing\n');
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"aaa"}\n',
    );
    commit(repo, 'wip: put it back\n');
    assert.equal(
      git(repo, ['diff', '--name-only', `${base}..HEAD`]).trim(),
      '',
      'net diff is empty — that is the point of this case',
    );
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 change\(s\)/);
  });

  test('the hash pin is caught even outside the fixture tree', () => {
    const { repo, base } = makeRepo();
    writeFile(repo, 'crates/stt-build/tests/expected-hashes.json', '{"x":1}\n');
    commit(repo, 'test: add build-side hashes\n');
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /crates\/stt-build\/tests\/expected-hashes\.json/);
  });
});

describe('working-tree mode', () => {
  test('uncommitted pin churn is IGNORED by default', () => {
    // The gate landed on a tree that already carried in-flight golden churn
    // from the byte-break wave. It enforces from its landing commit forward.
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"fff"}\n',
    );
    const r = runGate(repo, ['--base', base]);
    assert.equal(r.status, 0, r.stderr);
  });

  test('--working-tree opts in to flagging it', () => {
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${FIXTURE_DIR}/expected-hashes.json`,
      '{"single":"fff"}\n',
    );
    const r = runGate(repo, ['--base', base, '--working-tree']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /working tree/);
    assert.match(r.stderr, /expected-hashes\.json/);
  });

  test('--working-tree flags reader-side churn too', () => {
    // This is the mode that, on THIS repo, now reports the in-flight v2→v3
    // churn under packages/core/test/fixtures/. That report is correct and is
    // not a reason to narrow the watched set.
    const { repo, base } = makeRepo();
    writeFile(
      repo,
      `${TS_FIXTURE_DIR}/packed-golden/manifest.json`,
      '{"v":9}\n',
    );
    const r = runGate(repo, ['--base', base, '--working-tree']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /working tree/);
    assert.match(r.stderr, /packed-golden\/manifest\.json/);
  });

  test('--working-tree ignores untracked non-pin files', () => {
    const { repo, base } = makeRepo();
    writeFile(repo, 'scratch/notes.md', 'hello\n');
    const r = runGate(repo, ['--base', base, '--working-tree']);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('base resolution', () => {
  test('an unresolvable explicit base fails closed', () => {
    const { repo } = makeRepo();
    const r = runGate(repo, ['--base', 'no-such-ref-anywhere']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not resolve a base commit/);
    assert.match(r.stderr, /fetch-depth: 0/);
  });

  test('an unusable --head fails closed, not open', () => {
    const { repo, base } = makeRepo();
    const r = runGate(repo, ['--base', base, '--head', 'not-a-ref']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not run/);
    assert.match(r.stderr, /must not read as\n?a? ?passing one/);
  });

  test('--help exits 0 without touching git', () => {
    const r = runGate(REPO_ROOT, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--working-tree/);
  });
});
