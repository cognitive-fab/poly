# poly for VS Code

This adapter colours poly modules in VS Code: `.poly` files, and so `.policy.poly` files. It is configuration only, as every adapter is (S167): a language, its comments and brackets, and a TextMate grammar. It runs no code and starts no server. The specification is the paragraph "The VS Code adapter" in PT14 of `docs/03-technical-spec.md`, and `test/vscode-adapter.test.mjs` checks it.

## Install

Package the folder as a `.vsix` and install that with VS Code's command line, then run **Developer: Reload Window**. From the repository root, in Windows PowerShell or a POSIX shell:

```sh
cd adapters/vscode
npx @vscode/vsce package --no-dependencies --skip-license --out ../../poly-1.4.0.vsix
cd ../..
code --install-extension poly-1.4.0.vsix --force
```

`--no-dependencies` keeps `vsce` from asking npm for a dependency tree the adapter does not have (without it, the package held no files); `--skip-license` because the repository has no licence file. The `.vsix` can be deleted afterwards. `code --list-extensions --show-versions` lists `cognitive-fab.poly@1.4.0` once it is installed.

Copying this folder into the extensions folder (`.vscode/extensions`) is not enough. VS Code records each extension it installs in that folder's `extensions.json`, and marks a folder it did not install as removed: its log says `Marked extension as removed cognitive-fab.poly-1.4.0`, and the files stay grey.

To update it, package and install again. To remove it, `code --uninstall-extension cognitive-fab.poly`.

## What it colours

| Text | Scope | Example |
|---|---|---|
| A word that begins an item, coloured only as the first word of a line | `keyword.control.poly` | `machine`, `state`, `effect`, `order`, `kind` |
| A word that may stand anywhere on a line | `keyword.other.poly` | `require`, `else`, `reject`, `emit`, `retry`, `as`, `where` |
| A built-in type | `support.type.poly` | `bool`, `int`, `string`, `map` |
| A constant | `constant.language.poly` | `true`, `false`, `none`, `irreversible` |
| A capitalised word: a type, an enum value, an action | `entity.name.type.poly` | `Phase`, `Idle`, `Sent` |
| A primed field | `variable.other.primed.poly` | `phase'` |
| A duration | `constant.numeric.duration.poly` | `200ms`, `10s`, `168h` |
| A decimal or an integer | `constant.numeric.poly` | `0.8`, `3` |
| A string and its escapes | `string.quoted.double.poly` | `"mail.send"`, `\n` |
| A comment, and a requirement or diagnostic id inside it | `comment.*`, `constant.other.reference.poly` | `// PS23.4`, `PL4003` |

Your colour theme decides the colours; the grammar decides only the scopes.

## How the words were chosen

poly's keywords are contextual (PT2.1): the lexer has no keyword list, and the parser decides by position, so a field may be called `order` or `owner`. The grammar's words are therefore measured, not listed by hand. Every lower-case terminal of the spec's grammar, and every word the parser matches by text, is coloured by exactly one of the four word rules, and no word outside them is coloured. The test computes both sides from the spec and the parser, so a keyword added to either fails the test until the grammar has it.

A word that is often a field's name as well goes in the leading rule, so `owner == customer` does not colour `owner`. A word inside a hyphenated property name (`no-reproposal-after-allow`) or after a dot (`effect.kind`) is not coloured either.

## What it does not do

- **No diagnostics, formatting or fixes.** These are `poly lsp`'s, and VS Code starts a language server only from extension code, which an adapter may not hold. Run `poly check` in a terminal, or use the Claude Code adapter, which declares `poly lsp`. Starting `poly lsp` from VS Code waits for a ruling (`docs/proposals/v2.0-ideas.md`).
- **No parsing.** A TextMate grammar colours by regular expressions, line by line. A leading word that wraps onto a second line is not coloured there, and a word the parser reads as a name at the start of a line is coloured as a keyword.

## Files

- `package.json`: the language `poly` and its grammar `source.poly`.
- `language-configuration.json`: comments, brackets, closing pairs, and a word that may hold hyphens, so a double click selects a whole property name.
- `syntaxes/poly.tmLanguage.json`: the grammar. Two of its repository keys are their scope names (`comment.line.double-slash.poly`, `constant.other.reference.poly`), because the test follows includes by key.

## Conclusion

The adapter gives poly colour in VS Code with nothing to build and nothing to run. Its words come from the spec and the parser, and the test keeps them there.

## Glossary

- **Adapter:** a folder under `adapters/` that tells a host how to use poly, with configuration only (S167).
- **TextMate grammar:** a JSON file of regular expressions that assigns scopes to text; VS Code colours by it.
- **Scope:** a dotted name such as `keyword.control.poly` that a colour theme maps to a colour.
- **Contextual keyword:** a word that is a keyword only where the grammar expects one, and a name elsewhere.
- **Leading word:** a keyword this grammar colours only as the first word of a line.
- **.vsix:** a packaged VS Code extension, a zip file that `code --install-extension` installs and registers.
