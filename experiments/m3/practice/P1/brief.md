# Book loans

A small library lends books. Books are named by the caller with a string id. This is a practice task for pilot runs; its results are never scored with the experiment's ten tasks.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. A command on a book id that was never added is refused.

- `add(book)`: adds the book to the shelf, **available**. Refused if a book with that id exists.
- `lend(book)`: an available book becomes **lent**, and its count of loans goes up by 1. Refused otherwise.
- `giveBack(book)`: a lent book becomes **available** again. Refused otherwise.
- `retire(book)`: an available book becomes **retired** and accepts no further command. Refused otherwise.

## Query

`book(book)` returns `{ status, loans }` for a book that exists, and `null` otherwise: `status` is `"available"`, `"lent"` or `"retired"`, and `loans` counts its loans, at most 3; a fourth loan is refused.

## The interface

Implement `host.ts`. Its default export creates a fresh system, with no books.

## Conclusion

A book is lent to one borrower at a time, at most three times in all, and a retired book is never lent again.
