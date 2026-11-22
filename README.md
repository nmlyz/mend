[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nmlyz/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nmlyz/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend applies an edit to a tree of text files. The edit can be written as a
unified diff, as SEARCH/REPLACE blocks, as a V4A patch, or as JSON text-editor
tool calls. Lines are found even when their whitespace or indentation drifted,
and either every file changes or none does.

## Run it

```sh
node main.ts patch.diff
```

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, or `-` (or nothing) to read the patch from
  standard input. The working directory is the root of the tree.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects the format.
- `--check` reports what would change without writing anything.
- `--strict` matches lines exactly.

## Exit codes

- `0`: the patch applied. The changed files are listed, then
  `ok: <n> files`.
- `1`: one or more edits failed. Each failure is listed, then
  `failed: <k> of <n> edits`. Nothing is written.
- `2`: the invocation or the patch itself is unusable: `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`.

`A <path>` is a file that did not exist and now does, `D <path>` one that
existed and now does not, `M <path>` one that changed, and
`R <old> -> <new>` one that moved. See `SPEC.md` for the full contract.

## Requirements

Node 22 or later, standard library only. No dependencies, no install step.
